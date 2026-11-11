//! Asistente de IA: claves en el llavero del sistema y chat con streaming contra varios proveedores.
//!
//! La clave nunca sale de Rust: la interfaz solo guarda/borra y recibe una pista ("…abcd").
//! Estilos de API soportados:
//! - `anthropic`: Messages API de Anthropic (Claude)
//! - `gemini`: Gemini API de Google
//! - el resto (`openai`, `openrouter`, `ollama`, `compatible`): Chat Completions compatible con OpenAI

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

const KEYRING_SERVICE: &str = "com.fabian.mdviewer";
const ANTHROPIC_VERSION: &str = "2026-10-21";

/// Peticiones de chat en curso, para poder cancelarlas.
#[derive(Default)]
pub struct AiJobs(Mutex<HashMap<u64, tauri::async_runtime::JoinHandle<()>>>);

#[derive(Deserialize, Clone)]
pub struct ChatMessage {
    role: String, // "user" | "assistant"
    content: String,
}

#[derive(Serialize, Clone)]
struct AiEvent {
    id: u64,
    /// "delta" (trozo de texto), "thinking" (trozo del razonamiento), "done" (terminó) o "error"
    kind: &'static str,
    text: String,
}

enum Style {
    Anthropic,
    Gemini,
    OpenAi,
}

fn style(provider: &str) -> Style {
    match provider {
        "anthropic" => Style::Anthropic,
        "gemini" => Style::Gemini,
        _ => Style::OpenAi,
    }
}

// ---------- Claves ----------

fn entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("api-key:{provider}"))
        .map_err(|e| format!("No se pudo acceder al llavero del sistema: {e}"))
}

fn get_key(provider: &str) -> Result<Option<String>, String> {
    match entry(provider)?.get_password() {
        Ok(k) if !k.trim().is_empty() => Ok(Some(k)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("No se pudo leer la clave del llavero: {e}")),
    }
}

fn hint(key: &str) -> String {
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("…{tail}")
}

/// Pista de la clave guardada ("…abcd") o `None` si no hay.
#[tauri::command]
pub fn ai_key_status(provider: String) -> Result<Option<String>, String> {
    Ok(get_key(&provider)?.map(|k| hint(&k)))
}

/// Guarda la clave en el llavero del sistema (o la borra si viene vacía).
#[tauri::command]
pub fn ai_set_key(provider: String, key: Option<String>) -> Result<Option<String>, String> {
    let e = entry(&provider)?;
    match key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        Some(k) => {
            e.set_password(&k).map_err(|e| format!("No se pudo guardar la clave: {e}"))?;
            Ok(Some(hint(&k)))
        }
        None => match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("No se pudo borrar la clave: {e}")),
        },
    }
}

// ---------- HTTP ----------

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .user_agent(concat!("MD-Viewer/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

fn trim_base(base: &str) -> String {
    base.trim().trim_end_matches('/').to_string()
}

/// Añade las cabeceras de autenticación de cada proveedor.
fn authed(req: reqwest::RequestBuilder, provider: &str, key: Option<&str>) -> reqwest::RequestBuilder {
    let req = match (style(provider), key) {
        (Style::Anthropic, Some(k)) => req.header("x-api-key", k),
        (Style::Gemini, Some(k)) => req.header("x-goog-api-key", k),
        (Style::OpenAi, Some(k)) => req.bearer_auth(k),
        (_, None) => req,
    };
    let req = match style(provider) {
        Style::Anthropic => req.header("anthropic-version", ANTHROPIC_VERSION),
        _ => req,
    };
    if provider == "openrouter" {
        req.header("X-Title", "MD Viewer")
    } else {
        req
    }
}

fn needs_key(provider: &str) -> bool {
    !matches!(provider, "ollama" | "compatible")
}

fn require_key(provider: &str) -> Result<Option<String>, String> {
    let key = get_key(provider)?;
    if key.is_none() && needs_key(provider) {
        return Err("Falta la API key de este proveedor. Agrégala en la configuración del asistente.".into());
    }
    Ok(key)
}

/// Mensaje de error legible a partir de una respuesta HTTP fallida.
async fn http_error(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            let e = v.get("error")?;
            e.get("message").and_then(Value::as_str).map(str::to_string).or_else(|| e.as_str().map(str::to_string))
        })
        .unwrap_or_else(|| body.chars().take(300).collect());
    let hint = match status.as_u16() {
        401 | 403 => " (revisa la API key)",
        404 => " (revisa el modelo o la URL)",
        429 => " (límite de uso alcanzado; espera un poco o revisa tu saldo)",
        _ => "",
    };
    format!("Error {}{hint}: {detail}", status.as_u16())
}

fn net_error(e: reqwest::Error) -> String {
    if e.is_connect() {
        format!("No se pudo conectar con el servidor: {e}")
    } else if e.is_timeout() {
        "El servidor tardó demasiado en responder".into()
    } else {
        e.to_string()
    }
}

// ---------- Modelos ----------

/// Lista los modelos disponibles para la clave guardada (para elegir uno en la configuración).
#[tauri::command]
pub async fn ai_list_models(provider: String, base_url: String) -> Result<Vec<String>, String> {
    let key = require_key(&provider)?;
    let base = trim_base(&base_url);
    let url = match style(&provider) {
        Style::Anthropic => format!("{base}/v1/models?limit=1000"),
        Style::Gemini => format!("{base}/models?pageSize=1000"),
        Style::OpenAi => format!("{base}/models"),
    };
    let resp = authed(client()?.get(url), &provider, key.as_deref())
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(net_error)?;
    if !resp.status().is_success() {
        return Err(http_error(resp).await);
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut ids: Vec<String> = match style(&provider) {
        Style::Gemini => v["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| {
                m["supportedGenerationMethods"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|x| x == "generateContent"))
            })
            .filter_map(|m| m["name"].as_str().map(|n| n.trim_start_matches("models/").to_string()))
            .collect(),
        _ => v["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m["id"].as_str().map(str::to_string))
            .collect(),
    };
    // Las listas incluyen modelos que no sirven para chatear (embeddings, voz, imágenes…)
    const SKIP: &[&str] = &[
        "embed", "bge-", "rerank", "tts", "whisper", "dall-e", "moderation", "transcribe", "sora",
    ];
    const SKIP_OPENAI: &[&str] = &["image", "audio", "realtime", "search", "davinci", "babbage"];
    ids.retain(|id| {
        let id = id.to_lowercase();
        !SKIP.iter().any(|s| id.contains(s)) && !(provider == "openai" && SKIP_OPENAI.iter().any(|s| id.contains(s)))
    });
    // Anthropic los devuelve del más nuevo al más antiguo: se respeta ese orden
    if !matches!(style(&provider), Style::Anthropic) {
        ids.sort();
    }
    ids.dedup();
    Ok(ids)
}

// ---------- Chat ----------

/// Modelos de Anthropic que admiten el respaldo automático del servidor cuando el modelo
/// rechaza una petición por sus filtros de seguridad.
fn anthropic_supports_fallback(model: &str) -> bool {
    ["claude-fable-5", "claude-mythos-5", "claude-opus-5", "claude-sonnet-5-5"]
        .iter()
        .any(|p| model.starts_with(p))
}

/// Modelos de Anthropic con razonamiento adaptativo: se pide un resumen del razonamiento para
/// mostrar el progreso (por defecto llega vacío y solo se ve una pausa larga).
fn anthropic_adaptive_thinking(model: &str) -> bool {
    [
        "claude-fable-5", "claude-mythos-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-5",
        "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6",
    ]
    .iter()
    .any(|p| model.starts_with(p))
}

fn build_request(
    http: &reqwest::Client,
    provider: &str,
    key: Option<&str>,
    base: &str,
    model: &str,
    system: &str,
    messages: &[ChatMessage],
) -> reqwest::RequestBuilder {
    match style(provider) {
        Style::Anthropic => {
            let mut body = json!({
                "model": model,
                "max_tokens": 64000,
                "stream": true,
                "system": system,
                "messages": messages.iter().map(|m| json!({"role": m.role, "content": m.content})).collect::<Vec<_>>(),
            });
            if anthropic_adaptive_thinking(model) {
                body["thinking"] = json!({"type": "adaptive", "display": "summarized"});
            }
            let mut req = http.post(format!("{base}/v1/messages"));
            if anthropic_supports_fallback(model) {
                body["fallbacks"] = json!("default");
                req = req.header("anthropic-beta", "server-side-fallback-2026-07-01");
            }
            authed(req, provider, key).json(&body)
        }
        Style::Gemini => {
            let contents: Vec<Value> = messages
                .iter()
                .map(|m| {
                    let role = if m.role == "assistant" { "model" } else { "user" };
                    json!({"role": role, "parts": [{"text": m.content}]})
                })
                .collect();
            let body = json!({
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": contents,
            });
            let url = format!("{base}/models/{model}:streamGenerateContent?alt=sse");
            authed(http.post(url), provider, key).json(&body)
        }
        Style::OpenAi => {
            let mut msgs = vec![json!({"role": "system", "content": system})];
            msgs.extend(messages.iter().map(|m| json!({"role": m.role, "content": m.content})));
            let body = json!({"model": model, "stream": true, "messages": msgs});
            authed(http.post(format!("{base}/chat/completions")), provider, key).json(&body)
        }
    }
}

/// Resultado de procesar una línea `data:` del stream.
enum Chunk {
    Text(String),
    Thinking(String),
    Error(String),
    Refusal,
    Nothing,
}

fn parse_data(provider: &str, data: &str) -> Chunk {
    if data == "[DONE]" {
        return Chunk::Nothing;
    }
    let Ok(v) = serde_json::from_str::<Value>(data) else { return Chunk::Nothing };
    if let Some(msg) = v["error"]["message"].as_str() {
        return Chunk::Error(msg.to_string());
    }
    match style(provider) {
        Style::Anthropic => match v["type"].as_str() {
            Some("content_block_delta") if v["delta"]["type"] == "text_delta" => {
                Chunk::Text(v["delta"]["text"].as_str().unwrap_or_default().to_string())
            }
            Some("content_block_delta") if v["delta"]["type"] == "thinking_delta" => {
                Chunk::Thinking(v["delta"]["thinking"].as_str().unwrap_or_default().to_string())
            }
            Some("message_delta") if v["delta"]["stop_reason"] == "refusal" => Chunk::Refusal,
            _ => Chunk::Nothing,
        },
        Style::Gemini => {
            let text: String = v["candidates"][0]["content"]["parts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|p| p["thought"] != true)
                .filter_map(|p| p["text"].as_str())
                .collect();
            if text.is_empty() { Chunk::Nothing } else { Chunk::Text(text) }
        }
        Style::OpenAi => {
            let delta = &v["choices"][0]["delta"];
            // Ollama y OpenRouter mandan el razonamiento en `reasoning`; DeepSeek, en `reasoning_content`
            let reasoning = delta["reasoning"].as_str().or_else(|| delta["reasoning_content"].as_str());
            match (delta["content"].as_str(), reasoning) {
                (Some(t), _) if !t.is_empty() => Chunk::Text(t.to_string()),
                (_, Some(r)) if !r.is_empty() => Chunk::Thinking(r.to_string()),
                _ => Chunk::Nothing,
            }
        }
    }
}

async fn run_chat(
    app: &AppHandle,
    id: u64,
    provider: String,
    model: String,
    base_url: String,
    system: String,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    let key = require_key(&provider)?;
    if model.trim().is_empty() {
        return Err("Elige un modelo en la configuración del asistente.".into());
    }
    let http = client()?;
    let base = trim_base(&base_url);
    let resp = build_request(&http, &provider, key.as_deref(), &base, model.trim(), &system, &messages)
        .send()
        .await
        .map_err(net_error)?;
    if !resp.status().is_success() {
        return Err(http_error(resp).await);
    }

    let emit = |text: String| {
        let _ = app.emit("ai-event", AiEvent { id, kind: "delta", text });
    };
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    let mut got_text = false;
    let mut refused = false;
    while let Some(bytes) = resp.chunk().await.map_err(net_error)? {
        buf.extend_from_slice(&bytes);
        // Procesa las líneas completas; lo demás espera al siguiente trozo (puede cortar un carácter UTF-8)
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\r', '\n']);
            let Some(data) = line.strip_prefix("data:") else { continue };
            match parse_data(&provider, data.trim_start()) {
                Chunk::Text(t) => {
                    got_text = true;
                    emit(t);
                }
                Chunk::Thinking(t) => {
                    let _ = app.emit("ai-event", AiEvent { id, kind: "thinking", text: t });
                }
                Chunk::Error(e) => return Err(e),
                Chunk::Refusal => refused = true,
                Chunk::Nothing => {}
            }
        }
    }
    if refused {
        return Err("El modelo rechazó la petición por sus filtros de seguridad. Prueba a reformularla o usa otro modelo.".into());
    }
    if !got_text {
        return Err("El modelo no devolvió texto.".into());
    }
    Ok(())
}

/// Empieza una respuesta en streaming. Los trozos llegan como eventos `ai-event` con este `id`.
#[tauri::command]
pub fn ai_chat(
    app: AppHandle,
    jobs: State<AiJobs>,
    id: u64,
    provider: String,
    model: String,
    base_url: String,
    system: String,
    messages: Vec<ChatMessage>,
) {
    let app2 = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let result = run_chat(&app2, id, provider, model, base_url, system, messages).await;
        let ev = match result {
            Ok(()) => AiEvent { id, kind: "done", text: String::new() },
            Err(e) => AiEvent { id, kind: "error", text: e },
        };
        let _ = app2.emit("ai-event", ev);
        use tauri::Manager;
        app2.state::<AiJobs>().0.lock().unwrap().remove(&id);
    });
    jobs.0.lock().unwrap().insert(id, handle);
}

/// Detiene una respuesta en curso (lo ya recibido se conserva en la interfaz).
#[tauri::command]
pub fn ai_cancel(app: AppHandle, jobs: State<AiJobs>, id: u64) {
    if let Some(h) = jobs.0.lock().unwrap().remove(&id) {
        h.abort();
        let _ = app.emit("ai-event", AiEvent { id, kind: "done", text: String::new() });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(c: Chunk) -> Option<String> {
        match c {
            Chunk::Text(t) => Some(t),
            _ => None,
        }
    }

    #[test]
    fn parsea_anthropic() {
        let d = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hola"}}"#;
        assert_eq!(text(parse_data("anthropic", d)).as_deref(), Some("Hola"));
        let r = r#"{"type":"message_delta","delta":{"stop_reason":"refusal"}}"#;
        assert!(matches!(parse_data("anthropic", r), Chunk::Refusal));
        let e = r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#;
        assert!(matches!(parse_data("anthropic", e), Chunk::Error(m) if m == "Overloaded"));
    }

    #[test]
    fn parsea_openai_y_gemini() {
        let d = r#"{"choices":[{"delta":{"content":"ok"}}]}"#;
        assert_eq!(text(parse_data("openai", d)).as_deref(), Some("ok"));
        assert!(matches!(parse_data("ollama", "[DONE]"), Chunk::Nothing));
        let r = r#"{"choices":[{"delta":{"content":"","reasoning":"mmm"}}]}"#;
        assert!(matches!(parse_data("ollama", r), Chunk::Thinking(t) if t == "mmm"));
        let g = r#"{"candidates":[{"content":{"parts":[{"text":"pensando","thought":true},{"text":"sí"}]}}]}"#;
        assert_eq!(text(parse_data("gemini", g)).as_deref(), Some("sí"));
    }

    #[test]
    fn llavero_guarda_y_borra() {
        let p = "prueba-md-viewer".to_string();
        assert_eq!(ai_set_key(p.clone(), Some("sk-test-1234abcd".into())).unwrap().as_deref(), Some("…abcd"));
        assert_eq!(ai_key_status(p.clone()).unwrap().as_deref(), Some("…abcd"));
        assert_eq!(ai_set_key(p.clone(), None).unwrap(), None);
        assert_eq!(ai_key_status(p).unwrap(), None);
    }
}

#[cfg(test)]
mod net_tests {
    use super::*;

    /// Prueba de red (se ejecuta a mano): con una clave falsa, el 401 debe llegar como mensaje legible.
    #[tokio::test]
    #[ignore]
    async fn clave_falsa_da_error_legible() {
        let http = client().unwrap();
        let msgs = vec![ChatMessage { role: "user".into(), content: "hola".into() }];
        let resp = build_request(&http, "anthropic", Some("sk-ant-falsa"), "https://api.anthropic.com", "claude-opus-5-5", "x", &msgs)
            .send()
            .await
            .unwrap();
        let err = http_error(resp).await;
        println!("{err}");
        assert!(err.starts_with("Error 401 (revisa la API key)"), "{err}");
    }
}
