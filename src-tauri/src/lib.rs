use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher};

use pulldown_cmark::{html, Options, Parser};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const MD_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "txt"];

/// Archivo con el que se abrió la app (doble clic en un .md desde el Explorador o Finder).
/// `ready` indica que la interfaz ya lo pidió; a partir de ahí los archivos nuevos se emiten como evento.
struct StartupFile(Mutex<Startup>);

struct Startup {
    path: Option<PathBuf>,
    ready: bool,
}

/// Vigilante del archivo abierto, para recargarlo cuando otro programa (un editor, una IA) lo modifica.
struct FileWatch(Mutex<Option<notify::RecommendedWatcher>>);

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

#[tauri::command]
fn startup_file(state: State<StartupFile>) -> Result<Option<Doc>, String> {
    let mut startup = state.0.lock().unwrap();
    startup.ready = true;
    match startup.path.take() {
        Some(path) => read_doc(&path).map(Some),
        None => Ok(None),
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

/// Empieza a vigilar `path` (o deja de vigilar si es `None`) y emite `file-changed` con el contenido nuevo.
/// Se vigila la carpeta y no el archivo: muchos programas guardan escribiendo un temporal y renombrándolo,
/// y eso rompe la vigilancia directa del archivo.
#[tauri::command]
fn watch_file(app: AppHandle, state: State<FileWatch>, path: Option<String>) -> Result<(), String> {
    let mut slot = state.0.lock().unwrap();
    // Soltar el vigilante anterior cierra su canal y termina su hilo
    *slot = None;
    let Some(path) = path else { return Ok(()) };
    let target = PathBuf::from(path);
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

    *slot = Some(watcher);
    Ok(())
}

#[tauri::command]
fn render_markdown(text: String) -> String {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_FOOTNOTES);
    opts.insert(Options::ENABLE_HEADING_ATTRIBUTES);
    let parser = Parser::new_ext(&text, opts);
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

/// Primer argumento que sea un archivo existente (Windows y Linux pasan la ruta como argv[1]).
fn file_from_args() -> Option<PathBuf> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|p| !p.to_string_lossy().starts_with('-') && p.is_file())
}

/// macOS no pasa el archivo por argumentos: llega como evento `Opened` (antes o después de cargar la interfaz).
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn handle_opened(app: &AppHandle, urls: Vec<tauri::Url>) {
    use tauri::{Emitter, Manager};
    let Some(path) = urls.into_iter().find_map(|u| u.to_file_path().ok()) else { return };
    let state = app.state::<StartupFile>();
    let mut startup = state.0.lock().unwrap();
    if startup.ready {
        let _ = app.emit("open-file", path.to_string_lossy().into_owned());
    } else {
        startup.path = Some(path);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(StartupFile(Mutex::new(Startup {
            path: file_from_args(),
            ready: false,
        })))
        .manage(FileWatch(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            startup_file,
            read_file,
            write_file,
            watch_file,
            render_markdown,
            count_tokens,
            open_dialog,
            save_as_dialog,
            open_url
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
