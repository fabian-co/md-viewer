# MD Viewer

Visor y editor sencillo de archivos Markdown hecho con Tauri 2 + Rust. Funciona en **Windows, macOS y Linux**.

- Vistas: Editar, Dividido (vista previa en vivo) y Vista
- Asociación con `.md` / `.markdown` al instalar (doble clic desde el Explorador, Finder o el gestor de archivos)
- Barra de formato: títulos H1–H3, negrita, cursiva, tachado, código, listas, tareas, citas, hipervínculos, imágenes, bloques de código, tablas y líneas horizontales
- En modo Dividido el separador se arrastra para cambiar el ancho del editor y la vista previa (doble clic: mitad y mitad)
- Contador de palabras, caracteres y tokens aproximados para LLMs (tokenizador o200k de GPT-4o; otros modelos pueden variar)
- Menús **Archivo** (nueva pestaña, abrir, guardar, guardar como, cerrar pestaña) y **Acerca de** (versión, búsqueda de actualizaciones y enlace a las versiones)
- **Asistente IA** (botón «IA» o `Ctrl/⌘+J`): pregunta sobre el documento abierto o pide cambios. Distingue lo que pides: si preguntas algo sobre el documento («resume el documento», «¿de qué trata?»), la respuesta se queda en el chat, con un botón para agregarla al documento o copiarla; si pides contenido o cambios («añade una conclusión», «un párrafo sobre…», «corrige la ortografía»), se aplican directamente al documento y cada uno se puede deshacer. Funciona con Anthropic (Claude), OpenAI, Google Gemini, OpenRouter, Ollama (modelos locales, sin clave) y cualquier servicio compatible con la API de OpenAI (LM Studio, Groq, DeepSeek, Mistral…). Las respuestas llegan en tiempo real, con el razonamiento del modelo plegable, y hay una conversación por pestaña
- **IA sobre cada párrafo**: en la vista previa, al pasar el ratón por un párrafo (o un título, una lista, una tabla…) aparece un borde con las opciones *Refinar*, *Modificar…* (con tu instrucción) y *Generar…* (texto nuevo a partir de ese bloque, que se añade debajo). Para trabajar con varios bloques, selecciona su texto con el ratón o usa *Seleccionar*
- **Servidor MCP**: mientras la app está abierta, Claude Code, Claude Desktop y otros clientes MCP pueden listar, leer, editar, abrir y guardar los documentos de tus pestañas (incluidos los cambios sin guardar). Las instrucciones para conectarlos están en *Acerca de → Conectar por MCP…*. Escucha solo en `http://127.0.0.1:47823/mcp`; para clientes stdio, usa `md-viewer --mcp`
  - Las API keys se guardan en el llavero del sistema (Administrador de credenciales en Windows, Llavero en macOS, Secret Service en Linux), nunca en archivos, y solo se envían al proveedor elegido. El documento abierto se envía a ese proveedor con cada pregunta
- Recarga en tiempo real: si otro programa (un editor, una IA) modifica el archivo abierto, se actualiza al instante sin perder el scroll
- Pestañas: abrir otro `.md` con la app en marcha (doble clic en el Explorador, Finder o «Abrir con») lo añade como pestaña en la ventana existente en lugar de abrir otra ventana. Cada pestaña conserva su historial de deshacer, cursor, scroll y vista; las que tienen cambios sin guardar muestran un punto
- Arrastrar y soltar archivos sobre la ventana (cada uno en su pestaña)
- Atajos (`Ctrl` en Windows/Linux, `⌘` en macOS):

| Atajo | Acción |
|-------|--------|
| `Ctrl/⌘+N` / `Ctrl/⌘+T` | Nueva pestaña |
| `Ctrl/⌘+W` | Cerrar pestaña (también clic central) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Pestaña siguiente / anterior (también `Ctrl/⌘+AvPág` / `RePág`) |
| `Ctrl/⌘+O` | Abrir |
| `Ctrl/⌘+S` | Guardar |
| `Ctrl/⌘+Shift+S` | Guardar como |
| `Ctrl/⌘+E` | Cambiar vista |
| `Ctrl/⌘+J` | Mostrar u ocultar el asistente IA |
| `Ctrl/⌘+B` | Negrita |
| `Ctrl/⌘+I` | Cursiva |
| `Ctrl/⌘+Shift+X` | Tachado |
| `Ctrl/⌘+Shift+C` | Código en línea |
| `Ctrl/⌘+1` / `2` / `3` | Título 1 / 2 / 3 |
| `Ctrl/⌘+K` | Hipervínculo |
| `Ctrl/⌘+Shift+8` / `7` | Lista con viñetas / numerada |
| `Ctrl/⌘+Shift+.` | Cita |

## Descargas

Última versión: **[v1.5.0](https://github.com/fabian-co/md-viewer/releases/latest)**

| Sistema | Descarga |
|---------|----------|
| Windows | [Instalador `.exe`](https://github.com/fabian-co/md-viewer/releases/download/v1.5.0/MD.Viewer_1.5.0_x64-setup.exe) · [`.msi`](https://github.com/fabian-co/md-viewer/releases/download/v1.5.0/MD.Viewer_1.5.0_x64_en-US.msi) |
| macOS (Apple Silicon M1/M2/M3…) | [`.dmg`](https://github.com/fabian-co/md-viewer/releases/download/v1.5.0/MD.Viewer_1.5.0_aarch64.dmg) |
| macOS (Intel) | [`.dmg`](https://github.com/fabian-co/md-viewer/releases/download/v1.5.0/MD.Viewer_1.5.0_x64.dmg) |
| Linux (Debian/Ubuntu) | [`.deb`](https://github.com/fabian-co/md-viewer/releases/download/v1.5.0/MD.Viewer_1.5.0_amd64.deb) |
| Linux (Fedora/openSUSE) | [`.rpm`](https://github.com/fabian-co/md-viewer/releases/download/v1.5.0/MD.Viewer-1.5.0-1.x86_64.rpm) |
| Linux (cualquier distro) | [`.AppImage`](https://github.com/fabian-co/md-viewer/releases/download/v1.5.0/MD.Viewer_1.5.0_amd64.AppImage) |

Todas las versiones están en la pestaña [Releases](https://github.com/fabian-co/md-viewer/releases).

> En macOS la app no está firmada: la primera vez ábrela con clic derecho → **Abrir**, o ejecuta
> `xattr -dr com.apple.quarantine "/Applications/MD Viewer.app"`.

## Desarrollo

Requisitos: [Rust](https://rustup.rs), [Node.js](https://nodejs.org) y las dependencias de sistema de Tauri:

- **Windows**: Microsoft C++ Build Tools y WebView2 (incluido en Windows 10/11).
- **macOS**: `xcode-select --install`
- **Linux (Debian/Ubuntu)**:
  ```sh
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```
  Para otras distribuciones consulta los [requisitos de Tauri](https://v2.tauri.app/start/prerequisites/).

```sh
npm install
npm run dev     # modo desarrollo
npm run build   # instaladores en src-tauri/target/release/bundle/
npm test        # pruebas (intención del chat, respuestas de la IA y Rust)
```

Para publicar una versión: `git tag v1.5.0 && git push --tags` crea un release con los instaladores de los tres sistemas.
