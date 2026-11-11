mod ai;
mod mcp;

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher};

use pulldown_cmark::{html, Event, Options, Parser};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const MD_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "txt"];

/// Archivos con los que se abrió la app (doble clic en un .md desde el Explorador o Finder).
/// `ready` indica que la interfaz ya los pidió; a partir de ahí los archivos nuevos se emiten
/// como evento `open-file` y se abren en una pestaña de la ventana existente.
struct StartupFile(Mutex<Startup>);

struct Startup {
    paths: Vec<PathBuf>,
    ready: bool,
}

/// Vigilantes de los archivos abiertos en pestañas (uno por ruta), para recargarlos cuando
/// otro programa (un editor, una IA) los modifica.
struct FileWatch(Mutex<HashMap<String, notify::RecommendedWatcher>>);

#[derive(Serialize, Clone)]
struct Doc {
    path: String,
    content: String,
}

fn read_doc(path: &Path) -> Result<Doc, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("No se pudo leer {}: {e}", path.display()))?;
    let text = String::from_utf8_lossy(&bytes);
    let content = text.strip_prefix('\u{feff}').unwrap_or(&text).to_string();
    Ok(Doc {
        path: path.to_string_lossy().into_owned(),
        content,
    })
}

/// Archivos pendientes de abrir al cargar la interfaz (los que no se puedan leer se omiten).
#[tauri::command]
fn startup_files(state: State<StartupFile>) -> Vec<Doc> {
    let mut startup = state.0.lock().unwrap();
    startup.ready = true;
    startup.paths.drain(..).filter_map(|p| read_doc(&p).ok()).collect()
}

/// Abre `path` en una pestaña: si la interfaz ya cargó se emite el evento, si no se deja en cola.
fn open_in_tab(app: &AppHandle, path: PathBuf) {
    use tauri::Manager;
    let state = app.state::<StartupFile>();
    let mut startup = state.0.lock().unwrap();
    if startup.ready {
        let _ = app.emit("open-file", path.to_string_lossy().into_owned());
    } else {
        startup.paths.push(path);
    }
}

#[tauri::command]
fn read_file(path: String) -> Result<Doc, String> {
    read_doc(Path::new(&path))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("No se pudo guardar {path}: {e}"))
}

/// Vigila exactamente las rutas de `paths` (las pestañas abiertas con archivo) y emite `file-changed`
/// con el contenido nuevo cuando alguna cambia. Las rutas que ya se vigilaban se conservan.
#[tauri::command]
fn watch_files(app: AppHandle, state: State<FileWatch>, paths: Vec<String>) -> Result<(), String> {
    let mut map = state.0.lock().unwrap();
    // Soltar un vigilante cierra su canal y termina su hilo
    map.retain(|p, _| paths.contains(p));
    let mut errors = Vec::new();
    for path in paths {
        if map.contains_key(&path) {
            continue;
        }
        match watch_one(app.clone(), PathBuf::from(&path)) {
            Ok(w) => {
                map.insert(path, w);
            }
            Err(e) => errors.push(e),
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("\n")) }
}

/// Se vigila la carpeta y no el archivo: muchos programas guardan escribiendo un temporal y renombrándolo,
/// y eso rompe la vigilancia directa del archivo.
fn watch_one(app: AppHandle, target: PathBuf) -> Result<notify::RecommendedWatcher, String> {
    let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
        return Err("Ruta no válida".into());
    };
    let dir = dir.to_path_buf();
    // Sin distinguir mayúsculas: Windows y macOS no lo hacen; si sobra un evento, la interfaz lo descarta
    let name = name.to_string_lossy().to_lowercase();

    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        let ours = event
            .paths
            .iter()
            .any(|p| p.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase() == name));
        if ours {
            let _ = tx.send(());
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("No se pudo vigilar {}: {e}", dir.display()))?;

    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            // Un guardado produce varios eventos seguidos: se espera a que paren y se lee una sola vez
            loop {
                match rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(()) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            // Si falla (archivo a medio renombrar), llegará otro evento cuando aparezca
            if let Ok(doc) = read_doc(&target) {
                let _ = app.emit("file-changed", doc);
            }
        }
    });

    Ok(watcher)
}

fn md_options() -> Options {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_FOOTNOTES);
    opts.insert(Options::ENABLE_HEADING_ATTRIBUTES);
    opts
}

/// Renderiza el documento envolviendo cada bloque de primer nivel (párrafo, título, lista, cita,
/// código, tabla…) en `<div class="md-block" data-from data-to>` con su rango de líneas (desde 0,
/// ambas incluidas): así la vista previa sabe qué parte del texto corresponde a cada bloque.
#[tauri::command]
fn render_markdown(text: String) -> String {
    let line_starts: Vec<usize> = std::iter::once(0)
        .chain(text.match_indices('\n').map(|(i, _)| i + 1))
        .collect();
    let line_of = |byte: usize| line_starts.partition_point(|&s| s <= byte).saturating_sub(1);

    let mut events = Vec::new();
    let mut depth = 0usize;
    for (ev, range) in Parser::new_ext(&text, md_options()).into_offset_iter() {
        let open = || {
            // Sin las líneas en blanco del final (las listas las incluyen en su rango)
            let len = text[range.clone()].trim_end().len().max(1);
            Event::Html(
                format!(
                    "<div class=\"md-block\" data-from=\"{}\" data-to=\"{}\">",
                    line_of(range.start),
                    line_of(range.start + len - 1)
                )
                .into(),
            )
        };
        match ev {
            Event::Start(_) => {
                if depth == 0 {
                    events.push(open());
                }
                events.push(ev);
                depth += 1;
            }
            Event::End(_) => {
                depth = depth.saturating_sub(1);
                events.push(ev);
                if depth == 0 {
                    events.push(Event::Html("</div>\n".into()));
                }
            }
            // Bloques sueltos de primer nivel (línea horizontal)
            Event::Rule if depth == 0 => {
                events.push(open());
                events.push(ev);
                events.push(Event::Html("</div>\n".into()));
            }
            other => events.push(other),
        }
    }
    let mut out = String::with_capacity(text.len() * 3 / 2);
    html::push_html(&mut out, events.into_iter());
    out
}

/// Igual que `render_markdown` pero el HTML crudo se muestra como texto: para las respuestas
/// de la IA, que no deben poder inyectar etiquetas ni scripts en la interfaz.
#[tauri::command]
fn render_markdown_safe(text: String) -> String {
    let parser = Parser::new_ext(&text, md_options()).map(|ev| match ev {
        Event::Html(h) | Event::InlineHtml(h) => Event::Text(h),
        other => other,
    });
    let mut out = String::with_capacity(text.len() * 3 / 2);
    html::push_html(&mut out, parser);
    out
}

/// Tokens del texto con el tokenizador o200k_base (GPT-4o y posteriores).
/// Es async para no bloquear la interfaz: la primera llamada carga el vocabulario.
#[tauri::command]
async fn count_tokens(text: String) -> usize {
    tiktoken_rs::o200k_base_singleton().encode_ordinary(&text).len()
}

#[tauri::command]
async fn open_dialog(app: AppHandle) -> Result<Option<Doc>, String> {
    let dialog = app.dialog().file().add_filter("Markdown", MD_EXTENSIONS);
    // En macOS los filtros se combinan en uno solo y "*" no es una extensión válida
    #[cfg(not(target_os = "macos"))]
    let dialog = dialog.add_filter("Todos los archivos", &["*"]);
    let picked = dialog.blocking_pick_file();
    match picked {
        Some(fp) => {
            let path = fp.into_path().map_err(|e| e.to_string())?;
            read_doc(&path).map(Some)
        }
        None => Ok(None),
    }
}

#[tauri::command]
async fn save_as_dialog(app: AppHandle, content: String, suggested: Option<String>) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md"])
        .set_file_name(suggested.unwrap_or_else(|| "documento.md".into()))
        .blocking_save_file();
    let Some(fp) = picked else { return Ok(None) };
    let mut path = fp.into_path().map_err(|e| e.to_string())?;
    if path.extension().is_none() {
        path.set_extension("md");
    }
    std::fs::write(&path, content).map_err(|e| format!("No se pudo guardar {}: {e}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Argumentos que sean archivos existentes (Windows y Linux pasan las rutas como argv[1..]).
/// Las rutas relativas se resuelven contra `cwd` (la carpeta desde la que se lanzó esa instancia).
fn files_from_args(args: impl IntoIterator<Item = OsString>, cwd: Option<&Path>) -> Vec<PathBuf> {
    args.into_iter()
        .map(PathBuf::from)
        .filter(|p| !p.to_string_lossy().starts_with('-'))
        .map(|p| match cwd {
            Some(cwd) if p.is_relative() => cwd.join(p),
            _ => p,
        })
        .filter(|p| p.is_file())
        .collect()
}

/// macOS no pasa el archivo por argumentos: llega como evento `Opened` (antes o después de cargar la interfaz).
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn handle_opened(app: &AppHandle, urls: Vec<tauri::Url>) {
    for path in urls.into_iter().filter_map(|u| u.to_file_path().ok()) {
        open_in_tab(app, path);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `md-viewer --mcp`: puente stdio para clientes MCP (Claude Desktop), sin abrir ventana
    if std::env::args().skip(1).any(|a| a == "--mcp") {
        mcp::stdio_bridge();
        return;
    }
    let builder = tauri::Builder::default();
    // Una sola instancia: abrir otro .md con la app en marcha lo manda a una pestaña nueva
    // de la ventana existente en lugar de abrir otra ventana. Debe ser el primer plugin.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        use tauri::Manager;
        let cwd = PathBuf::from(cwd);
        for path in files_from_args(argv.into_iter().skip(1).map(OsString::from), Some(&cwd)) {
            open_in_tab(app, path);
        }
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        }
    }));

    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(StartupFile(Mutex::new(Startup {
            paths: files_from_args(std::env::args_os().skip(1), std::env::current_dir().ok().as_deref()),
            ready: false,
        })))
        .manage(FileWatch(Mutex::new(HashMap::new())))
        .manage(ai::AiJobs::default())
        .manage(std::sync::Arc::new(mcp::McpBridge::default()))
        .setup(|app| {
            mcp::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_files,
            read_file,
            write_file,
            watch_files,
            render_markdown,
            render_markdown_safe,
            count_tokens,
            open_dialog,
            save_as_dialog,
            open_url,
            ai::ai_key_status,
            ai::ai_set_key,
            ai::ai_list_models,
            ai::ai_chat,
            ai::ai_cancel,
            mcp::mcp_reply,
            mcp::mcp_info
        ])
        .build(tauri::generate_context!())
        .expect("error al iniciar MD Viewer");

    app.run(|_app, _event| {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = _event {
            handle_opened(_app, urls);
        }
    });
}

#[cfg(test)]
mod render_tests {
    use super::render_markdown;

    #[test]
    fn bloques_con_lineas() {
        let html = render_markdown("# Título\n\nUno\ndos\n\n- a\n- b\n\n---\n\n```\nx\n```\n".into());
        assert!(html.contains(r#"<div class="md-block" data-from="0" data-to="0">"#), "{html}");
        assert!(html.contains(r#"data-from="2" data-to="3">"#), "{html}");
        assert!(html.contains(r#"data-from="5" data-to="6">"#), "{html}");
        assert!(html.contains(r#"data-from="8" data-to="8">"#), "{html}");
        assert!(html.contains(r#"data-from="10" data-to="12">"#), "{html}");
        assert_eq!(html.matches("<div class=\"md-block\"").count(), html.matches("</div>").count());
    }
}
