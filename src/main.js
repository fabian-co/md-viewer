const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const editor = document.getElementById("editor");
const preview = document.getElementById("preview");
const fileNameEl = document.getElementById("file-name");
const statusMsg = document.getElementById("status-msg");
const statusCount = document.getElementById("status-count");

const state = {
  path: null,
  saved: "",
  crlf: false, // conservar saltos de línea de Windows al guardar
};

const isDirty = () => editor.value !== state.saved;
const baseName = (p) => (p ? p.split(/[\\/]/).pop() : "Sin título");

// ---------- Interfaz ----------

function updateTitle() {
  const name = baseName(state.path);
  const mark = isDirty() ? "• " : "";
  fileNameEl.textContent = mark + (state.path || "Sin título");
  appWindow.setTitle(`${mark}${name} — MD Viewer`);
}

function updateCount() {
  const text = editor.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  statusCount.textContent = `${words} palabras · ${text.length} caracteres`;
}

let statusTimer;
function flash(msg) {
  statusMsg.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (statusMsg.textContent = ""), 3000);
}

let renderTimer;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 120);
}

async function render() {
  preview.innerHTML = await invoke("render_markdown", { text: editor.value });
}

function setMode(mode) {
  document.body.dataset.mode = mode;
  document.querySelectorAll(".modes button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode)
  );
}

// El textarea siempre usa "\n"; al guardar se restaura "\r\n" si el archivo lo usaba
const toDisk = (text) => (state.crlf ? text.replace(/\n/g, "\r\n") : text);

function loadDoc(doc) {
  state.path = doc.path;
  state.crlf = doc.content.includes("\r\n");
  state.saved = doc.content.replace(/\r\n?/g, "\n");
  editor.value = state.saved;
  editor.scrollTop = 0;
  preview.scrollTop = 0;
  render();
  updateTitle();
  updateCount();
}

function confirmDiscard() {
  return !isDirty() || confirm("Hay cambios sin guardar. ¿Descartarlos?");
}

// ---------- Acciones ----------

async function newDoc() {
  if (!confirmDiscard()) return;
  loadDoc({ path: null, content: "" });
  setMode("split");
  editor.focus();
}

async function openDoc() {
  if (!confirmDiscard()) return;
  try {
    const doc = await invoke("open_dialog");
    if (doc) loadDoc(doc);
  } catch (e) {
    alert(e);
  }
}

async function openPath(path) {
  if (!confirmDiscard()) return;
  try {
    loadDoc(await invoke("read_file", { path }));
  } catch (e) {
    alert(e);
  }
}

async function save() {
  if (!state.path) return saveAs();
  try {
    const content = editor.value;
    await invoke("write_file", { path: state.path, content: toDisk(content) });
    state.saved = content;
    updateTitle();
    flash("Guardado");
  } catch (e) {
    alert(e);
  }
}

async function saveAs() {
  try {
    const content = editor.value;
    const path = await invoke("save_as_dialog", {
      content: toDisk(content),
      suggested: state.path ? baseName(state.path) : null,
    });
    if (!path) return;
    state.path = path;
    state.saved = content;
    updateTitle();
    flash("Guardado");
  } catch (e) {
    alert(e);
  }
}

// ---------- Eventos ----------

document.getElementById("btn-new").onclick = newDoc;
document.getElementById("btn-open").onclick = openDoc;
document.getElementById("btn-save").onclick = save;
document.getElementById("btn-save-as").onclick = saveAs;
document.querySelectorAll(".modes button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

editor.addEventListener("input", () => {
  scheduleRender();
  updateTitle();
  updateCount();
});

// Tab inserta espacios en lugar de cambiar el foco
editor.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !e.ctrlKey) {
    e.preventDefault();
    document.execCommand("insertText", false, "  ");
  }
});

// Sincroniza el scroll de la vista previa con el editor (proporcional)
editor.addEventListener("scroll", () => {
  if (document.body.dataset.mode !== "split") return;
  const ratio = editor.scrollTop / Math.max(1, editor.scrollHeight - editor.clientHeight);
  preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
});

// Los enlaces se abren en el navegador del sistema
preview.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") || "";
  if (href.startsWith("#")) {
    document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView();
  } else if (/^(https?|mailto):/i.test(href)) {
    invoke("open_url", { url: href });
  }
});

const modes = ["edit", "split", "view"];
document.addEventListener("keydown", (e) => {
  if (!e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k === "s" && e.shiftKey) { e.preventDefault(); saveAs(); }
  else if (k === "s") { e.preventDefault(); save(); }
  else if (k === "o") { e.preventDefault(); openDoc(); }
  else if (k === "n") { e.preventDefault(); newDoc(); }
  else if (k === "e") {
    e.preventDefault();
    const i = modes.indexOf(document.body.dataset.mode);
    setMode(modes[(i + 1) % modes.length]);
  }
});

// Arrastrar y soltar archivos sobre la ventana
listen("tauri://drag-drop", (event) => {
  const path = event.payload?.paths?.[0];
  if (path) openPath(path);
});

// Avisar de cambios sin guardar al cerrar
appWindow.onCloseRequested((event) => {
  if (!confirmDiscard()) event.preventDefault();
});

// ---------- Inicio ----------

(async () => {
  try {
    const doc = await invoke("startup_file");
    if (doc) {
      loadDoc(doc);
      setMode("view"); // al abrir desde el Explorador se muestra la vista
      return;
    }
  } catch (e) {
    alert(e);
  }
  loadDoc({ path: null, content: "" });
  setMode("split");
  editor.focus();
})();
