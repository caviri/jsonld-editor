/* ==============================================
   JSON-LD Graph Visualization — UI Module
   ============================================== */

/** Escape text for safe insertion into HTML. */
function escapeHtml(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** Only http(s) links are rendered as anchors. */
function safeHref(value) {
    return typeof value === "string" && /^https?:\/\//i.test(value) ? value : null;
}

/**
 * Create the UI module.
 * @param {object} graph - graphology Graph instance
 * @param {object} sigmaInstance - Sigma renderer instance
 * @param {object} layoutManager - from createLayouts()
 * @param {object} editorModule - from createEditor()
 * @returns {object} UI API
 */
function createUI(graph, sigmaInstance, layoutManager, editorModule) {
    let selectedNode = null;
    let hoveredNode = null;
    let highlightedNodes = new Set();
    let highlightedEdges = new Set();
    const hiddenTypes = new Set();
    let tooltipsEnabled = true;
    let tableSyncEnabled = true;
    let nodesByType = {};
    let activeDataTab = null;
    let graphData = null;
    let toolTabs = [];
    let nodeActionHandler = () => {};
    let nodeActionsProvider = () => [];
    const selectionListeners = new Set();
    const filterListeners = new Set();
    const emitSelection = () => selectionListeners.forEach(fn => { try { fn(selectedNode); } catch (_) { /* ignore */ } });

    // Drag state
    let draggedNode = null;
    let isDragging = false;
    let dragModeEnabled = false;

    function cssVar(name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }
    function mutedNodeColor() { return cssVar("--node-muted") || "#d1d5db"; }
    function mutedEdgeColor() { return cssVar("--edge-muted") || "#e5e7eb"; }

    // DOM elements
    const filtersContainer = document.getElementById("filters");
    const edgeLegend = document.getElementById("edge-legend");
    const searchInput = document.getElementById("search-input");
    const searchResults = document.getElementById("search-results");
    const dragHint = document.getElementById("drag-hint");
    const toggleDragBtn = document.getElementById("toggle-drag");
    const toggleTooltipBtn = document.getElementById("toggle-tooltip");
    const toggleSyncBtn = document.getElementById("toggle-sync");
    const tooltip = document.getElementById("tooltip");
    const tooltipProps = document.getElementById("tooltip-properties");
    const dataPanel = document.getElementById("data-panel");
    const dataPanelHeader = document.getElementById("data-panel-header");
    const dataPanelTabs = document.getElementById("data-panel-tabs");
    const dataPanelContent = document.getElementById("data-panel-content");
    const sidebar = document.getElementById("sidebar");
    const sidebarToggle = document.getElementById("sidebar-toggle");
    const nodeActions = document.getElementById("node-actions");
    const graphContainer = document.getElementById("graph-container");
    const controlTooltip = document.getElementById("ui-tooltip");

    const hiddenProps = new Set(["uuid", "composite", "originalColor", "originalSize"]);

    // ── Control tooltip ──────────────────────

    const CONTROL_TOOLTIP_DELAY_MS = 250;
    let controlTooltipTimer = null;
    let controlTooltipTarget = null;

    function hideControlTooltip() {
        clearTimeout(controlTooltipTimer);
        controlTooltip.classList.remove("visible");
        controlTooltipTarget = null;
    }

    function positionControlTooltip(target) {
        const containerRect = graphContainer.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const tooltipWidth = controlTooltip.offsetWidth;
        const tooltipHeight = controlTooltip.offsetHeight;
        let left = targetRect.left - containerRect.left - tooltipWidth - 10;
        if (left < 8) left = targetRect.right - containerRect.left + 10;
        let top = targetRect.top - containerRect.top + (targetRect.height - tooltipHeight) / 2;
        top = Math.max(8, Math.min(top, containerRect.height - tooltipHeight - 8));
        controlTooltip.style.left = `${left}px`;
        controlTooltip.style.top = `${top}px`;
    }

    function scheduleControlTooltip(target) {
        const tooltipText = target.dataset.tooltip;
        if (!tooltipText) return;
        clearTimeout(controlTooltipTimer);
        controlTooltipTimer = setTimeout(() => {
            controlTooltip.textContent = tooltipText;
            controlTooltip.classList.add("visible");
            positionControlTooltip(target);
            controlTooltipTarget = target;
        }, CONTROL_TOOLTIP_DELAY_MS);
    }

    // ── Stats & filters ─────────────────────

    function updateStats() {
        document.getElementById("node-count").textContent = graph.order;
        document.getElementById("edge-count").textContent = graph.size;
        const valSpan = document.getElementById("validation-count");
        const valStats = (graphData && graphData.metadata.validation) || {};
        valSpan.classList.remove("stat-ok", "stat-fail", "stat-none");
        if (valStats.valid + valStats.invalid > 0) {
            valSpan.classList.add(valStats.invalid === 0 ? "stat-ok" : "stat-fail");
            valSpan.textContent = `${valStats.valid}/${valStats.valid + valStats.invalid} valid`;
        } else {
            valSpan.classList.add("stat-none");
            valSpan.textContent = graphData && graphData.view === "schema" ? "schema view" : "not validated";
        }
    }

    function typeSummary() {
        const summary = new Map();
        (graphData.nodes || []).forEach(node => {
            const entry = summary.get(node.nodeType) || { color: node.color, count: 0 };
            entry.count += 1;
            summary.set(node.nodeType, entry);
        });
        return summary;
    }

    function regroupNodesByType() {
        nodesByType = {};
        (graphData.nodes || []).forEach(node => {
            if (!nodesByType[node.nodeType]) nodesByType[node.nodeType] = [];
            nodesByType[node.nodeType].push(node);
        });
    }

    function rebuildFilters() {
        filtersContainer.innerHTML = "";
        const summary = [...typeSummary().entries()].sort((a, b) => b[1].count - a[1].count);
        if (!summary.length) {
            filtersContainer.innerHTML = '<p class="muted-note">No nodes yet.</p>';
            return;
        }
        summary.forEach(([type, info]) => {
            const item = document.createElement("label");
            item.className = "filter-item";
            item.innerHTML = `
                <input type="checkbox" class="filter-checkbox" ${hiddenTypes.has(type) ? "" : "checked"}>
                <span class="filter-color" style="background: ${escapeHtml(info.color)}"></span>
                <span class="filter-label"></span>
                <span class="filter-count">${info.count}</span>`;
            item.querySelector(".filter-checkbox").dataset.type = type;
            item.querySelector(".filter-label").textContent = type;
            filtersContainer.appendChild(item);
        });
    }

    function buildEdgeLegend() {
        edgeLegend.innerHTML = "";
        const counts = new Map();
        (graphData.edges || []).forEach(e => {
            const entry = counts.get(e.label) || { color: e.color, count: 0 };
            entry.count += 1;
            counts.set(e.label, entry);
        });
        const entries = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
        if (!entries.length) {
            edgeLegend.innerHTML = '<p class="muted-note">No links between nodes.</p>';
            return;
        }
        entries.slice(0, 18).forEach(([label, info]) => {
            const item = document.createElement("div");
            item.className = "legend-item";
            item.innerHTML = `<span class="legend-line" style="background: ${escapeHtml(info.color)}"></span><span class="legend-label"></span><span class="filter-count">${info.count}</span>`;
            item.querySelector(".legend-label").textContent = label;
            edgeLegend.appendChild(item);
        });
        if (entries.length > 18) {
            const more = document.createElement("p");
            more.className = "muted-note";
            more.textContent = `+${entries.length - 18} more relationship types`;
            edgeLegend.appendChild(more);
        }
    }

    function updateVisibility() {
        graph.forEachNode((nodeId, attrs) => {
            graph.setNodeAttribute(nodeId, "hidden", hiddenTypes.has(attrs.nodeType));
        });
        graph.forEachEdge((edgeId, attrs, source, target) => {
            const sourceHidden = graph.getNodeAttribute(source, "hidden");
            const targetHidden = graph.getNodeAttribute(target, "hidden");
            graph.setEdgeAttribute(edgeId, "hidden", sourceHidden || targetHidden);
        });
        sigmaInstance.refresh();
    }

    // ── Node highlight / selection ───────────

    function paint(nodesToShow, edgesToShow) {
        graph.forEachNode((id, attrs) => {
            const on = nodesToShow.has(id);
            graph.setNodeAttribute(id, "color", on ? attrs.originalColor : mutedNodeColor());
            graph.setNodeAttribute(id, "zIndex", on ? 1 : 0);
        });
        graph.forEachEdge((id, attrs) => {
            const on = edgesToShow.has(id);
            graph.setEdgeAttribute(id, "color", on ? attrs.originalColor : mutedEdgeColor());
            graph.setEdgeAttribute(id, "size", on ? 3 : 1);
            graph.setEdgeAttribute(id, "zIndex", on ? 1 : 0);
        });
        sigmaInstance.refresh();
    }

    function neighbourhood(nodeId, nodesSet, edgesSet) {
        nodesSet.add(nodeId);
        graph.forEachEdge(nodeId, (edgeId, attrs, source, target) => {
            edgesSet.add(edgeId);
            nodesSet.add(source);
            nodesSet.add(target);
        });
    }

    function highlightNodeConnections(nodeId, combineWithSelection = false) {
        const n = new Set();
        const e = new Set();
        neighbourhood(nodeId, n, e);
        if (combineWithSelection && selectedNode && graph.hasNode(selectedNode)) neighbourhood(selectedNode, n, e);
        paint(n, e);
    }

    function restoreSelectionHighlight() {
        if (!selectedNode || !graph.hasNode(selectedNode)) return;
        highlightedNodes = new Set();
        highlightedEdges = new Set();
        neighbourhood(selectedNode, highlightedNodes, highlightedEdges);
        paint(highlightedNodes, highlightedEdges);
    }

    function resetHighlight() {
        selectedNode = null;
        highlightedNodes.clear();
        highlightedEdges.clear();
        graph.forEachNode((id, attrs) => {
            graph.setNodeAttribute(id, "color", attrs.originalColor);
            graph.setNodeAttribute(id, "zIndex", 0);
        });
        graph.forEachEdge((id, attrs) => {
            graph.setEdgeAttribute(id, "color", attrs.originalColor);
            graph.setEdgeAttribute(id, "size", 2);
            graph.setEdgeAttribute(id, "zIndex", 0);
        });
        editorModule.setNodeEditButtonState(null, graph);
        editorModule.clearSourceHighlights();
        sigmaInstance.refresh();
        emitSelection();
    }

    function focusNode(nodeId) {
        const nodePosition = sigmaInstance.getNodeDisplayData(nodeId);
        if (nodePosition) {
            sigmaInstance.getCamera().animate({ x: nodePosition.x, y: nodePosition.y, ratio: 0.3 }, { duration: 500 });
        }
    }

    // ── Node details panel ───────────────────

    function renderValue(container, value) {
        if (value && typeof value === "object" && !Array.isArray(value) && value.iri) {
            if (graph.hasNode(value.iri)) {
                const a = document.createElement("button");
                a.type = "button";
                a.className = "node-link";
                a.textContent = graph.getNodeAttribute(value.iri, "label") || value.text;
                a.title = value.iri;
                a.addEventListener("click", () => { selectNode(value.iri); focusNode(value.iri); });
                container.appendChild(a);
            } else {
                const href = safeHref(value.iri);
                const el = document.createElement(href ? "a" : "span");
                if (href) { el.href = href; el.target = "_blank"; el.rel = "noopener noreferrer"; }
                el.textContent = value.text || value.iri;
                el.title = value.iri;
                container.appendChild(el);
            }
            return;
        }
        if (typeof value === "string" && safeHref(value)) {
            const a = document.createElement("a");
            a.href = value;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = value;
            container.appendChild(a);
            return;
        }
        const span = document.createElement("span");
        span.textContent = typeof value === "object" ? JSON.stringify(value) : String(value);
        container.appendChild(span);
    }

    function addPropertyItem(container, key, value) {
        const item = document.createElement("div");
        item.className = "property-item";
        const k = document.createElement("div");
        k.className = "property-key";
        k.textContent = key;
        const v = document.createElement("div");
        v.className = "property-value";
        const values = Array.isArray(value) ? value : [value];
        values.forEach((val, i) => {
            if (i > 0) v.appendChild(document.createTextNode(", "));
            renderValue(v, val);
        });
        item.appendChild(k);
        item.appendChild(v);
        container.appendChild(item);
    }

    function renderNodeActions(nodeId, attrs) {
        nodeActions.querySelectorAll(".node-action-btn.dynamic").forEach(b => b.remove());
        const actions = nodeActionsProvider(nodeId, attrs) || [];
        actions.forEach(action => {
            const btn = document.createElement("button");
            btn.className = "node-action-btn dynamic";
            btn.type = "button";
            btn.textContent = action.label;
            if (action.title) btn.title = action.title;
            btn.addEventListener("click", () => nodeActionHandler(action.id, nodeId, attrs));
            nodeActions.appendChild(btn);
        });
    }

    function showNodeDetails(nodeId) {
        const attrs = graph.getNodeAttributes(nodeId);
        document.getElementById("details-placeholder").style.display = "none";
        const detailsDiv = document.getElementById("node-details");
        detailsDiv.classList.add("active");

        document.getElementById("node-title").textContent = attrs.label;
        const typeSpan = document.getElementById("node-type");
        typeSpan.textContent = attrs.nodeType;
        typeSpan.style.background = attrs.originalColor + "20";
        typeSpan.style.color = attrs.originalColor;
        editorModule.setNodeEditButtonState(nodeId, graph);
        renderNodeActions(nodeId, attrs);

        const propsDiv = document.getElementById("node-properties");
        propsDiv.innerHTML = "";

        if (attrs.invalidId) {
            const warn = document.createElement("div");
            warn.className = "detail-callout detail-callout-error";
            warn.textContent = "This identifier is not a valid IRI. RDF tools (and rete exports) drop this node. See the Problems tab.";
            propsDiv.appendChild(warn);
        }

        if (attrs.validation) {
            const v = attrs.validation;
            const box = document.createElement("div");
            box.className = `detail-callout ${v.ok ? "detail-callout-ok" : "detail-callout-error"}`;
            const title = document.createElement("div");
            title.className = "detail-callout-title";
            title.textContent = `${v.ok ? "✓ Valid" : "✗ Invalid"} · ${v.source || "validation"}`;
            box.appendChild(title);
            if (v.detail) {
                const d = document.createElement("div");
                d.className = "detail-callout-sub";
                d.textContent = v.detail;
                box.appendChild(d);
            }
            if (v.shape) {
                const s = document.createElement("div");
                s.className = "detail-callout-sub";
                s.textContent = `Shape: ${v.shape}`;
                box.appendChild(s);
            }
            (v.errors || []).slice(0, 12).forEach(msg => {
                const e = document.createElement("div");
                e.className = "detail-callout-item";
                e.textContent = `• ${msg}`;
                box.appendChild(e);
            });
            propsDiv.appendChild(box);
        }

        const types = attrs.types || [];
        if (types.length > 1) addPropertyItem(propsDiv, "@type", types);
        addPropertyItem(propsDiv, attrs.external ? "IRI (not described here)" : "@id", safeHref(nodeId) || nodeId);
        if (attrs.properties) {
            Object.entries(attrs.properties).forEach(([key, value]) => {
                if (key === "IRI") return;
                addPropertyItem(propsDiv, key, value);
            });
        }
    }

    function hideNodeDetails() {
        document.getElementById("details-placeholder").style.display = "block";
        document.getElementById("node-details").classList.remove("active");
        nodeActions.querySelectorAll(".node-action-btn.dynamic").forEach(b => b.remove());
        editorModule.setNodeEditButtonState(null, graph);
    }

    function selectNode(nodeId) {
        if (!graph.hasNode(nodeId)) return false;
        resetHighlight();
        selectedNode = nodeId;
        highlightedNodes = new Set();
        highlightedEdges = new Set();
        neighbourhood(nodeId, highlightedNodes, highlightedEdges);
        paint(highlightedNodes, highlightedEdges);
        showNodeDetails(nodeId);
        editorModule.setNodeEditButtonState(nodeId, graph);
        if (editorModule.isJsonldEditorOpen()) editorModule.highlightSourceForNode(selectedNode, true);
        if (tableSyncEnabled && !toolTabs.some(t => t.id === activeDataTab)) {
            const nodeType = graph.getNodeAttribute(nodeId, "nodeType");
            if (activeDataTab !== nodeType && nodesByType[nodeType]) switchTab(nodeType);
            highlightTableRow(nodeId);
        }
        emitSelection();
        return true;
    }

    // ── Data tables ──────────────────────────

    function buildValidationTable() {
        let html = '<div class="data-table-wrapper"><table class="data-table"><thead><tr>';
        html += "<th>Entity</th><th>Type</th><th>Source</th><th>Shape</th><th>Result</th><th>Errors</th>";
        html += "</tr></thead><tbody>";
        graphData.nodes.forEach(node => {
            const v = node.validation;
            if (v === undefined) return;
            html += `<tr data-node-id="${escapeHtml(node.id)}" class="${v === null ? "" : v.ok ? "row-ok" : "row-fail"}">`;
            html += `<td title="${escapeHtml(node.id)}">${escapeHtml(node.label)}</td>`;
            html += `<td>${escapeHtml(node.nodeType)}</td>`;
            if (!v) {
                html += '<td class="muted">-</td><td class="muted">-</td><td class="muted">not checked</td><td class="muted">-</td>';
            } else {
                const errs = v.errors || [];
                html += `<td>${escapeHtml(v.source || "")}</td><td>${escapeHtml(v.shape || "-")}</td>`;
                html += `<td class="${v.ok ? "cell-ok" : "cell-fail"}">${v.ok ? "Pass" : "Fail"}</td>`;
                html += errs.length
                    ? `<td class="cell-fail" title="${escapeHtml(errs.join("\n"))}">${errs.length} error${errs.length > 1 ? "s" : ""}</td>`
                    : '<td class="cell-ok">None</td>';
            }
            html += "</tr>";
        });
        html += "</tbody></table></div>";
        return html;
    }

    function cellText(value) {
        if (value === undefined || value === null) return "";
        if (Array.isArray(value)) return value.map(cellText).join(", ");
        if (typeof value === "object") return value.text || value.iri || JSON.stringify(value);
        return String(value);
    }

    function buildTable(type) {
        const nodes = nodesByType[type] || [];
        if (nodes.length === 0) return "<p class='panel-empty'>No nodes of this type</p>";
        const freq = new Map();
        nodes.forEach(node => Object.keys(node.properties || {}).forEach(key => {
            if (!hiddenProps.has(key) && key !== "IRI") freq.set(key, (freq.get(key) || 0) + 1);
        }));
        const keys = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k).slice(0, 9);
        let html = '<div class="data-table-wrapper"><table class="data-table"><thead><tr><th>label</th><th>@id</th>';
        keys.forEach(key => { html += `<th>${escapeHtml(key)}</th>`; });
        html += "</tr></thead><tbody>";
        nodes.forEach(node => {
            html += `<tr data-node-id="${escapeHtml(node.id)}">`;
            html += `<td title="${escapeHtml(node.label)}">${escapeHtml(node.label)}</td>`;
            const shortId = node.rawId || node.id;
            html += `<td class="muted" title="${escapeHtml(node.id)}">${escapeHtml(shortId.length > 40 ? shortId.slice(0, 40) + "…" : shortId)}</td>`;
            keys.forEach(key => {
                let text = cellText(node.properties ? node.properties[key] : "");
                const full = text;
                if (text.length > 50) text = text.slice(0, 50) + "…";
                html += `<td title="${escapeHtml(full)}">${escapeHtml(text || "-")}</td>`;
            });
            html += "</tr>";
        });
        html += "</tbody></table></div>";
        return html;
    }

    function highlightTableRow(nodeId) {
        document.querySelectorAll(".data-table tr.selected").forEach(row => row.classList.remove("selected"));
        const rows = document.querySelectorAll(".data-table tr[data-node-id]");
        for (const row of rows) {
            if (row.dataset.nodeId === nodeId) {
                row.classList.add("selected");
                row.scrollIntoView({ behavior: "smooth", block: "nearest" });
                break;
            }
        }
    }

    function clearTableSelection() {
        document.querySelectorAll(".data-table tr.selected").forEach(row => row.classList.remove("selected"));
    }

    function switchTab(type) {
        activeDataTab = type;
        document.querySelectorAll(".data-tab").forEach(tab => {
            tab.classList.toggle("active", tab.dataset.type === type);
        });
        const tool = toolTabs.find(t => t.id === type);
        if (tool) {
            dataPanelContent.innerHTML = "";
            dataPanelContent.classList.add("tool-content");
            tool.render(dataPanelContent);
            return;
        }
        dataPanelContent.classList.remove("tool-content");
        dataPanelContent.innerHTML = type === "__validation__" ? buildValidationTable() : buildTable(type);
        dataPanelContent.querySelectorAll(".data-table tr[data-node-id]").forEach(row => {
            row.addEventListener("click", () => {
                const nodeId = row.dataset.nodeId;
                selectNode(nodeId);
                focusNode(nodeId);
                highlightTableRow(nodeId);
            });
        });
        if (selectedNode) highlightTableRow(selectedNode);
    }

    function makeTab(id, label, color, count) {
        const tab = document.createElement("div");
        tab.className = "data-tab";
        tab.dataset.type = id;
        tab.setAttribute("role", "tab");
        tab.tabIndex = 0;
        tab.innerHTML = `${color ? `<span class="data-tab-dot" style="background: ${escapeHtml(color)}"></span>` : ""}<span class="data-tab-label"></span>${count !== undefined && count !== null ? `<span class="data-tab-count">${escapeHtml(count)}</span>` : ""}`;
        tab.querySelector(".data-tab-label").textContent = label;
        tab.addEventListener("click", () => switchTab(id));
        tab.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchTab(id); } });
        return tab;
    }

    function rebuildDataTabs(preferredType = null) {
        dataPanelTabs.innerHTML = "";
        let firstTab = null;
        Object.entries(nodesByType).sort((a, b) => b[1].length - a[1].length).forEach(([type, nodes]) => {
            dataPanelTabs.appendChild(makeTab(type, type, nodes[0] && nodes[0].color, nodes.length));
            if (!firstTab) firstTab = type;
        });
        const valMeta = graphData.metadata.validation || {};
        if (valMeta.valid + valMeta.invalid > 0) {
            dataPanelTabs.appendChild(makeTab("__validation__", "Validation", valMeta.invalid === 0 ? cssVar("--success") : cssVar("--error"), `${valMeta.valid}/${valMeta.valid + valMeta.invalid}`));
        }
        if (toolTabs.length) {
            const sep = document.createElement("div");
            sep.className = "data-tab-sep";
            dataPanelTabs.appendChild(sep);
            toolTabs.forEach(t => {
                const tab = makeTab(t.id, t.label, t.color, t.count);
                tab.classList.add("tool-tab");
                if (t.severity) tab.classList.add(`tool-tab-${t.severity}`);
                dataPanelTabs.appendChild(tab);
            });
        }
        const exists = id => [...dataPanelTabs.querySelectorAll(".data-tab")].some(t => t.dataset.type === id);
        const nextTab = preferredType && exists(preferredType) ? preferredType : (firstTab || (toolTabs[0] && toolTabs[0].id));
        if (nextTab) switchTab(nextTab);
        else dataPanelContent.innerHTML = "<p class='panel-empty'>No data available</p>";
    }

    function rebuildSidebarAndTables(preferredTab = null) {
        regroupNodesByType();
        rebuildFilters();
        buildEdgeLegend();
        rebuildDataTabs(preferredTab || activeDataTab);
        updateStats();
        updateVisibility();
    }

    // ── Apply graph data ─────────────────────

    function applyGraphData(nextGraphData, preferredTab = null, opts = {}) {
        const previousSelection = selectedNode;
        const previousPositions = new Map();
        if (opts.keepPositions) graph.forEachNode((id, a) => previousPositions.set(id, { x: a.x, y: a.y }));
        graphData = nextGraphData;
        addGraphDataToGraph(graph, graphData);
        let reused = 0;
        if (opts.keepPositions) {
            graph.forEachNode(id => {
                const p = previousPositions.get(id);
                if (p) { graph.setNodeAttribute(id, "x", p.x); graph.setNodeAttribute(id, "y", p.y); reused += 1; }
            });
        }
        rebuildSidebarAndTables(preferredTab);
        if (!opts.keepPositions || reused < graph.order) layoutManager.applyLayout(layoutManager.getCurrentLayout(), { warm: opts.keepPositions && reused > 0 });
        else sigmaInstance.refresh();

        if (previousSelection && graph.hasNode(previousSelection)) {
            selectNode(previousSelection);
        } else {
            selectedNode = null;
            hideNodeDetails();
            clearTableSelection();
            editorModule.clearSourceHighlights();
        }
    }

    function setToolTabs(tabs) {
        toolTabs = tabs;
        if (graphData) rebuildDataTabs(activeDataTab);
    }

    /** Update a tool tab's badge without re-rendering the active panel. */
    function updateToolBadge(id, count, severity) {
        const tool = toolTabs.find(t => t.id === id);
        if (tool) { tool.count = count; tool.severity = severity; }
        const tab = [...dataPanelTabs.querySelectorAll(".data-tab")].find(t => t.dataset.type === id);
        if (!tab) return;
        let badge = tab.querySelector(".data-tab-count");
        if (count === undefined || count === null) { if (badge) badge.remove(); }
        else {
            if (!badge) { badge = document.createElement("span"); badge.className = "data-tab-count"; tab.appendChild(badge); }
            badge.textContent = count;
        }
        tab.classList.remove("tool-tab-error", "tool-tab-warning", "tool-tab-info", "tool-tab-ok");
        if (severity) tab.classList.add(`tool-tab-${severity}`);
    }

    function openDataTab(id) {
        dataPanel.classList.remove("collapsed");
        switchTab(id);
    }

    function refreshActiveTool(id) {
        if (activeDataTab === id) switchTab(id);
    }

    // ── Wire up events ───────────────────────

    function wireEvents() {
        document.querySelectorAll("#graph-container .control-btn[title], #graph-container .layout-menu-item[title]").forEach(el => {
            const tooltipText = el.getAttribute("title");
            if (tooltipText) {
                el.dataset.tooltip = tooltipText;
                el.setAttribute("aria-label", tooltipText);
                el.removeAttribute("title");
            }
        });
        document.querySelectorAll("#graph-container .control-btn, #graph-container .layout-menu-item").forEach(el => {
            el.addEventListener("mouseenter", () => scheduleControlTooltip(el));
            el.addEventListener("mouseleave", hideControlTooltip);
            el.addEventListener("focus", () => scheduleControlTooltip(el));
            el.addEventListener("blur", hideControlTooltip);
            el.addEventListener("click", hideControlTooltip);
        });
        window.addEventListener("resize", () => {
            if (controlTooltip.classList.contains("visible") && controlTooltipTarget) positionControlTooltip(controlTooltipTarget);
        });

        // Layout menu
        const layoutMenu = document.getElementById("layout-menu");
        const layoutToggleBtn = document.getElementById("layout-toggle");
        layoutToggleBtn.addEventListener("click", e => {
            e.stopPropagation();
            hideControlTooltip();
            layoutMenu.classList.toggle("visible");
        });
        document.querySelectorAll(".layout-menu-item").forEach(btn => {
            btn.addEventListener("click", e => {
                e.stopPropagation();
                layoutManager.applyLayout(btn.dataset.layout);
                layoutMenu.classList.remove("visible");
            });
        });
        document.addEventListener("click", () => {
            hideControlTooltip();
            layoutMenu.classList.remove("visible");
        });

        toggleDragBtn.addEventListener("click", () => {
            dragModeEnabled = !dragModeEnabled;
            toggleDragBtn.classList.toggle("active", dragModeEnabled);
            dragHint.classList.toggle("visible", dragModeEnabled);
            if (dragModeEnabled) setTimeout(() => dragHint.classList.remove("visible"), 3000);
        });
        toggleTooltipBtn.addEventListener("click", () => {
            tooltipsEnabled = !tooltipsEnabled;
            toggleTooltipBtn.classList.toggle("active", tooltipsEnabled);
            if (!tooltipsEnabled) tooltip.classList.remove("visible");
        });
        toggleSyncBtn.addEventListener("click", () => {
            tableSyncEnabled = !tableSyncEnabled;
            toggleSyncBtn.classList.toggle("active", tableSyncEnabled);
        });

        // Drag events
        sigmaInstance.on("downNode", e => {
            if (!dragModeEnabled) return;
            isDragging = true;
            draggedNode = e.node;
            graph.setNodeAttribute(draggedNode, "highlighted", true);
            sigmaInstance.getCamera().disable();
        });
        sigmaInstance.getMouseCaptor().on("mousemovebody", e => {
            if (!isDragging || !draggedNode) return;
            const pos = sigmaInstance.viewportToGraph(e);
            graph.setNodeAttribute(draggedNode, "x", pos.x);
            graph.setNodeAttribute(draggedNode, "y", pos.y);
            e.preventSigmaDefault();
            e.original.preventDefault();
            e.original.stopPropagation();
            sigmaInstance.refresh();
        });
        const endDrag = () => {
            if (draggedNode && graph.hasNode(draggedNode)) graph.removeNodeAttribute(draggedNode, "highlighted");
            isDragging = false;
            draggedNode = null;
            sigmaInstance.getCamera().enable();
        };
        sigmaInstance.getMouseCaptor().on("mouseup", endDrag);
        sigmaInstance.getMouseCaptor().on("mouseleave", endDrag);

        filtersContainer.addEventListener("change", e => {
            if (e.target.classList.contains("filter-checkbox")) {
                const type = e.target.dataset.type;
                if (e.target.checked) hiddenTypes.delete(type);
                else hiddenTypes.add(type);
                updateVisibility();
                filterListeners.forEach(fn => fn());
            }
        });

        // Node search
        searchInput.addEventListener("input", e => {
            const query = e.target.value.toLowerCase().trim();
            searchResults.innerHTML = "";
            if (query.length < 2) return;
            const matches = [];
            graph.forEachNode((nodeId, attrs) => {
                const label = String(attrs.label || "").toLowerCase();
                if (label.includes(query) || nodeId.toLowerCase().includes(query)) {
                    matches.push({ id: nodeId, label: attrs.label, color: attrs.color, nodeType: attrs.nodeType, starts: label.startsWith(query) });
                }
            });
            matches.sort((a, b) => b.starts - a.starts || String(a.label).length - String(b.label).length);
            matches.slice(0, 12).forEach(match => {
                const div = document.createElement("div");
                div.className = "search-result";
                div.innerHTML = `<span class="search-result-dot" style="background: ${escapeHtml(match.color)}"></span><span class="search-result-label"></span><span class="search-result-type"></span>`;
                div.querySelector(".search-result-label").textContent = match.label;
                div.querySelector(".search-result-type").textContent = match.nodeType;
                div.addEventListener("click", () => {
                    selectNode(match.id);
                    focusNode(match.id);
                    searchInput.value = "";
                    searchResults.innerHTML = "";
                });
                searchResults.appendChild(div);
            });
            if (!matches.length) searchResults.innerHTML = '<p class="muted-note">No matching nodes.</p>';
        });

        // Sigma node/edge events
        sigmaInstance.on("clickNode", ({ node }) => {
            selectNode(node);
            if (tableSyncEnabled && dataPanel.classList.contains("collapsed") && !toolTabs.some(t => t.id === activeDataTab)) {
                dataPanel.classList.remove("collapsed");
            }
        });
        sigmaInstance.on("clickStage", () => {
            resetHighlight();
            hideNodeDetails();
            clearTableSelection();
        });
        sigmaInstance.on("enterNode", ({ node }) => {
            graphContainer.style.cursor = "pointer";
            const attrs = graph.getNodeAttributes(node);
            if (tooltipsEnabled) {
                document.getElementById("tooltip-title").textContent = attrs.label;
                const typeSpan = document.getElementById("tooltip-type");
                typeSpan.textContent = attrs.nodeType;
                typeSpan.style.background = attrs.color + "30";
                typeSpan.style.color = attrs.color;
                document.getElementById("tooltip-edge").textContent = attrs.external ? node : "";

                tooltipProps.innerHTML = "";
                const addRow = (key, value, cls) => {
                    const row = document.createElement("div");
                    row.className = "tooltip-prop";
                    const k = document.createElement("span");
                    k.className = "tooltip-prop-key";
                    k.textContent = `${key}:`;
                    const v = document.createElement("span");
                    v.className = "tooltip-prop-value" + (cls ? ` ${cls}` : "");
                    v.textContent = value;
                    row.appendChild(k);
                    row.appendChild(v);
                    tooltipProps.appendChild(row);
                };
                if (attrs.invalidId) addRow("problem", "invalid IRI — dropped in RDF", "cell-fail");
                if (attrs.validation) addRow("validation", attrs.validation.ok ? "✓ valid" : `✗ ${(attrs.validation.errors || []).length} error(s)`, attrs.validation.ok ? "cell-ok" : "cell-fail");
                const entries = Object.entries(attrs.properties || {}).filter(([key]) => !hiddenProps.has(key));
                entries.slice(0, 8).forEach(([key, value]) => {
                    let text = cellText(value);
                    if (text.length > 60) text = text.slice(0, 60) + "…";
                    addRow(key, text);
                });
                if (entries.length > 8) {
                    const more = document.createElement("div");
                    more.className = "tooltip-prop muted";
                    more.textContent = `…and ${entries.length - 8} more`;
                    tooltipProps.appendChild(more);
                }
                tooltipProps.style.display = tooltipProps.childElementCount ? "block" : "none";
                tooltip.classList.add("visible");
            }
            hoveredNode = node;
            highlightNodeConnections(node, !!selectedNode);
        });
        sigmaInstance.on("enterEdge", ({ edge }) => {
            graphContainer.style.cursor = "pointer";
            if (!tooltipsEnabled) return;
            const attrs = graph.getEdgeAttributes(edge);
            const source = graph.getSourceAttribute(edge, "label");
            const target = graph.getTargetAttribute(edge, "label");
            document.getElementById("tooltip-title").textContent = attrs.label;
            const typeSpan = document.getElementById("tooltip-type");
            typeSpan.textContent = attrs.edgeType || "";
            typeSpan.style.background = "";
            typeSpan.style.color = "";
            document.getElementById("tooltip-edge").textContent = `${source} → ${target}`;
            tooltipProps.innerHTML = "";
            tooltipProps.style.display = "none";
            tooltip.classList.add("visible");
        });
        sigmaInstance.on("leaveNode", () => {
            graphContainer.style.cursor = "default";
            tooltip.classList.remove("visible");
            hoveredNode = null;
            if (selectedNode) restoreSelectionHighlight();
            else resetHighlight();
        });
        sigmaInstance.on("leaveEdge", () => {
            graphContainer.style.cursor = "default";
            tooltip.classList.remove("visible");
        });
        sigmaInstance.getMouseCaptor().on("mousemove", e => {
            const rect = graphContainer.getBoundingClientRect();
            const maxLeft = rect.width - tooltip.offsetWidth - 8;
            const maxTop = rect.height - tooltip.offsetHeight - 8;
            tooltip.style.left = Math.max(8, Math.min(e.x + 15, maxLeft)) + "px";
            tooltip.style.top = Math.max(8, Math.min(e.y + 15, maxTop)) + "px";
        });

        // Zoom controls
        document.getElementById("zoom-in").addEventListener("click", () => sigmaInstance.getCamera().animatedZoom({ duration: 300 }));
        document.getElementById("zoom-out").addEventListener("click", () => sigmaInstance.getCamera().animatedUnzoom({ duration: 300 }));
        document.getElementById("zoom-fit").addEventListener("click", () => sigmaInstance.getCamera().animatedReset({ duration: 300 }));
        document.getElementById("reset-view").addEventListener("click", () => {
            resetHighlight();
            hideNodeDetails();
            clearTableSelection();
            hiddenTypes.clear();
            document.querySelectorAll(".filter-checkbox").forEach(cb => { cb.checked = true; });
            updateVisibility();
            layoutManager.applyLayout(layoutManager.getCurrentLayout());
            sigmaInstance.getCamera().animatedReset({ duration: 300 });
        });

        sidebarToggle.addEventListener("click", () => {
            sidebar.classList.toggle("collapsed");
            sidebarToggle.classList.toggle("sidebar-collapsed");
            const arrow = sidebarToggle.querySelector(".toggle-arrow") || sidebarToggle;
            arrow.textContent = sidebar.classList.contains("collapsed") ? "▶" : "◀";
            setTimeout(() => sigmaInstance.refresh(), 350);
        });
        document.querySelectorAll(".sidebar-section-header").forEach(header => {
            header.addEventListener("click", () => header.closest(".sidebar-section").classList.toggle("collapsed"));
        });
        dataPanelHeader.addEventListener("click", e => {
            if (e.target.closest("button")) return;
            dataPanel.classList.toggle("collapsed");
        });

        // Editor wiring
        editorModule.jsonldEditorToggle.addEventListener("click", () => {
            editorModule.toggleJsonldEditor(sigmaInstance, selectedNode, editorModule.highlightSourceForNode);
        });
        editorModule.openJsonldEditorBtn.addEventListener("click", () => {
            editorModule.openJsonldEditor(sigmaInstance, selectedNode, editorModule.highlightSourceForNode);
            if (selectedNode) editorModule.highlightSourceForNode(selectedNode, true);
        });
        editorModule.editNodeJsonldBtn.addEventListener("click", () => {
            const nodeId = editorModule.editNodeJsonldBtn.dataset.nodeId;
            if (!nodeId) return;
            editorModule.openJsonldEditor(sigmaInstance, selectedNode, editorModule.highlightSourceForNode);
            editorModule.highlightSourceForNode(nodeId, true);
        });

        // Info modal
        const infoOverlay = document.getElementById("info-modal-overlay");
        const closeInfoModal = () => infoOverlay.classList.add("hidden");
        document.getElementById("info-close-btn").addEventListener("click", closeInfoModal);
        document.getElementById("info-dismiss-btn").addEventListener("click", closeInfoModal);
        infoOverlay.addEventListener("click", e => { if (e.target === infoOverlay) closeInfoModal(); });
        document.addEventListener("keydown", e => {
            if (e.key === "Escape" && !infoOverlay.classList.contains("hidden")) closeInfoModal();
        });
        document.getElementById("info-btn").addEventListener("click", () => infoOverlay.classList.remove("hidden"));
    }

    // ── Initialize ───────────────────────────

    function init(initialGraphData) {
        graphData = initialGraphData;
        rebuildSidebarAndTables();
        editorModule.setNodeEditButtonState(null, graph);
        editorModule.syncJsonldEditorToggleState();
        wireEvents();
    }

    return {
        init,
        applyGraphData,
        selectNode,
        focusNode,
        resetHighlight,
        hideNodeDetails,
        setToolTabs,
        updateToolBadge,
        openDataTab,
        refreshActiveTool,
        getGraphData: () => graphData,
        getSelectedNode: () => selectedNode,
        setNodeActions: (provider, handler) => { nodeActionsProvider = provider; nodeActionHandler = handler; },
        onSelectionChange: fn => selectionListeners.add(fn),
        onFiltersChange: fn => filterListeners.add(fn),
        clearSelection: () => { resetHighlight(); hideNodeDetails(); clearTableSelection(); },
        refreshDetails: () => { if (selectedNode && graph.hasNode(selectedNode)) showNodeDetails(selectedNode); },
    };
}
