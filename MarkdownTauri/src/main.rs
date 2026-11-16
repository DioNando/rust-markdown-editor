// Backend Rust de l'éditeur Markdown (Tauri).
// L'interface (HTML/CSS/JS dans ui/) appelle ces fonctions via `invoke(...)`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")] // pas de console en release

use pulldown_cmark::{CowStr, Event, Options, Parser, Tag, html};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{Emitter, Manager};

const MD_EXTS: &[&str] = &["md", "markdown", "mdown", "txt"];
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"];

/// Chemin affichable, séparateurs homogènes (« \ » sous Windows) : un même fichier
/// a toujours la même écriture, donc un seul onglet.
fn path_string(p: &Path) -> String {
    let s = p.display().to_string();
    if cfg!(windows) { s.replace('/', "\\") } else { s }
}

fn ext_of(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

// ====================================================================
// Rendu Markdown
// ====================================================================

/// Convertit le Markdown en HTML. Appelé à chaque frappe : pulldown-cmark
/// traite des centaines de Mo/s, donc c'est instantané même sur de gros fichiers.
///
/// - `base_dir` : dossier du fichier, pour afficher les images locales relatives.
/// - Chaque bloc de premier niveau reçoit `data-line="N"` (ligne source, base 0) :
///   l'interface s'en sert pour caler le défilement éditeur ⇄ aperçu.
#[tauri::command]
fn render_markdown(text: &str, base_dir: Option<String>) -> String {
    let opts = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_SMART_PUNCTUATION
        | Options::ENABLE_MATH;

    let line_starts: Vec<usize> = std::iter::once(0)
        .chain(text.match_indices('\n').map(|(i, _)| i + 1))
        .collect();
    let line_of = |offset: usize| line_starts.partition_point(|&s| s <= offset).saturating_sub(1);
    let base = base_dir.as_deref().map(Path::new);

    let mut out = String::with_capacity(text.len() * 3 / 2);
    let mut block: Vec<Event> = Vec::new();
    let mut depth = 0usize;
    let mut block_line = 0usize;

    for (ev, range) in Parser::new_ext(text, opts).into_offset_iter() {
        let ev = match ev {
            // Sécurité : le HTML brut contenu dans le Markdown est affiché comme du texte,
            // pour qu'un fichier .md piégé ne puisse pas exécuter de script dans l'appli.
            Event::Html(s) | Event::InlineHtml(s) => Event::Text(s),
            Event::Start(Tag::Image { link_type, dest_url, title, id }) => Event::Start(Tag::Image {
                link_type,
                dest_url: local_image_url(&dest_url, base).map(CowStr::from).unwrap_or(dest_url),
                title,
                id,
            }),
            other => other,
        };
        match ev {
            Event::Start(_) => {
                if depth == 0 {
                    block_line = line_of(range.start);
                }
                depth += 1;
            }
            Event::End(_) => depth -= 1,
            _ if depth == 0 => block_line = line_of(range.start), // bloc sans contenu (ligne horizontale…)
            _ => {}
        }
        block.push(ev);
        if depth == 0 {
            push_block(&mut out, &mut block, block_line);
        }
    }
    push_block(&mut out, &mut block, block_line);
    out
}

/// Rend un bloc de premier niveau et ajoute `data-line` à sa balise ouvrante.
fn push_block(out: &mut String, block: &mut Vec<Event>, line: usize) {
    if block.is_empty() {
        return;
    }
    let mut s = String::new();
    html::push_html(&mut s, block.drain(..));
    if s.starts_with('<') {
        let name_end = s[1..]
            .find(|c: char| c == ' ' || c == '>' || c == '/')
            .map(|i| i + 1)
            .unwrap_or(s.len());
        s.insert_str(name_end, &format!(" data-line=\"{line}\""));
    }
    out.push_str(&s);
}

/// Image locale (chemin relatif au fichier, ou absolu) → URL du protocole `mdimg`.
/// Les URL web et `data:` sont laissées telles quelles.
fn local_image_url(dest: &str, base: Option<&Path>) -> Option<String> {
    let dest = dest.trim();
    if dest.is_empty() {
        return None;
    }
    let lower = dest.to_ascii_lowercase();
    let dest = if let Some(rest) = lower.strip_prefix("file:///").map(|_| &dest[8..]) {
        rest
    } else {
        // Un schéma (http:, data:…) : on ne touche pas. « C:\ » n'est pas un schéma.
        if let Some(i) = dest.find(':') {
            if i > 1 && !dest[..i].contains(['/', '\\']) {
                return None;
            }
        }
        dest
    };
    let decoded = percent_decode(dest);
    let path = Path::new(&decoded);
    let full = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base?.join(path)
    };
    if !IMAGE_EXTS.contains(&ext_of(&full).as_str()) {
        return None;
    }
    Some(format!("http://mdimg.localhost/{}", percent_encode(&full.display().to_string())))
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Sert les images locales de l'aperçu (et seulement des images).
fn serve_image(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let path = PathBuf::from(percent_decode(request.uri().path().trim_start_matches('/')));
    let mime = match ext_of(&path).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => "",
    };
    let file = if mime.is_empty() { None } else { std::fs::read(&path).ok() };
    let builder = tauri::http::Response::builder();
    match file {
        Some(bytes) => builder
            .header("Content-Type", mime)
            .header("Cache-Control", "no-cache")
            .body(bytes),
        None => builder.status(404).body(Vec::new()),
    }
    .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

// ====================================================================
// Fichiers
// ====================================================================

#[derive(Serialize)]
struct OpenedFile {
    path: String,
    content: String,
    mtime: Option<u64>,
}

#[derive(Serialize)]
struct SavedFile {
    path: String,
    mtime: Option<u64>,
}

/// Date de modification (ms depuis 1970), ou None si le fichier n'existe plus.
fn mtime_of(p: &Path) -> Option<u64> {
    let t = std::fs::metadata(p).ok()?.modified().ok()?;
    Some(t.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn read_markdown(p: &Path) -> Result<OpenedFile, String> {
    if !MD_EXTS.contains(&ext_of(p).as_str()) {
        return Err(format!("Type de fichier non pris en charge : {}", p.display()));
    }
    let content = std::fs::read_to_string(p).map_err(|e| format!("Lecture impossible : {e}"))?;
    Ok(OpenedFile {
        path: path_string(p),
        content,
        mtime: mtime_of(p),
    })
}

/// Ouvre une boîte de dialogue native et lit le fichier choisi.
#[tauri::command]
async fn open_file(window: tauri::WebviewWindow) -> Result<Option<OpenedFile>, String> {
    let Some(handle) = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .add_filter("Markdown", MD_EXTS)
        .pick_file()
        .await
    else {
        return Ok(None); // annulé
    };
    read_markdown(handle.path()).map(Some)
}

/// Lit un fichier (glisser-déposer, session, fichiers récents…) : seulement Markdown / texte.
#[tauri::command]
fn read_file(path: String) -> Result<OpenedFile, String> {
    read_markdown(Path::new(&path))
}

/// Dates de modification de plusieurs fichiers (détection des changements externes).
#[tauri::command]
fn file_mtimes(paths: Vec<String>) -> Vec<Option<u64>> {
    paths.iter().map(|p| mtime_of(Path::new(p))).collect()
}

/// Enregistre le texte. Sans chemin (ou en « Enregistrer sous »), demande où l'enregistrer.
/// Renvoie le chemin utilisé, ou None si l'utilisateur a annulé.
#[tauri::command]
async fn save_file(
    window: tauri::WebviewWindow,
    path: Option<String>,
    content: String,
    suggested_name: Option<String>,
) -> Result<Option<SavedFile>, String> {
    let target: PathBuf = match path {
        Some(p) => PathBuf::from(p),
        None => match rfd::AsyncFileDialog::new()
            .set_parent(&window)
            .add_filter("Markdown", &["md"])
            .set_file_name(suggested_name.unwrap_or_else(|| "document.md".into()))
            .save_file()
            .await
        {
            Some(h) => h.path().to_path_buf(),
            None => return Ok(None),
        },
    };
    std::fs::write(&target, content).map_err(|e| format!("Écriture impossible : {e}"))?;
    Ok(Some(SavedFile {
        mtime: mtime_of(&target),
        path: path_string(&target),
    }))
}

/// Export HTML : demande toujours où enregistrer.
#[tauri::command]
async fn save_export(
    window: tauri::WebviewWindow,
    content: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let Some(h) = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .add_filter("Page web", &["html"])
        .set_file_name(suggested_name)
        .save_file()
        .await
    else {
        return Ok(None);
    };
    std::fs::write(h.path(), content).map_err(|e| format!("Écriture impossible : {e}"))?;
    Ok(Some(h.path().display().to_string()))
}

/// Lien local de l'aperçu (`autre.md`, `../notes/x.md#titre`) → chemin d'un fichier Markdown existant.
#[tauri::command]
fn resolve_link(base_file: Option<String>, href: String) -> Result<String, String> {
    let target = href.split(['#', '?']).next().unwrap_or_default();
    let decoded = percent_decode(target.strip_prefix("file:///").unwrap_or(target));
    let rel = Path::new(&decoded);
    let full = if rel.is_absolute() {
        rel.to_path_buf()
    } else {
        let base = base_file.ok_or("Enregistre d'abord le document pour suivre ses liens locaux")?;
        Path::new(&base).parent().unwrap_or(Path::new(".")).join(rel)
    };
    if !MD_EXTS.contains(&ext_of(&full).as_str()) {
        return Err(format!("Seuls les liens vers des fichiers Markdown s'ouvrent ici : {href}"));
    }
    if !full.is_file() {
        return Err(format!("Fichier introuvable : {}", full.display()));
    }
    Ok(path_string(&full))
}

// ====================================================================
// Session (onglets ouverts, brouillons, fichiers récents)
// ====================================================================

fn session_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
}

#[tauri::command]
fn load_session(app: tauri::AppHandle) -> Option<String> {
    std::fs::read_to_string(session_path(&app).ok()?).ok()
}

/// Écriture atomique : fichier temporaire puis renommage (pas de session à moitié écrite).
#[tauri::command]
fn save_session(app: tauri::AppHandle, data: String) -> Result<(), String> {
    let path = session_path(&app)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

// ====================================================================
// Ligne de commande / instance unique
// ====================================================================

/// Arguments de la ligne de commande → fichiers Markdown existants.
fn args_to_paths(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .map(|a| cwd.join(a))
        .filter(|p| p.is_file() && MD_EXTS.contains(&ext_of(p).as_str()))
        .map(|p| path_string(&p))
        .collect()
}

/// Fichiers passés au lancement (double-clic sur un .md, « Ouvrir avec… »).
#[tauri::command]
fn startup_paths() -> Vec<String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    args_to_paths(std::env::args().skip(1), &cwd)
}

// ====================================================================
// Liens externes et navigation
// ====================================================================

/// N'autorise que les liens web et e-mail à sortir vers le système.
fn is_external(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")
}

/// Ouvre un lien de l'aperçu dans le navigateur (ou le client mail) par défaut.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !is_external(&url) {
        return Err(format!("Lien non pris en charge : {url}"));
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Garde-fou : la fenêtre ne doit jamais quitter la page de l'application.
/// Sinon un clic sur un lien remplacerait l'interface (et ses onglets non
/// enregistrés) par un site web. Les liens externes partent vers le navigateur.
fn navigation_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|_webview, url| {
            let is_app = matches!(url.host_str(), Some("tauri.localhost") | Some("localhost"))
                || url.scheme() == "tauri";
            let same_page = matches!(url.path(), "/" | "/index.html");
            if is_app && same_page {
                return true; // chargement initial, ancres #note
            }
            // Lien relatif (autre.md) : il pointerait vers l'app elle-même, on le bloque simplement
            if !is_app && is_external(url.as_str()) {
                let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .build()
}

fn main() {
    tauri::Builder::default()
        // Doit être le premier plugin : un 2e lancement (double-clic sur un autre .md)
        // transmet ses fichiers à la fenêtre déjà ouverte, puis se ferme.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let paths = args_to_paths(argv.into_iter().skip(1), Path::new(&cwd));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            let _ = app.emit("open-paths", paths);
        }))
        .plugin(navigation_guard())
        .register_uri_scheme_protocol("mdimg", |_ctx, request| serve_image(request))
        .invoke_handler(tauri::generate_handler![
            render_markdown,
            open_file,
            read_file,
            file_mtimes,
            save_file,
            save_export,
            resolve_link,
            load_session,
            save_session,
            startup_paths,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lignes_source() {
        let html = render_markdown("# Titre\n\nPara\n\n---\n\n- a\n- b\n", None);
        assert!(html.contains("<h1 data-line=\"0\">"), "{html}");
        assert!(html.contains("<p data-line=\"2\">"), "{html}");
        assert!(html.contains("<hr data-line=\"4\" />"), "{html}");
        assert!(html.contains("<ul data-line=\"6\">"), "{html}");
    }

    #[test]
    fn images_locales() {
        let html = render_markdown("![x](img/a%20b.png)![y](https://e.com/b.png)", Some("C:\\docs".into()));
        assert!(html.contains("http://mdimg.localhost/C%3A%5Cdocs%5Cimg%2Fa%20b.png"), "{html}");
        assert!(html.contains("https://e.com/b.png"), "{html}");
        assert_eq!(percent_decode("C%3A%5Cdocs%5Cimg%2Fa%20b.png"), "C:\\docs\\img/a b.png");
    }

    #[test]
    fn html_brut_neutralise() {
        let html = render_markdown("<script>alert(1)</script>", None);
        assert!(!html.contains("<script>"), "{html}");
    }
}
