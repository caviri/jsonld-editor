# JSON-LD Graph Editor

Interactive browser-based visualisation and editor for [JSON-LD](https://json-ld.org/) linked-data graphs. Built with **Sigma.js**, **Graphology**, and **CodeMirror** — zero server required; runs entirely as a static site on GitHub Pages.

![JSON-LD Explorer demo](json-ld-explorer.gif)

---

## ✨ Features

| Category | Details |
|---|---|
| **Graph visualisation** | Force-directed, circular, radial, and grid layouts powered by Graphology + Sigma.js |
| **Node interaction** | Click to select & highlight connections, hover tooltips, drag-to-reposition mode |
| **Search & filter** | Full-text search and per-entity-type toggle filters in the sidebar |
| **JSON-LD editor** | Embedded CodeMirror editor with syntax highlighting, minimap, and source-line linking |
| **Live editing** | Edit the JSON-LD source, click *Apply*, and the graph rebuilds instantly in the browser |
| **Data tables** | Bottom panel with sortable tables grouped by entity type |
| **Validation overlay** | Schema validation badges (✓/✗) on every node, plus a dedicated Validation tab |
| **Export** | Download the edited JSON-LD file with one click |

## 🚀 Quick start

```bash
# Serve locally (any static file server works)
python3 -m http.server 8000
# then open http://localhost:8000
```

Or simply push to GitHub and enable **GitHub Pages** — no build step needed.

### Using your own data

1. Replace `data/sample.jsonld.json` with your JSON-LD file.
2. The file must contain a top-level `"@graph"` array.
3. Entity types are configured in `js/config.js` (`ENTITY_TYPE_CONFIG`).

## 📁 Project structure

```
├── index.html            # Main HTML shell
├── css/
│   └── styles.css        # All styles
├── js/
│   ├── config.js          # Entity / edge type configuration
│   ├── graph.js           # Graph data building & ID resolution
│   ├── layouts.js         # Force, circular, radial, grid layouts
│   ├── editor.js          # CodeMirror JSON-LD editor + minimap
│   ├── ui.js              # Sidebar, tooltips, data tables, events
│   └── app.js             # Bootstrap: fetch data, init Sigma
└── data/
    └── sample.jsonld.json # Default JSON-LD dataset
```

## 🛠 Dependencies (loaded via CDN)

- [Graphology](https://graphology.github.io/) 0.25.4
- [Sigma.js](https://www.sigmajs.org/) 3.0.0-beta.9
- [CodeMirror](https://codemirror.net/) 5.65.16

## 📄 License

MIT