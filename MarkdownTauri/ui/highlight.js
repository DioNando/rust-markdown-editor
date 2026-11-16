// Coloration syntaxique du Markdown pour l'éditeur.
// Transforme le texte brut en HTML de <span class="t-…">. Ligne par ligne, avec
// un état pour les blocs de code délimités (``` ou ~~~). Le texte produit doit
// être caractère pour caractère identique à la source : on ne fait qu'entourer.

(function () {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const span = (cls, html) => `<span class="${cls}">${html}</span>`;
  const P = (s) => span("t-punct", esc(s));

  // Éléments en ligne, essayés dans cet ordre à chaque position
  const INLINE = new RegExp(
    [
      "(?<code>(`+)(?:(?!\\2).)+?\\2)",                                   // `code`
      "(?<link>(!?\\[)((?:[^\\[\\]]|\\[[^\\]]*\\])*)(\\]\\()([^)\\s]*)((?:\\s+\"[^\"]*\")?\\)))", // [texte](url)
      "(?<autolink><https?:\\/\\/[^>\\s]+>)",                               // <https://…>
      "(?<bold>(\\*\\*|__)(?=\\S)(.+?)(?<=\\S)\\11)",                       // **gras**
      "(?<strike>~~(?=\\S)(.+?)(?<=\\S)~~)",                                // ~~barré~~
      "(?<mark>==(?=\\S)(.+?)(?<=\\S)==)",                                  // ==surligné==
      "(?<italic>(\\*|_)(?=\\S)(.+?)(?<=\\S)\\18)",                         // *italique*
      "(?<html><\\/?[a-zA-Z][^<>]*>)",                                      // <balise>
      "(?<url>https?:\\/\\/[^\\s<>()]+)",                                   // URL nue
    ].join("|"),
    "g"
  );

  function inline(s) {
    // Regex locale : inline() est récursive, une regex /g partagée verrait son
    // lastIndex remis à zéro par l'appel imbriqué (boucle infinie).
    const re = new RegExp(INLINE.source, "g");
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      const g = m.groups;
      // `_` et `__` ne marquent pas l'emphase au milieu d'un mot (snake_case)
      const delim = g.bold ? m[11] : g.italic ? m[18] : "";
      if (delim[0] === "_") {
        const before = s[m.index - 1] || "", after = s[m.index + m[0].length] || "";
        if (/[\p{L}\p{N}_]/u.test(before) || /[\p{L}\p{N}_]/u.test(after)) {
          re.lastIndex = m.index + 1; // on ignore ce « _ » et on continue juste après
          continue;
        }
      }
      out += esc(s.slice(last, m.index));
      if (g.code) {
        const tick = m[2];
        out += span("t-code", P(tick) + esc(m[0].slice(tick.length, -tick.length)) + P(tick));
      } else if (g.link) {
        // m[4] = « [ » ou « ![ », m[5] = texte, m[6] = « ]( », m[7] = url, m[8] = titre + « ) »
        out += P(m[4]) + span("t-link", inline(m[5])) + P(m[6]) + span("t-url", esc(m[7])) + P(m[8]);
      } else if (g.autolink) {
        out += P("<") + span("t-url", esc(m[0].slice(1, -1))) + P(">");
      } else if (g.bold) {
        out += span("t-bold", P(m[11]) + inline(m[12]) + P(m[11]));
      } else if (g.strike) {
        out += span("t-strike", P("~~") + inline(m[14]) + P("~~"));
      } else if (g.mark) {
        out += span("t-mark", P("==") + inline(m[16]) + P("=="));
      } else if (g.italic) {
        out += span("t-italic", P(m[18]) + inline(m[19]) + P(m[18]));
      } else if (g.html) {
        out += span("t-html", esc(m[0]));
      } else if (g.url) {
        out += span("t-url", esc(m[0]));
      }
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++; // sécurité anti-boucle
    }
    return out + esc(s.slice(last));
  }

  const FENCE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
  const HEADING = /^(\s{0,3})(#{1,6})(\s+|$)(.*)$/;
  const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE = /^(\s*)((?:>\s?)+)(.*)$/;
  const LIST = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s)?(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

  function tableRow(line) {
    if (TABLE_SEP.test(line)) return P(line);
    return line.split(/(\|)/).map((part) => (part === "|" ? P("|") : inline(part))).join("");
  }

  function line(l) {
    let m;
    if ((m = HEADING.exec(l))) return esc(m[1]) + span("t-hmark", esc(m[2])) + m[3] + span("t-heading", inline(m[4]));
    if (HR.test(l)) return span("t-hr", esc(l));
    if ((m = QUOTE.exec(l))) return esc(m[1]) + P(m[2]) + span("t-quote", inline(m[3]));
    if ((m = LIST.exec(l))) {
      const task = m[4] ? span("t-task", esc(m[4])) : "";
      return esc(m[1]) + span("t-list", esc(m[2])) + m[3] + task + inline(m[5]);
    }
    if (/^\s*\|/.test(l)) return tableRow(l);
    return inline(l);
  }

  window.highlightMarkdown = function (text) {
    const lines = text.split("\n");
    let fence = null; // { ch, len } quand on est dans un bloc de code
    const out = new Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const f = FENCE.exec(l);
      if (fence) {
        if (f && f[2][0] === fence.ch && f[2].length >= fence.len && f[3].trim() === "") {
          out[i] = span("t-fence", esc(l));
          fence = null;
        } else {
          out[i] = span("t-codeblock", esc(l));
        }
      } else if (f && !(f[2][0] === "`" && f[3].includes("`"))) {
        fence = { ch: f[2][0], len: f[2].length };
        out[i] = esc(f[1]) + span("t-fence", esc(f[2])) + span("t-lang", esc(f[3]));
      } else {
        out[i] = line(l);
      }
    }
    // Un \n final ne crée pas de ligne visible dans un <pre> : on ajoute une espace
    return out.join("\n") + (text.endsWith("\n") ? " " : "");
  };
})();
