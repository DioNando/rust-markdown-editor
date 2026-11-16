// Interface : onglets, vue fractionnée, glisser-déposer.
// Le travail « lourd » (rendu Markdown, fichiers) est fait en Rust via invoke().
const { invoke } = window.__TAURI__.core;
const appWindow = window.__TAURI__.window.getCurrentWindow();
const webview = window.__TAURI__.webview.getCurrentWebview();

const $ = (id) => document.getElementById(id);
const workspace = $("workspace");
const groupTemplate = $("group-template");

const WELCOME = `# Bienvenue

Écris du **Markdown** à gauche, l'aperçu s'affiche à droite.
Le rendu est fait en **Rust** (pulldown-cmark), l'interface en HTML/CSS.

## Nouveautés

- **Glisser-déposer** : dépose un ou plusieurs fichiers \`.md\` sur un panneau.
- **Onglets** : un onglet par document, clic molette pour fermer.
- **Vue fractionnée** : deux panneaux côte à côte, chacun avec ses onglets.

## Raccourcis

| Action | Raccourci |
|---|---|
| Nouvel onglet | \`Ctrl+T\` |
| Fermer l'onglet | \`Ctrl+W\` |
| Onglet suivant / précédent | \`Ctrl+Tab\` / \`Ctrl+Maj+Tab\` |
| Fractionner la vue | \`Ctrl+\\\` |
| Ouvrir | \`Ctrl+O\` |
| Enregistrer / sous | \`Ctrl+S\` / \`Ctrl+Maj+S\` |

- [x] Installer Rust
- [x] Version egui
- [ ] Choisir sa préférée

> Astuce : le bouton en haut à droite change de thème.
`;

// ====================================================================
// Modèle
// ====================================================================
let nextId = 1;

/** @type {Map<number, {id:number, path:string|null, text:string, savedText:string, pristine:boolean, version:number, html:string, htmlVersion:number}>} */
const docs = new Map();
/** Panneaux : chacun a ses onglets (ids de documents), son onglet actif et son mode. */
const groups = [];
let focused = null;

function createDoc(text = "", path = null, { pristine = false } = {}) {
  const doc = { id: nextId++, path, text, savedText: text, pristine, version: 0, html: "", htmlVersion: -1 };
  docs.set(doc.id, doc);
  return doc;
}

const isDirty = (doc) => doc.text !== doc.savedText;
const docName = (doc) => (doc.path ? doc.path.split(/[\\/]/).pop() : "Sans titre");
const samePath = (a, b) => a && b && a.toLowerCase() === b.toLowerCase(); // Windows : insensible à la casse
const activeDoc = (g = focused) => (g ? docs.get(g.active) : null);
const groupsShowing = (doc) => groups.filter((g) => g.active === doc.id);
const isReferenced = (doc) => groups.some((g) => g.tabs.includes(doc.id));

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
    editor: el.querySelector(".editor"),
    hl: el.querySelector(".highlight"),
    hlCode: el.querySelector(".highlight code"),
    previewPane: el.querySelector(".preview-pane"),
    preview: el.querySelector(".markdown"),
    tabs: [],
    active: null,
    mode,
    views: new Map(), // état de vue (défilement, sélection) par document
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
}

function setMode(g, mode) {
  g.mode = mode;
  g.body.dataset.mode = mode;
  savePref("mode", mode);
  if (g === focused) updateChrome();
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
  syncLayer(g);
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
      const html = await invoke("render_markdown", { text: d.text });
      if (d.version !== version) continue; // modifié entre-temps : un autre rendu arrive
      d.html = html;
      d.htmlVersion = version;
      groupsShowing(d).forEach((g) => (g.preview.innerHTML = html));
    }
  });
}

function showPreview(g, scrollTop = 0) {
  const doc = activeDoc(g);
  if (doc.htmlVersion === doc.version) g.preview.innerHTML = doc.html;
  else scheduleRender(doc);
  requestAnimationFrame(() => (g.previewPane.scrollTop = scrollTop));
}

// ====================================================================
// Barre d'outils / état / titre
// ====================================================================
function updateChrome() {
  const doc = activeDoc();
  if (!doc) return;
  const dirty = isDirty(doc);
  $("filename").textContent = docName(doc);
  $("dirty").hidden = !dirty;
  document.querySelectorAll(".segmented button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === focused.mode)
  );
  $("btn-split").classList.toggle("on", groups.length > 1);
  $("btn-split").title = groups.length > 1 ? "Fermer la vue fractionnée (Ctrl+\\)" : "Fractionner la vue (Ctrl+\\)";
  appWindow.setTitle(`${dirty ? "• " : ""}${docName(doc)} - Éditeur Markdown`);
  updateStats();
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
  for (const doc of docs.values()) {
    if (samePath(doc.path, file.path)) {
      openInGroup(doc, g);
      return;
    }
  }
  // Remplace l'onglet de bienvenue / vide s'il n'a pas été touché
  const current = activeDoc(g);
  const replace = current && !current.path && !isDirty(current) && (current.pristine || current.text === "") && g.tabs.length === 1
    && !groups.some((x) => x !== g && x.tabs.includes(current.id));

  const doc = createDoc(file.content, file.path);
  openInGroup(doc, g);
  if (replace) {
    g.tabs.splice(g.tabs.indexOf(current.id), 1);
    g.views.delete(current.id);
    docs.delete(current.id);
    renderTabs(g);
  }
  status(`Ouvert : ${file.path}`);
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
  try {
    const path = await invoke("save_file", {
      path: saveAs ? null : doc.path,
      content,
      suggestedName: doc.path ? docName(doc) : "document.md",
    });
    if (!path) return false;
    doc.path = path;
    doc.savedText = content;
    doc.pristine = false;
    renderAllTabs();
    updateChrome();
    status(`Enregistré : ${path}`);
    return true;
  } catch (e) {
    status(String(e));
    return false;
  }
}

// ====================================================================
// Boîte de dialogue « Enregistrer les modifications ? »
// ====================================================================
const confirmDialog = $("confirm");
function askSave(doc) {
  $("confirm-text").textContent = `« ${docName(doc)} » contient des modifications non enregistrées.`;
  confirmDialog.returnValue = "cancel";
  confirmDialog.showModal();
  return new Promise((resolve) =>
    confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue || "cancel"), { once: true })
  );
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

  // Tab insère 4 espaces
  g.editor.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.ctrlKey) {
      e.preventDefault();
      document.execCommand("insertText", false, "    ");
    }
  });

  // Défilement synchronisé éditeur → aperçu
  // Le calque coloré suit la largeur utile du textarea (sans sa barre de défilement)
  new ResizeObserver(() => {
    g.hl.style.width = g.editor.clientWidth + "px";
    syncLayer(g);
  }).observe(g.editor);

  g.editor.addEventListener("scroll", () => {
    syncLayer(g);
    const ratio = g.editor.scrollTop / Math.max(1, g.editor.scrollHeight - g.editor.clientHeight);
    g.previewPane.scrollTop = ratio * (g.previewPane.scrollHeight - g.previewPane.clientHeight);
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
// Fermeture de la fenêtre : on propose d'enregistrer
// ====================================================================
appWindow.onCloseRequested(async (event) => {
  const dirty = [...docs.values()].filter(isDirty);
  if (dirty.length === 0) return;
  event.preventDefault();
  for (const doc of dirty) {
    const g = groups.find((x) => x.tabs.includes(doc.id));
    if (g) activate(g, doc.id, { focusEditor: false });
    const answer = await askSave(doc);
    if (answer === "cancel") return;
    if (answer === "save" && !(await saveDoc(doc))) return;
  }
  await appWindow.destroy();
});

// ====================================================================
// Barre d'outils et raccourcis
// ====================================================================
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  savePref("ui-theme", theme);
}

$("btn-open").onclick = openDialog;
$("btn-save").onclick = () => saveDoc(activeDoc(), false);
$("btn-save-as").onclick = () => saveDoc(activeDoc(), true);
$("btn-split").onclick = toggleSplit;
$("btn-theme").onclick = () =>
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

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
  if (!e.ctrlKey || confirmDialog.open) return;
  const k = e.key.toLowerCase();
  const actions = {
    o: () => openDialog(),
    s: () => saveDoc(activeDoc(), e.shiftKey),
    t: () => openInGroup(createDoc()),
    n: () => openInGroup(createDoc()),
    w: () => closeTab(focused, focused.active),
    tab: () => cycleTab(e.shiftKey ? -1 : 1),
    "\\": () => toggleSplit(),
  };
  if (actions[k]) {
    e.preventDefault();
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
// Démarrage
// ====================================================================
setTheme(loadPref("ui-theme", "light"));
const first = createGroup();
setFocus(first);
openInGroup(createDoc(WELCOME, null, { pristine: true }), first);
first.editor.setSelectionRange(0, 0);
first.editor.scrollTop = 0;
