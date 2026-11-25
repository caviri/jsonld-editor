/* ==============================================
   JSON-LD Graph Visualization — Box diagram view
   ==============================================

   An alternative rendering of the current graph data (instance or schema
   view): every node is a card — the same information as the hover box, plus
   its literal values (or a class's attributes, or a shape's constraints) —
   and links are drawn as orthogonal ("square") connectors between cards.

   Layout is layered: nodes that are pointed to sit higher, nodes that point
   to them sit below (so superclasses end up above subclasses, organisations
   above memberships above people). Long layers wrap; unconnected nodes go
   in a grid at the bottom.

   Interaction: drag the background to pan, wheel to zoom, drag a card to
   move it, click to select (synced with the sidebar, tables and editor),
   double-click to open its JSON-LD source.
*/

function createDiagram(app, graph) {
    const container = document.getElementById("diagram-container");
    const svg = document.getElementById("diagram-svg");
    const NS = "http://www.w3.org/2000/svg";
    const MAX_NODES = 600;
    const ROW_GAP = 84;
    const COL_GAP = 36;
    const HEADER_H = 36;
    const ROW_H = 15;
    const MAX_ROWS = 6;
    const MIN_W = 150;
    const MAX_W = 270;

    let active = false;
    let data = null;
    let boxes = new Map();     // id -> { id, x, y, w, h, row, node, el }
    let routes = [];           // { edge, el, labelEl, path }
    let view = { k: 1, tx: 0, ty: 0 };
    let viewport = null;
    let edgeLayer = null;
    let nodeLayer = null;
    let selected = null;
    let truncatedNotice = null;
    const measureCtx = document.createElement("canvas").getContext("2d");

    function el(name, attrs = {}, parent) {
        const node = document.createElementNS(NS, name);
        Object.entries(attrs).forEach(([k, v]) => { if (v !== undefined && v !== null) node.setAttribute(k, v); });
        if (parent) parent.appendChild(node);
        return node;
    }

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

    const FONT_LABEL = "600 12.5px system-ui, -apple-system, 'Segoe UI', sans-serif";
    const FONT_TYPE = "700 9.5px system-ui, -apple-system, 'Segoe UI', sans-serif";
    const FONT_ROW = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

    // ── Card content ──────────────────────────

    function rowsFor(node) {
        const rows = [];
        const props = node.properties || {};
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
            const shown = literals.map(v => (v && typeof v === "object" ? (v.text || v.iri) : String(v))).join(", ");
            rows.push({ key, text: shown });
        });
        return rows;
    }

    function measureBox(node) {
        const rows = rowsFor(node);
        const visible = rows.slice(0, MAX_ROWS);
        let w = Math.max(textWidth(node.label || "", FONT_LABEL) + 30, textWidth((node.nodeType || "").toUpperCase(), FONT_TYPE) + 40);
        visible.forEach(r => { w = Math.max(w, textWidth((r.key ? r.key + ": " : "") + r.text, FONT_ROW) + 22); });
        w = Math.max(MIN_W, Math.min(MAX_W, Math.ceil(w)));
        const extra = rows.length > MAX_ROWS ? 1 : 0;
        const h = HEADER_H + (visible.length + extra ? (visible.length + extra) * ROW_H + 10 : 0);
        return { w, h, rows: visible, more: rows.length - visible.length };
    }

    // ── Layout ────────────────────────────────

    function layout(nodes, edges) {
        const ids = nodes.map(n => n.id);
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

        // Break cycles with an iterative DFS; back edges are ignored for layering.
        const color = new Uint8Array(ids.length);
        const back = new Set();
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
                    stack.pop();
                }
            }
        }

        // Height = longest path to a sink: sinks (pointed-to things) on top.
        const height = new Int32Array(ids.length).fill(-1);
        const order = [];
        const seen = new Uint8Array(ids.length);
        for (let start = 0; start < ids.length; start += 1) {
            if (seen[start]) continue;
            const stack = [[start, 0]];
            seen[start] = 1;
            while (stack.length) {
                const top = stack[stack.length - 1];
                const [u, i] = top;
                if (i < out[u].length) {
                    top[1] += 1;
                    const v = out[u][i];
                    if (!back.has(u * 1e6 + v) && !seen[v]) { seen[v] = 1; stack.push([v, 0]); }
                } else {
                    order.push(u);
                    stack.pop();
                }
            }
        }
        order.forEach(u => {
            let h = 0;
            out[u].forEach(v => { if (!back.has(u * 1e6 + v)) h = Math.max(h, height[v] + 1); });
            height[u] = h;
        });

        const isolated = [];
        const layers = [];
        ids.forEach((id, i) => {
            if (!out[i].length && !inc[i].length) { isolated.push(i); return; }
            (layers[height[i]] = layers[height[i]] || []).push(i);
        });

        // Barycentric ordering, a few sweeps.
        const pos = new Float64Array(ids.length);
        layers.forEach(layer => { if (layer) layer.forEach((u, i) => { pos[u] = i; }); });
        for (let sweep = 0; sweep < 4; sweep += 1) {
            const range = sweep % 2 === 0 ? layers.keys() : [...layers.keys()].reverse();
            for (const li of range) {
                const layer = layers[li];
                if (!layer) continue;
                const bary = u => {
                    const nb = sweep % 2 === 0 ? out[u] : inc[u];
                    if (!nb.length) return pos[u];
                    return nb.reduce((s, v) => s + pos[v], 0) / nb.length;
                };
                layer.sort((a, b) => bary(a) - bary(b));
                layer.forEach((u, i) => { pos[u] = i; });
            }
        }

        // Rows: wrap long layers.
        const sizes = nodes.map(measureBox);
        const totalWidth = sizes.reduce((s, b) => s + b.w + COL_GAP, 0);
        const maxRowWidth = Math.max(1400, Math.sqrt(totalWidth * 900));
        const rows = [];
        layers.forEach(layer => {
            if (!layer) return;
            let current = [];
            let width = 0;
            layer.forEach(u => {
                if (current.length && width + sizes[u].w > maxRowWidth) { rows.push(current); current = []; width = 0; }
                current.push(u);
                width += sizes[u].w + COL_GAP;
            });
            if (current.length) rows.push(current);
        });
        // Isolated nodes: a grid below.
        if (isolated.length) {
            let current = [];
            let width = 0;
            isolated.forEach(u => {
                if (current.length && width + sizes[u].w > maxRowWidth) { rows.push(current); current = []; width = 0; }
                current.push(u);
                width += sizes[u].w + COL_GAP;
            });
            if (current.length) rows.push(current);
        }

        const placed = new Map();
        let y = 0;
        rows.forEach((row, ri) => {
            const rowW = row.reduce((s, u) => s + sizes[u].w, 0) + COL_GAP * (row.length - 1);
            const rowH = Math.max(...row.map(u => sizes[u].h));
            let x = -rowW / 2;
            row.forEach(u => {
                placed.set(ids[u], { x, y, w: sizes[u].w, h: sizes[u].h, row: ri, content: sizes[u] });
                x += sizes[u].w + COL_GAP;
            });
            y += rowH + ROW_GAP;
        });
        return placed;
    }

    // ── Routing (orthogonal connectors) ───────

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
        // Ports: spread the connectors of each box side along that side.
        const sides = new Map(); // `${id}|top` -> [{edgeIdx, otherX}]
        const plans = [];
        data.edges.forEach((e, i) => {
            const s = boxes.get(e.source);
            const t = boxes.get(e.target);
            if (!s || !t || s === t) return;
            let sSide;
            let tSide;
            if (t.y + t.h <= s.y) { sSide = "top"; tSide = "bottom"; }
            else if (t.y >= s.y + s.h) { sSide = "bottom"; tSide = "top"; }
            else { sSide = "bottom"; tSide = "bottom"; }
            plans.push({ i, e, s, t, sSide, tSide });
            const push = (key, other) => { if (!sides.has(key)) sides.set(key, []); sides.get(key).push({ plan: plans[plans.length - 1], otherX: other }); };
            push(`${s.id}|${sSide}|s`, t.x + t.w / 2);
            push(`${t.id}|${tSide}|t`, s.x + s.w / 2);
        });
        sides.forEach((list, key) => {
            const [id, side, role] = key.split("|");
            const box = boxes.get(id);
            list.sort((a, b) => a.otherX - b.otherX);
            list.forEach((entry, k) => {
                const x = box.x + ((k + 1) * box.w) / (list.length + 1);
                const y = side === "top" ? box.y : box.y + box.h;
                if (role === "s") entry.plan.sp = [x, y];
                else entry.plan.tp = [x, y];
            });
        });
        // Lanes inside each channel so horizontal segments don't overlap.
        const lanes = new Map();
        const lane = (key) => { const n = lanes.get(key) || 0; lanes.set(key, n + 1); return ((n % 7) - 3) * 6; };
        return plans.map(p => {
            const [sx, sy] = p.sp;
            const [tx, ty] = p.tp;
            let points;
            if (p.sSide === "top") {
                const cy = p.t.y + p.t.h + ROW_GAP / 2 + lane(`below|${p.t.row}`);
                points = [[sx, sy], [sx, cy], [tx, cy], [tx, ty]];
            } else if (p.tSide === "top") {
                const cy = p.t.y - ROW_GAP / 2 + lane(`above|${p.t.row}`);
                points = [[sx, sy], [sx, cy], [tx, cy], [tx, ty]];
            } else {
                const cy = Math.max(p.s.y + p.s.h, p.t.y + p.t.h) + 16 + Math.abs(lane(`same|${p.s.row}`));
                points = [[sx, sy], [sx, cy], [tx, cy], [tx, ty]];
            }
            // Drop zero-length segments.
            points = points.filter((pt, k) => k === 0 || pt[0] !== points[k - 1][0] || pt[1] !== points[k - 1][1]);
            const mid = points.length >= 3 ? [(points[1][0] + points[2][0]) / 2, points[1][1]] : [(sx + tx) / 2, (sy + ty) / 2];
            return { edge: p.e, points, mid, kind: p.e.kind };
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
        routes = computeRoutes().map(r => {
            const g = el("g", { class: "d-edge", "data-source": r.edge.source, "data-target": r.edge.target }, edgeLayer);
            const hollow = r.kind === "subclass";
            const path = el("path", {
                d: roundedPath(r.points),
                stroke: r.edge.color,
                fill: "none",
                "stroke-width": "1.6",
                "stroke-dasharray": r.kind === "shape" ? "5 4" : (r.kind === "observed" ? null : null),
                "marker-end": markerFor(r.edge.color, hollow),
            }, g);
            el("path", { d: roundedPath(r.points), stroke: "transparent", fill: "none", "stroke-width": "10", class: "d-edge-hit" }, g);
            let label = null;
            if (r.edge.label && data.edges.length <= 400) {
                label = el("text", { x: r.mid[0], y: r.mid[1] - 4, class: "d-edge-label", "text-anchor": "middle" }, g);
                label.textContent = r.edge.label;
            }
            const title = el("title", {}, g);
            title.textContent = `${r.edge.label}: ${graph.hasNode(r.edge.source) ? graph.getNodeAttribute(r.edge.source, "label") : r.edge.source} → ${graph.hasNode(r.edge.target) ? graph.getNodeAttribute(r.edge.target, "label") : r.edge.target}`;
            return { edge: r.edge, el: g, path, label };
        });
    }

    function drawBoxes() {
        nodeLayer.innerHTML = "";
        boxes.forEach(box => {
            const n = box.node;
            const g = el("g", { class: `d-node${n.external ? " external" : ""}`, transform: `translate(${box.x},${box.y})`, "data-id": n.id }, nodeLayer);
            el("rect", { class: "d-box", width: box.w, height: box.h, rx: 8, ry: 8 }, g);
            el("rect", { class: "d-box-header", width: box.w, height: HEADER_H, rx: 8, ry: 8, fill: n.color, "fill-opacity": "0.14" }, g);
            el("rect", { x: 0, y: 0, width: 4, height: box.h, rx: 2, fill: n.color }, g);
            const type = el("text", { x: 12, y: 13, class: "d-type", fill: n.color }, g);
            type.textContent = fit((n.nodeType || "").toUpperCase(), FONT_TYPE, box.w - 40);
            const label = el("text", { x: 12, y: 28, class: "d-label" }, g);
            label.textContent = fit(String(n.label || n.id), FONT_LABEL, box.w - 22);
            const content = box.content;
            if (content.rows.length || content.more > 0) {
                el("line", { x1: 0, x2: box.w, y1: HEADER_H, y2: HEADER_H, class: "d-divider" }, g);
                content.rows.forEach((r, i) => {
                    const t = el("text", { x: 12, y: HEADER_H + 16 + i * ROW_H, class: `d-row${r.muted ? " muted" : ""}` }, g);
                    const full = (r.key ? `${r.key}: ` : "") + r.text;
                    if (r.key) {
                        const k = el("tspan", { class: "d-row-key" }, t);
                        k.textContent = `${r.key}: `;
                        const v = el("tspan", {}, t);
                        v.textContent = fit(r.text, FONT_ROW, box.w - 22 - textWidth(`${r.key}: `, FONT_ROW));
                    } else {
                        t.textContent = fit(full, FONT_ROW, box.w - 22);
                    }
                });
                if (content.more > 0) {
                    const t = el("text", { x: 12, y: HEADER_H + 16 + content.rows.length * ROW_H, class: "d-row muted" }, g);
                    t.textContent = `+${content.more} more`;
                }
            }
            // Badges: invalid IRI, validation.
            const v = n.validation;
            if (v) {
                el("circle", { cx: box.w - 12, cy: 12, r: 7, fill: v.ok ? "#22c55e" : "#ef4444", class: "d-badge" }, g);
                const t = el("text", { x: box.w - 12, y: 15.5, "text-anchor": "middle", class: "d-badge-text" }, g);
                t.textContent = v.ok ? "✓" : "✗";
            }
            if (n.invalidId) {
                el("circle", { cx: box.w - (v ? 30 : 12), cy: 12, r: 7, fill: "#ef4444", class: "d-badge" }, g);
                const t = el("text", { x: box.w - (v ? 30 : 12), y: 15.5, "text-anchor": "middle", class: "d-badge-text" }, g);
                t.textContent = "!";
            }
            const title = el("title", {}, g);
            title.textContent = `${n.label}\n${n.id}`;
            box.el = g;
        });
    }

    function applyView() {
        if (viewport) viewport.setAttribute("transform", `translate(${view.tx},${view.ty}) scale(${view.k})`);
    }

    /**
     * Fit the diagram in the view. `readable` keeps cards legible (zoom ≥ 0.6):
     * when everything does not fit at that zoom, the top of the diagram is shown.
     */
    function fitView(readable = false) {
        if (!boxes.size) return;
        let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
        boxes.forEach(b => { minX = Math.min(minX, b.x); minY = Math.min(minY, b.y); maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h); });
        const W = container.clientWidth || 800;
        const H = container.clientHeight || 600;
        const pad = 50;
        const usableW = W - pad * 2 - 60; // controls column on the right
        const fitK = Math.min(1.3, usableW / Math.max(1, maxX - minX), (H - pad * 2) / Math.max(1, maxY - minY));
        view.k = Math.max(0.05, readable ? Math.max(fitK, Math.min(0.6, 1.3)) : fitK);
        view.tx = (W - 60) / 2 - ((minX + maxX) / 2) * view.k;
        view.ty = (maxY - minY) * view.k <= H - pad * 2 ? H / 2 - ((minY + maxY) / 2) * view.k : pad + 10 - minY * view.k;
        applyView();
    }

    function highlight() {
        const focus = selected && boxes.has(selected) ? selected : null;
        nodeLayer.querySelectorAll(".d-node").forEach(g => {
            const id = g.getAttribute("data-id");
            g.classList.toggle("selected", id === focus);
        });
        const neighbours = new Set();
        routes.forEach(r => {
            const on = focus && (r.edge.source === focus || r.edge.target === focus);
            r.el.classList.toggle("hl", Boolean(on));
            r.el.classList.toggle("dim", Boolean(focus && !on));
            if (on) { neighbours.add(r.edge.source); neighbours.add(r.edge.target); }
        });
        nodeLayer.querySelectorAll(".d-node").forEach(g => {
            const id = g.getAttribute("data-id");
            g.classList.toggle("dim", Boolean(focus && !neighbours.has(id) && id !== focus));
        });
    }

    function render(opts = {}) {
        if (!active) return;
        data = app.getGraphData();
        svg.innerHTML = "";
        markers.clear();
        el("defs", {}, svg);
        viewport = el("g", { class: "d-viewport" }, svg);
        edgeLayer = el("g", { class: "d-edges" }, viewport);
        nodeLayer = el("g", { class: "d-nodes" }, viewport);
        if (!data) return;
        const visibleNodes = data.nodes.filter(n => !graph.hasNode(n.id) || !graph.getNodeAttribute(n.id, "hidden"));
        const nodes = visibleNodes.slice(0, MAX_NODES);
        const keep = new Set(nodes.map(n => n.id));
        const edges = data.edges.filter(e => keep.has(e.source) && keep.has(e.target));
        if (truncatedNotice) truncatedNotice.textContent = visibleNodes.length > MAX_NODES
            ? `Showing ${MAX_NODES} of ${visibleNodes.length} nodes — hide some types in the sidebar to see the rest.` : "";
        const placed = layout(nodes, edges);
        const previous = boxes;
        boxes = new Map();
        nodes.forEach(n => {
            const p = placed.get(n.id);
            if (!p) return;
            const old = opts.keepPositions ? previous.get(n.id) : null;
            boxes.set(n.id, Object.assign({ id: n.id, node: n }, p, old && old.moved ? { x: old.x, y: old.y, moved: true } : {}));
        });
        data = Object.assign({}, data, { edges });
        drawEdges();
        drawBoxes();
        if (!opts.keepView) fitView(true); else applyView();
        selected = app.getSelectedNode();
        highlight();
    }

    // ── Interaction ───────────────────────────

    let drag = null;
    svg.addEventListener("mousedown", e => {
        if (e.button !== 0) return;
        const nodeEl = e.target.closest(".d-node");
        const pt = { x: e.clientX, y: e.clientY };
        if (nodeEl) {
            const box = boxes.get(nodeEl.getAttribute("data-id"));
            drag = { type: "node", box, start: pt, origin: { x: box.x, y: box.y }, moved: false };
        } else {
            drag = { type: "pan", start: pt, origin: { tx: view.tx, ty: view.ty }, moved: false };
            container.classList.add("panning");
        }
        e.preventDefault();
    });
    let frame = null;
    window.addEventListener("mousemove", e => {
        if (!drag) return;
        const dx = e.clientX - drag.start.x;
        const dy = e.clientY - drag.start.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.type === "pan") {
            view.tx = drag.origin.tx + dx;
            view.ty = drag.origin.ty + dy;
            applyView();
        } else if (drag.moved) {
            drag.box.x = drag.origin.x + dx / view.k;
            drag.box.y = drag.origin.y + dy / view.k;
            drag.box.moved = true;
            drag.box.el.setAttribute("transform", `translate(${drag.box.x},${drag.box.y})`);
            if (!frame) frame = requestAnimationFrame(() => { frame = null; drawEdges(); highlight(); });
        }
    });
    window.addEventListener("mouseup", () => {
        if (!drag) return;
        const d = drag;
        drag = null;
        container.classList.remove("panning");
        if (d.type === "node" && !d.moved) {
            app.selectNode(d.box.id, { focus: false });
        } else if (d.type === "pan" && !d.moved) {
            app.clearSelection();
        }
    });
    svg.addEventListener("dblclick", e => {
        const nodeEl = e.target.closest(".d-node");
        if (nodeEl) app.revealInEditor(nodeEl.getAttribute("data-id"));
    });
    svg.addEventListener("wheel", e => {
        e.preventDefault();
        const rect = svg.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * 0.0015);
        const k = Math.max(0.05, Math.min(4, view.k * factor));
        view.tx = mx - ((mx - view.tx) * k) / view.k;
        view.ty = my - ((my - view.ty) * k) / view.k;
        view.k = k;
        applyView();
    }, { passive: false });
    svg.addEventListener("mouseover", e => {
        const nodeEl = e.target.closest(".d-node");
        if (!nodeEl || drag) return;
        const id = nodeEl.getAttribute("data-id");
        routes.forEach(r => r.el.classList.toggle("hover", r.edge.source === id || r.edge.target === id));
    });
    svg.addEventListener("mouseout", e => {
        if (e.target.closest(".d-node")) routes.forEach(r => r.el.classList.remove("hover"));
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
        const W = container.clientWidth;
        const H = container.clientHeight;
        view.k = Math.max(view.k, 0.8);
        view.tx = W / 2 - (b.x + b.w / 2) * view.k;
        view.ty = H / 2 - (b.y + b.h / 2) * view.k;
        applyView();
    }

    function setActive(on) {
        active = on;
        container.classList.toggle("hidden", !on);
        if (on) render();
    }

    truncatedNotice = document.getElementById("diagram-notice");

    return {
        setActive,
        isActive: () => active,
        render,
        fit: () => fitView(false),
        zoomIn: () => zoomBy(1.25),
        zoomOut: () => zoomBy(0.8),
        focusOn,
        onSelection: id => {
            selected = id;
            if (active) { highlight(); if (id && boxes.has(id)) { /* keep view */ } }
        },
    };
}
