const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const editorsEl = document.getElementById("editors");
const tabList = document.getElementById("tab-list");
const preview = document.getElementById("preview");
const fileNameEl = document.getElementById("file-name");
const statusMsg = document.getElementById("status-msg");
const statusCount = document.getElementById("status-count");

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const isWin = /Win/.test(navigator.platform || navigator.userAgent);
const baseName = (p) => (p ? p.split(/[\\/]/).pop() : "Sin título");
// Windows no distingue mayúsculas ni el tipo de barra en las rutas
const normPath = (p) => (isWin ? p.replace(/\//g, "\\").toLowerCase() : p);
const samePath = (a, b) => !!a && !!b && normPath(a) === normPath(b);

// ---------- Pestañas ----------
// Cada pestaña tiene su propio textarea (así conserva su historial de deshacer, cursor y scroll);
// la vista previa es una sola y se vuelve a generar al cambiar de pestaña.

/** @type {{id:number, path:string|null, saved:string, crlf:boolean, mode:string, el:HTMLTextAreaElement, tabEl:HTMLElement, editorTop:number, previewTop:number}[]} */
const tabs = [];
let current = null; // pestaña activa
let editor = null; // textarea de la pestaña activa
let nextId = 1;

const isDirty = (tab = current) => tab.el.value !== tab.saved;
// Pestaña vacía y sin tocar: abrir un archivo la reutiliza en lugar de dejarla huérfana
const isBlank = (tab) => !tab.path && !tab.el.value && !tab.saved;

function createTab({ path = null, content = "", mode = "split" } = {}) {
  const el = document.createElement("textarea");
  el.className = "editor";
  el.spellcheck = false;
  el.placeholder = "Escribe Markdown aquí...";
  el.hidden = true;
  editorsEl.append(el);

  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.setAttribute("role", "tab");
  tabEl.innerHTML = '<span class="tab-name"></span><button class="tab-close" tabindex="-1" aria-label="Cerrar pestaña">×</button>';
  tabList.append(tabEl);

  const tab = { id: nextId++, path: null, saved: "", crlf: false, mode, el, tabEl, editorTop: 0, previewTop: 0 };
  tabs.push(tab);
  setContent(tab, path, content);

  tabEl.addEventListener("mousedown", (e) => {
    if (e.button === 1) e.preventDefault(); // evita el autoscroll del botón central
  });
  tabEl.addEventListener("click", (e) => {
    if (e.target.closest(".tab-close")) closeTab(tab);
    else activate(tab);
  });
  tabEl.addEventListener("auxclick", (e) => {
    if (e.button === 1) closeTab(tab); // clic central cierra
  });
  attachEditor(tab);
  return tab;
}

function setContent(tab, path, content) {
  tab.path = path;
  tab.crlf = content.includes("\r\n");
  tab.saved = content.replace(/\r\n?/g, "\n");
  tab.el.value = tab.saved;
  tab.editorTop = 0;
  tab.previewTop = 0;
  updateTabLabel(tab);
}

function updateTabLabel(tab) {
  tab.tabEl.querySelector(".tab-name").textContent = baseName(tab.path);
  tab.tabEl.title = tab.path || "Sin título";
  tab.tabEl.classList.toggle("dirty", isDirty(tab));
}

function activate(tab) {
  if (current === tab) return;
  if (current) {
    current.editorTop = current.el.scrollTop;
    current.previewTop = preview.scrollTop;
    current.el.hidden = true;
    current.tabEl.classList.remove("active");
    current.tabEl.setAttribute("aria-selected", "false");
  }
  current = tab;
  editor = tab.el;
  editor.hidden = false;
  editor.scrollTop = tab.editorTop;
  tab.tabEl.classList.add("active");
  tab.tabEl.setAttribute("aria-selected", "true");
  tab.tabEl.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (!linkDialog.hidden) closeLinkDialog();
  applyMode(tab.mode);
  clearTimeout(renderTimer);
  render().then(() => (preview.scrollTop = tab.previewTop));
  tokens = null;
  scheduleTokens();
  updateTitle();
  updateCount();
  if (tab.mode !== "view") editor.focus();
  window.AI?.onTabChange(tab);
}

async function closeTab(tab) {
  if (isDirty(tab)) {
    activate(tab);
    if (!confirm(`«${baseName(tab.path)}» tiene cambios sin guardar. ¿Cerrar y descartarlos?`)) return;
  }
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  tab.el.remove();
  tab.tabEl.remove();
  window.AI?.onTabClosed(tab);
  if (current === tab) {
    current = null;
    // Siempre queda al menos una pestaña
    activate(tabs[Math.min(i, tabs.length - 1)] || createTab());
  }
  syncWatch();
}

function cycleTab(step) {
  const i = tabs.indexOf(current);
  activate(tabs[(i + step + tabs.length) % tabs.length]);
}

// Vigila en disco los archivos de todas las pestañas
function syncWatch() {
  const paths = [...new Set(tabs.map((t) => t.path).filter(Boolean))];
  invoke("watch_files", { paths }).catch((e) => console.warn(e));
}

// ---------- Interfaz ----------

function updateTitle() {
  const name = baseName(current.path);
  const mark = isDirty() ? "• " : "";
  fileNameEl.textContent = mark + (current.path || "Sin título");
  appWindow.setTitle(`${mark}${name} — MD Viewer`);
  updateTabLabel(current);
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

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const html = await invoke("render_markdown", { text: editor.value });
  if (seq !== renderSeq) return; // descarta resultados de otra pestaña
  preview.innerHTML = html;
  window.AI?.onPreviewRender();
}

function applyMode(mode) {
  document.body.dataset.mode = mode;
  document.querySelectorAll(".modes button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode)
  );
}

function setMode(mode) {
  current.mode = mode;
  applyMode(mode);
}

// El textarea siempre usa "\n"; al guardar se restaura "\r\n" si el archivo lo usaba
const toDisk = (tab, text) => (tab.crlf ? text.replace(/\n/g, "\r\n") : text);

// Abre un documento en una pestaña: si ya está abierto la activa, si la actual está vacía la reutiliza
function openInTab(doc, mode) {
  const existing = doc.path && tabs.find((t) => samePath(t.path, doc.path));
  if (existing) {
    activate(existing);
    return existing;
  }
  let tab;
  if (current && isBlank(current)) {
    tab = current;
    setContent(tab, doc.path, doc.content);
    tab.mode = mode;
    current = null; // fuerza a refrescar la vista
  } else {
    tab = createTab({ path: doc.path, content: doc.content, mode });
  }
  activate(tab);
  syncWatch();
  return tab;
}

// Otro programa (un editor, una IA) modificó un archivo abierto: recargar sin perder el scroll ni el cursor
async function reloadFromDisk(doc) {
  const tab = tabs.find((t) => t.path === doc.path);
  if (!tab) return;
  const content = doc.content.replace(/\r\n?/g, "\n");
  if (content === tab.saved) return; // nuestro propio guardado o un cambio sin contenido nuevo
  if (isDirty(tab) && tab.el.value !== content &&
      !confirm(`«${baseName(tab.path)}» cambió en disco. ¿Recargarlo y descartar tus cambios sin guardar?`)) {
    return;
  }
  const el = tab.el;
  const { selectionStart, selectionEnd } = el;
  const active = tab === current;
  const scrollTop = active ? el.scrollTop : tab.editorTop;
  tab.crlf = doc.content.includes("\r\n");
  tab.saved = content;
  el.value = content;
  el.setSelectionRange(selectionStart, selectionEnd);
  updateTabLabel(tab);
  if (!active) return; // se renderiza al activarla
  el.scrollTop = scrollTop;
  const previewTop = preview.scrollTop;
  clearTimeout(renderTimer);
  await render();
  preview.scrollTop = previewTop;
  scheduleTokens();
  updateTitle();
  updateCount();
}

// ---------- Acciones ----------

function newDoc() {
  activate(createTab());
  editor.focus();
}

async function openDoc() {
  try {
    const doc = await invoke("open_dialog");
    if (doc) openInTab(doc, "split");
  } catch (e) {
    alert(e);
  }
}

async function openPath(path, mode = "split") {
  const existing = tabs.find((t) => samePath(t.path, path));
  if (existing) return activate(existing);
  try {
    openInTab(await invoke("read_file", { path }), mode);
  } catch (e) {
    alert(e);
  }
}

async function save() {
  const tab = current;
  if (!tab.path) return saveAs();
  try {
    const content = tab.el.value;
    await invoke("write_file", { path: tab.path, content: toDisk(tab, content) });
    tab.saved = content;
    updateTitle();
    flash("Guardado");
  } catch (e) {
    alert(e);
  }
}

async function saveAs() {
  const tab = current;
  try {
    const content = tab.el.value;
    const path = await invoke("save_as_dialog", {
      content: toDisk(tab, content),
      suggested: tab.path ? baseName(tab.path) : null,
    });
    if (!path) return;
    tab.path = path;
    tab.saved = content;
    syncWatch();
    if (tab === current) updateTitle();
    else updateTabLabel(tab);
    flash("Guardado");
  } catch (e) {
    alert(e);
  }
}

// ---------- Eventos ----------

document.getElementById("btn-new-tab").onclick = newDoc;

// ---------- Menús desplegables (Archivo, Acerca de) ----------

const commands = {
  new: newDoc,
  open: openDoc,
  save,
  saveAs,
  close: () => closeTab(current),
  about: () => openAbout(),
  checkUpdates: () => openAbout(true),
  releases: () => invoke("open_url", { url: `https://github.com/${REPO}/releases` }),
  mcp: () => window.openMcpDialog?.(),
};

const menubar = document.getElementById("menubar");
let openMenu = null;

function showMenu(menu) {
  if (openMenu === menu) return;
  closeMenu();
  openMenu = menu;
  menu.classList.add("open");
  menu.querySelector(".menu-btn").setAttribute("aria-expanded", "true");
}

function closeMenu() {
  if (!openMenu) return;
  openMenu.classList.remove("open");
  openMenu.querySelector(".menu-btn").setAttribute("aria-expanded", "false");
  openMenu = null;
}

menubar.querySelectorAll(".menu").forEach((menu) => {
  const btn = menu.querySelector(".menu-btn");
  btn.addEventListener("mousedown", (e) => e.preventDefault()); // no robar el foco al editor
  btn.addEventListener("click", () => (openMenu === menu ? closeMenu() : showMenu(menu)));
  // Con un menú abierto, pasar el ratón por otro lo abre (como en las apps de escritorio)
  btn.addEventListener("mouseenter", () => openMenu && showMenu(menu));
  btn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      showMenu(menu);
      menu.querySelector("[data-cmd]").focus();
    }
  });
  const items = [...menu.querySelectorAll("[data-cmd]")];
  items.forEach((item, i) => {
    item.addEventListener("mousedown", (e) => e.preventDefault());
    item.addEventListener("click", () => {
      closeMenu();
      commands[item.dataset.cmd]();
    });
    item.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
      }
    });
  });
});
document.addEventListener("mousedown", (e) => {
  if (openMenu && !e.target.closest(".menu")) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openMenu) {
    const btn = openMenu.querySelector(".menu-btn");
    closeMenu();
    btn.focus();
  }
});
window.addEventListener("blur", closeMenu);
document.querySelectorAll(".modes button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

// Doble clic en el espacio libre de la barra de pestañas: nueva pestaña
document.getElementById("tabs").addEventListener("dblclick", (e) => {
  if (!e.target.closest(".tab, button")) newDoc();
});
// La rueda del ratón desplaza las pestañas en horizontal
tabList.addEventListener("wheel", (e) => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    tabList.scrollLeft += e.deltaY;
    e.preventDefault();
  }
}, { passive: false });

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

async function openAbout(checkNow = false) {
  const [version, tauri] = await Promise.all([appVersion, getTauriVersion()]);
  document.getElementById("about-version").textContent = `Versión ${version}`;
  document.getElementById("about-tech").textContent = `Tauri ${tauri} + Rust`;
  aboutUpdate.textContent = "";
  aboutUpdate.className = "update";
  if (!about.open) about.showModal();
  if (checkNow) checkUpdates();
}
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

document.getElementById("about-check").onclick = () => checkUpdates();
async function checkUpdates() {
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
}

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

// Eventos de cada textarea (se llaman al crear la pestaña)
function attachEditor(tab) {
  const el = tab.el;
  el.addEventListener("input", () => {
    scheduleRender();
    scheduleTokens();
    updateTitle();
    updateCount();
  });

  // Tab inserta espacios en lugar de cambiar el foco
  el.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      document.execCommand("insertText", false, "  ");
    }
  });

  // Sincroniza el scroll de la vista previa con el editor (proporcional)
  el.addEventListener("scroll", () => {
    if (el !== editor || document.body.dataset.mode !== "split") return;
    const ratio = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight);
    preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
  });
}

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
  // Ctrl+Tab / Ctrl+Shift+Tab cambian de pestaña en todos los sistemas
  if (e.ctrlKey && e.key === "Tab") {
    e.preventDefault();
    cycleTab(e.shiftKey ? -1 : 1);
    return;
  }
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
  else if (k === "n" || k === "t") { e.preventDefault(); newDoc(); }
  else if (k === "w") { e.preventDefault(); closeTab(current); }
  else if (e.key === "PageDown") { e.preventDefault(); cycleTab(1); }
  else if (e.key === "PageUp") { e.preventDefault(); cycleTab(-1); }
  else if (k === "j") { e.preventDefault(); window.AI?.toggle(); }
  else if (k === "e") {
    e.preventDefault();
    const i = modes.indexOf(document.body.dataset.mode);
    setMode(modes[(i + 1) % modes.length]);
  }
});

// Arrastrar y soltar archivos sobre la ventana: cada uno en su pestaña
listen("tauri://drag-drop", async (event) => {
  for (const path of event.payload?.paths || []) await openPath(path);
});

// Cambios hechos a un archivo abierto desde fuera de la app
listen("file-changed", (event) => reloadFromDisk(event.payload));

// Archivo abierto desde el Explorador o Finder con la app ya en marcha: pestaña nueva
listen("open-file", (event) => openPath(event.payload, "view"));

// Avisar de cambios sin guardar al cerrar
appWindow.onCloseRequested((event) => {
  const dirty = tabs.filter((t) => isDirty(t));
  if (!dirty.length) return;
  const msg = dirty.length === 1
    ? `«${baseName(dirty[0].path)}» tiene cambios sin guardar. ¿Salir y descartarlos?`
    : `Hay ${dirty.length} pestañas con cambios sin guardar. ¿Salir y descartarlos?`;
  if (!confirm(msg)) event.preventDefault();
});

// ---------- Inicio ----------

// Muestra los atajos con ⌘ en macOS
if (isMac) {
  const mac = (t) => t.replace(/Ctrl\+Shift\+/g, "⇧⌘").replace(/Ctrl\+/g, "⌘");
  document.querySelectorAll("[title*='Ctrl+']").forEach((el) => (el.title = mac(el.title)));
  document.querySelectorAll("kbd").forEach((el) => (el.textContent = mac(el.textContent)));
}

// Puente para el asistente (ai.js): pestaña activa, editor y utilidades
window.App = {
  get tab() { return current; },
  get editor() { return editor; },
  baseName,
  invoke,
  flash,
  isMac,
};

(async () => {
  let docs = [];
  try {
    docs = await invoke("startup_files");
  } catch (e) {
    alert(e);
  }
  if (!docs.length) {
    activate(createTab());
    return;
  }
  // Al abrir desde el Explorador se muestra la vista
  for (const doc of docs) openInTab(doc, "view");
})();
