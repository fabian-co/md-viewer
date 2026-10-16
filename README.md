# MD Viewer

Visor y editor sencillo de archivos Markdown hecho con Tauri 2 + Rust. Funciona en **Windows, macOS y Linux**.

- Vistas: Editar, Dividido (vista previa en vivo) y Vista
- Asociación con `.md` / `.markdown` al instalar (doble clic desde el Explorador, Finder o el gestor de archivos)
- Arrastrar y soltar archivos sobre la ventana
- Atajos (`Ctrl` en Windows/Linux, `⌘` en macOS):

| Atajo | Acción |
|-------|--------|
| `Ctrl/⌘+N` | Nuevo |
| `Ctrl/⌘+O` | Abrir |
| `Ctrl/⌘+S` | Guardar |
| `Ctrl/⌘+Shift+S` | Guardar como |
| `Ctrl/⌘+E` | Cambiar vista |

## Descargas

Los instaladores se generan con GitHub Actions en cada push (pestaña **Actions** → artefactos) y al publicar un tag `v*` (pestaña **Releases**):

| Sistema | Formatos |
|---------|----------|
| Windows | `.msi`, `.exe` (NSIS) |
| macOS (Apple Silicon e Intel) | `.dmg`, `.app` |
| Linux | `.deb`, `.rpm`, `.AppImage` |

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

Para publicar una versión: `git tag v1.0.0 && git push --tags` crea un release con los instaladores de los tres sistemas.
