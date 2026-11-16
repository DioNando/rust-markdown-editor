// Interface : onglets, vue fractionnée, glisser-déposer, recherche, plan, session…
// Le travail « lourd » (rendu Markdown, fichiers) est fait en Rust via invoke().
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();
const webview = window.__TAURI__.webview.getCurrentWebview();

const $ = (id) => document.getElementById(id);
const workspace = $("workspace");
const groupTemplate = $("group-template");

const WELCOME = `# Bienvenue

Écris du **Markdown** à gauche, l'aperçu s'affiche à droite.
Le rendu est fait en **Rust** (pulldown-cmark), l'interface en HTML/CSS.

## Ce que sait faire l'éditeur

- **Glisser-déposer** : dépose un ou plusieurs fichiers \`.md\` sur un panneau.
- **Onglets** et **vue fractionnée** : chaque panneau a ses onglets.
- **Session** : les onglets (et les brouillons) sont rouverts au lancement.
- **Images locales** : \`![](images/photo.png)\`, relatif au fichier.
- **Code coloré**, **formules** $E = mc^2$ et **schémas** Mermaid.
- **Plan du document**, **recherche / remplacement**, **export** HTML et PDF.

## Raccourcis

| Action | Raccourci |
|---|---|
| Gras / italique / code / lien | \`Ctrl+B\` / \`Ctrl+I\` / \`Ctrl+E\` / \`Ctrl+K\` |
| Rechercher / remplacer | \`Ctrl+F\` / \`Ctrl+H\` |
| Plan du document | \`Ctrl+Maj+O\` |
| Nouvel onglet / fermer | \`Ctrl+T\` / \`Ctrl+W\` |
| Onglet suivant / précédent | \`Ctrl+Tab\` / \`Ctrl+Maj+Tab\` |
| Fractionner la vue | \`Ctrl+\\\` |
| Ouvrir / enregistrer / sous | \`Ctrl+O\` / \`Ctrl+S\` / \`Ctrl+Maj+S\` |
| Exporter en PDF | \`Ctrl+P\` |

- [x] Les listes continuent toutes seules avec \`Entrée\`
- [ ] Essayer \`Tab\` / \`Maj+Tab\` sur plusieurs lignes

\`\`\`mermaid
graph LR
  A[Markdown] -->|Rust| B(HTML)
  B --> C{Aperçu}
\`\`\`

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}
$$

> Astuce : le bouton en haut à droite change de thème.
`;

// ====================================================================
// Modèle
// ====================================================================
let nextId = 1;

/** @type {Map<number, any>} */
const docs = new Map();
/** Panneaux : chacun a ses onglets (ids de documents), son onglet actif et son mode. */
const groups = [];
let focused = null;

function createDoc(text = "", path = null, { pristine = false, savedText = text, mtime = null } = {}) {
  const doc = { id: nextId++, path, text, savedText, pristine, mtime, version: 0, html: "", htmlVersion: -1, htmlBase: null };
  docs.set(doc.id, doc);
  return doc;
}

const isDirty = (doc) => doc.text !== doc.savedText;
const docName = (doc) => (doc.path ? baseName(doc.path) : "Sans titre");
const baseName = (p) => p.split(/[\\/]/).pop();
const dirName = (p) => (p ? p.replace(/[\\/][^\\/]*$/, "") : null);
// Windows : insensible à la casse, « / » et « \ » équivalents
const samePath = (a, b) => a && b && a.replaceAll("/", "\\").toLowerCase() === b.replaceAll("/", "\\").toLowerCase();
const activeDoc = (g = focused) => (g ? docs.get(g.active) : null);
const groupsShowing = (doc) => groups.filter((g) => g.active === doc.id);
const isReferenced = (doc) => groups.some((g) => g.tabs.includes(doc.id));
const theme = () => document.documentElement.dataset.theme;

// ====================================================================
// Panneaux (groupes)
// ====================================================================
function createGroup(mode = loadPref("mode", "split")) {
  const el = groupTemplate.content.firstElementChild.cloneNode(true);
  const g = {
    id: nextId++,
    el,
    tabsEl: el.querySelector(".tabs"),
    body: el.querySelector(".group-body"),
    editorPane: el.querySelector(".editor-pane"),
    editor: el.querySelector(".editor"),
    hl: el.querySelector(".highlight"),
    hlCode: el.querySelector(".highlight code"),
    previewPane: el.querySelector(".preview-pane"),
    preview: el.querySelector(".markdown"),
    tabs: [],
    active: null,
    mode,
    views: new Map(), // état de vue (défilement, sélection) par document
    anchors: null, // correspondance lignes source ⇄ positions (défilement synchronisé)
    textIndex: null, // nœuds texte du calque coloré (recherche, positions de lignes)
    ignoreScroll: new Map(),
  };
  g.body.dataset.mode = mode;
  wireGroup(g);
  workspace.appendChild(el);
  groups.push(g);
  return g;
}

function removeGroup(g) {
  const i = groups.indexOf(g);
  if (i < 0) return;
  if (find.g === g) closeFind();
  groups.splice(i, 1);
  g.el.remove();
  if (focused === g) setFocus(groups[Math.max(0, i - 1)]);
  updateChrome();
}

function setFocus(g) {
  if (!g || focused === g) return;
  focused = g;
  groups.forEach((x) => x.el.classList.toggle("focused", x === g));
  updateChrome();
  scheduleOutline();
}

function setMode(g, mode) {
  g.mode = mode;
  g.body.dataset.mode = mode;
  savePref("mode", mode);
  g.anchors = null;
  if (mode === "preview" && find.g === g) closeFind();
  if (g === focused) updateChrome();
  if (mode === "split") requestAnimationFrame(() => syncScroll(g, "editor"));
  scheduleOutline();
}

// ====================================================================
// Onglets
// ====================================================================
function saveView(g) {
  if (g.active == null) return;
  g.views.set(g.active, {
    scroll: g.editor.scrollTop,
    selStart: g.editor.selectionStart,
    selEnd: g.editor.selectionEnd,
    previewScroll: g.previewPane.scrollTop,
  });
}

// ---------- Coloration syntaxique (calque <pre> sous le textarea) ----------
function paint(g) {
  g.hlCode.innerHTML = window.highlightMarkdown(g.editor.value);
  g.textIndex = null;
  g.anchors = null;
  syncLayer(g);
  if (find.open && find.g === g) refreshFind({ keepCurrent: true });
}
function syncLayer(g) {
  g.hl.scrollTop = g.editor.scrollTop;
  g.hl.scrollLeft = g.editor.scrollLeft;
}

function loadView(g) {
  const doc = activeDoc(g);
  if (!doc) return;
  g.editor.value = doc.text;
  paint(g);
  const v = g.views.get(doc.id) || { scroll: 0, selStart: 0, selEnd: 0, previewScroll: 0 };
  g.editor.setSelectionRange(v.selStart, v.selEnd);
  g.editor.scrollTop = v.scroll;
  syncLayer(g);
  showPreview(g, v.previewScroll);
}

function activate(g, docId, { focusEditor = true } = {}) {
  if (g.active !== docId) {
    saveView(g);
    g.active = docId;
    loadView(g);
  }
  renderTabs(g);
  setFocus(g);
  updateChrome();
  scheduleOutline();
  if (focusEditor && g.mode !== "preview") g.editor.focus({ preventScroll: true });
}

/** Ouvre un document dans un panneau (juste après l'onglet actif). */
function openInGroup(doc, g = focused) {
  if (!g.tabs.includes(doc.id)) {
    const at = g.tabs.indexOf(g.active);
    g.tabs.splice(at < 0 ? g.tabs.length : at + 1, 0, doc.id);
  }
  activate(g, doc.id);
}

async function closeTab(g, docId) {
  const doc = docs.get(docId);
  if (!doc) return;
  const elsewhere = groups.some((x) => x !== g && x.tabs.includes(docId));
  if (!elsewhere && isDirty(doc)) {
    activate(g, docId, { focusEditor: false });
    const answer = await askSave(doc);
    if (answer === "cancel") return;
    if (answer === "save" && !(await saveDoc(doc))) return;
  }

  const i = g.tabs.indexOf(docId);
  g.tabs.splice(i, 1);
  g.views.delete(docId);
  if (!isReferenced(doc)) docs.delete(docId);

  if (g.tabs.length === 0) {
    if (groups.length > 1) return removeGroup(g);
    g.active = null;
    openInGroup(createDoc(), g);
    return;
  }
  if (g.active === docId) {
    g.active = null;
    activate(g, g.tabs[Math.min(i, g.tabs.length - 1)]);
  } else {
    renderTabs(g);
    updateChrome();
  }
}

function cycleTab(dir) {
  const g = focused;
  if (g.tabs.length < 2) return;
  const i = g.tabs.indexOf(g.active);
  activate(g, g.tabs[(i + dir + g.tabs.length) % g.tabs.length]);
}

function renderTabs(g) {
  const frag = document.createDocumentFragment();
  for (const id of g.tabs) {
    const doc = docs.get(id);
    const tab = document.createElement("div");
    tab.className = "tab" + (id === g.active ? " active" : "") + (isDirty(doc) ? " dirty" : "");
    tab.dataset.id = id;
    tab.title = doc.path || "Document non enregistré";
    tab.setAttribute("role", "tab");

    const icon = document.createElement("span");
    icon.className = "ms tab-icon";
    icon.textContent = "description";

    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = docName(doc);

    const close = document.createElement("button");
    close.className = "tab-close";
    close.title = "Fermer (Ctrl+W)";
    close.innerHTML = '<span class="ms">close</span>';

    tab.append(icon, name, close);
    frag.appendChild(tab);
  }
  g.tabsEl.replaceChildren(frag);
  g.tabsEl.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

const renderAllTabs = () => groups.forEach(renderTabs);

// ====================================================================
// Rendu Markdown (en Rust), mis en cache par document
// ====================================================================
const renderQueue = new Set();
let renderScheduled = false;

function scheduleRender(doc) {
  renderQueue.add(doc);
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(async () => {
    renderScheduled = false;
    const batch = [...renderQueue];
    renderQueue.clear();
    for (const d of batch) {
      const version = d.version;
      const baseDir = dirName(d.path);
      const html = await invoke("render_markdown", { text: d.text, baseDir });
      if (d.version !== version || dirName(d.path) !== baseDir) continue; // modifié entre-temps : un autre rendu arrive
      d.html = html;
      d.htmlVersion = version;
      groupsShowing(d).forEach((g) => setPreview(g, html, { follow: true }));
    }
  });
}

/** Affiche le HTML dans l'aperçu d'un panneau, puis l'enrichit (code, formules, schémas). */
function setPreview(g, html, { follow = false } = {}) {
  g.preview.innerHTML = html;
  g.anchors = null;
  const relayout = () => {
    g.anchors = null;
    if (follow && g.mode === "split") syncScroll(g, "editor");
    if (g === focused) scheduleOutline();
  };
  relayout();
  window.enhancePreview(g.preview, theme()).then(() => {
    if (g.preview.innerHTML) relayout();
  });
}

function showPreview(g, scrollTop = 0) {
  const doc = activeDoc(g);
  if (doc.htmlVersion === doc.version) setPreview(g, doc.html);
  else scheduleRender(doc);
  requestAnimationFrame(() => (g.previewPane.scrollTop = scrollTop));
}

/** Rendu à refaire partout (changement de thème : les schémas changent de couleurs). */
function rerenderAll() {
  groups.forEach((g) => {
    const doc = activeDoc(g);
    if (doc?.htmlVersion === doc?.version) setPreview(g, doc.html);
  });
}

// ====================================================================
// Défilement synchronisé, calé sur les blocs (titres, paragraphes…)
// Rust indique la ligne source de chaque bloc (data-line) ; on mesure la
// position de cette ligne dans l'éditeur et celle du bloc dans l'aperçu.
// ====================================================================

/** Index des nœuds texte du calque coloré, pour convertir une position du texte en point du DOM. */
function textIndex(g) {
  if (g.textIndex) return g.textIndex;
  const nodes = [];
  const starts = [];
  const walker = document.createTreeWalker(g.hlCode, NodeFilter.SHOW_TEXT);
  let pos = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n);
    starts.push(pos);
    pos += n.data.length;
  }
  return (g.textIndex = { nodes, starts, length: pos });
}
function domPoint(g, offset) {
  const { nodes, starts } = textIndex(g);
  if (!nodes.length) return null;
  let lo = 0, hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { node: nodes[lo], offset: Math.min(offset - starts[lo], nodes[lo].data.length) };
}
function domRange(g, start, end = start) {
  const a = domPoint(g, start), b = domPoint(g, end);
  if (!a || !b) return null;
  const r = document.createRange();
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset);
  return r;
}
/** Position verticale (dans le contenu de l'éditeur) du caractère n° offset. */
function editorY(g, offset) {
  const r = domRange(g, offset, Math.min(offset + 1, textIndex(g).length));
  if (!r) return 0;
  const rect = r.getClientRects()[0] || r.getBoundingClientRect();
  return rect.top - g.hl.getBoundingClientRect().top + g.hl.scrollTop;
}
function lineStart(text, line) {
  let pos = 0;
  for (let i = 0; i < line && pos >= 0; i++) {
    pos = text.indexOf("\n", pos);
    if (pos >= 0) pos++;
  }
  return pos < 0 ? text.length : pos;
}
const lineOfOffset = (text, offset) => {
  let n = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) n++;
  return n;
};

function computeAnchors(g) {
  const text = g.editor.value;
  const paneTop = g.previewPane.getBoundingClientRect().top - g.previewPane.scrollTop;
  const anchors = [{ e: 0, p: 0 }];
  let line = 0, pos = 0;
  for (const el of g.preview.children) {
    const target = Number(el.dataset.line);
    if (!el.dataset.line || target < line) continue;
    // Avance de ligne en ligne (les blocs sont dans l'ordre du texte)
    while (line < target && pos >= 0) {
      pos = text.indexOf("\n", pos);
      if (pos >= 0) pos++;
      line++;
    }
    if (pos < 0) break;
    const e = editorY(g, pos);
    const p = el.getBoundingClientRect().top - paneTop;
    const last = anchors[anchors.length - 1];
    if (e >= last.e && p >= last.p) anchors.push({ e, p });
  }
  anchors.push({ e: g.editor.scrollHeight, p: g.previewPane.scrollHeight });
  return anchors;
}

function syncScroll(g, from) {
  if (g.mode !== "split" || !g.preview.firstChild) return;
  const anchors = (g.anchors ??= computeAnchors(g));
  const [src, dst, a, b] = from === "editor" ? [g.editor, g.previewPane, "e", "p"] : [g.previewPane, g.editor, "p", "e"];
  const s = src.scrollTop;
  let i = anchors.length - 2;
  while (i > 0 && anchors[i][a] > s) i--;
  const A = anchors[i], B = anchors[i + 1];
  const t = B[a] > A[a] ? Math.min(1, (s - A[a]) / (B[a] - A[a])) : 0;
  setScroll(g, dst, A[b] + t * (B[b] - A[b]));
}

/** Défilement programmé : l'événement « scroll » qu'il provoque ne doit pas renvoyer la balle. */
function setScroll(g, el, v) {
  v = Math.round(Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight)));
  if (Math.abs(el.scrollTop - v) < 1) return;
  g.ignoreScroll.set(el, v);
  el.scrollTop = v;
}
function isEcho(g, el) {
  const v = g.ignoreScroll.get(el);
  g.ignoreScroll.delete(el);
  return v !== undefined && Math.abs(el.scrollTop - v) <= 1;
}

// ====================================================================
// Barre d'outils / état / titre
// ====================================================================
function updateChrome() {
  const doc = activeDoc();
  if (!doc) return;
  const dirty = isDirty(doc);
  $("filename").textContent = docName(doc);
  $("filename").title = doc.path || "";
  $("dirty").hidden = !dirty;
  document.querySelectorAll(".segmented button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === focused.mode)
  );
  $("btn-split").classList.toggle("on", groups.length > 1);
  $("btn-split").title = groups.length > 1 ? "Fermer la vue fractionnée (Ctrl+\\)" : "Fractionner la vue (Ctrl+\\)";
  appWindow.setTitle(`${dirty ? "• " : ""}${docName(doc)} - Éditeur Markdown`);
  updateStats();
  scheduleSessionSave();
}

function updateStats() {
  const t = activeDoc()?.text ?? "";
  const words = (t.match(/\S+/g) || []).length;
  const lines = t ? t.split("\n").length : 0;
  const tabs = docs.size;
  $("stats").textContent =
    `${tabs} document${tabs > 1 ? "s" : ""}   ·   ${words} mots   ·   ${lines} lignes   ·   ${[...t].length} caractères`;
}

const status = (msg) => ($("status").textContent = msg);

// ====================================================================
// Fichiers
// ====================================================================
/** Ouvre un fichier déjà lu ; réutilise l'onglet s'il est déjà ouvert. */
function openLoaded(file, g = focused) {
  addRecent(file.path);
  for (const doc of docs.values()) {
    if (samePath(doc.path, file.path)) {
      openInGroup(doc, g);
      return doc;
    }
  }
  // Remplace l'onglet de bienvenue / vide s'il n'a pas été touché
  const current = activeDoc(g);
  const replace = current && !current.path && !isDirty(current) && (current.pristine || current.text === "") && g.tabs.length === 1
    && !groups.some((x) => x !== g && x.tabs.includes(current.id));

  const doc = createDoc(file.content, file.path, { mtime: file.mtime });
  openInGroup(doc, g);
  if (replace) {
    g.tabs.splice(g.tabs.indexOf(current.id), 1);
    g.views.delete(current.id);
    docs.delete(current.id);
    renderTabs(g);
    updateChrome();
  }
  status(`Ouvert : ${file.path}`);
  return doc;
}

async function openPaths(paths, g = focused) {
  for (const path of paths) {
    try {
      openLoaded(await invoke("read_file", { path }), g);
    } catch (e) {
      status(String(e));
    }
  }
}

async function openDialog() {
  try {
    const f = await invoke("open_file");
    if (f) openLoaded(f);
  } catch (e) {
    status(String(e));
  }
}

/** Enregistre un document. Renvoie true si c'est fait, false si annulé / erreur. */
async function saveDoc(doc, saveAs = false) {
  const content = doc.text;
  const oldDir = dirName(doc.path);
  doc.saving = true;
  try {
    const saved = await invoke("save_file", {
      path: saveAs ? null : doc.path,
      content,
      suggestedName: doc.path ? docName(doc) : "document.md",
    });
    if (!saved) return false;
    doc.path = saved.path;
    doc.mtime = saved.mtime;
    doc.savedText = content;
    doc.pristine = false;
    addRecent(saved.path);
    if (dirName(saved.path) !== oldDir) {
      doc.htmlVersion = -1; // les images relatives dépendent du dossier
      scheduleRender(doc);
    }
    renderAllTabs();
    updateChrome();
    status(`Enregistré : ${saved.path}`);
    return true;
  } catch (e) {
    status(String(e));
    return false;
  } finally {
    doc.saving = false;
  }
}

// ====================================================================
// Boîte de dialogue générique
// ====================================================================
const confirmDialog = $("confirm");
/** buttons : [{ value, label, primary? }] ; renvoie la valeur choisie ("cancel" avec Échap). */
function askChoice(title, text, buttons) {
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("confirm-actions").replaceChildren(
    ...buttons.map((b) => {
      const el = document.createElement("button");
      el.value = b.value;
      el.textContent = b.label;
      el.className = b.primary ? "btn-primary" : "btn-ghost";
      if (b.primary) el.autofocus = true;
      return el;
    })
  );
  confirmDialog.returnValue = "cancel";
  confirmDialog.showModal();
  return new Promise((resolve) =>
    confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue || "cancel"), { once: true })
  );
}
function askSave(doc) {
  return askChoice("Enregistrer les modifications ?", `« ${docName(doc)} » contient des modifications non enregistrées.`, [
    { value: "cancel", label: "Annuler" },
    { value: "discard", label: "Ne pas enregistrer" },
    { value: "save", label: "Enregistrer", primary: true },
  ]);
}

// ====================================================================
// Vue fractionnée
// ====================================================================
function toggleSplit() {
  if (groups.length === 1) {
    const doc = activeDoc();
    const g2 = createGroup(focused.mode === "split" ? "preview" : focused.mode);
    openInGroup(doc, g2);
    status("Vue fractionnée : chaque panneau a ses propres onglets");
  } else {
    // Fusionne le second panneau dans le premier
    const [g1, g2] = groups;
    saveView(g2);
    for (const id of g2.tabs) if (!g1.tabs.includes(id)) g1.tabs.push(id);
    const keep = focused === g2 ? g2.active : g1.active;
    removeGroup(g2);
    activate(g1, keep);
  }
  updateChrome();
}

// ====================================================================
// Aides à l'écriture : gras, italique, lien, listes, indentation
// ====================================================================
/** Remplace [start, end) par `text` via insertText : garde l'annulation (Ctrl+Z) native. */
function replaceRange(ed, start, end, text) {
  ed.setSelectionRange(start, end);
  if (text) document.execCommand("insertText", false, text);
  else if (start !== end) document.execCommand("delete");
}

function wrapSelection(ed, before, after = before, placeholder = "texte") {
  const { selectionStart: s, selectionEnd: e, value } = ed;
  const sel = value.slice(s, e);
  // Déjà entouré : on retire les marqueurs
  if (value.slice(s - before.length, s) === before && value.slice(e, e + after.length) === after
      && !(before === "*" && value[s - 2] === "*" && value[e + 1] === "*" && value.slice(s - 3, s) !== "***")) {
    replaceRange(ed, s - before.length, e + after.length, sel);
    ed.setSelectionRange(s - before.length, e - before.length);
    return;
  }
  const inner = sel || placeholder;
  replaceRange(ed, s, e, before + inner + after);
  ed.setSelectionRange(s + before.length, s + before.length + inner.length);
}

function insertLink(ed) {
  const { selectionStart: s, selectionEnd: e, value } = ed;
  const sel = value.slice(s, e);
  if (/^(https?:\/\/|mailto:)\S+$/i.test(sel)) {
    replaceRange(ed, s, e, `[texte](${sel})`);
    ed.setSelectionRange(s + 1, s + 6);
  } else {
    const label = sel || "texte";
    replaceRange(ed, s, e, `[${label}](https://)`);
    const urlStart = s + label.length + 3;
    ed.setSelectionRange(urlStart, urlStart + 8);
  }
}

const LIST_RE = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;
const QUOTE_RE = /^\s*(?:>\s?)+/;

function insideFence(text, upTo) {
  let open = false;
  for (const m of text.slice(0, upTo).matchAll(/^\s{0,3}(```|~~~)/gm)) open = !open;
  return open;
}

/** Entrée : continue la liste / la citation, ou la termine sur un élément vide. */
function smartEnter(ed) {
  const { selectionStart: s, selectionEnd: e, value } = ed;
  if (s !== e) return false;
  const ls = value.lastIndexOf("\n", s - 1) + 1;
  let le = value.indexOf("\n", s);
  if (le < 0) le = value.length;
  const before = value.slice(ls, s);
  const after = value.slice(s, le);
  if (insideFence(value, ls)) {
    const indent = before.match(/^\s*/)[0];
    if (!indent) return false;
    replaceRange(ed, s, s, "\n" + indent);
    return true;
  }
  let m = LIST_RE.exec(before);
  if (m) {
    if (!before.slice(m[0].length).trim() && !after.trim()) {
      replaceRange(ed, ls, le, ""); // élément vide : fin de liste
      return true;
    }
    const marker = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2];
    replaceRange(ed, s, s, "\n" + m[1] + marker + m[5] + (m[6] ? "[ ] " : ""));
    return true;
  }
  m = QUOTE_RE.exec(before);
  if (m) {
    if (!before.slice(m[0].length).trim() && !after.trim()) {
      replaceRange(ed, ls, le, "");
      return true;
    }
    replaceRange(ed, s, s, "\n" + m[0]);
    return true;
  }
  const indent = before.match(/^\s*/)[0];
  if (indent && before.trim()) {
    replaceRange(ed, s, s, "\n" + indent);
    return true;
  }
  return false;
}

/** Tab / Maj+Tab : indente ou désindente (plusieurs lignes, ou un élément de liste). */
function indent(ed, outdent) {
  const { selectionStart: s, selectionEnd: e, value } = ed;
  const ls = value.lastIndexOf("\n", s - 1) + 1;
  const multi = value.slice(s, e).includes("\n");
  const onListItem = LIST_RE.test(value.slice(ls, value.indexOf("\n", ls) >>> 0));
  if (!outdent && !multi && !onListItem) {
    replaceRange(ed, s, e, "    ");
    return;
  }
  let le = value.indexOf("\n", e - (e > s && value[e - 1] === "\n" ? 1 : 0));
  if (le < 0) le = value.length;
  const lines = value.slice(ls, le).split("\n");
  let firstDelta = 0, total = 0;
  const out = lines.map((l, i) => {
    let res;
    if (outdent) {
      const n = l.match(/^( {1,4}|\t)?/)[0].length;
      res = l.slice(n);
    } else {
      res = l ? "    " + l : l;
    }
    const d = res.length - l.length;
    if (i === 0) firstDelta = d;
    total += d;
    return res;
  });
  const text = out.join("\n");
  if (text === value.slice(ls, le)) return;
  replaceRange(ed, ls, le, text);
  ed.setSelectionRange(Math.max(ls, s + firstDelta), Math.max(ls, e + total));
}

// ====================================================================
// Rechercher / remplacer
// ====================================================================
const find = { open: false, g: null, matches: [], current: -1, caseSensitive: false, replace: false };
const findBar = $("findbar");
const findInput = $("find-input");
const replaceInput = $("replace-input");
const hasHighlights = typeof CSS !== "undefined" && "highlights" in CSS;

function openFind(withReplace = false) {
  const g = focused;
  if (g.mode === "preview") setMode(g, "split");
  if (find.g && find.g !== g) clearFindMarks();
  find.g = g;
  find.open = true;
  find.replace = withReplace || (find.replace && findBar.isConnected && !findBar.hidden);
  g.editorPane.appendChild(findBar);
  findBar.hidden = false;
  findBar.classList.toggle("with-replace", find.replace);
  const { selectionStart: s, selectionEnd: e, value } = g.editor;
  const sel = value.slice(s, e);
  if (sel && !sel.includes("\n")) findInput.value = sel;
  refreshFind({ from: s });
  (withReplace && findInput.value ? replaceInput : findInput).focus();
  (withReplace && findInput.value ? replaceInput : findInput).select();
}

function closeFind() {
  if (!find.open) return;
  find.open = false;
  findBar.hidden = true;
  clearFindMarks();
  const g = find.g;
  const m = find.matches[find.current];
  if (g && m != null) g.editor.setSelectionRange(m, m + findInput.value.length);
  g?.editor.focus({ preventScroll: true });
}

function clearFindMarks() {
  if (!hasHighlights) return;
  CSS.highlights.delete("find-match");
  CSS.highlights.delete("find-current");
}

function computeMatches(text, q) {
  const out = [];
  if (!q) return out;
  const hay = find.caseSensitive ? text : text.toLowerCase();
  const needle = find.caseSensitive ? q : q.toLowerCase();
  for (let i = hay.indexOf(needle); i >= 0 && out.length < 10000; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/** Recalcule les résultats ; `from` = position à partir de laquelle choisir le résultat courant. */
function refreshFind({ from = null, keepCurrent = false } = {}) {
  const g = find.g;
  if (!g) return;
  const q = findInput.value;
  const prev = find.matches[find.current];
  find.matches = computeMatches(g.editor.value, q);
  if (!find.matches.length) find.current = -1;
  else {
    const pos = from ?? (keepCurrent && prev != null ? prev : g.editor.selectionStart);
    const i = find.matches.findIndex((m) => m >= pos);
    find.current = i < 0 ? 0 : i;
  }
  paintFind();
  if (!keepCurrent) revealMatch();
}

function paintFind() {
  const g = find.g;
  const n = find.matches.length;
  const q = findInput.value;
  $("find-count").textContent = q ? (n ? `${find.current + 1} / ${n}${n >= 10000 ? "+" : ""}` : "Aucun résultat") : "";
  findBar.classList.toggle("no-match", !!q && !n);
  if (!hasHighlights) return;
  const all = new Highlight();
  const cur = new Highlight();
  find.matches.forEach((m, i) => {
    const r = domRange(g, m, m + q.length);
    if (r) (i === find.current ? cur : all).add(r);
  });
  CSS.highlights.set("find-match", all);
  CSS.highlights.set("find-current", cur);
}

function revealMatch() {
  const g = find.g;
  const m = find.matches[find.current];
  if (m == null) return;
  const y = editorY(g, m);
  const ed = g.editor;
  if (y < ed.scrollTop + 30 || y > ed.scrollTop + ed.clientHeight - 60) ed.scrollTop = y - ed.clientHeight / 3;
}

function stepFind(dir) {
  const n = find.matches.length;
  if (!n) return;
  find.current = (find.current + dir + n) % n;
  paintFind();
  revealMatch();
}

function replaceCurrent() {
  const g = find.g;
  const m = find.matches[find.current];
  if (m == null) return;
  const q = findInput.value;
  const by = replaceInput.value;
  const ed = g.editor;
  const scroll = ed.scrollTop;
  ed.focus({ preventScroll: true });
  replaceRange(ed, m, m + q.length, by);
  ed.scrollTop = scroll;
  refreshFind({ from: m + by.length });
  replaceInput.focus();
}

function replaceAll() {
  const g = find.g;
  const q = findInput.value;
  const n = find.matches.length;
  if (!n) return;
  const by = replaceInput.value;
  const ed = g.editor;
  const text = ed.value;
  let out = "", last = 0;
  for (const m of find.matches) {
    out += text.slice(last, m) + by;
    last = m + q.length;
  }
  out += text.slice(last);
  const scroll = ed.scrollTop;
  ed.focus({ preventScroll: true });
  replaceRange(ed, 0, text.length, out); // une seule étape d'annulation
  ed.setSelectionRange(0, 0);
  ed.scrollTop = scroll;
  refreshFind({ from: 0, keepCurrent: true });
  status(`${n} remplacement${n > 1 ? "s" : ""}`);
  replaceInput.focus();
}

findInput.addEventListener("input", () => refreshFind({ from: find.g?.editor.selectionStart ?? 0 }));
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    stepFind(e.shiftKey ? -1 : 1);
  }
});
replaceInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.ctrlKey && e.altKey) replaceAll();
    else replaceCurrent();
  }
});
findBar.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeFind();
  }
});
$("find-prev").onclick = () => stepFind(-1);
$("find-next").onclick = () => stepFind(1);
$("find-close").onclick = closeFind;
$("find-case").onclick = () => {
  find.caseSensitive = !find.caseSensitive;
  $("find-case").classList.toggle("on", find.caseSensitive);
  refreshFind();
};
$("find-toggle").onclick = () => {
  find.replace = !find.replace;
  findBar.classList.toggle("with-replace", find.replace);
  (find.replace ? replaceInput : findInput).focus();
};
$("replace-one").onclick = replaceCurrent;
$("replace-all").onclick = replaceAll;

// ====================================================================
// Plan du document
// ====================================================================
const outlineEl = $("outline");
const outlineList = $("outline-list");
let outlineHeadings = [];
let outlineScheduled = false;

function setOutline(show) {
  outlineEl.hidden = !show;
  $("btn-outline").classList.toggle("on", show);
  savePref("outline", show ? "1" : "0");
  groups.forEach((g) => (g.anchors = null));
  scheduleOutline();
}

function scheduleOutline() {
  if (outlineEl.hidden || outlineScheduled) return;
  outlineScheduled = true;
  requestAnimationFrame(() => {
    outlineScheduled = false;
    buildOutline();
  });
}

function buildOutline() {
  const g = focused;
  if (!g) return;
  outlineHeadings = [...g.preview.querySelectorAll("h1, h2, h3, h4, h5, h6")];
  if (!outlineHeadings.length) {
    outlineList.innerHTML = '<p class="outline-empty">Aucun titre. Commence une ligne par <code>#</code>.</p>';
    return;
  }
  const min = Math.min(...outlineHeadings.map((h) => Number(h.tagName[1])));
  outlineList.replaceChildren(
    ...outlineHeadings.map((h, i) => {
      const b = document.createElement("button");
      b.className = "outline-item";
      b.style.setProperty("--lvl", Number(h.tagName[1]) - min);
      b.textContent = h.textContent;
      b.title = h.textContent;
      b.dataset.i = i;
      return b;
    })
  );
  highlightOutline();
}

function highlightOutline() {
  if (outlineEl.hidden || !outlineHeadings.length) return;
  const g = focused;
  let idx = 0;
  if (g.mode !== "edit") {
    const top = g.previewPane.getBoundingClientRect().top + 40;
    outlineHeadings.forEach((h, i) => { if (h.getBoundingClientRect().top <= top) idx = i; });
  } else {
    const text = g.editor.value;
    const y = g.editor.scrollTop + 40;
    outlineHeadings.forEach((h, i) => {
      const line = h.closest("[data-line]")?.dataset.line;
      if (line != null && editorY(g, lineStart(text, Number(line))) <= y) idx = i;
    });
  }
  outlineList.querySelectorAll(".outline-item").forEach((b, i) => b.classList.toggle("active", i === idx));
  outlineList.querySelector(".outline-item.active")?.scrollIntoView({ block: "nearest" });
}

outlineList.addEventListener("click", (e) => {
  const b = e.target.closest(".outline-item");
  if (!b) return;
  const g = focused;
  const h = outlineHeadings[Number(b.dataset.i)];
  if (!h) return;
  const line = h.closest("[data-line]")?.dataset.line;
  if (g.mode !== "preview" && line != null) {
    const pos = lineStart(g.editor.value, Number(line));
    g.editor.focus({ preventScroll: true });
    g.editor.setSelectionRange(pos, pos);
    g.editor.scrollTop = editorY(g, pos) - 24;
  }
  if (g.mode === "preview") {
    g.previewPane.scrollTop += h.getBoundingClientRect().top - g.previewPane.getBoundingClientRect().top - 24;
  }
});

// ====================================================================
// Événements d'un panneau
// ====================================================================
function wireGroup(g) {
  g.el.addEventListener("pointerdown", () => setFocus(g), true);
  g.el.addEventListener("focusin", () => setFocus(g));

  // Onglets : clic = activer, croix / clic molette = fermer
  g.tabsEl.addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    const id = Number(tab.dataset.id);
    if (e.target.closest(".tab-close")) closeTab(g, id);
    else activate(g, id);
  });
  g.tabsEl.addEventListener("auxclick", (e) => {
    const tab = e.target.closest(".tab");
    if (tab && e.button === 1) closeTab(g, Number(tab.dataset.id));
  });
  g.tabsEl.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault()); // pas d'autoscroll
  g.tabsEl.addEventListener("wheel", (e) => {
    g.tabsEl.scrollLeft += e.deltaY;
  }, { passive: true });
  g.el.querySelector(".tab-new").addEventListener("click", () => openInGroup(createDoc(), g));

  // Saisie
  g.editor.addEventListener("input", () => {
    const doc = activeDoc(g);
    const wasDirty = isDirty(doc);
    doc.text = g.editor.value;
    doc.version++;
    doc.pristine = false;
    paint(g);
    // Même document affiché dans l'autre panneau : on le garde synchronisé
    for (const other of groupsShowing(doc)) {
      if (other === g) continue;
      const { selectionStart: s, selectionEnd: e, scrollTop } = other.editor;
      other.editor.value = doc.text;
      other.editor.setSelectionRange(s, e);
      other.editor.scrollTop = scrollTop;
      paint(other);
    }
    scheduleRender(doc);
    if (wasDirty !== isDirty(doc)) renderAllTabs();
    updateChrome();
  });

  // Raccourcis d'écriture
  g.editor.addEventListener("keydown", (e) => {
    const ed = g.editor;
    if (e.isComposing) return;
    if (e.ctrlKey && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      const act = { b: () => wrapSelection(ed, "**"), i: () => wrapSelection(ed, "*"), e: () => wrapSelection(ed, "`", "`", "code"), k: () => insertLink(ed) }[k];
      if (act) {
        e.preventDefault();
        act();
      }
      return;
    }
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      indent(ed, e.shiftKey);
    } else if (e.key === "Enter" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (smartEnter(ed)) e.preventDefault();
    }
  });

  // Le calque coloré suit la largeur utile du textarea (sans sa barre de défilement)
  new ResizeObserver(() => {
    g.hl.style.width = g.editor.clientWidth + "px";
    syncLayer(g);
    g.anchors = null;
    g.textIndex = null;
  }).observe(g.editor);
  new ResizeObserver(() => (g.anchors = null)).observe(g.previewPane);
  // Une image qui finit de charger décale l'aperçu
  g.preview.addEventListener("load", () => {
    g.anchors = null;
    if (g.mode === "split") syncScroll(g, "editor");
  }, true);

  // Défilement synchronisé éditeur ⇄ aperçu
  g.editor.addEventListener("scroll", () => {
    syncLayer(g);
    if (!isEcho(g, g.editor)) syncScroll(g, "editor");
    if (g === focused) requestAnimationFrame(highlightOutline);
  }, { passive: true });
  g.previewPane.addEventListener("scroll", () => {
    if (!isEcho(g, g.previewPane)) syncScroll(g, "preview");
    if (g === focused) requestAnimationFrame(highlightOutline);
  }, { passive: true });

  // Séparateur éditeur / aperçu
  const divider = g.el.querySelector(".divider");
  divider.addEventListener("pointerdown", (e) => {
    divider.setPointerCapture(e.pointerId);
    divider.classList.add("dragging");
    const rect = g.body.getBoundingClientRect();
    const move = (ev) => {
      const pct = Math.min(80, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100));
      g.body.style.setProperty("--split", pct + "%");
    };
    const up = () => {
      divider.classList.remove("dragging");
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
  });
}

// ====================================================================
// Glisser-déposer de fichiers (événement natif Tauri : on reçoit les chemins)
// ====================================================================
let dropTarget = null;
function groupAt(position) {
  // La position est en pixels physiques : on la convertit en pixels CSS
  const x = position.x / window.devicePixelRatio;
  const y = position.y / window.devicePixelRatio;
  const el = document.elementFromPoint(x, y)?.closest(".group");
  return groups.find((g) => g.el === el) || focused;
}
function setDropTarget(g) {
  if (dropTarget === g) return;
  dropTarget?.el.classList.remove("drop-target");
  dropTarget = g;
  g?.el.classList.add("drop-target");
}

webview.onDragDropEvent((event) => {
  const p = event.payload;
  if (p.type === "enter" || p.type === "over") {
    setDropTarget(groupAt(p.position));
  } else if (p.type === "drop") {
    const g = groupAt(p.position);
    setDropTarget(null);
    if (p.paths?.length) openPaths(p.paths, g);
  } else {
    setDropTarget(null);
  }
});

// ====================================================================
// Fichiers modifiés par un autre programme
// ====================================================================
let checkingExternal = false;
async function checkExternalChanges() {
  if (checkingExternal || confirmDialog.open) return;
  const list = [...docs.values()].filter((d) => d.path && !d.saving);
  if (!list.length) return;
  checkingExternal = true;
  try {
    const mtimes = await invoke("file_mtimes", { paths: list.map((d) => d.path) });
    for (let i = 0; i < list.length; i++) {
      const doc = list[i];
      const mtime = mtimes[i];
      if (!docs.has(doc.id) || doc.saving) continue;
      if (mtime == null) {
        if (!doc.missing) status(`Fichier supprimé ou déplacé : ${doc.path}`);
        doc.missing = true;
        continue;
      }
      doc.missing = false;
      if (doc.mtime == null || mtime === doc.mtime) {
        doc.mtime = mtime;
        continue;
      }
      let file;
      try {
        file = await invoke("read_file", { path: doc.path });
      } catch {
        continue;
      }
      doc.mtime = file.mtime;
      if (file.content === doc.savedText) continue; // date changée, contenu identique
      if (isDirty(doc)) {
        const g = groups.find((x) => x.tabs.includes(doc.id));
        if (g) activate(g, doc.id, { focusEditor: false });
        const answer = await askChoice(
          "Fichier modifié ailleurs",
          `« ${docName(doc)} » a été modifié par un autre programme, et tu as des modifications non enregistrées ici.`,
          [
            { value: "keep", label: "Garder ma version" },
            { value: "reload", label: "Recharger depuis le disque", primary: true },
          ]
        );
        if (answer !== "reload") {
          doc.savedText = file.content; // la version disque devient la référence (onglet toujours « modifié »)
          renderAllTabs();
          updateChrome();
          continue;
        }
      }
      reloadDoc(doc, file.content);
      status(`Rechargé (modifié par un autre programme) : ${doc.path}`);
    }
  } catch (e) {
    console.error(e);
  } finally {
    checkingExternal = false;
  }
}

function reloadDoc(doc, content) {
  doc.text = doc.savedText = content;
  doc.version++;
  for (const g of groupsShowing(doc)) {
    const { selectionStart: s, selectionEnd: e, scrollTop } = g.editor;
    g.editor.value = content;
    g.editor.setSelectionRange(Math.min(s, content.length), Math.min(e, content.length));
    g.editor.scrollTop = scrollTop;
    paint(g);
  }
  scheduleRender(doc);
  renderAllTabs();
  updateChrome();
}

window.addEventListener("focus", checkExternalChanges);
setInterval(() => document.visibilityState === "visible" && checkExternalChanges(), 4000);

// ====================================================================
// Session : onglets, brouillons, fichiers récents
// ====================================================================
let sessionReady = false;
let sessionTimer = null;
let recent = [];

function addRecent(path) {
  recent = [path, ...recent.filter((p) => !samePath(p, path))].slice(0, 12);
  scheduleSessionSave();
}

function serializeSession({ final = false } = {}) {
  groups.forEach(saveView);
  const ids = [];
  const docList = [];
  for (const g of groups) {
    for (const id of g.tabs) {
      if (ids.includes(id)) continue;
      const doc = docs.get(id);
      const entry = { path: doc.path };
      const keepDraft = !(final && doc.discarded);
      if (!doc.path && doc.pristine && doc.text === WELCOME) entry.welcome = true;
      else if ((!doc.path || isDirty(doc)) && keepDraft) entry.text = doc.text;
      if (!doc.path && !entry.text && !entry.welcome) continue; // onglet vide ou abandonné
      ids.push(id);
      docList.push(entry);
    }
  }
  const index = (id) => ids.indexOf(id);
  const groupList = groups
    .map((g) => ({
      mode: g.mode,
      tabs: g.tabs.map(index).filter((i) => i >= 0),
      active: index(g.active),
      views: Object.fromEntries(g.tabs.filter((id) => index(id) >= 0 && g.views.has(id)).map((id) => [index(id), g.views.get(id)])),
      focused: g === focused,
    }))
    .filter((g) => g.tabs.length);
  return JSON.stringify({ version: 1, docs: docList, groups: groupList, recent });
}

function scheduleSessionSave() {
  if (!sessionReady) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => invoke("save_session", { data: serializeSession() }).catch(console.error), 800);
}

async function restoreSession(data) {
  if (!data || data.version !== 1) return false;
  recent = Array.isArray(data.recent) ? data.recent : [];
  const restored = await Promise.all(
    (data.docs || []).map(async (d) => {
      if (d.welcome) return createDoc(WELCOME, null, { pristine: true });
      if (!d.path) return createDoc(d.text ?? "", null, { savedText: "" });
      try {
        const f = await invoke("read_file", { path: d.path });
        return createDoc(d.text ?? f.content, f.path, { savedText: f.content, mtime: f.mtime });
      } catch {
        // Fichier disparu : on garde le brouillon s'il y en a un, sinon on oublie l'onglet
        return d.text != null ? createDoc(d.text, d.path, { savedText: "" }) : null;
      }
    })
  );
  let toFocus = null;
  for (const sg of data.groups || []) {
    const tabs = sg.tabs.map((i) => restored[i]).filter(Boolean);
    if (!tabs.length || groups.length >= 2) continue;
    const g = createGroup(["edit", "split", "preview"].includes(sg.mode) ? sg.mode : "split");
    g.tabs = tabs.map((d) => d.id);
    for (const [i, v] of Object.entries(sg.views || {})) if (restored[i]) g.views.set(restored[i].id, v);
    const active = restored[sg.active] && g.tabs.includes(restored[sg.active].id) ? restored[sg.active].id : g.tabs[0];
    if (!focused) setFocus(g);
    activate(g, active, { focusEditor: false });
    if (sg.focused) toFocus = g;
  }
  // Documents restaurés mais dans aucun panneau : inutiles
  for (const d of restored) if (d && !isReferenced(d)) docs.delete(d.id);
  if (!groups.length) return false;
  if (toFocus) setFocus(toFocus);
  activate(focused, focused.active);
  return true;
}

// ====================================================================
// Fermeture de la fenêtre : on propose d'enregistrer, puis on mémorise la session
// ====================================================================
appWindow.onCloseRequested(async (event) => {
  event.preventDefault();
  const dirty = [...docs.values()].filter(isDirty);
  for (const doc of dirty) {
    const g = groups.find((x) => x.tabs.includes(doc.id));
    if (g) activate(g, doc.id, { focusEditor: false });
    const answer = await askSave(doc);
    if (answer === "cancel") {
      dirty.forEach((d) => (d.discarded = false));
      return;
    }
    if (answer === "save" && !(await saveDoc(doc))) return;
    if (answer === "discard") doc.discarded = true;
  }
  clearTimeout(sessionTimer);
  try {
    await invoke("save_session", { data: serializeSession({ final: true }) });
  } catch (e) {
    console.error(e);
  }
  await appWindow.destroy();
});

// ====================================================================
// Export HTML / PDF
// ====================================================================
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Page HTML autonome du document (styles inclus). */
async function buildExportHtml(doc) {
    // Rendu sans dossier de base : les images gardent leurs chemins relatifs d'origine
    const body = await invoke("render_markdown", { text: doc.text, baseDir: null });
    const article = document.createElement("article");
    article.className = "markdown";
    article.innerHTML = body;
    const holder = document.createElement("div");
    holder.style.cssText = "position:fixed;left:-10000px;top:0;width:800px";
    holder.appendChild(article);
    document.body.appendChild(holder);
    await window.enhancePreview(article, "light");
    holder.remove();
    article.querySelectorAll("[data-line]").forEach((el) => el.removeAttribute("data-line"));

    const css = await (await fetch("style.css")).text();
    const katex = article.querySelector(".katex")
      ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">\n'
      : "";
    const title = article.querySelector("h1")?.textContent || docName(doc).replace(/\.[^.]+$/, "");
    const html = `<!doctype html>
<html lang="fr" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${katex}<style>
${css}
/* Page exportée */
html, body { height: auto; }
body.export { display: block; overflow: auto; user-select: text; padding: 40px 16px; }
body.export .markdown { background: var(--surface); border-radius: var(--radius-cards); box-shadow: var(--shadow-xl); }
@media print { body.export { padding: 0; background: #fff; } body.export .markdown { box-shadow: none; } }
</style>
</head>
<body class="export">
${article.outerHTML}
</body>
</html>
`;
    return html;
}

async function exportHtml() {
  const doc = activeDoc();
  try {
    const html = await buildExportHtml(doc);
    const base = doc.path ? docName(doc).replace(/\.[^.]+$/, "") : "document";
    const path = await invoke("save_export", { content: html, suggestedName: base + ".html" });
    if (path) status(`Exporté : ${path}`);
  } catch (e) {
    status(String(e));
  }
}

async function exportPdf() {
  const g = focused;
  const doc = activeDoc(g);
  const previous = theme();
  document.documentElement.classList.add("printing");
  if (previous !== "light") document.documentElement.dataset.theme = "light";
  try {
    // Aperçu à jour et schémas aux couleurs claires avant d'imprimer
    const html = await invoke("render_markdown", { text: doc.text, baseDir: dirName(doc.path) });
    g.preview.innerHTML = html;
    await window.enhancePreview(g.preview, "light");
    await Promise.all([...g.preview.querySelectorAll("img")].map((img) =>
      img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));
    const title = document.title;
    document.title = docName(doc).replace(/\.[^.]+$/, ""); // nom proposé pour le PDF
    status("Impression : choisis « Enregistrer au format PDF » comme imprimante");
    window.print();
    document.title = title;
  } catch (e) {
    status(String(e));
  } finally {
    document.documentElement.classList.remove("printing");
    if (previous !== "light") document.documentElement.dataset.theme = previous;
    rerenderAll();
  }
}

// ====================================================================
// Menu « Plus »
// ====================================================================
const menu = $("menu");

function renderRecent() {
  const list = $("recent-list");
  if (!recent.length) {
    list.innerHTML = '<p class="menu-empty">Aucun fichier récent</p>';
    return;
  }
  list.replaceChildren(
    ...recent.slice(0, 8).map((p) => {
      const b = document.createElement("button");
      b.setAttribute("role", "menuitem");
      b.dataset.path = p;
      b.title = p;
      b.innerHTML = `<span class="recent-name"></span><span class="recent-dir"></span>`;
      b.querySelector(".recent-name").textContent = baseName(p);
      b.querySelector(".recent-dir").textContent = dirName(p);
      return b;
    })
  );
}

function openMenu() {
  renderRecent();
  menu.hidden = false;
  const r = $("btn-more").getBoundingClientRect();
  menu.style.top = r.bottom + 8 + "px";
  menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)) + "px";
  $("btn-more").classList.add("on");
  menu.querySelector("button")?.focus();
}
function closeMenu() {
  menu.hidden = true;
  $("btn-more").classList.remove("on");
}

$("btn-more").onclick = (e) => {
  e.stopPropagation();
  menu.hidden ? openMenu() : closeMenu();
};
document.addEventListener("pointerdown", (e) => {
  if (!menu.hidden && !menu.contains(e.target) && !e.target.closest("#btn-more")) closeMenu();
});
menu.addEventListener("keydown", (e) => {
  const items = [...menu.querySelectorAll("button")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "Escape") closeMenu();
  else if (e.key === "ArrowDown") items[(i + 1) % items.length]?.focus();
  else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
  else return;
  e.preventDefault();
});
menu.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  closeMenu();
  if (b.dataset.path) {
    try {
      openLoaded(await invoke("read_file", { path: b.dataset.path }));
    } catch (err) {
      recent = recent.filter((p) => p !== b.dataset.path);
      scheduleSessionSave();
      status(String(err));
    }
    return;
  }
  ({
    find: () => openFind(false),
    replace: () => openFind(true),
    "export-html": exportHtml,
    "export-pdf": exportPdf,
  })[b.dataset.cmd]?.();
});

// ====================================================================
// Barre d'outils et raccourcis
// ====================================================================
function setTheme(t) {
  const changed = theme() !== t;
  document.documentElement.dataset.theme = t;
  savePref("ui-theme", t);
  if (changed) rerenderAll();
}

$("btn-open").onclick = openDialog;
$("btn-save").onclick = () => saveDoc(activeDoc(), false);
$("btn-save-as").onclick = () => saveDoc(activeDoc(), true);
$("btn-split").onclick = toggleSplit;
$("btn-outline").onclick = () => setOutline(outlineEl.hidden);
$("outline-close").onclick = () => {
  setOutline(false);
  focused?.editor.focus({ preventScroll: true });
};
$("btn-theme").onclick = () => setTheme(theme() === "dark" ? "light" : "dark");

// ---------- Liens de l'aperçu : navigateur par défaut, ou onglet pour un .md local ----------
workspace.addEventListener("click", async (e) => {
  const a = e.target.closest(".markdown a[href]");
  if (!a) return;
  const href = a.getAttribute("href");
  if (href.startsWith("#")) return; // ancre interne (notes de bas de page) : comportement normal
  e.preventDefault();
  if (/^(https?:|mailto:)/i.test(href)) {
    invoke("open_external", { url: href })
      .then(() => status(`Ouvert dans le navigateur : ${href}`))
      .catch((err) => status(String(err)));
    return;
  }
  const g = groups.find((x) => x.el.contains(a)) || focused;
  try {
    const path = await invoke("resolve_link", { baseFile: activeDoc(g)?.path ?? null, href });
    await openPaths([path], g);
  } catch (err) {
    status(String(err));
  }
});

// ---------- Pas de rechargement ni de « page précédente » (perte des onglets) ----------
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  const reload = k === "f5" || (e.ctrlKey && k === "r");
  const back = e.altKey && (k === "arrowleft" || k === "arrowright");
  if (reload || back || k === "browserback" || k === "browserforward") e.preventDefault();
}, true);
// Boutons « précédent / suivant » de la souris
window.addEventListener("mouseup", (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); });
// Menu contextuel du navigateur (Précédent, Actualiser…) : seulement là où il sert (copier / coller)
window.addEventListener("contextmenu", (e) => {
  const editable = e.target.closest("textarea, input, [contenteditable]");
  const hasSelection = String(window.getSelection()).length > 0;
  if (!editable && !hasSelection) e.preventDefault();
});

// ---------- Boutons de fenêtre (barre de titre native désactivée) ----------
$("win-min").onclick = () => appWindow.minimize();
$("win-max").onclick = () => appWindow.toggleMaximize();
$("win-close").onclick = () => appWindow.close(); // passe par onCloseRequested (confirmation)

async function syncMaximized() {
  const max = await appWindow.isMaximized();
  document.documentElement.classList.toggle("is-maximized", max);
  $("win-max").title = $("win-max").ariaLabel = max ? "Restaurer" : "Agrandir";
}
appWindow.onResized(syncMaximized);
syncMaximized();
document.querySelectorAll(".segmented button").forEach((b) =>
  (b.onclick = () => setMode(focused, b.dataset.mode))
);

window.addEventListener("keydown", (e) => {
  if (!e.ctrlKey || e.altKey || confirmDialog.open || !focused) return;
  const k = e.key.toLowerCase();
  const actions = {
    o: () => (e.shiftKey ? setOutline(outlineEl.hidden) : openDialog()),
    s: () => saveDoc(activeDoc(), e.shiftKey),
    t: () => openInGroup(createDoc()),
    n: () => openInGroup(createDoc()),
    w: () => closeTab(focused, focused.active),
    tab: () => cycleTab(e.shiftKey ? -1 : 1),
    "\\": () => toggleSplit(),
    f: () => openFind(false),
    h: () => openFind(true),
    p: () => exportPdf(),
  };
  if (actions[k]) {
    e.preventDefault();
    closeMenu();
    actions[k]();
  }
});

// Préférences (localStorage peut être indisponible : on ne casse rien)
function loadPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

// ====================================================================
// Démarrage : session précédente, puis fichiers passés en argument
// ====================================================================
async function init() {
  setTheme(loadPref("ui-theme", "light"));
  outlineEl.hidden = loadPref("outline", "0") !== "1";
  $("btn-outline").classList.toggle("on", !outlineEl.hidden);

  let restored = false;
  try {
    const raw = await invoke("load_session");
    if (raw) restored = await restoreSession(JSON.parse(raw));
  } catch (e) {
    console.error("Session illisible", e);
  }
  if (!restored) {
    const g = createGroup();
    setFocus(g);
    openInGroup(createDoc(WELCOME, null, { pristine: true }), g);
    g.editor.setSelectionRange(0, 0);
    g.editor.scrollTop = 0;
  }

  // Double-clic sur un .md / « Ouvrir avec… » (1er lancement)
  const paths = await invoke("startup_paths").catch(() => []);
  if (paths.length) await openPaths(paths);
  // … et lancements suivants : l'instance déjà ouverte reçoit les fichiers
  await listen("open-paths", (e) => e.payload?.length && openPaths(e.payload));

  sessionReady = true;
  scheduleSessionSave();
  scheduleOutline();
}
init();
