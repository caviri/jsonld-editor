/* ==============================================
   JSON-LD Graph Visualization — UI Module
   ============================================== */

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
    let hiddenTypes = new Set();
    let tooltipsEnabled = true;
    let tableSyncEnabled = true;
    let nodesByType = {};
    let activeDataTab = null;
    let graphData = null;
    let validationLookupById = {};

    // Drag state
    let draggedNode = null;
    let isDragging = false;
    let dragModeEnabled = false;

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

    const hiddenProps = new Set(["uuid", "composite", "originalColor", "originalSize"]);

    // ── Control tooltip ──────────────────────

    const graphContainer = document.getElementById("graph-container");
    const controlTooltip = document.getElementById("ui-tooltip");
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
        const valStats = graphData.metadata.validation || {};
        if (valStats.total > 0) {
            const allValid = valStats.invalid === 0;
            valSpan.style.color = allValid ? "#22c55e" : "#ef4444";
            valSpan.style.fontWeight = "600";
            valSpan.textContent = `${valStats.valid}/${valStats.total} valid`;
        } else {
            valSpan.textContent = "no validation";
            valSpan.style.color = "#94a3b8";
            valSpan.style.fontWeight = "500";
        }
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
        const typeCounts = {};
        (graphData.nodes || []).forEach(node => {
            typeCounts[node.nodeType] = (typeCounts[node.nodeType] || 0) + 1;
        });

        Object.entries(ENTITY_CONFIG).forEach(([type, config]) => {
            const count = typeCounts[type] || 0;
            if (count === 0) return;
            const item = document.createElement("label");
            item.className = "filter-item";
            item.innerHTML = `
                <input type="checkbox" class="filter-checkbox" data-type="${type}" ${hiddenTypes.has(type) ? "" : "checked"}>
                <span class="filter-color" style="background: ${config.color}"></span>
                <span class="filter-label">${type}</span>
                <span class="filter-count">${count}</span>
            `;
            filtersContainer.appendChild(item);
        });
    }

    function buildEdgeLegend() {
        edgeLegend.innerHTML = "";
        Object.entries(EDGE_CONFIG).forEach(([label, config]) => {
            const item = document.createElement("div");
            item.className = "legend-item";
            item.innerHTML = `
                <span class="legend-line" style="background: ${config.color}"></span>
                <span>${label}</span>
            `;
            edgeLegend.appendChild(item);
        });
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

    function highlightNodeConnections(nodeId, combineWithSelection = false) {
        const hoverNodes = new Set();
        const hoverEdges = new Set();
        hoverNodes.add(nodeId);

        graph.forEachEdge(nodeId, (edgeId, attrs, source, target) => {
            hoverEdges.add(edgeId);
            hoverNodes.add(source);
            hoverNodes.add(target);
        });

        const combinedNodes = new Set([...hoverNodes]);
        const combinedEdges = new Set([...hoverEdges]);

        if (combineWithSelection && selectedNode) {
            combinedNodes.add(selectedNode);
            graph.forEachEdge(selectedNode, (edgeId, attrs, source, target) => {
                combinedEdges.add(edgeId);
                combinedNodes.add(source);
                combinedNodes.add(target);
            });
        }

        graph.forEachNode((id, attrs) => {
            if (combinedNodes.has(id)) {
                graph.setNodeAttribute(id, "color", attrs.originalColor);
                graph.setNodeAttribute(id, "zIndex", 1);
            } else {
                graph.setNodeAttribute(id, "color", "#d1d5db");
                graph.setNodeAttribute(id, "zIndex", 0);
            }
        });

        graph.forEachEdge((id, attrs) => {
            if (combinedEdges.has(id)) {
                graph.setEdgeAttribute(id, "color", attrs.originalColor);
                graph.setEdgeAttribute(id, "size", 3);
                graph.setEdgeAttribute(id, "zIndex", 1);
            } else {
                graph.setEdgeAttribute(id, "color", "#e5e7eb");
                graph.setEdgeAttribute(id, "size", 1);
                graph.setEdgeAttribute(id, "zIndex", 0);
            }
        });

        sigmaInstance.refresh();
    }

    function restoreSelectionHighlight() {
        if (!selectedNode) return;
        highlightedNodes.clear();
        highlightedEdges.clear();
        highlightedNodes.add(selectedNode);

        graph.forEachEdge(selectedNode, (edgeId, attrs, source, target) => {
            highlightedEdges.add(edgeId);
            highlightedNodes.add(source);
            highlightedNodes.add(target);
        });

        graph.forEachNode((id, attrs) => {
            if (highlightedNodes.has(id)) {
                graph.setNodeAttribute(id, "color", attrs.originalColor);
                graph.setNodeAttribute(id, "zIndex", 1);
            } else {
                graph.setNodeAttribute(id, "color", "#d1d5db");
                graph.setNodeAttribute(id, "zIndex", 0);
            }
        });

        graph.forEachEdge((id, attrs) => {
            if (highlightedEdges.has(id)) {
                graph.setEdgeAttribute(id, "color", attrs.originalColor);
                graph.setEdgeAttribute(id, "size", 3);
                graph.setEdgeAttribute(id, "zIndex", 1);
            } else {
                graph.setEdgeAttribute(id, "color", "#e5e7eb");
                graph.setEdgeAttribute(id, "size", 1);
                graph.setEdgeAttribute(id, "zIndex", 0);
            }
        });

        sigmaInstance.refresh();
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
    }

    function focusNode(nodeId) {
        const nodePosition = sigmaInstance.getNodeDisplayData(nodeId);
        if (nodePosition) {
            sigmaInstance.getCamera().animate(
                { x: nodePosition.x, y: nodePosition.y, ratio: 0.3 },
                { duration: 500 },
            );
        }
    }

    // ── Node details panel ───────────────────

    function addPropertyItem(container, key, value) {
        const item = document.createElement("div");
        item.className = "property-item";
        let valueHtml = String(value);
        if (typeof value === "string" && (value.startsWith("http") || value.startsWith("https"))) {
            valueHtml = `<a href="${value}" target="_blank">${value}</a>`;
        }
        item.innerHTML = `
            <div class="property-key">${key}</div>
            <div class="property-value">${valueHtml}</div>
        `;
        container.appendChild(item);
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

        const propsDiv = document.getElementById("node-properties");
        propsDiv.innerHTML = "";

        // Validation section
        if (attrs.validation) {
            const v = attrs.validation;
            const allOk = v.strict && v.agent;
            const valDiv = document.createElement("div");
            valDiv.style.cssText = `padding: 10px; margin-bottom: 12px; border-radius: 8px; background: ${allOk ? "#f0fdf4" : "#fef2f2"}; border: 1px solid ${allOk ? "#bbf7d0" : "#fecaca"};`;
            let valHtml = `<div style="font-weight: 600; font-size: 13px; margin-bottom: 6px; color: ${allOk ? "#166534" : "#991b1b"};">${allOk ? "✓ Validation Passed" : "✗ Validation Failed"}</div>`;
            valHtml += `<div style="font-size: 12px;"><span style="color: ${v.strict ? "#22c55e" : "#ef4444"};">Strict: ${v.strict ? "Pass" : "Fail"}</span> · <span style="color: ${v.agent ? "#22c55e" : "#ef4444"};">Agent: ${v.agent ? "Pass" : "Fail"}</span></div>`;
            if (v.shape) valHtml += `<div style="font-size: 11px; color: #64748b; margin-top: 4px;">Shape: ${v.shape}</div>`;
            const allErrors = [...(v.strict_errors || []), ...(v.agent_errors || [])];
            if (allErrors.length > 0) {
                valHtml += `<div style="font-size: 12px; color: #991b1b; margin-top: 8px; font-weight: 500;">Errors (${allErrors.length}):</div>`;
                allErrors.forEach(err => {
                    const msg = typeof err === "string" ? err : (err.message || JSON.stringify(err));
                    valHtml += `<div style="font-size: 11px; color: #991b1b; padding: 2px 0;">&bull; ${msg}</div>`;
                });
            }
            valDiv.innerHTML = valHtml;
            propsDiv.appendChild(valDiv);
        } else if (attrs.validation === null) {
            const valDiv = document.createElement("div");
            valDiv.style.cssText = "padding: 10px; margin-bottom: 12px; border-radius: 8px; background: #f8fafc; border: 1px solid #e2e8f0;";
            valDiv.innerHTML = '<div style="font-size: 12px; color: #94a3b8;">No validation data available</div>';
            propsDiv.appendChild(valDiv);
        }

        addPropertyItem(propsDiv, "ID", nodeId);
        if (attrs.properties) {
            Object.entries(attrs.properties).forEach(([key, value]) => {
                if (Array.isArray(value)) value = value.join(", ");
                else if (typeof value === "object") value = JSON.stringify(value);
                addPropertyItem(propsDiv, key, value);
            });
        }
    }

    function hideNodeDetails() {
        document.getElementById("details-placeholder").style.display = "block";
        document.getElementById("node-details").classList.remove("active");
        editorModule.setNodeEditButtonState(null, graph);
    }

    function selectNode(nodeId) {
        if (!graph.hasNode(nodeId)) return;
        resetHighlight();
        selectedNode = nodeId;
        highlightedNodes.add(nodeId);

        graph.forEachEdge(nodeId, (edgeId, attrs, source, target) => {
            highlightedEdges.add(edgeId);
            highlightedNodes.add(source);
            highlightedNodes.add(target);
        });

        graph.forEachNode((id, attrs) => {
            if (highlightedNodes.has(id)) {
                graph.setNodeAttribute(id, "color", attrs.originalColor);
                graph.setNodeAttribute(id, "zIndex", 1);
            } else {
                graph.setNodeAttribute(id, "color", "#d1d5db");
                graph.setNodeAttribute(id, "zIndex", 0);
            }
        });

        graph.forEachEdge((id, attrs) => {
            if (highlightedEdges.has(id)) {
                graph.setEdgeAttribute(id, "color", attrs.originalColor);
                graph.setEdgeAttribute(id, "size", 3);
                graph.setEdgeAttribute(id, "zIndex", 1);
            } else {
                graph.setEdgeAttribute(id, "color", "#e5e7eb");
                graph.setEdgeAttribute(id, "size", 1);
                graph.setEdgeAttribute(id, "zIndex", 0);
            }
        });

        showNodeDetails(nodeId);
        editorModule.setNodeEditButtonState(nodeId, graph);
        if (editorModule.isJsonldEditorOpen()) {
            editorModule.highlightSourceForNode(selectedNode, true);
        }
        sigmaInstance.refresh();
    }

    // ── Data tables ──────────────────────────

    function buildValidationTable() {
        let html = '<div class="data-table-wrapper"><table class="data-table"><thead><tr>';
        html += "<th>Entity</th><th>Type</th><th>Shape</th><th>Strict</th><th>Agent</th><th>Errors</th>";
        html += "</tr></thead><tbody>";

        graphData.nodes.forEach(node => {
            const v = node.validation;
            const strictOk = v ? v.strict : null;
            const agentOk = v ? v.agent : null;
            const errCount = v ? (v.strict_errors || []).length + (v.agent_errors || []).length : 0;
            const rowBg = v === null ? "" : (strictOk && agentOk ? 'style="background: #f0fdf430;"' : 'style="background: #fef2f230;"');

            html += `<tr data-node-id="${node.id}" ${rowBg}>`;
            html += `<td title="${node.id}">${node.label}</td>`;
            html += `<td>${node.nodeType}</td>`;
            html += `<td>${v ? v.shape : "-"}</td>`;

            if (v === null) {
                html += '<td style="color:#94a3b8">-</td><td style="color:#94a3b8">-</td><td>-</td>';
            } else {
                html += `<td style="color:${strictOk ? "#22c55e" : "#ef4444"}; font-weight:600;">${strictOk ? "Pass" : "Fail"}</td>`;
                html += `<td style="color:${agentOk ? "#22c55e" : "#ef4444"}; font-weight:600;">${agentOk ? "Pass" : "Fail"}</td>`;
                if (errCount > 0) {
                    const allErrs = [...(v.strict_errors || []), ...(v.agent_errors || [])];
                    const firstErr = allErrs[0];
                    const msg = typeof firstErr === "string" ? firstErr : (firstErr.message || JSON.stringify(firstErr));
                    html += `<td style="color:#ef4444" title="${msg.replace(/"/g, '&quot;')}">${errCount} error${errCount > 1 ? "s" : ""}</td>`;
                } else {
                    html += '<td style="color:#22c55e">None</td>';
                }
            }
            html += "</tr>";
        });

        html += "</tbody></table></div>";
        return html;
    }

    function buildTable(type) {
        const nodes = nodesByType[type] || [];
        if (nodes.length === 0) return "<p style='padding: 20px; color: #94a3b8;'>No nodes of this type</p>";

        const allKeys = new Set(["name"]);
        nodes.forEach(node => {
            if (node.properties) {
                Object.keys(node.properties).forEach(key => {
                    if (!hiddenProps.has(key)) allKeys.add(key);
                });
            }
        });

        const priorityKeys = ["name", "email", "url", "identifier", "githubUsername", "orcidIdentifier", "role", "githubRepositoryHandle"];
        const sortedKeys = [...allKeys].sort((a, b) => {
            const aIdx = priorityKeys.indexOf(a);
            const bIdx = priorityKeys.indexOf(b);
            if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
            if (aIdx >= 0) return -1;
            if (bIdx >= 0) return 1;
            return a.localeCompare(b);
        }).slice(0, 8);

        let html = '<div class="data-table-wrapper"><table class="data-table"><thead><tr>';
        sortedKeys.forEach(key => { html += `<th>${key}</th>`; });
        html += "</tr></thead><tbody>";

        nodes.forEach(node => {
            html += `<tr data-node-id="${node.id}">`;
            sortedKeys.forEach(key => {
                let value = node.properties ? node.properties[key] : "";
                if (key === "name") value = node.label;
                if (Array.isArray(value)) value = value.join(", ");
                if (typeof value === "object") value = JSON.stringify(value);
                if (typeof value === "string" && value.length > 50) value = value.slice(0, 50) + "...";
                html += `<td title="${String(value || "").replace(/"/g, "&quot;")}">${value || "-"}</td>`;
            });
            html += "</tr>";
        });

        html += "</tbody></table></div>";
        return html;
    }

    function highlightTableRow(nodeId) {
        document.querySelectorAll(".data-table tr.selected").forEach(row => row.classList.remove("selected"));
        const row = document.querySelector(`.data-table tr[data-node-id="${nodeId}"]`);
        if (row) {
            row.classList.add("selected");
            row.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
        dataPanelContent.innerHTML = type === "__validation__" ? buildValidationTable() : buildTable(type);

        document.querySelectorAll(".data-table tr[data-node-id]").forEach(row => {
            row.addEventListener("click", () => {
                const nodeId = row.dataset.nodeId;
                selectNode(nodeId);
                focusNode(nodeId);
                highlightTableRow(nodeId);
            });
        });
    }

    function rebuildDataTabs(preferredType = null) {
        dataPanelTabs.innerHTML = "";
        let firstTab = null;

        Object.entries(nodesByType).forEach(([type, nodes]) => {
            const config = ENTITY_CONFIG[type] || { color: "#64748b" };
            const tab = document.createElement("div");
            tab.className = "data-tab";
            tab.dataset.type = type;
            tab.innerHTML = `
                <span class="data-tab-dot" style="background: ${config.color}"></span>
                <span>${type}</span>
                <span class="data-tab-count">${nodes.length}</span>
            `;
            tab.addEventListener("click", () => switchTab(type));
            dataPanelTabs.appendChild(tab);
            if (!firstTab) firstTab = type;
        });

        const valMeta = graphData.metadata.validation || {};
        if (valMeta.total > 0) {
            const valTab = document.createElement("div");
            valTab.className = "data-tab";
            valTab.dataset.type = "__validation__";
            const allValid = valMeta.invalid === 0;
            valTab.innerHTML = `
                <span class="data-tab-dot" style="background: ${allValid ? "#22c55e" : "#ef4444"}"></span>
                <span>Validation</span>
                <span class="data-tab-count">${valMeta.valid}/${valMeta.total}</span>
            `;
            valTab.addEventListener("click", () => switchTab("__validation__"));
            dataPanelTabs.appendChild(valTab);
        }

        const nextTab = preferredType && dataPanelTabs.querySelector(`[data-type="${preferredType}"]`)
            ? preferredType
            : (firstTab || "__validation__");

        if (nextTab && dataPanelTabs.querySelector(`[data-type="${nextTab}"]`)) {
            switchTab(nextTab);
        } else {
            dataPanelContent.innerHTML = "<p style='padding: 20px; color: #94a3b8;'>No data available</p>";
        }
    }

    function rebuildSidebarAndTables(preferredTab = null) {
        regroupNodesByType();
        rebuildFilters();
        rebuildDataTabs(preferredTab || activeDataTab);
        updateStats();
        updateVisibility();
    }

    // ── Apply graph data ─────────────────────

    function applyGraphData(nextGraphData, preferredTab = null) {
        graphData = nextGraphData;
        addGraphDataToGraph(graph, graphData);
        rebuildSidebarAndTables(preferredTab);
        layoutManager.applyLayout(layoutManager.getCurrentLayout());

        if (selectedNode && graph.hasNode(selectedNode)) {
            selectNode(selectedNode);
            if (tableSyncEnabled) {
                const nodeType = graph.getNodeAttribute(selectedNode, "nodeType");
                switchTab(nodeType);
                highlightTableRow(selectedNode);
            }
        } else {
            selectedNode = null;
            hideNodeDetails();
            clearTableSelection();
            editorModule.clearSourceHighlights();
        }
    }

    // ── Wire up events ───────────────────────

    function wireEvents() {
        // Replace native tooltips
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
            if (controlTooltip.classList.contains("visible") && controlTooltipTarget) {
                positionControlTooltip(controlTooltipTarget);
            }
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

        // Drag mode
        toggleDragBtn.addEventListener("click", () => {
            dragModeEnabled = !dragModeEnabled;
            toggleDragBtn.classList.toggle("active", dragModeEnabled);
            dragHint.classList.toggle("visible", dragModeEnabled);
            if (dragModeEnabled) setTimeout(() => dragHint.classList.remove("visible"), 3000);
        });

        // Tooltip toggle
        toggleTooltipBtn.addEventListener("click", () => {
            tooltipsEnabled = !tooltipsEnabled;
            toggleTooltipBtn.classList.toggle("active", tooltipsEnabled);
            if (!tooltipsEnabled) tooltip.classList.remove("visible");
        });

        // Table sync toggle
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

        sigmaInstance.getMouseCaptor().on("mouseup", () => {
            if (draggedNode) graph.removeNodeAttribute(draggedNode, "highlighted");
            isDragging = false;
            draggedNode = null;
            sigmaInstance.getCamera().enable();
        });

        sigmaInstance.getMouseCaptor().on("mouseleave", () => {
            if (draggedNode) graph.removeNodeAttribute(draggedNode, "highlighted");
            isDragging = false;
            draggedNode = null;
            sigmaInstance.getCamera().enable();
        });

        // Filter checkboxes
        filtersContainer.addEventListener("change", e => {
            if (e.target.classList.contains("filter-checkbox")) {
                const type = e.target.dataset.type;
                if (e.target.checked) hiddenTypes.delete(type);
                else hiddenTypes.add(type);
                updateVisibility();
            }
        });

        // Search
        searchInput.addEventListener("input", e => {
            const query = e.target.value.toLowerCase().trim();
            searchResults.innerHTML = "";
            if (query.length < 2) return;

            const matches = [];
            graph.forEachNode((nodeId, attrs) => {
                if (attrs.label.toLowerCase().includes(query) || nodeId.toLowerCase().includes(query)) {
                    matches.push({ id: nodeId, label: attrs.label, color: attrs.color, nodeType: attrs.nodeType });
                }
            });

            matches.slice(0, 10).forEach(match => {
                const div = document.createElement("div");
                div.className = "search-result";
                div.innerHTML = `
                    <span class="search-result-dot" style="background: ${match.color}"></span>
                    <span>${match.label}</span>
                `;
                div.addEventListener("click", () => {
                    selectNode(match.id);
                    focusNode(match.id);
                    searchInput.value = "";
                    searchResults.innerHTML = "";
                });
                searchResults.appendChild(div);
            });
        });

        // Sigma node/edge events
        sigmaInstance.on("clickNode", ({ node }) => {
            selectNode(node);
            if (tableSyncEnabled) {
                const nodeType = graph.getNodeAttribute(node, "nodeType");
                if (dataPanel.classList.contains("collapsed")) dataPanel.classList.remove("collapsed");
                switchTab(nodeType);
                highlightTableRow(node);
            }
        });

        sigmaInstance.on("clickStage", () => {
            resetHighlight();
            hideNodeDetails();
            clearTableSelection();
        });

        sigmaInstance.on("enterNode", ({ node }) => {
            const attrs = graph.getNodeAttributes(node);
            if (tooltipsEnabled) {
                document.getElementById("tooltip-title").textContent = attrs.label;
                const typeSpan = document.getElementById("tooltip-type");
                typeSpan.textContent = attrs.nodeType;
                typeSpan.style.background = attrs.color + "30";
                typeSpan.style.color = attrs.color;
                document.getElementById("tooltip-edge").textContent = "";

                let propsHtml = "";
                if (attrs.validation) {
                    const v = attrs.validation;
                    propsHtml += `<div class="tooltip-prop"><span class="tooltip-prop-key">Validation:</span><span class="tooltip-prop-value"><span style="color:${v.strict ? "#22c55e" : "#ef4444"}">Strict ${v.strict ? "✓" : "✗"}</span> · <span style="color:${v.agent ? "#22c55e" : "#ef4444"}">Agent ${v.agent ? "✓" : "✗"}</span></span></div>`;
                } else if (attrs.validation === null) {
                    propsHtml += '<div class="tooltip-prop"><span class="tooltip-prop-key">Validation:</span><span class="tooltip-prop-value" style="color:#94a3b8">No data</span></div>';
                }

                if (attrs.properties) {
                    const propEntries = Object.entries(attrs.properties).filter(([key]) => !hiddenProps.has(key)).slice(0, 8);
                    propEntries.forEach(([key, value]) => {
                        let displayValue = value;
                        if (Array.isArray(value)) { displayValue = value.slice(0, 3).join(", "); if (value.length > 3) displayValue += "..."; }
                        else if (typeof value === "object") displayValue = JSON.stringify(value).slice(0, 50);
                        else if (typeof value === "string" && value.length > 40) displayValue = value.slice(0, 40) + "...";
                        propsHtml += `<div class="tooltip-prop"><span class="tooltip-prop-key">${key}:</span><span class="tooltip-prop-value">${displayValue}</span></div>`;
                    });
                    if (Object.keys(attrs.properties).length > 8) {
                        propsHtml += `<div class="tooltip-prop" style="color: #94a3b8; font-style: italic;">...and ${Object.keys(attrs.properties).length - 8} more</div>`;
                    }
                }
                tooltipProps.innerHTML = propsHtml;
                tooltipProps.style.display = propsHtml ? "block" : "none";
                tooltip.classList.add("visible");
            }

            hoveredNode = node;
            highlightNodeConnections(node, !!selectedNode);
        });

        sigmaInstance.on("enterEdge", ({ edge }) => {
            if (!tooltipsEnabled) return;
            const attrs = graph.getEdgeAttributes(edge);
            const source = graph.getSourceAttribute(edge, "label");
            const target = graph.getTargetAttribute(edge, "label");
            document.getElementById("tooltip-title").textContent = attrs.label;
            document.getElementById("tooltip-type").textContent = "";
            document.getElementById("tooltip-type").style.background = "";
            document.getElementById("tooltip-edge").textContent = `${source} → ${target}`;
            tooltipProps.innerHTML = "";
            tooltipProps.style.display = "none";
            tooltip.classList.add("visible");
        });

        sigmaInstance.on("leaveNode", () => {
            tooltip.classList.remove("visible");
            hoveredNode = null;
            if (selectedNode) restoreSelectionHighlight();
            else resetHighlight();
        });

        sigmaInstance.on("leaveEdge", () => {
            tooltip.classList.remove("visible");
        });

        sigmaInstance.getMouseCaptor().on("mousemove", e => {
            tooltip.style.left = e.x + 15 + "px";
            tooltip.style.top = e.y + 15 + "px";
        });

        // Zoom controls
        document.getElementById("zoom-in").addEventListener("click", () => {
            sigmaInstance.getCamera().animatedZoom({ duration: 300 });
        });
        document.getElementById("zoom-out").addEventListener("click", () => {
            sigmaInstance.getCamera().animatedUnzoom({ duration: 300 });
        });
        document.getElementById("zoom-fit").addEventListener("click", () => {
            sigmaInstance.getCamera().animatedReset({ duration: 300 });
        });
        document.getElementById("reset-view").addEventListener("click", () => {
            resetHighlight();
            hideNodeDetails();
            clearTableSelection();
            hiddenTypes.clear();
            document.querySelectorAll(".filter-checkbox").forEach(cb => cb.checked = true);
            updateVisibility();
            layoutManager.applyLayout(layoutManager.getCurrentLayout());
            sigmaInstance.getCamera().animatedReset({ duration: 300 });
        });

        // Sidebar toggle
        sidebarToggle.addEventListener("click", () => {
            sidebar.classList.toggle("collapsed");
            sidebarToggle.classList.toggle("sidebar-collapsed");
            sidebarToggle.textContent = sidebar.classList.contains("collapsed") ? "▶" : "◀";
            setTimeout(() => sigmaInstance.refresh(), 350);
        });

        // Sidebar section collapse
        document.querySelectorAll(".sidebar-section-header").forEach(header => {
            header.addEventListener("click", () => {
                header.closest(".sidebar-section").classList.toggle("collapsed");
            });
        });

        // Data panel toggle
        dataPanelHeader.addEventListener("click", () => {
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

        editorModule.jsonldApplyBtn.addEventListener("click", () => {
            editorModule.applyJsonldChanges(validationLookupById, applyGraphData, activeDataTab, selectedNode);
        });

        // Info modal
        const infoOverlay = document.getElementById("info-modal-overlay");
        const infoCloseBtn = document.getElementById("info-close-btn");
        const infoDismissBtn = document.getElementById("info-dismiss-btn");
        const infoBtn = document.getElementById("info-btn");

        function closeInfoModal() { infoOverlay.classList.add("hidden"); }
        function openInfoModal() { infoOverlay.classList.remove("hidden"); }

        infoCloseBtn.addEventListener("click", closeInfoModal);
        infoDismissBtn.addEventListener("click", closeInfoModal);
        infoOverlay.addEventListener("click", e => { if (e.target === infoOverlay) closeInfoModal(); });
        document.addEventListener("keydown", e => {
            if (e.key === "Escape" && !infoOverlay.classList.contains("hidden")) closeInfoModal();
        });
        infoBtn.addEventListener("click", openInfoModal);
    }

    // ── Initialize ───────────────────────────

    function init(initialGraphData, initialValidationLookup) {
        graphData = initialGraphData;
        validationLookupById = initialValidationLookup;
        buildEdgeLegend();
        rebuildSidebarAndTables();
        editorModule.setNodeEditButtonState(null, graph);
        editorModule.syncJsonldEditorToggleState();
        wireEvents();
    }

    return {
        init,
        applyGraphData,
        getSelectedNode: () => selectedNode,
    };
}
