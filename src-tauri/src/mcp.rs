//! Servidor MCP (Model Context Protocol) de MD Viewer.
//!
//! Mientras la app está abierta escucha en `http://127.0.0.1:47823/mcp` (transporte HTTP
//! "streamable", respuestas JSON). Así Claude Code, Claude Desktop y otros clientes MCP pueden
//! listar, leer, editar, abrir y guardar los documentos de las pestañas, incluidos los cambios
//! sin guardar. Las herramientas se ejecutan en la interfaz (src/mcp.js): Rust emite `mcp-call`
//! y espera la respuesta por `mcp_reply`.
//!
//! Para los clientes que solo hablan stdio (Claude Desktop), `md-viewer --mcp` hace de puente:
//! reenvía cada mensaje de stdin al servidor HTTP (abriendo la app si hace falta).

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

pub const PORT: u16 = 47823;
const PROTOCOLS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

pub fn url() -> String {
    format!("http://127.0.0.1:{PORT}/mcp")
}

type Reply = Result<Value, String>;

/// Llamadas a herramientas esperando la respuesta de la interfaz
#[derive(Default)]
pub struct McpBridge {
    pending: Mutex<HashMap<u64, mpsc::Sender<Reply>>>,
    next: AtomicU64,
    status: Mutex<Option<String>>, // error al arrancar el servidor, si lo hubo
}

/// Respuesta de la interfaz a una llamada `mcp-call`
#[tauri::command]
pub fn mcp_reply(bridge: State<Arc<McpBridge>>, id: u64, result: Option<Value>, error: Option<String>) {
    if let Some(tx) = bridge.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(match error {
            Some(e) => Err(e),
            None => Ok(result.unwrap_or(Value::Null)),
        });
    }
}

/// Datos para el diálogo «Conectar por MCP»
#[tauri::command]
pub fn mcp_info(bridge: State<Arc<McpBridge>>) -> Value {
    json!({
        "url": url(),
        "exe": std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        "error": bridge.status.lock().unwrap().clone(),
    })
}

fn tools() -> Value {
    let doc = json!({
        "type": "string",
        "description": "Documento: su id (de list_documents), su ruta o su nombre de archivo. Si se omite, el de la pestaña activa."
    });
    json!([
        {
            "name": "list_documents",
            "description": "Lista los documentos abiertos en las pestañas de MD Viewer: id, nombre, ruta, si es la pestaña activa, si tiene cambios sin guardar y su tamaño.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "read_document",
            "description": "Lee el contenido Markdown actual de un documento abierto (incluidos los cambios sin guardar).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "document": doc,
                    "line_numbers": { "type": "boolean", "description": "Antepone el número de línea a cada línea (por defecto false)." }
                }
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "get_selection",
            "description": "Devuelve el texto que el usuario tiene seleccionado en MD Viewer (en el editor o en bloques de la vista previa), para trabajar sobre «esto».",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "edit_document",
            "description": "Reemplaza un fragmento exacto del documento por otro texto. old_text debe aparecer literalmente y una sola vez (añade contexto si se repite), salvo con replace_all. El cambio se puede deshacer en MD Viewer y no se guarda en disco hasta llamar a save_document.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "document": doc,
                    "old_text": { "type": "string", "description": "Texto exacto que hay ahora en el documento." },
                    "new_text": { "type": "string", "description": "Texto que lo reemplaza (vacío para borrarlo)." },
                    "replace_all": { "type": "boolean", "description": "Reemplazar todas las apariciones (por defecto false)." }
                },
                "required": ["old_text", "new_text"]
            }
        },
        {
            "name": "insert_text",
            "description": "Inserta texto en el documento: al final, al inicio o después de una línea concreta. Se separa con una línea en blanco como un párrafo nuevo.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "document": doc,
                    "text": { "type": "string" },
                    "position": { "type": "string", "enum": ["end", "start", "after_line"], "description": "Dónde insertar (por defecto end)." },
                    "line": { "type": "integer", "minimum": 1, "description": "Con after_line: número de línea (desde 1) tras la que se inserta." }
                },
                "required": ["text"]
            }
        },
        {
            "name": "write_document",
            "description": "Sustituye todo el contenido del documento. Para cambios parciales usa edit_document o insert_text.",
            "inputSchema": {
                "type": "object",
                "properties": { "document": doc, "content": { "type": "string" } },
                "required": ["content"]
            }
        },
        {
            "name": "open_document",
            "description": "Abre un archivo Markdown del disco en una pestaña de MD Viewer (o activa su pestaña si ya está abierto).",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Ruta absoluta del archivo." } },
                "required": ["path"]
            }
        },
        {
            "name": "new_document",
            "description": "Crea un documento nuevo sin guardar en una pestaña, opcionalmente con contenido.",
            "inputSchema": {
                "type": "object",
                "properties": { "content": { "type": "string" } }
            }
        },
        {
            "name": "save_document",
            "description": "Guarda el documento en disco. Si no tiene archivo todavía, indica path para guardarlo ahí (también sirve para «guardar como»).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "document": doc,
                    "path": { "type": "string", "description": "Ruta absoluta donde guardarlo (opcional si ya tiene archivo)." }
                }
            }
        }
    ])
}

/// Ejecuta una herramienta en la interfaz y espera su resultado
fn call_tool(app: &AppHandle, name: &str, args: Value) -> Reply {
    let bridge = app.state::<Arc<McpBridge>>();
    let id = bridge.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    bridge.pending.lock().unwrap().insert(id, tx);
    if let Err(e) = app.emit("mcp-call", json!({ "id": id, "name": name, "args": args })) {
        bridge.pending.lock().unwrap().remove(&id);
        return Err(e.to_string());
    }
    let r = rx.recv_timeout(Duration::from_secs(60));
    bridge.pending.lock().unwrap().remove(&id);
    r.unwrap_or_else(|_| Err("MD Viewer no respondió a tiempo".into()))
}

fn rpc_result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Procesa un mensaje JSON-RPC; None para notificaciones (sin respuesta)
fn handle(app: &AppHandle, msg: &Value) -> Option<Value> {
    let id = msg.get("id")?.clone();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(json!({}));
    Some(match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = if PROTOCOLS.contains(&asked) { asked } else { PROTOCOLS[0] };
            rpc_result(&id, json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "md-viewer", "title": "MD Viewer", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "MD Viewer es un editor de Markdown con pestañas. Estas herramientas trabajan sobre los documentos abiertos en la app, incluidos los cambios sin guardar: úsalas en lugar de leer o escribir el archivo directamente cuando el usuario hable del documento que tiene abierto en MD Viewer. Las ediciones se ven al instante y se pueden deshacer; no se guardan en disco hasta llamar a save_document."
            }))
        }
        "ping" => rpc_result(&id, json!({})),
        "tools/list" => rpc_result(&id, json!({ "tools": tools() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            if !tools().as_array().unwrap().iter().any(|t| t["name"] == name) {
                return Some(rpc_error(&id, -32602, &format!("Herramienta desconocida: {name}")));
            }
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let (text, is_error) = match call_tool(app, name, args) {
                Ok(Value::String(s)) => (s, false),
                Ok(v) => (serde_json::to_string_pretty(&v).unwrap_or_default(), false),
                Err(e) => (e, true),
            };
            rpc_result(&id, json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }))
        }
        _ => rpc_error(&id, -32601, &format!("Método no soportado: {method}")),
    })
}

/// Solo se aceptan peticiones locales: evita que una página web las haga desde el navegador
fn allowed_origin(req: &tiny_http::Request) -> bool {
    req.headers().iter().all(|h| {
        let name = h.field.as_str().as_str().to_ascii_lowercase();
        let v = h.value.as_str().to_ascii_lowercase();
        let local = |s: &str| {
            let host = s.split("://").last().unwrap_or("");
            host.starts_with("127.0.0.1") || host.starts_with("localhost") || host.starts_with("[::1]")
        };
        match name.as_str() {
            "origin" => v == "null" || local(&v),
            "host" => local(&v),
            _ => true,
        }
    })
}

fn respond(req: tiny_http::Request, status: u16, body: Option<Value>) {
    let json_ct = tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap();
    let resp = match body {
        Some(b) => tiny_http::Response::from_string(b.to_string()).with_header(json_ct),
        None => tiny_http::Response::from_string(""),
    };
    let _ = req.respond(resp.with_status_code(status));
}

pub fn start(app: AppHandle) {
    let bridge = app.state::<Arc<McpBridge>>().inner().clone();
    let server = match tiny_http::Server::http(("127.0.0.1", PORT)) {
        Ok(s) => s,
        Err(e) => {
            *bridge.status.lock().unwrap() = Some(format!("No se pudo abrir el puerto {PORT}: {e}"));
            return;
        }
    };
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let app = app.clone();
            // Cada petición en su hilo: una herramienta lenta no bloquea a las demás
            std::thread::spawn(move || {
                if !allowed_origin(&req) {
                    return respond(req, 403, None);
                }
                if req.url().split('?').next() != Some("/mcp") {
                    return respond(req, 404, None);
                }
                match req.method() {
                    tiny_http::Method::Post => {}
                    tiny_http::Method::Delete => return respond(req, 200, None), // fin de sesión
                    _ => return respond(req, 405, None), // sin stream de eventos del servidor
                }
                let mut raw = Vec::new();
                if req.as_reader().read_to_end(&mut raw).is_err() {
                    return respond(req, 400, None);
                }
                let body = String::from_utf8_lossy(&raw);
                let msg: Value = match serde_json::from_str(&body) {
                    Ok(v) => v,
                    Err(_) => return respond(req, 400, Some(rpc_error(&Value::Null, -32700, "JSON no válido"))),
                };
                let out = match &msg {
                    Value::Array(batch) => {
                        let rs: Vec<Value> = batch.iter().filter_map(|m| handle(&app, m)).collect();
                        (!rs.is_empty()).then_some(Value::Array(rs))
                    }
                    m => handle(&app, m),
                };
                match out {
                    Some(v) => respond(req, 200, Some(v)),
                    None => respond(req, 202, None),
                }
            });
        }
    });
}

// ---------- Puente stdio (`md-viewer --mcp`) ----------

/// Reenvía por HTTP cada mensaje JSON-RPC que llega por stdin y escribe la respuesta en stdout.
/// Si MD Viewer no está abierto, lo abre y espera a que el servidor responda.
pub fn stdio_bridge() {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .expect("cliente HTTP");
    let mut launched = false;
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let id = serde_json::from_str::<Value>(&line).ok().and_then(|v| v.get("id").cloned());
        let mut result = Err(String::new());
        for attempt in 0..40 {
            match client.post(url()).header("Content-Type", "application/json")
                .header("Accept", "application/json, text/event-stream").body(line.clone()).send()
            {
                Ok(r) => {
                    result = Ok((r.status().as_u16(), r.text().unwrap_or_default()));
                    break;
                }
                Err(e) if e.is_connect() => {
                    if !launched {
                        launched = true;
                        if let Ok(exe) = std::env::current_exe() {
                            let _ = std::process::Command::new(exe)
                                .stdin(std::process::Stdio::null())
                                .stdout(std::process::Stdio::null())
                                .stderr(std::process::Stdio::null())
                                .spawn();
                        }
                    }
                    result = Err("MD Viewer no está abierto y no se pudo iniciar".into());
                    std::thread::sleep(Duration::from_millis(if attempt == 0 { 1000 } else { 500 }));
                }
                Err(e) => {
                    result = Err(e.to_string());
                    break;
                }
            }
        }
        let out = match result {
            Ok((200, body)) if !body.is_empty() => Some(body),
            Ok(_) => None, // 202: era una notificación
            Err(e) => id.map(|id| rpc_error(&id, -32000, &e).to_string()),
        };
        if let Some(out) = out {
            let _ = writeln!(stdout, "{out}");
            let _ = stdout.flush();
        }
    }
}
