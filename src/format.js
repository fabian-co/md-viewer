// Herramientas de formato Markdown para el editor (negrita, títulos, listas, ...).
// Todas las ediciones pasan por insertText para que Ctrl+Z las pueda deshacer.

const Format = (() => {
  // Reemplaza [start, end) por text y deja seleccionado [selStart, selEnd) (relativos a start)
  function replace(ed, start, end, text, selStart = text.length, selEnd = selStart) {
    ed.focus();
    ed.setSelectionRange(start, end);
    if (!document.execCommand("insertText", false, text)) {
      ed.setRangeText(text, start, end);
      ed.dispatchEvent(new Event("input"));
    }
    ed.setSelectionRange(start + selStart, start + selEnd);
  }

  // Cuántas veces se repite ch justo antes de pos (o desde pos hacia delante si forward)
  function run(text, pos, ch, forward) {
    let n = 0;
    if (forward) while (text[pos + n] === ch) n++;
    else while (text[pos - 1 - n] === ch) n++;
    return n;
  }

  // Distingue *cursiva* de **negrita**: un marcador de 1 carácter no cuenta si hay exactamente 2
  const matches = (count, marker) => count >= marker.length && (marker.length > 1 || count !== 2);

  // Envuelve la selección con un marcador (o lo quita si ya está)
  function wrap(ed, marker, placeholder) {
    const { value: v, selectionStart: s, selectionEnd: e } = ed;
    const sel = v.slice(s, e);
    const ch = marker[0];
    const m = marker.length;

    // Marcadores alrededor de la selección: **|texto|**
    if (matches(run(v, s, ch, false), marker) && matches(run(v, e, ch, true), marker)) {
      return replace(ed, s - m, e + m, sel, 0, sel.length);
    }
    // Marcadores dentro de la selección: |**texto**|
    if (
      sel.length >= 2 * m &&
      matches(run(sel, 0, ch, true), marker) &&
      matches(run(sel, sel.length, ch, false), marker)
    ) {
      const inner = sel.slice(m, -m);
      return replace(ed, s, e, inner, 0, inner.length);
    }
    // No envolver los espacios del borde: "**texto **" no es Markdown válido
    const lead = sel.match(/^\s*/)[0];
    const trail = sel.slice(lead.length).match(/\s*$/)[0];
    const core = sel.slice(lead.length, sel.length - trail.length) || placeholder;
    const text = lead + marker + core + marker + trail;
    replace(ed, s, e, text, lead.length + m, lead.length + m + core.length);
  }

  // Líneas completas que toca la selección
  function lineRange(ed) {
    const { value: v, selectionStart: s } = ed;
    let e = ed.selectionEnd;
    if (e > s && v[e - 1] === "\n") e--; // si la selección acaba en un salto, no incluye la línea siguiente
    const start = v.lastIndexOf("\n", s - 1) + 1;
    let end = v.indexOf("\n", e);
    if (end === -1) end = v.length;
    return { start, end, lines: v.slice(start, end).split("\n") };
  }

  // Aplica fn a cada línea seleccionada; con varias líneas deja seleccionado el resultado
  function mapLines(ed, fn) {
    const { start, end, lines } = lineRange(ed);
    const text = lines.map(fn).join("\n");
    if (lines.length === 1) replace(ed, start, end, text);
    else replace(ed, start, end, text, 0, text.length);
  }

  const HEADING = /^#{1,6}\s+/;
  const LIST = /^(\s*)(?:[-*+] \[[ xX]\] |[-*+] |\d+[.)] )/;
  const QUOTE = /^>\s?/;

  function heading(ed, level) {
    const prefix = "#".repeat(level) + " ";
    const all = lineRange(ed).lines.every((l) => l.startsWith(prefix));
    mapLines(ed, (l) => {
      const bare = l.replace(HEADING, "");
      return all ? bare : prefix + bare;
    });
  }

  const LINE_TESTS = {
    ul: (l) => /^\s*[-*+] (?!\[[ xX]\] )/.test(l),
    ol: (l) => /^\s*\d+[.)] /.test(l),
    task: (l) => /^\s*[-*+] \[[ xX]\] /.test(l),
    quote: (l) => QUOTE.test(l),
  };

  // kind: "ul" | "ol" | "task" | "quote". Si todas las líneas ya lo tienen, lo quita.
  function prefixLines(ed, kind) {
    const { lines } = lineRange(ed);
    const nonEmpty = lines.filter((l) => l.trim());
    const remove = nonEmpty.length > 0 && nonEmpty.every(LINE_TESTS[kind]);
    let n = 0;
    mapLines(ed, (l) => {
      if (kind === "quote") return remove ? l.replace(QUOTE, "") : "> " + l;
      if (remove) return l.replace(LIST, "$1");
      if (!l.trim() && lines.length > 1) return l;
      const indent = l.match(/^\s*/)[0];
      const body = l.replace(LIST, "").trimStart();
      const prefix = kind === "ul" ? "- " : kind === "task" ? "- [ ] " : `${++n}. `;
      return indent + prefix + body;
    });
  }

  // Inserta un bloque en líneas propias, separado del texto que lo rodea
  function block(ed, text, selStart, selEnd) {
    const { value: v, selectionStart: s, selectionEnd: e } = ed;
    const before = s === 0 || v[s - 1] === "\n" ? "" : "\n";
    const after = e === v.length || v[e] === "\n" ? "" : "\n";
    replace(ed, s, e, before + text + after, before.length + selStart, before.length + selEnd);
  }

  function codeBlock(ed) {
    const body = ed.value.slice(ed.selectionStart, ed.selectionEnd) || "código";
    block(ed, "```\n" + body + "\n```", 4, 4 + body.length);
  }

  function table(ed) {
    block(ed, "| Columna 1 | Columna 2 |\n|-----------|-----------|\n| Texto     | Texto     |", 2, 11);
  }

  function hr(ed) {
    block(ed, "\n---\n", 5, 5);
  }

  function link(ed, image) {
    const { value: v, selectionStart: s, selectionEnd: e } = ed;
    const sel = v.slice(s, e).trim();
    const bang = image ? "!" : "";
    if (/^(https?:\/\/|mailto:|www\.)\S+$/i.test(sel)) {
      // Se seleccionó una URL: queda seleccionado el texto para escribirlo
      const label = image ? "descripción" : "texto";
      replace(ed, s, e, `${bang}[${label}](${sel})`, bang.length + 1, bang.length + 1 + label.length);
    } else {
      const text = `${bang}[${sel || (image ? "descripción" : "texto del enlace")}](url)`;
      replace(ed, s, e, text, text.length - 4, text.length - 1);
    }
  }

  const actions = {
    h1: (ed) => heading(ed, 1),
    h2: (ed) => heading(ed, 2),
    h3: (ed) => heading(ed, 3),
    bold: (ed) => wrap(ed, "**", "negrita"),
    italic: (ed) => wrap(ed, "*", "cursiva"),
    strike: (ed) => wrap(ed, "~~", "tachado"),
    code: (ed) => wrap(ed, "`", "código"),
    ul: (ed) => prefixLines(ed, "ul"),
    ol: (ed) => prefixLines(ed, "ol"),
    task: (ed) => prefixLines(ed, "task"),
    quote: (ed) => prefixLines(ed, "quote"),
    link: (ed) => link(ed, false),
    image: (ed) => link(ed, true),
    codeblock: codeBlock,
    table,
    hr,
  };

  // Atajos (con Ctrl/Cmd ya pulsado). Se usa e.code para no depender de la distribución del teclado.
  const SHORTCUTS = {
    KeyB: "bold",
    KeyI: "italic",
    KeyK: "link",
    Digit1: "h1",
    Digit2: "h2",
    Digit3: "h3",
  };
  const SHIFT_SHORTCUTS = {
    KeyX: "strike",
    KeyC: "code",
    Digit8: "ul",
    Digit7: "ol",
    Period: "quote",
  };

  return {
    apply: (ed, name) => actions[name]?.(ed),
    shortcut: (e) => (e.shiftKey ? SHIFT_SHORTCUTS : SHORTCUTS)[e.code] ?? null,
  };
})();
