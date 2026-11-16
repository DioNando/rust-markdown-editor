// Backend Rust de l'éditeur Markdown (Tauri).
// L'interface (HTML/CSS/JS dans ui/) appelle ces fonctions via `invoke(...)`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")] // pas de console en release

use pulldown_cmark::{Event, Options, Parser, html};
use serde::Serialize;
use std::path::PathBuf;

/// Convertit le Markdown en HTML. Appelé à chaque frappe : pulldown-cmark
/// traite des centaines de Mo/s, donc c'est instantané même sur de gros fichiers.
#[tauri::command]
fn render_markdown(text: &str) -> String {
    let opts = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_SMART_PUNCTUATION;

    // Sécurité : le HTML brut contenu dans le Markdown est affiché comme du texte,
    // pour qu'un fichier .md piégé ne puisse pas exécuter de script dans l'appli.
    let parser = Parser::new_ext(text, opts).map(|ev| match ev {
        Event::Html(s) | Event::InlineHtml(s) => Event::Text(s),
        other => other,
    });

    let mut out = String::with_capacity(text.len() * 3 / 2);
    html::push_html(&mut out, parser);
    out
}

#[derive(Serialize)]
struct OpenedFile {
    path: String,
    content: String,
}

/// Ouvre une boîte de dialogue native et lit le fichier choisi.
#[tauri::command]
async fn open_file(window: tauri::WebviewWindow) -> Result<Option<OpenedFile>, String> {
    let Some(handle) = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .pick_file()
        .await
    else {
        return Ok(None); // annulé
    };
    let path = handle.path().to_path_buf();
    let content = std::fs::read_to_string(&path).map_err(|e| format!("Lecture impossible : {e}"))?;
    Ok(Some(OpenedFile {
        path: path.display().to_string(),
        content,
    }))
}

/// Lit un fichier déposé par glisser-déposer (seulement Markdown / texte).
#[tauri::command]
fn read_file(path: String) -> Result<OpenedFile, String> {
    let p = PathBuf::from(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "md" | "markdown" | "mdown" | "txt") {
        return Err(format!("Type de fichier non pris en charge : {}", p.display()));
    }
    let content = std::fs::read_to_string(&p).map_err(|e| format!("Lecture impossible : {e}"))?;
    Ok(OpenedFile { path, content })
}

/// Enregistre le texte. Sans chemin (ou en « Enregistrer sous »), demande où l'enregistrer.
/// Renvoie le chemin utilisé, ou None si l'utilisateur a annulé.
#[tauri::command]
async fn save_file(
    window: tauri::WebviewWindow,
    path: Option<String>,
    content: String,
    suggested_name: Option<String>,
) -> Result<Option<String>, String> {
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
    Ok(Some(target.display().to_string()))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![render_markdown, open_file, read_file, save_file])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application");
}
