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

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const isDirty = () => editor.value !== state.saved;
const baseName = (p) => (p ? p.split(/[\\/]/).pop() : "Sin título");

// ---------- Interfaz ----------

function updateTitle() {
  const name = baseName(state.path);
  const mark = isDirty() ? "• " : "";
  fileNameEl.textContent = mark + (state.path || "Sin título");
  appWindow.setTitle(`${mark}${name} — MD Viewer`);
}

const nf = new Intl.NumberFormat("es");
let tokens = null; // null mientras se calcula
let tokenSeq = 0;

function updateCount() {
  const text = editor.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const tk = tokens === null ? "…" : nf.format(tokens);
  statusCount.textContent = `${nf.format(words)} palabras · ${nf.format(text.length)} caracteres · ≈ ${tk} tokens`;
}

// Los tokens se calculan en Rust y con retraso, como la vista previa
let tokenTimer;
function scheduleTokens() {
  clearTimeout(tokenTimer);
  tokenTimer = setTimeout(async () => {
    const seq = ++tokenSeq;
    try {
      const n = await invoke("count_tokens", { text: editor.value });
      if (seq !== tokenSeq) return; // llegó tarde: ya hay un cálculo más reciente
      tokens = n;
    } catch {
      tokens = null;
    }
    updateCount();
  }, 250);
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

// Vigila el archivo abierto en disco (null deja de vigilar)
function watch(path) {
  invoke("watch_file", { path }).catch((e) => console.warn(e));
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
  scheduleTokens();
  updateTitle();
  updateCount();
  watch(doc.path);
}

// Otro programa (un editor, una IA) modificó el archivo: recargar sin perder el scroll ni el cursor
async function reloadFromDisk(doc) {
  if (doc.path !== state.path) return;
  const content = doc.content.replace(/\r\n?/g, "\n");
  if (content === state.saved) return; // nuestro propio guardado o un cambio sin contenido nuevo
  if (isDirty() && editor.value !== content &&
      !confirm("El archivo cambió en disco. ¿Recargarlo y descartar tus cambios sin guardar?")) {
    return;
  }
  const { selectionStart, selectionEnd, scrollTop } = editor;
  const previewTop = preview.scrollTop;
  state.crlf = doc.content.includes("\r\n");
  state.saved = content;
  editor.value = content;
  editor.setSelectionRange(selectionStart, selectionEnd);
  editor.scrollTop = scrollTop;
  clearTimeout(renderTimer);
  await render();
  preview.scrollTop = previewTop;
  scheduleTokens();
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
    watch(path);
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

// Barra de formato: mousedown sin foco para no perder la selección del editor
document.querySelectorAll("[data-fmt]").forEach((b) => {
  b.onmousedown = (e) => e.preventDefault();
  b.onclick = () => applyFormat(b.dataset.fmt);
});

function applyFormat(name) {
  if (name === "link") openLinkDialog();
  else Format.apply(editor, name);
}

// ---------- Diálogo de hipervínculo ----------

const linkDialog = document.getElementById("link-dialog");
const linkText = document.getElementById("link-text");
const linkUrl = document.getElementById("link-url");
let linkRange = null; // selección del editor al abrir el diálogo

function openLinkDialog() {
  const { value, selectionStart: s, selectionEnd: e } = editor;
  const sel = value.slice(s, e);
  linkRange = [s, e];
  const isUrl = /^(https?:\/\/|mailto:|www\.)\S+$/i.test(sel.trim());
  linkText.value = isUrl ? "" : sel;
  linkUrl.value = isUrl ? sel.trim() : "";
  linkUrl.classList.remove("invalid");
  linkDialog.hidden = false;
  (linkText.value ? linkUrl : linkText).focus();
}

function closeLinkDialog() {
  linkDialog.hidden = true;
  editor.focus();
  if (linkRange) editor.setSelectionRange(...linkRange);
  linkRange = null;
}

function confirmLink() {
  if (!linkUrl.value.trim()) {
    linkUrl.classList.add("invalid");
    linkUrl.focus();
    return;
  }
  const [s, e] = linkRange;
  linkDialog.hidden = true;
  linkRange = null;
  Format.insertLink(editor, s, e, linkText.value, linkUrl.value);
}

linkDialog.addEventListener("submit", (e) => {
  e.preventDefault();
  confirmLink();
});
document.getElementById("link-cancel").onclick = closeLinkDialog;
linkDialog.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeLinkDialog();
  }
});
linkUrl.addEventListener("input", () => linkUrl.classList.remove("invalid"));

// ---------- Acerca de ----------

const REPO = "fabian-co/md-viewer";
const about = document.getElementById("about");
const aboutUpdate = document.getElementById("about-update");
const { getVersion, getTauriVersion } = window.__TAURI__.app;
const appVersion = getVersion();

document.getElementById("btn-about").onclick = async () => {
  const [version, tauri] = await Promise.all([appVersion, getTauriVersion()]);
  document.getElementById("about-version").textContent = `Versión ${version}`;
  document.getElementById("about-tech").textContent = `Tauri ${tauri} + Rust`;
  aboutUpdate.textContent = "";
  aboutUpdate.className = "update";
  about.showModal();
};
document.getElementById("about-close").onclick = () => about.close();
document.getElementById("about-releases").onclick = () =>
  invoke("open_url", { url: `https://github.com/${REPO}/releases` });
about.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (a) {
    e.preventDefault();
    invoke("open_url", { url: a.href });
  } else if (e.target === about) {
    about.close(); // clic fuera del cuadro
  }
});

// Compara "1.2.0" con "1.10.0" numéricamente
const newer = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

document.getElementById("about-check").onclick = async () => {
  aboutUpdate.className = "update";
  aboutUpdate.textContent = "Buscando…";
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!res.ok) throw new Error(res.status);
    const latest = (await res.json()).tag_name.replace(/^v/, "");
    if (newer(latest, await appVersion)) {
      aboutUpdate.className = "update new";
      aboutUpdate.textContent = `Hay una versión nueva: ${latest}. Descárgala en "Ver versiones".`;
    } else {
      aboutUpdate.textContent = "Tienes la última versión.";
    }
  } catch {
    aboutUpdate.textContent = "No se pudo comprobar (¿sin conexión?).";
  }
};

// ---------- Divisor arrastrable (modo dividido) ----------

const panes = document.querySelector(".panes");
const splitter = document.getElementById("splitter");
const SPLIT_KEY = "md-viewer.split";

function setSplit(ratio) {
  const r = Math.min(0.85, Math.max(0.15, ratio));
  panes.style.setProperty("--split", `${r * 100}%`);
  return r;
}

try {
  const saved = parseFloat(localStorage.getItem(SPLIT_KEY));
  if (saved) setSplit(saved);
} catch {}

splitter.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  splitter.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing");
});
splitter.addEventListener("pointermove", (e) => {
  if (!splitter.hasPointerCapture(e.pointerId)) return;
  const box = panes.getBoundingClientRect();
  const r = setSplit((e.clientX - box.left) / box.width);
  try { localStorage.setItem(SPLIT_KEY, r); } catch {}
});
const endDrag = () => document.body.classList.remove("resizing");
splitter.addEventListener("pointerup", endDrag);
splitter.addEventListener("lostpointercapture", endDrag);
// Doble clic: volver a mitad y mitad
splitter.addEventListener("dblclick", () => {
  setSplit(0.5);
  try { localStorage.removeItem(SPLIT_KEY); } catch {}
});

editor.addEventListener("input", () => {
  scheduleRender();
  scheduleTokens();
  updateTitle();
  updateCount();
});

// Tab inserta espacios en lugar de cambiar el foco
editor.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !e.ctrlKey && !e.metaKey) {
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
  // Cmd en macOS, Ctrl en Windows y Linux
  if (!(isMac ? e.metaKey : e.ctrlKey) || e.altKey) return;
  if (document.activeElement === editor) {
    const fmt = Format.shortcut(e);
    if (fmt) {
      e.preventDefault();
      applyFormat(fmt);
      return;
    }
  }
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

// Cambios hechos al archivo abierto desde fuera de la app
listen("file-changed", (event) => reloadFromDisk(event.payload));

// macOS: archivo abierto desde Finder con la app ya en marcha
listen("open-file", (event) => openPath(event.payload));

// Avisar de cambios sin guardar al cerrar
appWindow.onCloseRequested((event) => {
  if (!confirmDiscard()) event.preventDefault();
});

// ---------- Inicio ----------

// Muestra los atajos con ⌘ en macOS
if (isMac) {
  document.querySelectorAll("[title*='Ctrl+']").forEach((el) => {
    el.title = el.title.replace(/Ctrl\+Shift\+/g, "⇧⌘").replace(/Ctrl\+/g, "⌘");
  });
}

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
