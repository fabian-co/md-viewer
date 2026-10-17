# MD Viewer

Visor y editor sencillo de archivos Markdown hecho con Tauri 2 + Rust. Funciona en **Windows, macOS y Linux**.

- Vistas: Editar, Dividido (vista previa en vivo) y Vista
- Asociación con `.md` / `.markdown` al instalar (doble clic desde el Explorador, Finder o el gestor de archivos)
- Barra de formato: títulos H1–H3, negrita, cursiva, tachado, código, listas, tareas, citas, hipervínculos, imágenes, bloques de código, tablas y líneas horizontales
- En modo Dividido el separador se arrastra para cambiar el ancho del editor y la vista previa (doble clic: mitad y mitad)
- Contador de palabras, caracteres y tokens aproximados para LLMs (tokenizador o200k de GPT-4o; otros modelos pueden variar)
- Ventana «Acerca de» con la versión, el repositorio y búsqueda de actualizaciones
- Arrastrar y soltar archivos sobre la ventana
- Atajos (`Ctrl` en Windows/Linux, `⌘` en macOS):

| Atajo | Acción |
|-------|--------|
| `Ctrl/⌘+N` | Nuevo |
| `Ctrl/⌘+O` | Abrir |
| `Ctrl/⌘+S` | Guardar |
| `Ctrl/⌘+Shift+S` | Guardar como |
| `Ctrl/⌘+E` | Cambiar vista |
| `Ctrl/⌘+B` | Negrita |
| `Ctrl/⌘+I` | Cursiva |
| `Ctrl/⌘+Shift+X` | Tachado |
| `Ctrl/⌘+Shift+C` | Código en línea |
| `Ctrl/⌘+1` / `2` / `3` | Título 1 / 2 / 3 |
| `Ctrl/⌘+K` | Hipervínculo |
| `Ctrl/⌘+Shift+8` / `7` | Lista con viñetas / numerada |
| `Ctrl/⌘+Shift+.` | Cita |

## Descargas

Última versión: **[v1.2.1](https://github.com/fabian-co/md-viewer/releases/latest)**

| Sistema | Descarga |
|---------|----------|
| Windows | [Instalador `.exe`](https://github.com/fabian-co/md-viewer/releases/download/v1.2.1/MD.Viewer_1.2.1_x64-setup.exe) · [`.msi`](https://github.com/fabian-co/md-viewer/releases/download/v1.2.1/MD.Viewer_1.2.1_x64_en-US.msi) |
| macOS (Apple Silicon M1/M2/M3…) | [`.dmg`](https://github.com/fabian-co/md-viewer/releases/download/v1.2.1/MD.Viewer_1.2.1_aarch64.dmg) |
| macOS (Intel) | [`.dmg`](https://github.com/fabian-co/md-viewer/releases/download/v1.2.1/MD.Viewer_1.2.1_x64.dmg) |
| Linux (Debian/Ubuntu) | [`.deb`](https://github.com/fabian-co/md-viewer/releases/download/v1.2.1/MD.Viewer_1.2.1_amd64.deb) |
| Linux (Fedora/openSUSE) | [`.rpm`](https://github.com/fabian-co/md-viewer/releases/download/v1.2.1/MD.Viewer-1.2.1-1.x86_64.rpm) |
| Linux (cualquier distro) | [`.AppImage`](https://github.com/fabian-co/md-viewer/releases/download/v1.2.1/MD.Viewer_1.2.1_amd64.AppImage) |

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
```

Para publicar una versión: `git tag v1.2.1 && git push --tags` crea un release con los instaladores de los tres sistemas.
