// Herramientas del servidor MCP (src-tauri/src/mcp.rs): Rust recibe la petición del cliente MCP,
// la reenvía aquí como evento `mcp-call` y espera la respuesta en `mcp_reply`.
// Usa las funciones de pestañas de main.js (scripts clásicos: comparten el ámbito global).
(() => {
  const MAX_READ = 400_000;

  // Resuelve el parámetro `document`: id, ruta o nombre de archivo; vacío = pestaña activa
  function findTab(ref) {
    if (ref == null || String(ref).trim() === "") return current;
    const r = String(ref).trim();
    const t = tabs.find((t) => String(t.id) === r)
      || tabs.find((t) => samePath(t.path, r))
      || tabs.filter((t) => baseName(t.path).toLowerCase() === r.toLowerCase()).at(0);
    if (!t) throw new Error(`No hay ningún documento abierto que coincida con «${r}». Usa list_documents para ver los abiertos u open_document para abrir un archivo.`);
    return t;
  }

  const describe = (t) => ({
    id: t.id,
    name: baseName(t.path),
    path: t.path,
    active: t === current,
    unsaved_changes: isDirty(t),
    lines: t.el.value.split("\n").length,
    characters: t.el.value.length,
  });

  // Aplica un cambio como si lo escribiera el usuario (entra en el historial de deshacer)
  function replace(tab, start, end, text) {
    if (tab !== current) activate(tab); // se ve el cambio y la vista previa se actualiza
    window.AI.replaceRange(tab.el, start, end, text);
  }

  function countOccurrences(hay, needle) {
    let n = 0;
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
    return n;
  }

  const normalize = (s) => String(s ?? "").replace(/\r\n?/g, "\n");

  const TOOLS = {
    list_documents() {
      return { documents: tabs.map(describe) };
    },

    read_document({ document, line_numbers }) {
      const t = findTab(document);
      let text = t.el.value;
      if (line_numbers) {
        const lines = text.split("\n");
        const w = String(lines.length).length;
        text = lines.map((l, i) => `${String(i + 1).padStart(w)}\t${l}`).join("\n");
      }
      const head = `Documento ${t.id} · ${baseName(t.path)}${t.path ? ` (${t.path})` : " (sin guardar en disco)"}${isDirty(t) ? " · con cambios sin guardar" : ""}`;
      if (text.length > MAX_READ) text = text.slice(0, MAX_READ) + "\n[… recortado]";
      return `${head}\n\n${text}`;
    },

    get_selection() {
      const t = current;
      const ed = t.el;
      let text = document.body.dataset.mode !== "view" ? ed.value.slice(ed.selectionStart, ed.selectionEnd) : "";
      if (!text) text = window.AI.selectedText?.() || "";
      if (!text) text = String(window.getSelection() || "");
      return text
        ? `Selección en el documento ${t.id} (${baseName(t.path)}):\n\n${text}`
        : `No hay nada seleccionado en el documento ${t.id} (${baseName(t.path)}).`;
    },

    edit_document({ document, old_text, new_text, replace_all }) {
      const t = findTab(document);
      const oldT = normalize(old_text), newT = normalize(new_text);
      if (!oldT) throw new Error("old_text no puede estar vacío (para reemplazar todo usa write_document).");
      const doc = t.el.value;
      const n = countOccurrences(doc, oldT);
      if (n === 0) throw new Error("old_text no aparece en el documento. Vuelve a leerlo con read_document y copia el fragmento exacto.");
      if (n > 1 && !replace_all) throw new Error(`old_text aparece ${n} veces. Añade más contexto para que sea único o usa replace_all.`);
      if (replace_all) {
        replace(t, 0, doc.length, doc.split(oldT).join(newT));
      } else {
        const i = doc.indexOf(oldT);
        replace(t, i, i + oldT.length, newT);
      }
      flash(`MCP: documento editado`);
      return `Hecho: ${replace_all ? `${n} reemplazos` : "1 reemplazo"} en «${baseName(t.path)}» (sin guardar en disco).`;
    },

    insert_text({ document, text, position = "end", line }) {
      const t = findTab(document);
      const body = normalize(text).replace(/^\n+|\n+$/g, "");
      if (!body) throw new Error("text está vacío.");
      const doc = t.el.value;
      if (position === "start") {
        replace(t, 0, 0, body + (doc.trim() ? "\n\n" : "\n"));
      } else if (position === "after_line") {
        const lines = doc.split("\n");
        if (!Number.isInteger(line) || line < 1 || line > lines.length) {
          throw new Error(`line debe estar entre 1 y ${lines.length}.`);
        }
        const at = lines.slice(0, line).join("\n").length;
        replace(t, at, at, `\n\n${body}${line < lines.length && lines[line].trim() ? "\n" : ""}`);
      } else {
        const sep = !doc.trim() ? "" : doc.endsWith("\n\n") ? "" : doc.endsWith("\n") ? "\n" : "\n\n";
        replace(t, doc.length, doc.length, sep + body + "\n");
      }
      flash("MCP: texto insertado");
      return `Hecho: texto insertado en «${baseName(t.path)}» (sin guardar en disco).`;
    },

    write_document({ document, content }) {
      const t = findTab(document);
      replace(t, 0, t.el.value.length, normalize(content));
      flash("MCP: documento reescrito");
      return `Hecho: contenido de «${baseName(t.path)}» reemplazado (sin guardar en disco).`;
    },

    async open_document({ path }) {
      if (!path) throw new Error("Falta path.");
      const existing = tabs.find((t) => samePath(t.path, path));
      if (existing) {
        activate(existing);
        return { opened: describe(existing), note: "Ya estaba abierto" };
      }
      const doc = await invoke("read_file", { path });
      return { opened: describe(openInTab(doc, "split")) };
    },

    new_document({ content }) {
      const t = createTab({ content: "" });
      activate(t);
      if (content) window.AI.replaceRange(t.el, 0, 0, normalize(content));
      return { created: describe(t) };
    },

    async save_document({ document, path }) {
      const t = findTab(document);
      const target = path || t.path;
      if (!target) throw new Error("El documento no tiene archivo: indica path para guardarlo.");
      const content = t.el.value;
      await invoke("write_file", { path: target, content: toDisk(t, content) });
      t.saved = content;
      if (path && !samePath(path, t.path)) {
        t.path = path;
        syncWatch();
      }
      if (t === current) updateTitle();
      else updateTabLabel(t);
      flash("Guardado (MCP)");
      return `Guardado en ${target}.`;
    },
  };

  window.__TAURI__.event.listen("mcp-call", async ({ payload }) => {
    const { id, name, args } = payload;
    try {
      const result = await TOOLS[name](args || {});
      await invoke("mcp_reply", { id, result });
    } catch (e) {
      await invoke("mcp_reply", { id, error: String(e?.message || e) });
    }
  });

  // ---------- Diálogo «Conectar por MCP» ----------

  const dlg = document.getElementById("mcp-dialog");
  const copyable = (id, text) => {
    const box = document.getElementById(id);
    box.querySelector("code").textContent = text;
    box.querySelector("button").onclick = async () => {
      await navigator.clipboard.writeText(text);
      flash("Copiado");
    };
  };

  window.openMcpDialog = async () => {
    const info = await invoke("mcp_info");
    copyable("mcp-url", info.url);
    copyable("mcp-claude-code", `claude mcp add --transport http md-viewer ${info.url}`);
    copyable("mcp-desktop", JSON.stringify({ mcpServers: { "md-viewer": { command: info.exe, args: ["--mcp"] } } }, null, 2));
    const err = document.getElementById("mcp-error");
    err.textContent = info.error || "";
    err.hidden = !info.error;
    dlg.showModal();
  };
  document.getElementById("mcp-close").onclick = () => dlg.close();
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
})();
