# Agents

This document describes the AI agent conventions used in this project.

## Architecture overview

The app is a **zero-build static site** — plain HTML + CSS + vanilla JS served directly from GitHub Pages. There is no framework, no bundler, and no server-side code.

### File layout

| Path | Purpose |
|---|---|
| `index.html` | DOM structure, CDN script/link tags |
| `css/styles.css` | All visual styles |
| `js/config.js` | `ENTITY_TYPE_CONFIG`, `EDGE_TYPE_CONFIG`, `CROSS_REF_FIELDS` — edit these to support new entity or relationship types |
| `js/graph.js` | Pure-function graph-building logic: ID indexing, edge extraction, radial positioning, validation matching |
| `js/layouts.js` | `createLayouts(graph, sigma)` — returns `{ applyLayout, stopForceAnimation, getCurrentLayout }` |
| `js/editor.js` | `createEditor()` — CodeMirror wrapper, source-index builder, minimap, apply/download |
| `js/ui.js` | `createUI(graph, sigma, layoutManager, editorModule)` — all DOM event wiring, sidebar, tooltips, data tables |
| `js/app.js` | Entry point: `fetch()` the JSON-LD, build graph data, init Sigma, wire modules |
| `data/sample.jsonld.json` | Default dataset (loaded at runtime via fetch) |

### Module dependency graph

```
app.js
 ├── config.js    (global constants, loaded first)
 ├── graph.js     (pure functions, no DOM)
 ├── layouts.js   (needs graph + sigma)
 ├── editor.js    (needs DOM + CodeMirror)
 └── ui.js        (needs everything above)
```

All files use global scope (`<script>` tags, not ES modules) for simplicity and GitHub Pages compatibility.

## Conventions

- **No build step.** Any change should be testable by refreshing the browser.
- **CDN dependencies only.** Do not add `node_modules`; libraries come from `cdnjs.cloudflare.com`.
- **Data goes in `data/`.** The app reads `data/sample.jsonld.json` via `fetch()`. Replace the file with your own JSON-LD to visualise different data.
- **Config-driven entity types.** To add a new entity type, add an entry to `ENTITY_TYPE_CONFIG` in `js/config.js`. No other file needs changing.
- **Factory functions.** `createLayouts()`, `createEditor()`, and `createUI()` are factory functions that return API objects. They capture their dependencies via closure, avoiding global mutable state.

## Testing

```bash
# Serve the project
python3 -m http.server 8000

# Verify in browser
open http://localhost:8000
```

Check:
1. Graph renders with correct node colors and labels
2. Force layout animates on load
3. All four layouts work (Force / Circular / Radial / Grid)
4. Search, filters, tooltips, drag mode function correctly
5. JSON-LD editor opens, highlights source, Apply rebuilds graph
6. Data tables show entities grouped by type
