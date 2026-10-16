use std::path::{Path, PathBuf};
use std::sync::Mutex;

use pulldown_cmark::{html, Options, Parser};
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const MD_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "txt"];

/// Archivo recibido por línea de comandos (doble clic en un .md desde el Explorador).
struct StartupFile(Mutex<Option<PathBuf>>);

#[derive(Serialize)]
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
    match state.0.lock().unwrap().take() {
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

#[tauri::command]
async fn open_dialog(app: AppHandle) -> Result<Option<Doc>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Markdown", MD_EXTENSIONS)
        .add_filter("Todos los archivos", &["*"])
        .blocking_pick_file();
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

/// Primer argumento que sea un archivo existente (Windows pasa la ruta como argv[1]).
fn file_from_args() -> Option<PathBuf> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|p| !p.to_string_lossy().starts_with('-') && p.is_file())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(StartupFile(Mutex::new(file_from_args())))
        .invoke_handler(tauri::generate_handler![
            startup_file,
            read_file,
            write_file,
            render_markdown,
            open_dialog,
            save_as_dialog,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar MD Viewer");
}
