// Enrichissement de l'aperçu après le rendu Rust :
//   - coloration du code (highlight.js) pour les blocs ```langage
//   - formules mathématiques $…$ et $$…$$ (KaTeX, chargé à la demande)
//   - schémas ```mermaid (Mermaid, chargé à la demande)
// Tout est mis en cache par source : retaper un caractère ne recalcule que ce qui a changé,
// et ce qui est en cache est appliqué tout de suite (pas de clignotement).
(function () {
  const scripts = {};
  function loadScript(src) {
    return (scripts[src] ??= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Chargement impossible : ${src}`));
      document.head.appendChild(s);
    }));
  }
  function loadCss(href) {
    if (document.querySelector(`link[href="${href}"]`)) return;
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = href;
    document.head.appendChild(l);
  }

  const cache = { code: new Map(), math: new Map(), mermaid: new Map() };
  function remember(map, key, value) {
    if (map.size > 400) map.delete(map.keys().next().value);
    map.set(key, value);
    return value;
  }
  const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // ---------- Code ----------
  function highlightCode(root) {
    if (!window.hljs) return;
    for (const code of root.querySelectorAll("pre > code[class*='language-']")) {
      const lang = (code.className.match(/language-([\w+#.-]+)/) || [])[1]?.toLowerCase();
      if (!lang || lang === "mermaid" || !hljs.getLanguage(lang)) continue;
      const src = code.textContent;
      const key = lang + "\0" + src;
      let html = cache.code.get(key);
      if (html === undefined) {
        try {
          html = hljs.highlight(src, { language: lang, ignoreIllegals: true }).value;
        } catch {
          html = null;
        }
        remember(cache.code, key, html);
      }
      if (html != null) {
        code.innerHTML = html;
        code.classList.add("hljs");
      }
    }
  }

  // ---------- Formules ----------
  function applyMath(nodes) {
    for (const el of nodes) {
      const display = el.classList.contains("math-display");
      const src = el.textContent;
      const key = (display ? "D" : "I") + src;
      let html = cache.math.get(key);
      if (html === undefined) {
        html = katex.renderToString(src, { displayMode: display, throwOnError: false, output: "htmlAndMathml" });
        remember(cache.math, key, html);
      }
      el.innerHTML = html;
      el.classList.add("rendered");
    }
  }
  async function renderMath(root) {
    const nodes = root.querySelectorAll(".math");
    if (!nodes.length) return;
    loadCss("vendor/katex/katex.min.css");
    if (!window.katex) await loadScript("vendor/katex/katex.min.js");
    applyMath(nodes);
  }

  // ---------- Schémas Mermaid ----------
  let mermaidTheme = null;
  let mermaidId = 0;
  let queue = Promise.resolve(); // Mermaid n'aime pas les rendus simultanés

  function mermaidKey(theme, src) {
    return theme + "\0" + src;
  }
  function placeDiagram(code, result) {
    const pre = code.parentElement;
    if (!pre?.parentElement) return;
    const fig = document.createElement("figure");
    fig.className = "mermaid" + (result.error ? " error" : "");
    if (pre.dataset.line) fig.dataset.line = pre.dataset.line;
    fig.innerHTML = result.error
      ? `<figcaption>Schéma Mermaid invalide</figcaption><pre>${escapeHtml(result.error)}</pre>`
      : result.svg;
    pre.replaceWith(fig);
  }
  function renderOne(theme, src) {
    const run = async () => {
      const key = mermaidKey(theme, src);
      if (cache.mermaid.has(key)) return cache.mermaid.get(key);
      if (mermaidTheme !== theme) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "dark" ? "dark" : "neutral",
          fontFamily: "Nunito Sans, Segoe UI, sans-serif",
        });
        mermaidTheme = theme;
      }
      const id = "mmd-" + ++mermaidId;
      let result;
      try {
        result = { svg: (await mermaid.render(id, src)).svg };
      } catch (e) {
        result = { error: String(e?.message || e).trim() };
      }
      document.getElementById(id)?.remove();
      document.getElementById("d" + id)?.remove(); // conteneur temporaire laissé en cas d'erreur
      return remember(cache.mermaid, key, result);
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }
  async function renderMermaid(root, theme) {
    const blocks = [...root.querySelectorAll("pre > code.language-mermaid")];
    if (!blocks.length) return;
    const pending = [];
    for (const code of blocks) {
      const hit = cache.mermaid.get(mermaidKey(theme, code.textContent));
      if (hit) placeDiagram(code, hit);
      else pending.push(code);
    }
    if (!pending.length) return;
    if (!window.mermaid) await loadScript("vendor/mermaid.min.js");
    for (const code of pending) placeDiagram(code, await renderOne(theme, code.textContent));
  }

  /**
   * Enrichit un aperçu. Ce qui est déjà en cache est appliqué immédiatement ;
   * la promesse se résout quand tout est terminé (bibliothèques chargées, schémas rendus).
   */
  window.enhancePreview = function (root, theme) {
    highlightCode(root);
    const math = root.querySelectorAll(".math");
    if (math.length && window.katex) applyMath(math);
    return Promise.all([
      math.length && !window.katex ? renderMath(root) : null,
      renderMermaid(root, theme),
    ]).catch((e) => console.error(e));
  };
})();
