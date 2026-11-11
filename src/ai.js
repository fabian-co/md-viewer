// Asistente de IA: lee el documento de la pestaña activa y propone cambios que el usuario revisa y aplica.
// Las peticiones y las API keys viven en Rust (src-tauri/src/ai.rs); aquí solo está la interfaz.
(() => {
  const { invoke, baseName } = window.App;
  const { listen } = window.__TAURI__.event;

  // ---------- Proveedores ----------

  const PROVIDERS = {
    anthropic: {
      name: "Anthropic (Claude)",
      base: "https://api.anthropic.com",
      model: "claude-opus-5-5",
      key: true,
      keyUrl: "https://console.anthropic.com/settings/keys",
      help: "Modelos Claude. Crea una API key en la consola de Anthropic.",
    },
    openai: {
      name: "OpenAI",
      base: "https://api.openai.com/v1",
      model: "gpt-5",
      key: true,
      keyUrl: "https://platform.openai.com/api-keys",
      help: "Modelos GPT. Crea una API key en la plataforma de OpenAI.",
    },
    gemini: {
      name: "Google Gemini",
      base: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-flash-latest",
      key: true,
      keyUrl: "https://aistudio.google.com/apikey",
      help: "Modelos Gemini. Crea una API key gratuita en Google AI Studio.",
    },
    openrouter: {
      name: "OpenRouter",
      base: "https://openrouter.ai/api/v1",
      model: "openrouter/auto",
      key: true,
      keyUrl: "https://openrouter.ai/keys",
      help: "Una sola clave para cientos de modelos de distintas empresas.",
    },
    ollama: {
      name: "Ollama (local)",
      base: "http://localhost:11434/v1",
      model: "llama3.2",
      key: false,
      help: "Modelos en tu propio equipo, sin clave ni internet. Instala Ollama y descarga un modelo (ollama pull llama3.2). Para documentos largos, sube su contexto con la variable OLLAMA_CONTEXT_LENGTH (por ejemplo 32768).",
    },
    compatible: {
      name: "Otro compatible con OpenAI",
      base: "http://localhost:1234/v1",
      model: "",
      key: "optional",
      help: "Cualquier servicio con API compatible con OpenAI: LM Studio, Groq, DeepSeek, Mistral, Together… Pon su URL base y, si la pide, su clave.",
    },
  };

  const CONFIG_KEY = "md-viewer.ai";
  const config = loadConfig();
  const keyHints = {}; // proveedor -> "…abcd" | null

  function loadConfig() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}; } catch {}
    c.providers ||= {};
    for (const [id, p] of Object.entries(PROVIDERS)) {
      c.providers[id] = { model: p.model, base: p.base, ...c.providers[id] };
    }
    if (!PROVIDERS[c.active]) c.active = null;
    return c;
  }

  function saveConfig() {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); } catch {}
  }

  const usable = (id) => PROVIDERS[id].key !== true || !!keyHints[id];

  // ---------- Elementos ----------

  const panel = document.getElementById("ai-panel");
  const toggleBtn = document.getElementById("btn-ai");
  const providerSel = document.getElementById("ai-provider");
  const messagesEl = document.getElementById("ai-messages");
  const form = document.getElementById("ai-form");
  const promptEl = document.getElementById("ai-prompt");
  const sendBtn = document.getElementById("ai-send");
  const contextEl = document.getElementById("ai-context");

  // ---------- Conversaciones (una por pestaña) ----------

  /** @type {WeakMap<object, {messages: object[], job: number|null}>} */
  const chats = new WeakMap();
  const chatOf = (tab) => {
    if (!chats.has(tab)) chats.set(tab, { messages: [], job: null });
    return chats.get(tab);
  };
  const jobs = new Map(); // id de petición -> { chat, msg }
  let nextJob = Date.now();

  // ---------- Prompt de sistema ----------

  function systemPrompt(tab, selection, mode) {
    const name = baseName(tab.path);
    const doc = tab.el.value;
    let s = `Eres el asistente de MD Viewer, un editor de Markdown. Ayudas a leer, entender, revisar y editar el documento que el usuario tiene abierto. Responde en el idioma del usuario, con claridad y sin rodeos, usando Markdown.

Cuando el usuario pida cambiar el documento (corregir, reescribir, traducir, añadir o quitar contenido, reordenar, dar formato…), propón los cambios con bloques de edición. Hay tres tipos, con estos marcadores exactos (7 signos, cada marcador en su propia línea):

1. Reemplazar un fragmento:
<<<<<<< BUSCAR
texto exacto que hay ahora en el documento
=======
texto nuevo que lo reemplaza
>>>>>>> REEMPLAZAR

2. Añadir texto al final del documento:
<<<<<<< AL FINAL
texto nuevo
>>>>>>> FIN

3. Añadir texto al inicio del documento:
<<<<<<< AL INICIO
texto nuevo
>>>>>>> FIN

Reglas de los bloques de edición:
- El texto de BUSCAR se copia literal del documento actual (mismos espacios, signos y saltos de línea) y debe aparecer una sola vez: incluye las líneas necesarias para que sea único, sin pasarte.
- Para borrar texto, deja vacía la parte de reemplazo. Para añadir texto en medio del documento, usa como BUSCAR las líneas junto a donde va lo nuevo y repítelas en el reemplazo junto con lo añadido. Para añadirlo al final o al inicio, usa AL FINAL o AL INICIO.
- Si el documento está vacío, o el usuario pide reescribirlo entero, deja BUSCAR vacío: el reemplazo será el documento completo.
- Prefiere varios bloques pequeños a uno enorme y no repitas partes que no cambian.
- No pongas los bloques dentro de bloques de código (\`\`\`).
- Fuera de los bloques, explica en una o dos frases qué cambias. Cada bloque se aplica al documento automáticamente en cuanto lo terminas de escribir (el usuario puede deshacerlo).

Si el usuario solo pregunta algo sobre el documento, responde sin bloques de edición.

${MODE_RULES[mode] || ""}

Documento abierto: «${name}»${tab.path ? ` (${tab.path})` : " (sin guardar)"}, ${doc.length} caracteres.
<documento>
${doc}
</documento>`;
    if (selection) {
      s += `\n\nEl usuario tiene seleccionado este fragmento; si pide algo sobre «esto» o «la selección», se refiere a él:\n<seleccion>\n${selection}\n</seleccion>`;
    }
    return s;
  }

  // Qué debe hacer el modelo según la intención detectada en el mensaje (intent.js)
  const MODE_RULES = {
    ask: `MODO DE ESTE MENSAJE: PREGUNTA. El usuario pregunta o pide información sobre el documento (resumir, explicar, analizar, opinar…). Responde solo en el chat y NO uses bloques de edición: tu respuesta no se añade al documento (el usuario puede añadirla después con un botón si quiere).`,
    write: `MODO DE ESTE MENSAJE: ESCRIBIR EN EL DOCUMENTO. El usuario quiere que el contenido que pide quede en el documento, aunque no lo diga explícitamente. Escribe SIEMPRE el contenido dentro de bloques de edición: AL FINAL para contenido nuevo (salvo que indique otra posición), AL INICIO si lo pide al principio y BUSCAR/REEMPLAZAR para cambiar o insertar en medio. No escribas el contenido fuera de los bloques; fuera solo una frase breve que diga qué has hecho.`,
  };

  // ---------- Bloques de edición ----------

  // Marcadores tolerantes: los modelos pequeños a veces ponen 5 o 6 signos, espacios o vallas de código
  const OPEN_RE = /^\s*(?:```[\w-]*\s*)?<{3,}\s*(BUSCAR|AL\s+FINAL|AL\s+INICIO)\b.*$/i;
  const SEP_RE = /^\s*={3,}\s*$/;
  const CLOSE_RE = /^\s*>{3,}\s*(REEMPLAZAR|FIN)?\b.*$/i;
  const FENCE_RE = /^\s*```[\w-]*\s*$/;

  /**
   * Divide la respuesta en texto y bloques de edición. Mientras llega el stream, un bloque sin cerrar
   * queda como "pending"; al terminar, se acepta si solo le falta el cierre, o se marca como "bad".
   */
  function parseReply(text, streaming) {
    const parts = [];
    const lines = text.split("\n");
    let buf = [];
    let block = null; // { kind, search: [], replace: [], stage: "search" | "replace", raw: [] }

    // Quita una valla de código suelta (```) que el modelo dejó alrededor de un bloque, pero solo si
    // queda desparejada: las de un bloque de código legítimo dentro del texto van en pareja y se conservan
    const trim = (arr) => {
      if (arr.filter((l) => FENCE_RE.test(l)).length % 2 === 1) {
        if (FENCE_RE.test(arr[arr.length - 1])) arr.pop();
        else if (FENCE_RE.test(arr[0])) arr.shift();
      }
      return arr.join("\n");
    };
    const flushText = () => {
      const t = trim(buf);
      if (t.trim()) parts.push({ type: "text", text: t });
      buf = [];
    };
    const finishBlock = () => {
      parts.push({
        type: "edit",
        kind: block.kind,
        search: block.kind === "replace" ? trim(block.search) : "",
        replace: trim(block.replace),
      });
      block = null;
    };

    for (const line of lines) {
      if (!block) {
        const m = line.match(OPEN_RE);
        if (m) {
          flushText();
          const word = m[1].toUpperCase().replace(/\s+/g, " ");
          const kind = word === "BUSCAR" ? "replace" : word === "AL FINAL" ? "append" : "prepend";
          block = { kind, search: [], replace: [], stage: kind === "replace" ? "search" : "replace", raw: [line] };
        } else {
          buf.push(line);
        }
        continue;
      }
      block.raw.push(line);
      if (block.stage === "search" && SEP_RE.test(line)) block.stage = "replace";
      else if (CLOSE_RE.test(line) && block.stage === "replace") finishBlock();
      else block[block.stage].push(line);
    }

    if (block) {
      if (streaming) parts.push({ type: "pending" });
      else if (block.stage === "replace") finishBlock(); // solo faltaba el marcador de cierre
      else parts.push({ type: "bad", raw: block.raw.join("\n") });
    }
    flushText();
    return parts;
  }

  // Busca `search` en el documento: exacto o, si no, ignorando espacios al final de las líneas
  function locate(doc, search) {
    if (!search.trim()) return null;
    const i = doc.indexOf(search);
    if (i >= 0) return [i, i + search.length];
    const lines = doc.split("\n");
    const want = search.replace(/\n+$/, "").split("\n").map((l) => l.trimEnd());
    const offsets = [];
    let off = 0;
    for (const l of lines) { offsets.push(off); off += l.length + 1; }
    for (let a = 0; a + want.length <= lines.length; a++) {
      let ok = true;
      for (let j = 0; j < want.length && ok; j++) ok = lines[a + j].trimEnd() === want[j];
      if (ok) {
        const end = a + want.length - 1;
        return [offsets[a], offsets[end] + lines[end].length];
      }
    }
    return null;
  }

  // Reemplaza [start, end) por `text`. Con insertText entra en el historial del editor (Ctrl+Z);
  // en modo Vista el editor está oculto y no recibe el foco, así que se reemplaza directamente.
  function replaceRange(el, start, end, text) {
    const doc = el.value;
    const expected = doc.slice(0, start) + text + doc.slice(end);
    const prev = document.activeElement;
    el.focus({ preventScroll: true });
    el.setSelectionRange(start, end);
    if (document.activeElement === el) {
      if (text) document.execCommand("insertText", false, text);
      else document.execCommand("delete");
    }
    if (el.value !== expected) {
      el.value = expected;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.setSelectionRange(start, start + text.length);
    const lineH = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.scrollTop = Math.max(0, doc.slice(0, start).split("\n").length * lineH - el.clientHeight / 3);
    // Si el usuario estaba escribiendo en otro campo (p. ej. el chat), se le devuelve el foco
    if (prev && prev !== el && /^(TEXTAREA|INPUT)$/.test(prev.tagName)) prev.focus();
  }

  // Aplica un bloque y guarda lo necesario para deshacerlo
  function applyEdit(edit, state, el = window.App.editor) {
    const doc = el.value;
    let range, text = edit.replace;
    if (edit.kind === "append") {
      // Separado del contenido anterior por una línea en blanco
      const body = text.replace(/^\n+|\n+$/g, "");
      const sep = !doc.trim() ? "" : doc.endsWith("\n\n") ? "" : doc.endsWith("\n") ? "\n" : "\n\n";
      range = [doc.length, doc.length];
      text = sep + body + "\n";
    } else if (edit.kind === "prepend") {
      const body = text.replace(/^\n+|\n+$/g, "");
      range = [0, 0];
      text = body + (doc.trim() ? "\n\n" : "\n");
    } else {
      // Posición conocida (acciones sobre bloques de la vista previa) o búsqueda del texto
      range = edit.at != null && doc.slice(edit.at, edit.at + edit.search.length) === edit.search
        ? [edit.at, edit.at + edit.search.length]
        : !edit.search.trim() ? [0, doc.length] : locate(doc, edit.search); // BUSCAR vacío: todo
    }
    if (!range) return false;
    const original = doc.slice(range[0], range[1]);
    replaceRange(el, range[0], range[1], text);
    state.undo = { start: range[0], original, inserted: text };
    return true;
  }

  function undoEdit(state, el = window.App.editor) {
    const u = state.undo;
    let start = u.start;
    // Si el texto se movió por otros cambios, se busca de nuevo
    if (el.value.slice(start, start + u.inserted.length) !== u.inserted) {
      start = u.inserted ? el.value.indexOf(u.inserted) : -1;
      if (start < 0) return false;
    }
    replaceRange(el, start, start + u.inserted.length, u.original);
    return true;
  }

  // Diferencias por líneas entre dos textos cortos (LCS); para textos grandes, todo quitado + todo añadido
  function diffLines(a, b) {
    const A = a ? a.split("\n") : [], B = b ? b.split("\n") : [];
    if (A.length * B.length > 250000) {
      return [...A.map((t) => ["-", t]), ...B.map((t) => ["+", t])];
    }
    const n = A.length, m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push([" ", A[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(["-", A[i++]]);
      else out.push(["+", B[j++]]);
    }
    while (i < n) out.push(["-", A[i++]]);
    while (j < m) out.push(["+", B[j++]]);
    return out;
  }

  // ---------- Renderizado ----------

  const mdCache = new Map();
  async function md(text) {
    if (mdCache.has(text)) return mdCache.get(text);
    const html = await invoke("render_markdown_safe", { text });
    if (mdCache.size > 300) mdCache.clear();
    mdCache.set(text, html);
    return html;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderEmpty() {
    messagesEl.replaceChildren();
    const box = el("div", "ai-empty");
    if (!config.active || !usable(config.active)) {
      box.append(
        el("h3", null, "Asistente IA"),
        el("p", null, "Pregunta sobre el documento abierto o pide cambios: el asistente los aplica directamente y puedes deshacer cada uno. En la vista previa, pasa el ratón por un párrafo para refinarlo o generar texto a partir de él."),
        el("p", null, "Para empezar, elige un proveedor (Claude, OpenAI, Gemini, OpenRouter, Ollama…) y agrega tu API key."),
      );
      const b = el("button", "primary", "Configurar proveedor");
      b.type = "button";
      b.onclick = () => openSettings();
      box.append(b);
    } else {
      box.append(
        el("h3", null, "¿Qué quieres hacer con este documento?"),
        el("p", null, "Si preguntas algo, la respuesta se queda en el chat. Si pides contenido o cambios, van directamente al documento."),
      );
      const list = el("div", "ai-suggestions");
      for (const s of [
        "Resume el documento",
        "Corrige la ortografía y la gramática",
        "Mejora la redacción sin cambiar el sentido",
        "Añade un índice al principio",
        "Tradúcelo al inglés",
      ]) {
        const b = el("button", null, s);
        b.type = "button";
        b.onclick = () => send(s);
        list.append(b);
      }
      box.append(list);
    }
    messagesEl.append(box);
  }

  function renderChat() {
    const tab = window.App.tab;
    if (!tab) return;
    const chat = chatOf(tab);
    updateSendButton(chat);
    if (!chat.messages.length) return renderEmpty();
    messagesEl.replaceChildren(...chat.messages.map((m) => {
      m.node = buildMessage(m);
      return m.node;
    }));
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function buildMessage(msg) {
    const node = el("div", `ai-msg ${msg.role}`);
    fillMessage(node, msg);
    return node;
  }

  let fillSeq = new WeakMap();
  async function fillMessage(node, msg) {
    const seq = (fillSeq.get(node) || 0) + 1;
    fillSeq.set(node, seq);
    if (msg.role === "user") {
      node.replaceChildren(el("div", "ai-bubble", msg.content));
      if (msg.mode && !msg.block) {
        node.append(el("div", `ai-intent ${msg.mode}`, msg.mode === "ask" ? "💬 Pregunta · respuesta en el chat" : "📄 Va al documento"));
      }
      return;
    }
    if (msg.error) {
      const box = el("div", "ai-error", msg.error);
      if (/API key|clave|401|403/i.test(msg.error)) {
        const b = el("button", null, "Configurar");
        b.type = "button";
        b.onclick = () => openSettings();
        box.append(b);
      }
      if (msg.content) await fillParts(node, msg, seq, box);
      else node.replaceChildren(box);
      return;
    }
    if (msg.block && !msg.error) return fillBlockMessage(node, msg, seq);
    if (!msg.content && msg.streaming) {
      // Mientras el modelo razona se muestra su razonamiento en vivo (si el proveedor lo envía)
      node.replaceChildren(...(msg.thinking ? [reasoningBox(msg, true)] : []), el("div", "ai-thinking", "Pensando"));
      const body = node.querySelector(".ai-reasoning-body");
      if (body) body.scrollTop = body.scrollHeight;
      return;
    }
    await fillParts(node, msg, seq);
  }

  async function fillParts(node, msg, seq, tail) {
    const parts = parseReply(msg.content, msg.streaming);
    msg.edits ||= [];
    let editIndex = 0;
    const children = msg.thinking ? [reasoningBox(msg, false)] : [];
    for (const part of parts) {
      if (part.type === "text") {
        const div = el("div", "markdown ai-md");
        div.innerHTML = await md(part.text);
        children.push(div);
      } else if (part.type === "edit") {
        const i = editIndex++;
        msg.edits[i] ||= { status: "pending" };
        children.push(buildEditCard(msg, part, i));
      } else if (part.type === "bad") {
        // El modelo empezó un bloque de cambio pero no respetó el formato: se muestra tal cual
        const card = el("div", "ai-edit bad");
        const head = el("div", "ai-edit-head");
        head.append(
          el("span", "ai-edit-title", "Cambio con formato incompleto"),
          el("span", "ai-edit-badge warn", "No se puede aplicar automáticamente"),
        );
        card.append(
          head,
          el("p", "ai-edit-help", "El modelo no escribió el cambio en el formato esperado. Copia el texto a mano o pídeselo de nuevo; los modelos pequeños fallan más en esto."),
          el("pre", "ai-diff ai-raw", part.raw),
        );
        children.push(card);
      } else {
        children.push(el("div", "ai-edit pending", "Preparando cambio…"));
      }
    }
    if (fillSeq.get(node) !== seq) return; // ya hay un renderizado más reciente
    msg.parsed = parts.filter((p) => p.type === "edit");
    const pendingCount = msg.parsed.filter((_, i) => msg.edits[i].status === "pending").length;
    if (!msg.streaming && pendingCount > 1) {
      const bar = el("div", "ai-edit-all");
      const b = el("button", "primary", `Aplicar los ${pendingCount} cambios`);
      b.type = "button";
      b.onclick = () => applyAll(msg);
      bar.append(b);
      children.push(bar);
    }
    if (msg.cancelled) children.push(el("div", "ai-note", "Respuesta detenida."));
    if (!msg.streaming && !msg.parsed.length) {
      const actions = answerActions(msg);
      if (actions) children.push(actions);
    }
    if (tail) children.push(tail);
    node.replaceChildren(...children);
  }

  function reasoningBox(msg, live) {
    const d = el("details", "ai-reasoning");
    d.open = live || !!msg.reasoningOpen;
    d.append(el("summary", null, live ? "Razonando…" : "Razonamiento"), el("div", "ai-reasoning-body", msg.thinking));
    if (!live) d.addEventListener("toggle", () => (msg.reasoningOpen = d.open));
    return d;
  }

  function buildEditCard(msg, edit, i) {
    const state = msg.edits[i];
    const card = el("div", `ai-edit ${state.status}`);
    const head = el("div", "ai-edit-head");
    const ed = msg.tab?.el || window.App.editor;
    const label = msg.block ? msg.block.label
      : edit.kind === "append" ? "Añadir al final"
      : edit.kind === "prepend" ? "Añadir al inicio"
      : !edit.search.trim() ? "Reemplazar todo el documento"
      : !edit.replace ? "Eliminar" : "Cambio";
    head.append(el("span", "ai-edit-title", `${label} ${msg.parsed?.length > 1 || i > 0 ? `#${i + 1}` : ""}`.trim()));

    const doc = ed?.value ?? "";
    const found = edit.kind !== "replace" || !edit.search.trim() || !!locate(doc, edit.search);
    if (state.status === "pending" && !found) state.status = "missing";
    if (state.status === "missing" && found) state.status = "pending";

    const actions = el("div", "ai-edit-actions");
    if (state.status === "pending" && !msg.streaming) {
      const apply = el("button", "primary", "Aplicar");
      apply.type = "button";
      apply.onclick = () => {
        state.status = applyEdit(edit, state, ed) ? "applied" : "missing";
        refresh(msg);
      };
      const discard = el("button", null, "Descartar");
      discard.type = "button";
      discard.onclick = () => { state.status = "discarded"; refresh(msg); };
      actions.append(discard, apply);
    } else if (state.status === "applied") {
      actions.append(el("span", "ai-edit-badge ok", "Aplicado"));
      if (state.undo) {
        const undo = el("button", null, "Deshacer");
        undo.type = "button";
        undo.onclick = () => {
          if (undoEdit(state, ed)) {
            state.status = "pending";
            state.undo = null;
          } else {
            window.App.flash("No se pudo deshacer: el texto cambió después de aplicarlo");
          }
          refresh(msg);
        };
        actions.append(undo);
      }
    } else if (state.status === "discarded") {
      actions.append(el("span", "ai-edit-badge", "Descartado"));
    } else if (state.status === "missing") {
      actions.append(el("span", "ai-edit-badge warn", "No se encontró el texto en el documento"));
    }
    head.append(actions);
    card.append(head);

    const pre = el("pre", "ai-diff");
    const lines = diffLines(edit.kind === "replace" && edit.search.trim() ? edit.search : "", edit.replace);
    // Con mucho contexto sin cambios, solo se muestran 2 líneas alrededor de cada cambio
    const keep = lines.map(([t]) => t !== " ");
    const show = lines.map((_, k) => keep.slice(Math.max(0, k - 2), k + 3).some(Boolean));
    let skipped = false;
    lines.forEach(([t, text], k) => {
      if (!show[k]) {
        if (!skipped) pre.append(el("span", "ai-diff-skip", "⋯\n"));
        skipped = true;
        return;
      }
      skipped = false;
      pre.append(el("span", t === "-" ? "del" : t === "+" ? "add" : "ctx", `${t} ${text}\n`));
    });
    card.append(pre);
    return card;
  }

  function refresh(msg) {
    if (msg.node?.isConnected) fillMessage(msg.node, msg);
  }

  function applyAll(msg) {
    msg.parsed.forEach((edit, i) => {
      if (msg.edits[i].status !== "pending") return;
      msg.edits[i].status = applyEdit(edit, msg.edits[i], msg.tab?.el) ? "applied" : "missing";
    });
    refresh(msg);
  }

  // ---------- Envío y streaming ----------

  function selectionText() {
    const ed = window.App.editor;
    if (!ed || document.body.dataset.mode === "view") return "";
    return ed.value.slice(ed.selectionStart, ed.selectionEnd);
  }

  function updateContext() {
    const tab = window.App.tab;
    if (!tab) return;
    const sel = selectionText();
    const lines = sel ? sel.split("\n").length : 0;
    contextEl.textContent = `📄 ${baseName(tab.path)}` + (sel ? ` · selección (${lines} ${lines === 1 ? "línea" : "líneas"})` : "");
  }

  function updateSendButton(chat) {
    const busy = chat.job !== null;
    sendBtn.textContent = busy ? "Detener" : "Enviar";
    sendBtn.classList.toggle("primary", !busy);
    sendBtn.classList.toggle("stop", busy);
  }

  async function send(text) {
    const tab = window.App.tab;
    const chat = chatOf(tab);
    text = text.trim();
    if (!text || chat.job !== null) return;
    if (!config.active || !usable(config.active)) return openSettings();
    const id = config.active;
    const p = config.providers[id];

    const history = chat.messages
      .filter((m) => !m.block && (!m.error || m.content))
      .map((m) => ({ role: m.role, content: m.content }))
      .filter((m) => m.content.trim());
    const mode = window.Intent?.classify(text) || "write";
    const user = { role: "user", content: text, mode };
    const reply = { role: "assistant", content: "", streaming: true, tab, mode };
    if (!chat.messages.length) messagesEl.replaceChildren();
    chat.messages.push(user, reply);
    for (const m of [user, reply]) {
      m.node = buildMessage(m);
      messagesEl.append(m.node);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    promptEl.value = "";

    const job = ++nextJob;
    chat.job = job;
    jobs.set(job, { chat, msg: reply, tab });
    updateSendButton(chat);
    try {
      await invoke("ai_chat", {
        id: job,
        provider: id,
        model: p.model,
        baseUrl: p.base,
        system: systemPrompt(tab, selectionText(), mode),
        messages: [...history, user],
      });
    } catch (e) {
      finish(job, String(e));
    }
  }

  let paintTimer = null;
  function schedulePaint(msg) {
    if (paintTimer) return;
    paintTimer = setTimeout(() => {
      paintTimer = null;
      if (!msg.node?.isConnected) return;
      const stick = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
      fillMessage(msg.node, msg).then(() => {
        if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    }, 80);
  }

  function finish(job, error) {
    const j = jobs.get(job);
    if (!j) return;
    jobs.delete(job);
    if (j.chat.job === job) j.chat.job = null;
    j.msg.streaming = false;
    if (error) j.msg.error = error;
    if (j.msg.block) finishBlock(j);
    else {
      if (!error && !j.msg.cancelled && j.msg.mode === "write") wrapLooseContent(j.msg);
      autoApply(j, false);
    }
    if (window.App.tab === j.tab) {
      updateSendButton(j.chat);
      clearTimeout(paintTimer);
      paintTimer = null;
      refresh(j.msg);
      setTimeout(() => (messagesEl.scrollTop = messagesEl.scrollHeight), 50);
    }
  }

  listen("ai-event", ({ payload }) => {
    const j = jobs.get(payload.id);
    if (!j) return;
    if (payload.kind === "delta" || payload.kind === "thinking") {
      if (payload.kind === "delta") {
        j.msg.content += payload.text;
        // Cada bloque de cambio se aplica en cuanto llega su marcador de cierre
        if (!j.msg.block && payload.text.includes(">")) autoApply(j, true);
      } else j.msg.thinking = (j.msg.thinking || "") + payload.text;
      if (window.App.tab === j.tab) schedulePaint(j.msg);
    } else {
      finish(payload.id, payload.kind === "error" ? payload.text : null);
    }
  });

  // Aplica directamente al documento los bloques de cambio terminados que aún no se aplicaron
  function autoApply(j, streaming) {
    const edits = parseReply(j.msg.content, streaming).filter((p) => p.type === "edit");
    j.msg.edits ||= [];
    let changed = false;
    edits.forEach((edit, i) => {
      const st = (j.msg.edits[i] ||= { status: "pending" });
      if (st.auto) return;
      st.auto = true;
      st.status = applyEdit(edit, st, j.tab.el) ? "applied" : "missing";
      changed = true;
    });
    if (changed && streaming && window.App.tab === j.tab) schedulePaint(j.msg);
  }

  // Los modelos pequeños a veces escriben el contenido pedido sin bloques de edición: se envuelve
  // en un bloque AL FINAL, quitando la frase de introducción («Aquí tienes…») y la de cierre
  function wrapLooseContent(msg) {
    const parts = parseReply(msg.content, false);
    if (parts.some((p) => p.type === "edit" || p.type === "bad")) return;
    const text = msg.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!text) return;
    const paras = text.split(/\n{2,}/);
    const intro = [], outro = [];
    const INTRO = /^(¡?claro|¡?por supuesto|¡?perfecto|¡?entendido|¡?listo|aqu[ií] (tienes|est[aá])|a continuaci[oó]n|he (a[nñ]adido|agregado|escrito)|este es|esta es|te dejo)\b|:\s*$/i;
    const OUTRO = /^(¿?quieres|¿?te gustar[ií]a|si (quieres|necesitas|deseas)|espero que|¿?necesitas|av[ií]same|d[ií]me si)\b/i;
    while (paras.length > 1 && INTRO.test(paras[0].trim()) && paras[0].length < 220) intro.push(paras.shift());
    while (paras.length > 1 && OUTRO.test(paras[paras.length - 1].trim()) && paras[paras.length - 1].length < 220) outro.unshift(paras.pop());
    let body = paras.join("\n\n");
    const fenced = body.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
    if (fenced) body = fenced[1];
    if (!body.trim()) return;
    msg.content = [...intro, `<<<<<<< AL FINAL\n${body}\n>>>>>>> FIN`, ...outro].join("\n\n");
  }

  // Texto de la respuesta sin los bloques de edición, para añadirlo al documento o copiarlo
  function answerText(msg) {
    return parseReply(msg.content, false).filter((p) => p.type === "text").map((p) => p.text.trim()).join("\n\n")
      .replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  }

  // Botones bajo una respuesta del chat: añadirla al documento o copiarla
  function answerActions(msg) {
    const text = answerText(msg);
    if (!text) return null;
    const bar = el("div", "ai-answer-actions");
    const ed = msg.tab?.el || window.App.editor;
    const ICON_ADD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/></svg>';
    const ICON_COPY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
    const ICON_UNDO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>';
    const mk = (icon, label, title, onclick) => {
      const b = el("button", "ai-answer-btn");
      b.type = "button";
      b.title = title;
      b.innerHTML = icon;
      b.append(el("span", null, label));
      b.onclick = onclick;
      return b;
    };
    if (msg.added?.undo) {
      bar.append(el("span", "ai-edit-badge ok", "✓ Añadido al documento"), mk(ICON_UNDO, "Deshacer", "Quitarlo del documento", () => {
        if (undoEdit(msg.added, ed)) msg.added = null;
        else window.App.flash("No se pudo deshacer: el texto cambió después");
        refresh(msg);
      }));
    } else {
      bar.append(mk(ICON_ADD, "Agregar al documento", "Añadir esta respuesta al final del documento", () => {
        const state = {};
        if (applyEdit({ kind: "append", replace: text }, state, ed)) {
          msg.added = state;
          window.App.flash("Respuesta añadida al documento");
        }
        refresh(msg);
      }));
    }
    bar.append(mk(ICON_COPY, "Copiar", "Copiar la respuesta (Markdown)", async () => {
      await navigator.clipboard.writeText(text);
      window.App.flash("Copiado");
    }));
    return bar;
  }

  function stop() {
    const chat = chatOf(window.App.tab);
    if (chat.job === null) return;
    const j = jobs.get(chat.job);
    if (j) j.msg.cancelled = true;
    invoke("ai_cancel", { id: chat.job });
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (chatOf(window.App.tab).job !== null) stop();
    else send(promptEl.value);
  });
  promptEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  document.getElementById("ai-new-chat").onclick = () => {
    const tab = window.App.tab;
    stop();
    chats.set(tab, { messages: [], job: null });
    renderChat();
    promptEl.focus();
  };

  // Enlaces de las respuestas: en el navegador del sistema
  messagesEl.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") || "";
    if (/^(https?|mailto):/i.test(href)) invoke("open_url", { url: href });
  });

  document.addEventListener("selectionchange", () => {
    if (!panel.hidden && document.activeElement === window.App.editor) updateContext();
  });

  // ---------- Acciones de IA sobre bloques de la vista previa ----------
  // Cada bloque renderizado lleva data-from/data-to con sus líneas en el texto (ver render_markdown).

  const preview = document.getElementById("preview");
  const BLOCK_ACTIONS = {
    refine: {
      verb: "Refinar",
      busy: "Refinando",
      mode: "replace",
      instruction: "Mejora la redacción: que sea más clara, fluida y correcta, sin cambiar el sentido, la extensión aproximada ni el formato Markdown.",
    },
    modify: {
      verb: "Modificar",
      busy: "Modificando",
      mode: "replace",
      ask: "¿Cómo quieres cambiarlo?",
      placeholder: "Ej.: hazlo más corto y directo",
      chips: ["Más corto", "Más detallado", "Más formal", "Más sencillo", "Corrige la ortografía", "Conviértelo en una lista", "Tradúcelo al inglés"],
    },
    generate: {
      verb: "Generar",
      busy: "Generando texto a partir de",
      mode: "insert",
      ask: "¿Qué texto quieres generar a partir de esto? (se añade debajo)",
      placeholder: "Ej.: un párrafo con un ejemplo práctico",
      chips: ["Continúa el texto", "Escribe un ejemplo", "Resume los puntos clave en una lista", "Escribe una conclusión", "Añade un párrafo con más contexto"],
    },
  };

  // Rango de caracteres [inicio, fin) de las líneas from..to (sin el salto de línea final)
  function linesRange(doc, from, to) {
    const offs = [0];
    for (let i = doc.indexOf("\n"); i >= 0; i = doc.indexOf("\n", i + 1)) offs.push(i + 1);
    const start = offs[Math.min(from, offs.length - 1)];
    const end = to + 1 < offs.length ? offs[to + 1] - 1 : doc.length;
    return [start, Math.max(start, end)];
  }

  const blockRange = (b) => ({ from: +b.dataset.from, to: +b.dataset.to });
  const blocks = () => [...preview.querySelectorAll(":scope > .md-block")];
  const inRange = (r, b) => b.from >= r.from && b.to <= r.to;
  let selection = null; // { from, to } de varios bloques seleccionados
  let hovered = null; // elemento .md-block bajo el ratón
  let pinned = false; // con el cuadro de instrucciones abierto, la barra no se mueve
  let target = null; // { from, to } sobre el que actuará la barra

  const tools = el("div", "block-tools");
  tools.hidden = true;
  const toolsBar = el("div", "block-tools-bar");
  const toolsLabel = el("span", "block-tools-label");
  const mkTool = (text, title, onclick) => {
    const b = el("button", null, text);
    b.type = "button";
    b.title = title;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.onclick = onclick;
    return b;
  };
  const selectBtn = mkTool("", "Seleccionar varios bloques: marca uno y luego otro para incluir todo lo que hay entre ambos (también puedes seleccionar texto con el ratón)", () => toggleSelect());
  toolsBar.append(
    toolsLabel,
    mkTool("✦ Refinar", "Mejorar la redacción con IA", () => runBlock("refine")),
    mkTool("✎ Modificar…", "Cambiarlo con una instrucción", () => openAsk("modify")),
    mkTool("＋ Generar…", "Generar texto nuevo a partir de esto (se añade debajo)", () => openAsk("generate")),
    selectBtn,
  );

  const ask = el("form", "block-ask");
  ask.hidden = true;
  const askTitle = el("div", "block-ask-title");
  const askInput = el("textarea");
  askInput.rows = 2;
  const askChips = el("div", "block-ask-chips");
  const askSend = el("button", "primary", "Enviar");
  askSend.type = "submit";
  const askCancel = el("button", null, "Cancelar");
  askCancel.type = "button";
  askCancel.onclick = () => closeAsk();
  const askActions = el("div", "block-ask-actions");
  askActions.append(el("span", "ai-hint", "Enter envía · Esc cierra"), askCancel, askSend);
  ask.append(askTitle, askInput, askChips, askActions);
  tools.append(toolsBar, ask);
  document.body.append(tools);

  const toast = el("div", "ai-toast");
  toast.hidden = true;
  document.body.append(toast);
  let toastTimer;
  function showToast(text, undo, sticky) {
    clearTimeout(toastTimer);
    toast.replaceChildren(el("span", null, text));
    if (undo) {
      const b = el("button", null, "Deshacer");
      b.type = "button";
      b.onclick = () => { undo(); toast.hidden = true; };
      toast.append(b);
    }
    toast.hidden = false;
    if (!sticky) toastTimer = setTimeout(() => (toast.hidden = true), undo ? 9000 : 5000);
  }

  function paintBlocks() {
    const working = [...jobs.values()].filter((j) => j.msg.block?.streamingRange && j.tab === window.App.tab);
    for (const b of blocks()) {
      const r = blockRange(b);
      b.classList.toggle("selected", !!selection && inRange(selection, r));
      b.classList.toggle("ai-working", working.some((j) => inRange(j.msg.block.streamingRange, r)));
      b.classList.toggle("hover", b === hovered);
    }
  }

  function placeTools() {
    if (!hovered?.isConnected) return hideTools(true);
    const r = hovered.getBoundingClientRect();
    const p = preview.getBoundingClientRect();
    tools.hidden = false;
    const w = tools.offsetWidth;
    const barH = toolsBar.offsetHeight;
    // Encima del borde superior del bloque, alineada a la derecha y siempre dentro de la vista previa
    let top = Math.max(r.top - barH + 1, p.top + 4);
    top = Math.min(top, window.innerHeight - tools.offsetHeight - 8);
    tools.style.top = `${top}px`;
    tools.style.left = `${Math.max(p.left + 4, Math.min(r.right - w, p.right - w - 14))}px`;
  }

  function updateTools() {
    if (!hovered) return;
    const own = blockRange(hovered);
    target = selection && inRange(selection, own) ? selection : own;
    const multi = target === selection && (selection.from !== own.from || selection.to !== own.to);
    const n = blocks().filter((b) => inRange(target, blockRange(b))).length;
    toolsLabel.textContent = `${n} bloques`;
    toolsLabel.hidden = !multi;
    selectBtn.textContent = selection && inRange(selection, own) ? "✕ Quitar selección" : selection ? "☐ Ampliar selección" : "☐ Seleccionar";
    paintBlocks();
    placeTools();
  }

  function hideTools(force) {
    if (pinned && !force) return;
    tools.hidden = true;
    hovered = null;
    paintBlocks();
  }

  preview.addEventListener("mouseover", (e) => {
    if (pinned) return;
    const b = e.target.closest(".md-block");
    if (!b || b.parentElement !== preview || b === hovered) return;
    hovered = b;
    updateTools();
  });
  preview.addEventListener("mouseleave", (e) => {
    if (!tools.contains(e.relatedTarget)) hideTools();
  });
  tools.addEventListener("mouseleave", (e) => {
    if (!e.relatedTarget?.closest?.("#preview")) hideTools();
  });
  preview.addEventListener("scroll", () => !tools.hidden && placeTools());
  window.addEventListener("resize", () => !tools.hidden && placeTools());

  // Seleccionar texto con el ratón a lo largo de varios bloques los selecciona todos
  preview.addEventListener("mouseup", () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || pinned) return;
    const touched = blocks().filter((b) => sel.containsNode(b, true));
    if (touched.length < 2) return;
    const rs = touched.map(blockRange);
    selection = { from: Math.min(...rs.map((r) => r.from)), to: Math.max(...rs.map((r) => r.to)) };
    hovered = touched[touched.length - 1];
    updateTools();
  });

  function toggleSelect() {
    const own = blockRange(hovered);
    if (selection && inRange(selection, own)) selection = null;
    else if (selection) selection = { from: Math.min(selection.from, own.from), to: Math.max(selection.to, own.to) };
    else selection = own;
    updateTools();
  }

  let askAction = null;
  function openAsk(action) {
    const a = BLOCK_ACTIONS[action];
    askAction = action;
    pinned = true;
    tools.classList.add("pinned");
    askTitle.textContent = a.ask;
    askInput.placeholder = a.placeholder;
    askInput.value = "";
    askChips.replaceChildren(...a.chips.map((c) => {
      const b = el("button", null, c);
      b.type = "button";
      b.onclick = () => { askInput.value = c; ask.requestSubmit(); };
      return b;
    }));
    ask.hidden = false;
    placeTools();
    askInput.focus();
  }

  function closeAsk() {
    ask.hidden = true;
    pinned = false;
    tools.classList.remove("pinned");
    askAction = null;
    hideTools();
  }

  ask.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = askInput.value.trim();
    if (!text) return askInput.focus();
    const action = askAction;
    ask.hidden = true;
    pinned = false;
    tools.classList.remove("pinned");
    runBlock(action, text);
  });
  askInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask.requestSubmit(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeAsk(); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && selection && !pinned) {
      selection = null;
      if (hovered) updateTools(); else paintBlocks();
    }
  });
  document.addEventListener("mousedown", (e) => {
    if (pinned && !tools.contains(e.target)) closeAsk();
  });

  function blockSystemPrompt(tab, fragment, range, mode) {
    const what = mode === "insert"
      ? "Devuelve SOLO el texto nuevo que se insertará justo después del fragmento: en Markdown, listo para pegar, sin repetir el fragmento."
      : "Devuelve SOLO el texto que reemplazará al fragmento: en Markdown, listo para pegar. Conserva su formato (títulos, listas, enlaces, énfasis) salvo que la instrucción pida cambiarlo.";
    return `Eres el asistente de escritura de MD Viewer, un editor de Markdown. El usuario ha elegido un fragmento de su documento y te da una instrucción sobre él.

${what}
No escribas explicaciones, introducciones («Aquí tienes…»), comentarios ni comillas alrededor, y no envuelvas la respuesta en un bloque de código. Escribe en el idioma del fragmento salvo que la instrucción pida otro. Tu respuesta se inserta tal cual en el documento.

Documento completo, como contexto («${baseName(tab.path)}»):
<documento>
${tab.el.value}
</documento>

Fragmento elegido (líneas ${range.from + 1}–${range.to + 1}):
<fragmento>
${fragment}
</fragmento>`;
  }

  // Limpia lo que suelen añadir los modelos aunque se les pida que no
  function cleanGenerated(text, fragment) {
    let t = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const fenced = t.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
    if (fenced && !fragment.trim().startsWith("```")) t = fenced[1];
    t = t.replace(/^<fragmento>\s*|\s*<\/fragmento>$/g, "");
    return t.replace(/^\n+|\s+$/g, "");
  }

  async function runBlock(action, instruction) {
    const tab = window.App.tab;
    if (!tab || !target) return;
    if (!config.active || !usable(config.active)) return openSettings();
    const a = BLOCK_ACTIONS[action];
    const range = { ...target };
    const doc = tab.el.value;
    const [start, end] = linesRange(doc, range.from, range.to);
    const fragment = doc.slice(start, end);
    const inside = blocks().filter((b) => inRange(range, blockRange(b)));
    const what = inside.length > 1 ? `${inside.length} bloques`
      : inside[0]?.firstElementChild?.tagName === "P" ? "párrafo" : "bloque";
    const label = `${a.verb} ${what}`;
    selection = null;
    pinned = false;
    hideTools(true);

    const chat = chatOf(tab);
    const p = config.providers[config.active];
    const user = { role: "user", content: instruction ? `${a.verb} ${what}: ${instruction}` : label, block: true };
    const reply = {
      role: "assistant", content: "", streaming: true, tab,
      block: { label, mode: a.mode, start, fragment, streamingRange: range },
    };
    const visible = window.App.tab === tab && !panel.hidden;
    if (!chat.messages.length && visible) messagesEl.replaceChildren();
    chat.messages.push(user, reply);
    if (visible) {
      for (const m of [user, reply]) { m.node = buildMessage(m); messagesEl.append(m.node); }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    const job = ++nextJob;
    jobs.set(job, { chat, msg: reply, tab });
    paintBlocks();
    showToast(`${a.busy} ${inside.length > 1 ? "los bloques" : `el ${what}`}…`, null, true);
    try {
      await invoke("ai_chat", {
        id: job,
        provider: config.active,
        model: p.model,
        baseUrl: p.base,
        system: blockSystemPrompt(tab, fragment, range, a.mode),
        messages: [{ role: "user", content: instruction || a.instruction }],
      });
    } catch (e) {
      finish(job, String(e));
    }
  }

  // Al terminar una acción sobre bloques, el resultado se escribe directamente en el documento
  function finishBlock(j) {
    const msg = j.msg, b = msg.block;
    b.streamingRange = null;
    if (window.App.tab === j.tab) paintBlocks();
    if (msg.error) return showToast(msg.error);
    if (msg.cancelled) return (toast.hidden = true);
    const text = cleanGenerated(msg.content, b.fragment);
    if (!text) {
      msg.error = "El modelo no devolvió texto.";
      return showToast(msg.error);
    }
    const edit = {
      kind: "replace",
      at: b.start,
      search: b.fragment,
      replace: b.mode === "insert" ? `${b.fragment}\n\n${text}` : text,
    };
    const state = { status: "pending", auto: true };
    msg.parsed = [edit];
    msg.edits = [state];
    state.status = applyEdit(edit, state, j.tab.el) ? "applied" : "missing";
    if (state.status === "applied") {
      showToast(`${b.label}: hecho.`, () => {
        if (undoEdit(state, j.tab.el)) { state.status = "pending"; state.undo = null; refresh(msg); }
        else window.App.flash("No se pudo deshacer: el texto cambió después");
      });
    } else {
      showToast("No se pudo aplicar: el fragmento cambió mientras se generaba el texto.");
    }
  }

  // Mensaje del chat de una acción sobre bloques: el texto en vivo y, al terminar, la tarjeta del cambio
  async function fillBlockMessage(node, msg, seq) {
    const children = msg.thinking ? [reasoningBox(msg, msg.streaming && !msg.content)] : [];
    if (msg.streaming || !msg.parsed) {
      if (msg.content) {
        const div = el("div", "markdown ai-md");
        div.innerHTML = await md(msg.content);
        children.push(div);
      }
      if (msg.streaming) children.push(el("div", "ai-thinking", msg.content ? "Escribiendo" : "Pensando"));
      else if (msg.cancelled) children.push(el("div", "ai-note", "Respuesta detenida."));
    } else {
      children.push(buildEditCard(msg, msg.parsed[0], 0));
    }
    if (fillSeq.get(node) !== seq) return;
    node.replaceChildren(...children);
  }

  // ---------- Selector de proveedor del panel ----------

  function renderProviderSelect() {
    providerSel.replaceChildren();
    const ready = Object.keys(PROVIDERS).filter(usable);
    for (const id of ready) {
      const o = new Option(`${PROVIDERS[id].name} · ${config.providers[id].model || "sin modelo"}`, id);
      providerSel.append(o);
    }
    providerSel.append(new Option("Configurar proveedores…", "__settings"));
    providerSel.value = config.active && usable(config.active) ? config.active : "__settings";
  }

  providerSel.addEventListener("change", () => {
    if (providerSel.value === "__settings") {
      renderProviderSelect();
      openSettings();
      return;
    }
    config.active = providerSel.value;
    saveConfig();
  });

  // ---------- Configuración ----------

  const dlg = document.getElementById("ai-settings");
  const sProvider = document.getElementById("ais-provider");
  const sHelp = document.getElementById("ais-help");
  const sKeyRow = document.getElementById("ais-key-row");
  const sKey = document.getElementById("ais-key");
  const sKeyStatus = document.getElementById("ais-key-status");
  const sKeyDelete = document.getElementById("ais-key-delete");
  const sBase = document.getElementById("ais-base");
  const sModel = document.getElementById("ais-model");
  const sModels = document.getElementById("ais-models");
  const sLoad = document.getElementById("ais-load-models");
  const sMsg = document.getElementById("ais-msg");

  for (const [id, p] of Object.entries(PROVIDERS)) sProvider.append(new Option(p.name, id));

  function msg(text, kind = "") {
    sMsg.textContent = text;
    sMsg.className = `ais-msg ${kind}`;
  }

  function fillSettings(id) {
    const p = PROVIDERS[id];
    const c = config.providers[id];
    sHelp.replaceChildren(document.createTextNode(p.help + " "));
    if (p.keyUrl) {
      const a = el("a", null, "Obtener una API key");
      a.href = p.keyUrl;
      a.onclick = (e) => { e.preventDefault(); invoke("open_url", { url: p.keyUrl }); };
      sHelp.append(a);
    }
    sKeyRow.hidden = !p.key;
    sKey.value = "";
    const h = keyHints[id];
    sKey.placeholder = h ? "Escribe una clave nueva para reemplazarla" : p.key === "optional" ? "Opcional" : "Pega aquí tu API key";
    sKeyStatus.textContent = h ? `Clave guardada (${h})` : "Sin clave guardada";
    sKeyDelete.hidden = !h;
    sBase.value = c.base;
    sModel.value = c.model;
    sModels.replaceChildren();
    msg("");
  }

  async function openSettings() {
    sProvider.value = config.active || "anthropic";
    fillSettings(sProvider.value);
    if (!dlg.open) dlg.showModal();
    (PROVIDERS[sProvider.value].key && !keyHints[sProvider.value] ? sKey : sModel).focus();
  }

  sProvider.addEventListener("change", () => fillSettings(sProvider.value));

  // Guarda la clave escrita (si hay) antes de usarla para cargar modelos o guardar
  async function storeTypedKey(id) {
    const k = sKey.value.trim();
    if (!k) return;
    keyHints[id] = await invoke("ai_set_key", { provider: id, key: k });
    sKey.value = "";
    fillSettingsKeepFields(id);
  }

  function fillSettingsKeepFields(id) {
    const base = sBase.value, model = sModel.value;
    const options = [...sModels.children];
    fillSettings(id);
    sBase.value = base;
    sModel.value = model;
    sModels.replaceChildren(...options);
  }

  sKeyDelete.onclick = async () => {
    const id = sProvider.value;
    try {
      keyHints[id] = await invoke("ai_set_key", { provider: id, key: null });
      fillSettingsKeepFields(id);
      msg("Clave borrada del llavero.");
      renderProviderSelect();
    } catch (e) {
      msg(String(e), "error");
    }
  };

  sLoad.onclick = async () => {
    const id = sProvider.value;
    sLoad.disabled = true;
    msg("Consultando modelos…");
    try {
      await storeTypedKey(id);
      const models = await invoke("ai_list_models", { provider: id, baseUrl: sBase.value.trim() || PROVIDERS[id].base });
      sModels.replaceChildren(...models.map((m) => new Option(m, m)));
      if (!models.length) msg("Conexión correcta, pero el proveedor no devolvió modelos.", "error");
      else {
        if (!sModel.value || !models.includes(sModel.value)) sModel.value = models[0];
        msg(`Conexión correcta: ${models.length} modelos disponibles. Elige uno en el campo Modelo.`, "ok");
      }
    } catch (e) {
      msg(String(e), "error");
    } finally {
      sLoad.disabled = false;
    }
  };

  document.getElementById("ais-cancel").onclick = () => dlg.close();
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });

  document.getElementById("ai-settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = sProvider.value;
    try {
      await storeTypedKey(id);
    } catch (err) {
      return msg(String(err), "error");
    }
    if (PROVIDERS[id].key === true && !keyHints[id]) return msg("Agrega la API key para usar este proveedor.", "error"), sKey.focus();
    if (!sModel.value.trim()) return msg("Escribe o elige un modelo.", "error"), sModel.focus();
    config.providers[id] = { base: sBase.value.trim() || PROVIDERS[id].base, model: sModel.value.trim() };
    config.active = id;
    saveConfig();
    dlg.close();
    renderProviderSelect();
    const tab = window.App.tab;
    if (tab && !chatOf(tab).messages.length) renderEmpty();
    promptEl.focus();
  });

  // ---------- Panel ----------

  function setOpen(open) {
    panel.hidden = !open;
    document.body.classList.toggle("ai-open", open);
    toggleBtn.classList.toggle("active", open);
    toggleBtn.setAttribute("aria-pressed", String(open));
    try { localStorage.setItem("md-viewer.ai-open", open ? "1" : ""); } catch {}
    if (open) {
      renderChat();
      updateContext();
      promptEl.focus();
    } else {
      window.App.editor?.focus();
    }
  }

  toggleBtn.onclick = () => setOpen(panel.hidden);
  document.getElementById("ai-close").onclick = () => setOpen(false);
  document.getElementById("ai-open-settings").onclick = () => openSettings();

  window.AI = {
    toggle: () => setOpen(panel.hidden),
    replaceRange: (el, start, end, text) => replaceRange(el, start, end, text),
    // Texto de los bloques seleccionados en la vista previa (para la herramienta MCP get_selection)
    selectedText() {
      if (!selection) return "";
      const [a, b] = linesRange(window.App.tab.el.value, selection.from, selection.to);
      return window.App.tab.el.value.slice(a, b);
    },
    onTabChange() {
      selection = null;
      pinned = false;
      ask.hidden = true;
      hideTools(true);
      if (panel.hidden) return;
      renderChat();
      updateContext();
    },
    // La vista previa se vuelve a generar en cada cambio: se restauran selección y marcas
    onPreviewRender() {
      if (hovered && !hovered.isConnected) {
        const r = blockRange(hovered);
        hovered = blocks().find((b) => +b.dataset.from === r.from) || null;
        if (hovered) updateTools(); else hideTools(true);
      } else paintBlocks();
    },
    onTabClosed(tab) {
      const chat = chats.get(tab);
      if (chat?.job != null) invoke("ai_cancel", { id: chat.job });
    },
  };

  // ---------- Inicio ----------

  (async () => {
    await Promise.all(Object.keys(PROVIDERS).filter((id) => PROVIDERS[id].key).map(async (id) => {
      try { keyHints[id] = await invoke("ai_key_status", { provider: id }); } catch { keyHints[id] = null; }
    }));
    renderProviderSelect();
    let wasOpen = false;
    try { wasOpen = localStorage.getItem("md-viewer.ai-open") === "1"; } catch {}
    if (wasOpen) setOpen(true);
  })();
})();
