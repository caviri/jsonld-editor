/* ==============================================
   JSON-LD Graph Visualization — Box diagram view
   ==============================================

   An alternative rendering of the current graph data (instance or schema
   view). Every node is a card:

       ┌──────────────────────────┐
       │ TYPE                   ▾ │  header (▾/▸ collapses the card)
       │ Label                    │
       ├──────────────────────────┤
       │ key: literal value       │  values / attributes / constraints
       ├──────────────────────────┤
       │ ● predicate → Target    ─┼──┐  one row per outgoing link; the
       └──────────────────────────┘  │  connector leaves from that row
                                     └──▶ target card

   Layouts
     layered     targets above sources (superclasses above subclasses)
     type        one framed group per type, groups placed near the groups
                 they link to
     community   groups found by label propagation over the links
   Groups can be collapsed into a single summary card.

   Interaction: drag the background to pan, wheel to zoom, drag a card (or
   the selected cards, or a group by its title) to move it, click to select,
   Ctrl/⌘+click to add to the selection, double-click for the source.
*/

function createDiagram(app, graph) {
    const container = document.getElementById("diagram-container");
    const svg = document.getElementById("diagram-svg");
    const NS = "http://www.w3.org/2000/svg";
    const MAX_NODES = 600;
    const ROW_GAP = 84;
    const COL_GAP = 40;
    const HEADER_H = 36;
    const ROW_H = 15;
    const EDGE_ROW_H = 17;
    const MAX_ROWS = 6;
    const MAX_EDGE_ROWS = 10;
    const MIN_W = 160;
    const MAX_W = 300;
    const FRAME_PAD = 22;
    const FRAME_TITLE = 28;
    const CLUSTER_GAP = 70;
    const STORAGE_KEY = "jsonld-editor:diagram";

    let active = false;
    let data = null;
    let boxes = new Map();        // id -> box
    let frames = [];              // cluster frames
    let routes = [];
    let view = { k: 1, tx: 0, ty: 0 };
    let viewport = null;
    let frameLayer = null;
    let edgeLayer = null;
    let nodeLayer = null;
    let selection = new Set();
    const collapsedBoxes = new Set();
    const collapsedClusters = new Set();
    const prefs = Object.assign({ instances: "type", schema: "layered" }, readPrefs());
    const measureCtx = document.createElement("canvas").getContext("2d");

    function readPrefs() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch (_) { return {}; }
    }
    function savePrefs() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch (_) { /* ignore */ }
    }
    const currentMode = () => prefs[data && data.view === "schema" ? "schema" : "instances"] || "layered";

    function el(name, attrs = {}, parent) {
        const node = document.createElementNS(NS, name);
        Object.entries(attrs).forEach(([k, v]) => { if (v !== undefined && v !== null) node.setAttribute(k, v); });
        if (parent) parent.appendChild(node);
        return node;
    }

    const FONT_LABEL = "600 12.5px system-ui, -apple-system, 'Segoe UI', sans-serif";
    const FONT_TYPE = "700 9.5px system-ui, -apple-system, 'Segoe UI', sans-serif";
    const FONT_ROW = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

    function textWidth(text, font) {
        measureCtx.font = font;
        return measureCtx.measureText(text).width;
    }

    function fit(text, font, max) {
        if (textWidth(text, font) <= max) return text;
        let t = text;
        while (t.length > 1 && textWidth(t + "…", font) > max) t = t.slice(0, -1);
        return t + "…";
    }

    // ── Toolbar ───────────────────────────────

    const toolbar = document.createElement("div");
    toolbar.id = "diagram-toolbar";
    toolbar.innerHTML = `
        <label class="dt-field">Layout
            <select id="diagram-layout">
                <option value="layered">Layered</option>
                <option value="type">Grouped by type</option>
                <option value="community">Grouped by community</option>
            </select>
        </label>
        <button type="button" class="dt-btn" data-act="collapse" title="Collapse the selected cards, or all cards when nothing is selected">▸ Collapse</button>
        <button type="button" class="dt-btn" data-act="expand" title="Expand the selected cards, or all cards when nothing is selected">▾ Expand</button>
        <span class="dt-groups">
            <button type="button" class="dt-btn" data-act="collapse-groups" title="Collapse every group into one card">▸ Groups</button>
            <button type="button" class="dt-btn" data-act="expand-groups" title="Expand every group">▾ Groups</button>
        </span>
        <button type="button" class="dt-btn" data-act="mermaid" title="Download this diagram as Mermaid (.mmd): a classDiagram in the schema view, a flowchart in the instance view">⬇ Mermaid</button>
        <span class="dt-hint">Ctrl/⌘+click: multi-select</span>`;
    container.appendChild(toolbar);
    const layoutSelect = toolbar.querySelector("#diagram-layout");
    layoutSelect.addEventListener("change", () => {
        prefs[data && data.view === "schema" ? "schema" : "instances"] = layoutSelect.value;
        savePrefs();
        render();
    });
    toolbar.addEventListener("mousedown", e => e.stopPropagation());
    toolbar.addEventListener("click", e => {
        const btn = e.target.closest("[data-act]");
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === "mermaid") { app.exportMermaid("mmd"); return; }
        const targets = selection.size ? [...selection].filter(id => boxes.has(id)) : [...boxes.keys()].filter(id => !id.startsWith("group::"));
        if (act === "collapse") targets.forEach(id => collapsedBoxes.add(id));
        if (act === "expand") targets.forEach(id => collapsedBoxes.delete(id));
        if (act === "collapse-groups") frames.forEach(f => collapsedClusters.add(f.key));
        if (act === "expand-groups") collapsedClusters.clear();
        render({ keepView: act === "collapse" || act === "expand" });
    });

    // ── Clustering ────────────────────────────

    /** Label propagation over the (undirected) links: deterministic, a few sweeps. */
    function communities(ids, edges) {
        const index = new Map(ids.map((id, i) => [id, i]));
        const adj = ids.map(() => []);
        edges.forEach(e => {
            const s = index.get(e.source);
            const t = index.get(e.target);
            if (s === undefined || t === undefined || s === t) return;
            adj[s].push(t);
            adj[t].push(s);
        });
        const label = ids.map((_, i) => i);
        const order = ids.map((_, i) => i).sort((a, b) => adj[b].length - adj[a].length);
        for (let sweep = 0; sweep < 15; sweep += 1) {
            let changed = false;
            order.forEach(u => {
                if (!adj[u].length) return;
                const counts = new Map();
                adj[u].forEach(v => counts.set(label[v], (counts.get(label[v]) || 0) + 1));
                let best = label[u];
                let bestCount = counts.get(best) || 0;
                counts.forEach((c, l) => { if (c > bestCount || (c === bestCount && l < best)) { best = l; bestCount = c; } });
                if (best !== label[u]) { label[u] = best; changed = true; }
            });
            if (!changed) break;
        }
        return { label, adj };
    }

    function buildClusters(nodes, edges, mode) {
        const clusterOf = new Map();
        const clusters = new Map();
        const add = (key, label, color, id) => {
            if (!clusters.has(key)) clusters.set(key, { key, label, color, members: [] });
            clusters.get(key).members.push(id);
            clusterOf.set(id, key);
        };
        if (mode === "type") {
            nodes.forEach(n => add(`type:${n.nodeType}`, n.nodeType || "Untyped", n.color, n.id));
        } else if (mode === "community") {
            const ids = nodes.map(n => n.id);
            const { label, adj } = communities(ids, edges);
            const groups = new Map();
            ids.forEach((id, i) => {
                const key = adj[i].length ? `c:${label[i]}` : "c:unlinked";
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(i);
            });
            groups.forEach((members, key) => {
                const typeCounts = new Map();
                members.forEach(i => typeCounts.set(nodes[i].nodeType, (typeCounts.get(nodes[i].nodeType) || 0) + 1));
                const top = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
                const name = key === "c:unlinked" ? "Not linked" : top.slice(0, 2).map(([t]) => t).join(" · ");
                const color = nodes[members[0]].color;
                members.forEach(i => add(key, name, color, ids[i]));
            });
        } else {
            nodes.forEach(n => add("all", "", null, n.id));
        }
        return { clusterOf, clusters };
    }

    // ── Card content ──────────────────────────

    function valueRows(node) {
        const rows = [];
        const props = node.properties || {};
        if (node.isGroup) {
            rows.push({ text: `${node.count} nodes`, muted: true });
            if (node.internal) rows.push({ text: `${node.internal} links inside the group`, muted: true });
            node.sample.forEach(label => rows.push({ text: `· ${label}` }));
            return rows;
        }
        if (node.kind === "class" || node.kind === "shape") {
            (props.attributes || []).forEach(a => rows.push({ text: a }));
            (props.constraints || []).forEach(c => rows.push({ text: c }));
            if (!rows.length && props.instances) rows.push({ text: `${props.instances} instance(s)`, muted: true });
            return rows;
        }
        if (node.external) return rows;
        Object.entries(props).forEach(([key, value]) => {
            if (key === "IRI") return;
            const values = Array.isArray(value) ? value : [value];
            const literals = values.filter(v => !(v && typeof v === "object" && v.iri && graph.hasNode(v.iri)));
            if (!literals.length) return;
            rows.push({ key, text: literals.map(v => (v && typeof v === "object" ? (v.text || v.iri) : String(v))).join(", ") });
        });
        return rows;
    }

    function measureCard(node, outgoing, labels) {
        const collapsed = !node.isGroup && collapsedBoxes.has(node.id);
        let w = Math.max(textWidth(node.label || "", FONT_LABEL) + 44, textWidth((node.nodeType || "").toUpperCase(), FONT_TYPE) + 60);
        if (collapsed) return { w: Math.max(MIN_W, Math.min(MAX_W, Math.ceil(w))), h: HEADER_H + 4, rows: [], more: 0, edgeRows: [], collapsed };
        const all = valueRows(node);
        const rows = all.slice(0, MAX_ROWS);
        rows.forEach(r => { w = Math.max(w, textWidth((r.key ? r.key + ": " : "") + r.text, FONT_ROW) + 24); });
        const edgeRows = [];
        const visible = outgoing.slice(0, MAX_EDGE_ROWS);
        visible.forEach(e => {
            const text = `${e.label}${e.count > 1 ? ` ×${e.count}` : ""} → ${labels.get(e.target) || e.target}`;
            edgeRows.push({ text, edges: [e] });
            w = Math.max(w, textWidth(text, FONT_ROW) + 34);
        });
        if (outgoing.length > MAX_EDGE_ROWS) {
            edgeRows.push({ text: `+${outgoing.length - MAX_EDGE_ROWS} more links`, edges: outgoing.slice(MAX_EDGE_ROWS), more: true });
        }
        w = Math.max(MIN_W, Math.min(MAX_W, Math.ceil(w)));
        const more = all.length - rows.length;
        let h = HEADER_H;
        const valueBlock = rows.length + (more > 0 ? 1 : 0);
        if (valueBlock) h += valueBlock * ROW_H + 10;
        let edgeTop = h;
        if (edgeRows.length) {
            h += 4;
            edgeTop = h;
            h += edgeRows.length * EDGE_ROW_H + 6;
        }
        edgeRows.forEach((r, i) => { r.cy = edgeTop + 4 + i * EDGE_ROW_H + EDGE_ROW_H / 2; });
        return { w, h, rows, more, edgeRows, edgeTop, collapsed };
    }

    // ── Layered placement (used for the whole graph or inside a group) ──

    function layered(ids, edges, sizes, minRowWidth) {
        const index = new Map(ids.map((id, i) => [id, i]));
        const out = ids.map(() => []);
        const inc = ids.map(() => []);
        edges.forEach(e => {
            const s = index.get(e.source);
            const t = index.get(e.target);
            if (s === undefined || t === undefined || s === t) return;
            out[s].push(t);
            inc[t].push(s);
        });
        // Cycles: an iterative DFS marks back edges, which are ignored for layering.
        const color = new Uint8Array(ids.length);
        const back = new Set();
        const order = [];
        for (let start = 0; start < ids.length; start += 1) {
            if (color[start]) continue;
            const stack = [[start, 0]];
            color[start] = 1;
            while (stack.length) {
                const top = stack[stack.length - 1];
                const [u, i] = top;
                if (i < out[u].length) {
                    top[1] += 1;
                    const v = out[u][i];
                    if (color[v] === 1) back.add(u * 1e6 + v);
                    else if (!color[v]) { color[v] = 1; stack.push([v, 0]); }
                } else {
                    color[u] = 2;
                    order.push(u);
                    stack.pop();
                }
            }
        }
        // Height = longest path to a sink: what is pointed to sits on top.
        const height = new Int32Array(ids.length);
        order.forEach(u => {
            let h = 0;
            out[u].forEach(v => { if (!back.has(u * 1e6 + v)) h = Math.max(h, height[v] + 1); });
            height[u] = h;
        });
        const layers = [];
        const isolated = [];
        ids.forEach((_, i) => {
            if (!out[i].length && !inc[i].length) isolated.push(i);
            else (layers[height[i]] = layers[height[i]] || []).push(i);
        });
        // Barycentric ordering.
        const pos = new Float64Array(ids.length);
        layers.forEach(layer => { if (layer) layer.forEach((u, i) => { pos[u] = i; }); });
        for (let sweep = 0; sweep < 4; sweep += 1) {
            const range = sweep % 2 === 0 ? [...layers.keys()] : [...layers.keys()].reverse();
            range.forEach(li => {
                const layer = layers[li];
                if (!layer) return;
                const bary = u => {
                    const nb = sweep % 2 === 0 ? out[u] : inc[u];
                    return nb.length ? nb.reduce((s, v) => s + pos[v], 0) / nb.length : pos[u];
                };
                layer.sort((a, b) => bary(a) - bary(b));
                layer.forEach((u, i) => { pos[u] = i; });
            });
        }
        // Rows, wrapping long layers.
        const area = ids.reduce((s, id) => s + (sizes.get(id).w + COL_GAP) * (sizes.get(id).h + ROW_GAP / 2), 0);
        const maxRow = Math.max(minRowWidth, Math.sqrt(area) * 1.5);
        const rows = [];
        const wrap = list => {
            let current = [];
            let width = 0;
            list.forEach(u => {
                const w = sizes.get(ids[u]).w;
                if (current.length && width + w > maxRow) { rows.push(current); current = []; width = 0; }
                current.push(u);
                width += w + COL_GAP;
            });
            if (current.length) rows.push(current);
        };
        layers.forEach(layer => { if (layer) wrap(layer); });
        if (isolated.length) wrap(isolated);
        const rowWidths = rows.map(r => r.reduce((s, u) => s + sizes.get(ids[u]).w, 0) + COL_GAP * (r.length - 1));
        const W = Math.max(0, ...rowWidths);
        const positions = new Map();
        let y = 0;
        rows.forEach((row, ri) => {
            let x = (W - rowWidths[ri]) / 2;
            const rowH = Math.max(...row.map(u => sizes.get(ids[u]).h));
            row.forEach(u => {
                positions.set(ids[u], { x, y });
                x += sizes.get(ids[u]).w + COL_GAP;
            });
            y += rowH + ROW_GAP;
        });
        return { positions, w: W, h: Math.max(0, y - ROW_GAP) };
    }

    // ── Routing (orthogonal connectors from the link rows) ──

    function roundedPath(points, r = 6) {
        if (points.length < 2) return "";
        let d = `M${points[0][0]},${points[0][1]}`;
        for (let i = 1; i < points.length - 1; i += 1) {
            const [px, py] = points[i - 1];
            const [cx, cy] = points[i];
            const [nx, ny] = points[i + 1];
            const d1 = Math.hypot(cx - px, cy - py);
            const d2 = Math.hypot(nx - cx, ny - cy);
            const rr = Math.min(r, d1 / 2, d2 / 2);
            const ax = cx - ((cx - px) / (d1 || 1)) * rr;
            const ay = cy - ((cy - py) / (d1 || 1)) * rr;
            const bx = cx + ((nx - cx) / (d2 || 1)) * rr;
            const by = cy + ((ny - cy) / (d2 || 1)) * rr;
            d += ` L${ax},${ay} Q${cx},${cy} ${bx},${by}`;
        }
        const last = points[points.length - 1];
        return `${d} L${last[0]},${last[1]}`;
    }

    function computeRoutes() {
        const plans = [];
        boxes.forEach(box => {
            const rows = box.content.edgeRows;
            const sideLanes = { 1: 0, "-1": 0 };
            const emit = (e, cy) => {
                const t = boxes.get(e.target);
                if (!t || t === box) return;
                const dir = t.x + t.w / 2 >= box.x + box.w / 2 ? 1 : -1;
                const lane = sideLanes[dir]++;
                plans.push({ e, s: box, t, dir, sx: dir > 0 ? box.x + box.w : box.x, sy: box.y + cy, lane });
            };
            if (rows.length) rows.forEach(r => r.edges.forEach(e => emit(e, r.cy)));
            else (box.outgoing || []).forEach((e, i) => emit(e, HEADER_H / 2 + ((i % 5) - 2) * 3));
        });

        // Decide how each connector enters its target.
        plans.forEach(p => {
            const t = p.t;
            if (t.y - 16 > p.sy) p.entry = "top";
            else if (t.y + t.h + 16 < p.sy) p.entry = "bottom";
            else p.entry = p.dir > 0 ? "left" : "right";
            if ((p.entry === "left" && t.x - p.sx < 24) || (p.entry === "right" && p.sx - (t.x + t.w) < 24)) {
                p.entry = t.y + t.h / 2 >= p.sy ? "top" : "bottom";
            }
        });
        // Spread entry points along each target side.
        const groups = new Map();
        plans.forEach(p => {
            const key = `${p.t.id}|${p.entry}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(p);
        });
        groups.forEach(list => {
            const t = list[0].t;
            const side = list[0].entry;
            if (side === "top" || side === "bottom") {
                list.sort((a, b) => a.sx - b.sx);
                list.forEach((p, k) => {
                    p.tx = t.x + ((k + 1) * t.w) / (list.length + 1);
                    p.ty = side === "top" ? t.y : t.y + t.h;
                    p.gy = side === "top" ? t.y - 12 - k * 5 : t.y + t.h + 12 + k * 5;
                });
            } else {
                list.sort((a, b) => a.sy - b.sy);
                const top = t.y + 10;
                const span = Math.max(10, Math.min(t.h, HEADER_H + 60) - 20);
                list.forEach((p, k) => {
                    p.tx = side === "left" ? t.x : t.x + t.w;
                    p.ty = top + ((k + 1) * span) / (list.length + 1);
                    p.mx = (p.sx + p.tx) / 2 + (k - (list.length - 1) / 2) * 5;
                });
            }
        });
        return plans.map(p => {
            const x1 = p.sx + p.dir * (14 + p.lane * 5);
            let points;
            if (p.entry === "top" || p.entry === "bottom") points = [[p.sx, p.sy], [x1, p.sy], [x1, p.gy], [p.tx, p.gy], [p.tx, p.ty]];
            else points = [[p.sx, p.sy], [p.mx, p.sy], [p.mx, p.ty], [p.tx, p.ty]];
            points = points.filter((pt, k) => k === 0 || pt[0] !== points[k - 1][0] || pt[1] !== points[k - 1][1]);
            return { edge: p.e, points, start: [p.sx, p.sy] };
        });
    }

    // ── Rendering ─────────────────────────────

    const markers = new Map();
    function markerFor(color, hollow) {
        const key = `${color}|${hollow ? 1 : 0}`;
        if (markers.has(key)) return markers.get(key);
        const id = `dm-${markers.size}`;
        const defs = svg.querySelector("defs");
        const m = el("marker", { id, viewBox: "0 0 12 12", refX: hollow ? "11" : "10", refY: "6", markerWidth: hollow ? "13" : "9", markerHeight: hollow ? "13" : "9", orient: "auto-start-reverse", markerUnits: "userSpaceOnUse" }, defs);
        if (hollow) el("path", { d: "M1,1 L11,6 L1,11 Z", style: "fill: var(--diagram-bg)", stroke: color, "stroke-width": "1.4" }, m);
        else el("path", { d: "M1,1 L11,6 L1,11 L4,6 Z", fill: color }, m);
        markers.set(key, `url(#${id})`);
        return markers.get(key);
    }

    function drawEdges() {
        edgeLayer.innerHTML = "";
        routes = computeRoutes().map((r, i) => {
            const g = el("g", { class: "d-edge", "data-route": i, "data-source": r.edge.source, "data-target": r.edge.target }, edgeLayer);
            const d = roundedPath(r.points);
            el("path", {
                d,
                class: "d-edge-line",
                stroke: r.edge.color,
                fill: "none",
                "stroke-width": "1.6",
                "stroke-dasharray": r.edge.kind === "shape" ? "5 4" : null,
                "marker-end": markerFor(r.edge.color, r.edge.kind === "subclass"),
            }, g);
            el("path", { d, stroke: "transparent", fill: "none", "stroke-width": "10", class: "d-edge-hit" }, g);
            el("circle", { cx: r.start[0], cy: r.start[1], r: 3, fill: r.edge.color, class: "d-port" }, g);
            const title = el("title", {}, g);
            title.textContent = `${r.edge.label}: ${labelOf(r.edge.source)} → ${labelOf(r.edge.target)}`;
            return { edge: r.edge, el: g };
        });
    }

    let labelIndex = new Map();
    const labelOf = id => labelIndex.get(id) || id;

    function drawFrames() {
        frameLayer.innerHTML = "";
        frames.forEach(f => {
            const g = el("g", { class: "d-frame", "data-key": f.key }, frameLayer);
            el("rect", { x: f.x, y: f.y, width: f.w, height: f.h, rx: 12, ry: 12, fill: f.color || "#94a3b8", "fill-opacity": "0.05", stroke: f.color || "#94a3b8", "stroke-opacity": "0.45", "stroke-dasharray": "6 4", class: "d-frame-rect" }, g);
            const title = el("g", { class: "d-frame-title", "data-key": f.key }, g);
            el("rect", { x: f.x, y: f.y, width: f.w, height: FRAME_TITLE, rx: 12, ry: 12, fill: "transparent" }, title);
            const toggle = el("text", { x: f.x + 12, y: f.y + 18, class: "d-cluster-toggle", "data-key": f.key }, title);
            toggle.textContent = "▾";
            const t = el("text", { x: f.x + 28, y: f.y + 18, class: "d-frame-label", fill: f.color || null }, title);
            t.textContent = `${f.label} · ${f.members.length}`;
        });
    }

    function drawBoxes() {
        nodeLayer.innerHTML = "";
        boxes.forEach(box => {
            const n = box.node;
            const c = box.content;
            const g = el("g", { class: `d-node${n.external ? " external" : ""}${n.isGroup ? " group" : ""}${c.collapsed ? " collapsed" : ""}`, transform: `translate(${box.x},${box.y})`, "data-id": n.id }, nodeLayer);
            el("rect", { class: "d-box", width: box.w, height: box.h, rx: 8, ry: 8 }, g);
            el("rect", { class: "d-box-header", width: box.w, height: Math.min(HEADER_H, box.h), rx: 8, ry: 8, fill: n.color, "fill-opacity": "0.14" }, g);
            el("rect", { x: 0, y: 0, width: 4, height: box.h, rx: 2, fill: n.color }, g);
            const type = el("text", { x: 12, y: 13, class: "d-type", fill: n.color }, g);
            type.textContent = fit((n.nodeType || "").toUpperCase(), FONT_TYPE, box.w - 60);
            const label = el("text", { x: 12, y: 28, class: "d-label" }, g);
            label.textContent = fit(String(n.label || n.id), FONT_LABEL, box.w - 40);
            const toggle = el("text", { x: box.w - 14, y: 15, class: "d-toggle", "text-anchor": "middle" }, g);
            toggle.textContent = c.collapsed || n.isGroup ? "▸" : "▾";
            const tt = el("title", {}, toggle);
            tt.textContent = n.isGroup ? "Expand the group" : c.collapsed ? "Expand the card" : "Collapse the card";

            let y = HEADER_H;
            if (c.rows.length || c.more > 0) {
                el("line", { x1: 0, x2: box.w, y1: y, y2: y, class: "d-divider" }, g);
                c.rows.forEach((r, i) => {
                    const t = el("text", { x: 12, y: HEADER_H + 16 + i * ROW_H, class: `d-row${r.muted ? " muted" : ""}` }, g);
                    if (r.key) {
                        const k = el("tspan", { class: "d-row-key" }, t);
                        k.textContent = `${r.key}: `;
                        const v = el("tspan", {}, t);
                        v.textContent = fit(r.text, FONT_ROW, box.w - 24 - textWidth(`${r.key}: `, FONT_ROW));
                    } else {
                        t.textContent = fit(r.text, FONT_ROW, box.w - 24);
                    }
                });
                if (c.more > 0) {
                    const t = el("text", { x: 12, y: HEADER_H + 16 + c.rows.length * ROW_H, class: "d-row muted" }, g);
                    t.textContent = `+${c.more} more`;
                }
            }
            if (c.edgeRows.length) {
                y = c.edgeTop - 4;
                el("line", { x1: 0, x2: box.w, y1: y, y2: y, class: "d-divider strong" }, g);
                c.edgeRows.forEach((r, i) => {
                    const row = el("g", { class: `d-edge-row${r.more ? " more" : ""}`, "data-row": i }, g);
                    el("rect", { x: 1, y: r.cy - EDGE_ROW_H / 2, width: box.w - 2, height: EDGE_ROW_H, class: "d-edge-row-bg" }, row);
                    const e = r.edges[0];
                    el("rect", { x: 10, y: r.cy - 1, width: 8, height: 2.5, rx: 1, fill: r.more ? "var(--text-muted)" : e.color }, row);
                    const t = el("text", { x: 24, y: r.cy + 4, class: "d-row d-edge-text" }, row);
                    if (r.more) {
                        t.textContent = r.text;
                    } else {
                        const pred = el("tspan", { class: "d-edge-pred", fill: e.color }, t);
                        const predText = `${e.label}${e.count > 1 ? ` ×${e.count}` : ""}`;
                        pred.textContent = fit(predText, FONT_ROW, (box.w - 40) * 0.55);
                        const arrow = el("tspan", { class: "d-row-key" }, t);
                        arrow.textContent = " → ";
                        const target = el("tspan", {}, t);
                        target.textContent = fit(labelOf(e.target), FONT_ROW, Math.max(30, box.w - 40 - textWidth(pred.textContent + " → ", FONT_ROW)));
                    }
                    r.el = row;
                });
            }
            const v = n.validation;
            if (v) {
                el("circle", { cx: box.w - 32, cy: 12, r: 7, fill: v.ok ? "#22c55e" : "#ef4444", class: "d-badge" }, g);
                const t = el("text", { x: box.w - 32, y: 15.5, "text-anchor": "middle", class: "d-badge-text" }, g);
                t.textContent = v.ok ? "✓" : "✗";
            }
            if (n.invalidId) {
                const cx = box.w - (v ? 50 : 32);
                el("circle", { cx, cy: 12, r: 7, fill: "#ef4444", class: "d-badge" }, g);
                const t = el("text", { x: cx, y: 15.5, "text-anchor": "middle", class: "d-badge-text" }, g);
                t.textContent = "!";
            }
            const title = el("title", {}, g);
            title.textContent = n.isGroup ? `${n.label}: ${n.count} nodes (double-click to expand)` : `${n.label}\n${n.id}`;
            box.el = g;
        });
    }

    function applyView() {
        if (viewport) viewport.setAttribute("transform", `translate(${view.tx},${view.ty}) scale(${view.k})`);
    }

    function contentBounds() {
        let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
        boxes.forEach(b => { minX = Math.min(minX, b.x); minY = Math.min(minY, b.y); maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h); });
        frames.forEach(f => { minX = Math.min(minX, f.x); minY = Math.min(minY, f.y); maxX = Math.max(maxX, f.x + f.w); maxY = Math.max(maxY, f.y + f.h); });
        return { minX, minY, maxX, maxY };
    }

    /** Fit the diagram; `readable` keeps zoom ≥ 0.6 and shows the top when it does not fit. */
    function fitView(readable = false) {
        if (!boxes.size) return;
        const { minX, minY, maxX, maxY } = contentBounds();
        const W = container.clientWidth || 800;
        const H = container.clientHeight || 600;
        const pad = 50;
        const usableW = W - pad * 2 - 60;
        const top = 64; // toolbar
        const fitK = Math.min(1.3, usableW / Math.max(1, maxX - minX), (H - top - pad) / Math.max(1, maxY - minY));
        view.k = Math.max(0.05, readable ? Math.max(fitK, 0.6) : fitK);
        view.tx = (W - 60) / 2 - ((minX + maxX) / 2) * view.k;
        view.ty = (maxY - minY) * view.k <= H - top - pad ? top + (H - top - pad) / 2 - ((minY + maxY) / 2) * view.k : top + 10 - minY * view.k;
        applyView();
    }

    function highlight() {
        const focus = new Set([...selection].filter(id => boxes.has(id)));
        const neighbours = new Set(focus);
        routes.forEach(r => {
            const on = focus.has(r.edge.source) || focus.has(r.edge.target);
            r.el.classList.toggle("hl", on);
            r.el.classList.toggle("dim", Boolean(focus.size && !on));
            if (on) { neighbours.add(r.edge.source); neighbours.add(r.edge.target); }
        });
        boxes.forEach((box, id) => {
            if (!box.el) return;
            box.el.classList.toggle("selected", focus.has(id));
            box.el.classList.toggle("dim", Boolean(focus.size && !neighbours.has(id)));
        });
    }

    /**
     * What the diagram shows, without drawing it: visible nodes, groups,
     * collapsed groups replaced by one summary node, merged links, card
     * content. Shared by render() and the Mermaid export.
     */
    function buildScene(sceneData, mode) {
        const visible = sceneData.nodes.filter(n => !graph.hasNode(n.id) || !graph.getNodeAttribute(n.id, "hidden"));
        const nodes = visible.slice(0, MAX_NODES);
        const keep = new Set(nodes.map(n => n.id));
        const rawEdges = sceneData.edges.filter(e => keep.has(e.source) && keep.has(e.target));
        const { clusterOf, clusters } = buildClusters(nodes, rawEdges, mode);
        const rep = id => (collapsedClusters.has(clusterOf.get(id)) ? `group::${clusterOf.get(id)}` : id);
        const effNodes = [];
        const internal = new Map();
        nodes.forEach(n => { if (!collapsedClusters.has(clusterOf.get(n.id))) effNodes.push(n); });
        clusters.forEach(c => {
            if (!collapsedClusters.has(c.key)) return;
            const members = c.members.map(id => nodes.find(n => n.id === id)).filter(Boolean);
            effNodes.push({
                id: `group::${c.key}`, isGroup: true, key: c.key, label: c.label || "Group", nodeType: "Group",
                color: c.color || "#64748b", count: c.members.length, internal: 0,
                sample: members.slice(0, 4).map(m => m.label).concat(members.length > 4 ? [`… ${members.length - 4} more`] : []),
                properties: {},
            });
        });
        const merged = new Map();
        rawEdges.forEach(e => {
            const s = rep(e.source);
            const t = rep(e.target);
            if (s === t) { if (s.startsWith("group::")) internal.set(s, (internal.get(s) || 0) + 1); return; }
            const key = `${s}|${t}|${e.label}`;
            if (merged.has(key)) merged.get(key).count += 1;
            else merged.set(key, Object.assign({}, e, { source: s, target: t, count: 1 }));
        });
        effNodes.forEach(n => { if (n.isGroup) n.internal = internal.get(n.id) || 0; });
        const edges = [...merged.values()];
        const labels = new Map(effNodes.map(n => [n.id, String(n.label || n.id)]));
        const outgoing = new Map();
        edges.forEach(e => {
            if (!outgoing.has(e.source)) outgoing.set(e.source, []);
            outgoing.get(e.source).push(e);
        });
        const sizes = new Map();
        effNodes.forEach(n => sizes.set(n.id, measureCard(n, outgoing.get(n.id) || [], labels)));
        return { mode, view: sceneData.view, total: visible.length, effNodes, edges, clusters, clusterOf, labels, outgoing, sizes };
    }

    // ── Mermaid export ────────────────────────

    /** Escape text for a Mermaid label (entity codes, single line). */
    function mmd(text, max = 60) {
        let s = String(text === undefined || text === null ? "" : text).replace(/\s+/g, " ").trim();
        if (s.length > max) s = s.slice(0, max - 1) + "…";
        // Mermaid renders labels as Markdown and refuses auto-links (URLs, e-mails):
        // a zero-width space keeps them as plain text without changing how they look.
        s = s.replace(/:\/\//g, ":​//").replace(/@/g, "@​").replace(/\bwww\./gi, m => m.slice(0, 3) + "​.");
        return s.replace(/#/g, "#35;").replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;")
            .replace(/\|/g, "#124;").replace(/[{}]/g, c => (c === "{" ? "#123;" : "#125;")).replace(/`/g, "#96;");
    }

    /** Text for class-diagram members and relation labels (no entity codes there). */
    function plain(text, max = 70) {
        let s = String(text === undefined || text === null ? "" : text).replace(/\s+/g, " ").trim();
        s = s.replace(/[{}~`"<>]/g, "").replace(/\((\d+)\)$/, "[$1]").replace(/\(([^)]*)\)/g, "[$1]");
        return s.length > max ? s.slice(0, max - 1) + "…" : s;
    }

    function safeName(text, fallback) {
        const s = String(text || "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
        return /^[A-Za-z]/.test(s) ? s.slice(0, 40) : `${fallback}${s ? "_" + s.slice(0, 30) : ""}`;
    }

    /**
     * The diagram as Mermaid: `classDiagram` for the schema view, `flowchart`
     * for the instance view. opts: { data (graph data, default: current), title }.
     */
    function toMermaid(opts = {}) {
        const sceneData = opts.data || app.getGraphData();
        if (!sceneData || !sceneData.nodes.length) return null;
        const mode = prefs[sceneData.view === "schema" ? "schema" : "instances"] || "layered";
        const scene = buildScene(sceneData, mode);
        const ids = new Map();
        scene.effNodes.forEach((n, i) => ids.set(n.id, `${sceneData.view === "schema" ? "C" : "n"}${i}`));
        const lines = [];
        const header = `%% ${opts.title || "JSON-LD Explorer"} — ${sceneData.view === "schema" ? "schema view" : "instance view"}, ${mode === "layered" ? "layered" : mode === "type" ? "grouped by type" : "grouped by community"}`;
        lines.push(header);
        if (scene.total > MAX_NODES) lines.push(`%% ${MAX_NODES} of ${scene.total} nodes (the diagram's limit)`);
        const grouped = mode !== "layered";
        const byCluster = new Map();
        scene.effNodes.forEach(n => {
            const key = n.isGroup || !grouped ? null : scene.clusterOf.get(n.id);
            if (!byCluster.has(key)) byCluster.set(key, []);
            byCluster.get(key).push(n);
        });
        const clusterLabel = key => {
            const c = scene.clusters.get(key);
            return c ? `${c.label || "Group"} · ${c.members.length}` : "Group";
        };

        if (sceneData.view === "schema") {
            lines.push("classDiagram");
            lines.push("  direction TB");
            const classBlock = (n, indent) => {
                const id = ids.get(n.id);
                const s = scene.sizes.get(n.id);
                const members = [];
                if (!s.collapsed) {
                    s.rows.forEach(r => members.push((r.key ? `${r.key}: ` : "") + r.text));
                    if (s.more > 0) members.push(`… ${s.more} more`);
                }
                const out = [`${indent}class ${id}["${plain(n.label, 60)}"] {`];
                if (n.kind === "shape") out.push(`${indent}  <<shape>>`);
                else if (n.isGroup) out.push(`${indent}  <<group>>`);
                else if (n.external) out.push(`${indent}  <<reused>>`);
                members.forEach(m => out.push(`${indent}  +${plain(m)}`));
                out.push(`${indent}}`);
                return out;
            };
            byCluster.forEach((list, key) => {
                if (key !== null) {
                    lines.push(`  namespace ${safeName(clusterLabel(key), "Group")} {`);
                    list.forEach(n => lines.push(...classBlock(n, "    ")));
                    lines.push("  }");
                } else {
                    list.forEach(n => lines.push(...classBlock(n, "  ")));
                }
            });
            scene.edges.forEach(e => {
                const s = ids.get(e.source);
                const t = ids.get(e.target);
                if (!s || !t) return;
                // Relation labels may not contain ":" in Mermaid; U+2236 (∶) looks the same.
                const label = plain(`${e.label}${e.count > 1 ? ` x${e.count}` : ""}`, 50).replace(/:/g, "∶");
                if (e.kind === "subclass") lines.push(`  ${t} <|-- ${s}`);
                else if (e.kind === "equivalent") lines.push(`  ${s} .. ${t} : equivalentClass`);
                else if (e.kind === "shape") lines.push(`  ${s} ..> ${t} : targetClass`);
                else lines.push(`  ${s} --> ${t} : ${label}`);
            });
            return lines.join("\n") + "\n";
        }

        // Instance view: flowchart with one box per card.
        lines.push("flowchart LR");
        const styles = new Map();
        const styleFor = color => {
            const c = /^#[0-9a-f]{6}$/i.test(color || "") ? color : "#64748b";
            if (!styles.has(c)) styles.set(c, `t${styles.size}`);
            return styles.get(c);
        };
        const nodeLine = n => {
            const id = ids.get(n.id);
            const s = scene.sizes.get(n.id);
            const parts = [`<b>${mmd(n.label, 50)}</b>`, `<i>${mmd(n.nodeType, 40)}</i>`];
            if (n.isGroup) {
                parts.push(mmd(`${n.count} nodes`));
                if (n.internal) parts.push(mmd(`${n.internal} links inside`));
            } else if (!s.collapsed) {
                s.rows.forEach(r => parts.push(mmd((r.key ? `${r.key}: ` : "") + r.text, 56)));
                if (s.more > 0) parts.push(mmd(`+${s.more} more`));
            }
            return `${id}["${parts.join("<br/>")}"]`;
        };
        byCluster.forEach((list, key) => {
            if (key !== null) {
                lines.push(`  subgraph ${safeName(clusterLabel(key), "group")}_${ids.get(list[0].id)}["${mmd(clusterLabel(key))}"]`);
                lines.push("    direction TB");
                list.forEach(n => lines.push(`    ${nodeLine(n)}`));
                lines.push("  end");
            } else {
                list.forEach(n => lines.push(`  ${nodeLine(n)}`));
            }
        });
        scene.edges.forEach(e => {
            const s = ids.get(e.source);
            const t = ids.get(e.target);
            if (!s || !t) return;
            lines.push(`  ${s} -->|"${mmd(`${e.label}${e.count > 1 ? ` ×${e.count}` : ""}`, 50)}"| ${t}`);
        });
        scene.effNodes.forEach(n => {
            const cls = n.external ? "ext" : n.isGroup ? "grp" : styleFor(n.color);
            lines.push(`  class ${ids.get(n.id)} ${cls}`);
        });
        styles.forEach((cls, color) => lines.push(`  classDef ${cls} fill:${color}1f,stroke:${color},stroke-width:1.5px`));
        lines.push("  classDef ext fill:#f8fafc,stroke:#94a3b8,stroke-dasharray:4 3");
        lines.push("  classDef grp fill:#e2e8f0,stroke:#475569,stroke-width:2px");
        return lines.join("\n") + "\n";
    }

    function render(opts = {}) {
        if (!active) return;
        data = app.getGraphData();
        svg.innerHTML = "";
        markers.clear();
        el("defs", {}, svg);
        viewport = el("g", { class: "d-viewport" }, svg);
        frameLayer = el("g", { class: "d-frames" }, viewport);
        edgeLayer = el("g", { class: "d-edges" }, viewport);
        nodeLayer = el("g", { class: "d-nodes" }, viewport);
        boxes = new Map();
        frames = [];
        if (!data) return;
        const mode = currentMode();
        layoutSelect.value = mode;
        toolbar.querySelector(".dt-groups").style.display = mode === "layered" ? "none" : "";

        const scene = buildScene(data, mode);
        const notice = document.getElementById("diagram-notice");
        if (notice) notice.textContent = scene.total > MAX_NODES ? `Showing ${MAX_NODES} of ${scene.total} nodes — hide some types in the sidebar to see the rest.` : "";
        const { effNodes, edges, clusters, outgoing, sizes } = scene;
        labelIndex = scene.labels;

        // Place: groups (or the whole graph) laid out, then packed.
        const items = [];
        if (mode === "layered") {
            const ids = effNodes.map(n => n.id);
            const lay = layered(ids, edges, sizes, 1400);
            items.push({ key: "all", frame: false, ids, lay, w: lay.w, h: lay.h });
        } else {
            clusters.forEach(c => {
                if (collapsedClusters.has(c.key)) {
                    const id = `group::${c.key}`;
                    const s = sizes.get(id);
                    items.push({ key: c.key, frame: false, ids: [id], lay: { positions: new Map([[id, { x: 0, y: 0 }]]) }, w: s.w, h: s.h });
                    return;
                }
                const ids = c.members.filter(id => sizes.has(id));
                const inner = edges.filter(e => ids.includes(e.source) && ids.includes(e.target));
                const lay = layered(ids, inner, sizes, 520);
                items.push({ key: c.key, frame: true, label: c.label, color: c.color, ids, lay, w: lay.w + FRAME_PAD * 2, h: lay.h + FRAME_PAD * 2 + FRAME_TITLE });
            });
            // Order groups so that linked groups end up next to each other.
            const itemOf = new Map();
            items.forEach((it, i) => it.ids.forEach(id => itemOf.set(id, i)));
            const weight = new Map();
            edges.forEach(e => {
                const a = itemOf.get(e.source);
                const b = itemOf.get(e.target);
                if (a === undefined || b === undefined || a === b) return;
                const k = a < b ? `${a}|${b}` : `${b}|${a}`;
                weight.set(k, (weight.get(k) || 0) + 1);
            });
            const placedOrder = [];
            const remaining = new Set(items.map((_, i) => i));
            const byArea = [...remaining].sort((a, b) => items[b].ids.length - items[a].ids.length);
            if (byArea.length) { placedOrder.push(byArea[0]); remaining.delete(byArea[0]); }
            while (remaining.size) {
                let best = null;
                let bestW = -1;
                remaining.forEach(i => {
                    let w = 0;
                    placedOrder.forEach(j => { w += weight.get(i < j ? `${i}|${j}` : `${j}|${i}`) || 0; });
                    if (w > bestW || (w === bestW && items[i].ids.length > items[best].ids.length)) { best = i; bestW = w; }
                });
                placedOrder.push(best);
                remaining.delete(best);
            }
            const ordered = placedOrder.map(i => items[i]);
            items.length = 0;
            items.push(...ordered);
        }
        // Shelf packing of the items.
        const area = items.reduce((s, it) => s + (it.w + CLUSTER_GAP) * (it.h + CLUSTER_GAP), 0);
        const maxRow = Math.max(1500, Math.sqrt(area) * 1.4);
        let x = 0;
        let y = 0;
        let rowH = 0;
        items.forEach(it => {
            if (x > 0 && x + it.w > maxRow) { x = 0; y += rowH + CLUSTER_GAP; rowH = 0; }
            it.x = x;
            it.y = y;
            x += it.w + CLUSTER_GAP;
            rowH = Math.max(rowH, it.h);
        });
        items.forEach(it => {
            const ox = it.x + (it.frame ? FRAME_PAD : 0);
            const oy = it.y + (it.frame ? FRAME_PAD + FRAME_TITLE : 0);
            it.ids.forEach(id => {
                const p = it.lay.positions.get(id);
                const node = effNodes.find(n => n.id === id);
                const s = sizes.get(id);
                if (!p || !node) return;
                boxes.set(id, { id, node, x: ox + p.x, y: oy + p.y, w: s.w, h: s.h, content: s, outgoing: outgoing.get(id) || [], cluster: it.key });
            });
            if (it.frame) frames.push({ key: it.key, label: it.label, color: it.color, x: it.x, y: it.y, w: it.w, h: it.h, members: it.ids });
        });

        drawFrames();
        drawEdges();
        drawBoxes();
        if (!opts.keepView) fitView(true); else applyView();
        selection = new Set(app.getSelectedNodes ? app.getSelectedNodes() : []);
        highlight();
    }

    // ── Interaction ───────────────────────────

    let drag = null;
    let frame = null;

    function redrawAfterMove() {
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = null;
            frames.forEach(f => {
                const g = frameLayer.querySelector(`.d-frame[data-key="${CSS.escape(f.key)}"]`);
                if (g && f.dirty) {
                    g.querySelectorAll("rect").forEach((r, i) => { r.setAttribute("x", f.x); r.setAttribute("y", f.y); if (i === 0) { r.setAttribute("width", f.w); r.setAttribute("height", f.h); } });
                    g.querySelectorAll("text").forEach((t, i) => { t.setAttribute("x", f.x + (i === 0 ? 12 : 28)); t.setAttribute("y", f.y + 18); });
                    f.dirty = false;
                }
            });
            drawEdges();
            highlight();
        });
    }

    svg.addEventListener("mousedown", e => {
        if (e.button !== 0) return;
        const pt = { x: e.clientX, y: e.clientY };
        const frameTitle = e.target.closest(".d-frame-title");
        const nodeEl = e.target.closest(".d-node");
        if (nodeEl) {
            const box = boxes.get(nodeEl.getAttribute("data-id"));
            const group = selection.has(box.id) && selection.size > 1 ? [...selection].map(id => boxes.get(id)).filter(Boolean) : [box];
            drag = { type: "nodes", boxes: group, origins: group.map(b => ({ x: b.x, y: b.y })), start: pt, moved: false, target: e.target, box, additive: e.ctrlKey || e.metaKey };
        } else if (frameTitle) {
            const f = frames.find(x => x.key === frameTitle.getAttribute("data-key"));
            const members = f.members.map(id => boxes.get(id)).filter(Boolean);
            drag = { type: "frame", frame: f, boxes: members, origins: members.map(b => ({ x: b.x, y: b.y })), forigin: { x: f.x, y: f.y }, start: pt, moved: false, target: e.target };
        } else {
            drag = { type: "pan", start: pt, origin: { tx: view.tx, ty: view.ty }, moved: false, additive: e.ctrlKey || e.metaKey };
            container.classList.add("panning");
        }
        e.preventDefault();
    });
    window.addEventListener("mousemove", e => {
        if (!drag) return;
        const dx = e.clientX - drag.start.x;
        const dy = e.clientY - drag.start.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (!drag.moved) return;
        if (drag.type === "pan") {
            view.tx = drag.origin.tx + dx;
            view.ty = drag.origin.ty + dy;
            applyView();
            return;
        }
        drag.boxes.forEach((b, i) => {
            b.x = drag.origins[i].x + dx / view.k;
            b.y = drag.origins[i].y + dy / view.k;
            b.el.setAttribute("transform", `translate(${b.x},${b.y})`);
        });
        if (drag.type === "frame") {
            drag.frame.x = drag.forigin.x + dx / view.k;
            drag.frame.y = drag.forigin.y + dy / view.k;
            drag.frame.dirty = true;
        }
        redrawAfterMove();
    });
    window.addEventListener("mouseup", () => {
        if (!drag) return;
        const d = drag;
        drag = null;
        container.classList.remove("panning");
        if (d.moved) return;
        if (d.type === "frame") {
            if (d.target.closest(".d-cluster-toggle") || d.target.closest(".d-frame-title")) {
                collapsedClusters.add(d.frame.key);
                render({ keepView: true });
            }
            return;
        }
        if (d.type === "pan") {
            if (!d.additive) app.clearSelection();
            return;
        }
        const id = d.box.id;
        if (d.target.closest(".d-toggle")) {
            if (d.box.node.isGroup) collapsedClusters.delete(d.box.node.key);
            else if (collapsedBoxes.has(id)) collapsedBoxes.delete(id);
            else collapsedBoxes.add(id);
            render({ keepView: true });
            return;
        }
        if (d.box.node.isGroup) return;
        const row = d.target.closest(".d-edge-row");
        if (row && !d.additive) {
            const r = d.box.content.edgeRows[Number(row.getAttribute("data-row"))];
            if (r && !r.more && graph.hasNode(r.edges[0].target)) {
                app.selectNode(r.edges[0].target, { focus: false });
                focusOn(r.edges[0].target);
                return;
            }
        }
        app.selectNode(id, { focus: false, additive: d.additive });
    });
    svg.addEventListener("dblclick", e => {
        const nodeEl = e.target.closest(".d-node");
        if (!nodeEl) return;
        const id = nodeEl.getAttribute("data-id");
        const box = boxes.get(id);
        if (box && box.node.isGroup) { collapsedClusters.delete(box.node.key); render({ keepView: true }); return; }
        app.revealInEditor(id);
    });
    svg.addEventListener("wheel", e => {
        e.preventDefault();
        const rect = svg.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const k = Math.max(0.05, Math.min(4, view.k * Math.exp(-e.deltaY * 0.0015)));
        view.tx = mx - ((mx - view.tx) * k) / view.k;
        view.ty = my - ((my - view.ty) * k) / view.k;
        view.k = k;
        applyView();
    }, { passive: false });
    svg.addEventListener("mouseover", e => {
        if (drag) return;
        const row = e.target.closest(".d-edge-row");
        const nodeEl = e.target.closest(".d-node");
        routes.forEach(r => r.el.classList.remove("hover"));
        if (row && nodeEl) {
            const box = boxes.get(nodeEl.getAttribute("data-id"));
            const r = box && box.content.edgeRows[Number(row.getAttribute("data-row"))];
            if (r) {
                const set = new Set(r.edges);
                routes.forEach(rt => { if (set.has(rt.edge)) rt.el.classList.add("hover"); });
            }
        } else if (nodeEl) {
            const id = nodeEl.getAttribute("data-id");
            routes.forEach(r => { if (r.edge.source === id || r.edge.target === id) r.el.classList.add("hover"); });
        }
    });

    function zoomBy(factor) {
        const W = container.clientWidth / 2;
        const H = container.clientHeight / 2;
        const k = Math.max(0.05, Math.min(4, view.k * factor));
        view.tx = W - ((W - view.tx) * k) / view.k;
        view.ty = H - ((H - view.ty) * k) / view.k;
        view.k = k;
        applyView();
    }

    function focusOn(id) {
        const b = boxes.get(id);
        if (!b) return;
        view.k = Math.max(view.k, 0.8);
        view.tx = container.clientWidth / 2 - (b.x + b.w / 2) * view.k;
        view.ty = container.clientHeight / 2 - (b.y + b.h / 2) * view.k;
        applyView();
    }

    function setActive(on) {
        active = on;
        container.classList.toggle("hidden", !on);
        if (on) render();
    }

    return {
        setActive,
        isActive: () => active,
        render,
        fit: () => fitView(false),
        zoomIn: () => zoomBy(1.25),
        zoomOut: () => zoomBy(0.8),
        focusOn,
        toMermaid,
        onSelection: (id, ids) => {
            selection = new Set(ids || (id ? [id] : []));
            if (active) highlight();
        },
    };
}
