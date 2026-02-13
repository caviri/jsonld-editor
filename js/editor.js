/* ==============================================
   JSON-LD Graph Visualization — Editor
   ============================================== */

/**
 * Create the JSON-LD editor module.
 * @returns {object} Editor API
 */
function createEditor() {
    let jsonldEditor = null;
    let sourceIndex = {};
    let highlightedSourceLines = [];
    let minimapVisible = false;

    // DOM elements
    const jsonldEditorWrapper = document.getElementById("jsonld-editor-wrapper");
    const jsonldEditorToggle = document.getElementById("jsonld-editor-toggle");
    const openJsonldEditorBtn = document.getElementById("open-jsonld-editor-btn");
    const editNodeJsonldBtn = document.getElementById("edit-node-jsonld-btn");
    const jsonldApplyBtn = document.getElementById("jsonld-apply-btn");
    const jsonldDownloadBtn = document.getElementById("jsonld-download-btn");
    const jsonldToggleMinimapBtn = document.getElementById("jsonld-toggle-minimap-btn");
    const jsonldStatusEl = document.getElementById("jsonld-editor-status");
    const jsonldTextarea = document.getElementById("jsonld-editor-textarea");
    const jsonldMinimap = document.getElementById("jsonld-minimap");
    const jsonldMinimapMarkers = document.getElementById("jsonld-minimap-markers");
    const jsonldMinimapViewport = document.getElementById("jsonld-minimap-viewport");

    function setJsonldStatus(message, level = "info") {
        jsonldStatusEl.classList.remove("success", "error");
        if (level === "success") jsonldStatusEl.classList.add("success");
        else if (level === "error") jsonldStatusEl.classList.add("error");
        jsonldStatusEl.textContent = message;
    }

    function getJsonldText() {
        return jsonldEditor ? jsonldEditor.getValue() : jsonldTextarea.value;
    }

    function isJsonldEditorOpen() {
        return !jsonldEditorWrapper.classList.contains("collapsed");
    }

    function syncJsonldEditorToggleState() {
        jsonldEditorToggle.textContent = isJsonldEditorOpen() ? "◀" : "▶";
    }

    function openJsonldEditor(sigmaInstance, selectedNode, highlightSourceForNodeFn) {
        if (!isJsonldEditorOpen()) {
            jsonldEditorWrapper.classList.remove("collapsed");
            syncJsonldEditorToggleState();
            setTimeout(() => {
                if (jsonldEditor) {
                    jsonldEditor.refresh();
                    if (selectedNode) {
                        highlightSourceForNodeFn(selectedNode, true);
                    }
                    updateMinimapMarkers();
                    updateMinimapViewport();
                }
                if (sigmaInstance) sigmaInstance.refresh();
            }, 350);
        }
    }

    function closeJsonldEditor(sigmaInstance) {
        if (isJsonldEditorOpen()) {
            jsonldEditorWrapper.classList.add("collapsed");
            syncJsonldEditorToggleState();
            setTimeout(() => { if (sigmaInstance) sigmaInstance.refresh(); }, 350);
        }
    }

    function toggleJsonldEditor(sigmaInstance, selectedNode, highlightSourceForNodeFn) {
        if (isJsonldEditorOpen()) {
            closeJsonldEditor(sigmaInstance);
        } else {
            openJsonldEditor(sigmaInstance, selectedNode, highlightSourceForNodeFn);
        }
    }

    function setNodeEditButtonState(nodeId, graph) {
        const enabled = Boolean(nodeId && graph && graph.hasNode(nodeId));
        editNodeJsonldBtn.disabled = !enabled;
        editNodeJsonldBtn.dataset.nodeId = enabled ? nodeId : "";
    }

    function scrollEditorToLine(line, focus = false) {
        if (!jsonldEditor) return;
        const maxLine = Math.max(0, jsonldEditor.lineCount() - 1);
        const safeLine = Math.max(0, Math.min(line, maxLine));
        jsonldEditor.scrollIntoView({ line: safeLine, ch: 0 }, 120);
        jsonldEditor.setCursor({ line: safeLine, ch: 0 });
        if (focus) jsonldEditor.focus();
        updateMinimapViewport();
    }

    function setMinimapButtonState() {
        jsonldToggleMinimapBtn.classList.toggle("active", minimapVisible);
        jsonldToggleMinimapBtn.textContent = minimapVisible ? "Hide Minimap" : "Show Minimap";
        jsonldToggleMinimapBtn.setAttribute("aria-pressed", minimapVisible ? "true" : "false");
    }

    function updateMinimapViewport() {
        if (!jsonldEditor || !minimapVisible) return;
        const scrollInfo = jsonldEditor.getScrollInfo();
        const fullHeight = Math.max(scrollInfo.height, 1);
        const viewHeight = Math.max(scrollInfo.clientHeight, 1);

        if (fullHeight <= viewHeight) {
            jsonldMinimapViewport.style.top = "0%";
            jsonldMinimapViewport.style.height = "100%";
            return;
        }

        const topRatio = Math.max(0, Math.min(1, scrollInfo.top / (fullHeight - viewHeight)));
        const heightRatio = Math.max(0.02, Math.min(1, viewHeight / fullHeight));
        jsonldMinimapViewport.style.top = `${topRatio * 100}%`;
        jsonldMinimapViewport.style.height = `${heightRatio * 100}%`;
    }

    function updateMinimapMarkers() {
        if (!minimapVisible) return;
        jsonldMinimapMarkers.innerHTML = "";
        if (!jsonldEditor) return;

        const lineCount = Math.max(1, jsonldEditor.lineCount());
        const markerMap = new Map();

        highlightedSourceLines.forEach(item => {
            const kind = item.className === "cm-node-line" ? "node" : "ref";
            if (!markerMap.has(item.line) || kind === "node") {
                markerMap.set(item.line, kind);
            }
        });

        const fragment = document.createDocumentFragment();
        markerMap.forEach((kind, line) => {
            const marker = document.createElement("div");
            marker.className = `minimap-marker minimap-marker-${kind}`;
            marker.style.top = `${(line / lineCount) * 100}%`;
            marker.title = `Line ${line + 1}`;
            marker.addEventListener("click", event => {
                event.stopPropagation();
                scrollEditorToLine(line, true);
            });
            fragment.appendChild(marker);
        });
        jsonldMinimapMarkers.appendChild(fragment);
    }

    function setMinimapVisibility(visible) {
        minimapVisible = visible;
        jsonldMinimap.classList.toggle("visible", minimapVisible);
        setMinimapButtonState();
        if (jsonldEditor) {
            setTimeout(() => {
                jsonldEditor.refresh();
                updateMinimapMarkers();
                updateMinimapViewport();
            }, 0);
        }
    }

    function toggleMinimap() {
        setMinimapVisibility(!minimapVisible);
    }

    // ── Source index helpers ──────────────────

    function buildLineStartOffsets(text) {
        const offsets = [0];
        for (let i = 0; i < text.length; i += 1) {
            if (text[i] === "\n") {
                offsets.push(i + 1);
            }
        }
        return offsets;
    }

    function findLineForOffset(offsets, index) {
        let low = 0;
        let high = offsets.length - 1;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            if (offsets[mid] <= index) low = mid + 1;
            else high = mid - 1;
        }
        return Math.max(0, high);
    }

    function getLineAndColumnForOffset(text, index) {
        const offsets = buildLineStartOffsets(text);
        const line = findLineForOffset(offsets, index);
        return {
            line: line + 1,
            column: index - offsets[line] + 1,
        };
    }

    function extractGraphObjectRanges(text) {
        const graphMatch = /"@graph"\s*:/.exec(text);
        if (!graphMatch) return [];

        let cursor = graphMatch.index + graphMatch[0].length;
        while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
        if (text[cursor] !== "[") return [];

        const arrayStart = cursor;
        let inString = false;
        let escaped = false;
        let bracketDepth = 0;
        let arrayEnd = -1;

        for (let i = arrayStart; i < text.length; i += 1) {
            const ch = text[i];
            if (inString) {
                if (escaped) { escaped = false; }
                else if (ch === "\\") { escaped = true; }
                else if (ch === '"') { inString = false; }
                continue;
            }
            if (ch === '"') { inString = true; }
            else if (ch === "[") { bracketDepth += 1; }
            else if (ch === "]") {
                bracketDepth -= 1;
                if (bracketDepth === 0) { arrayEnd = i; break; }
            }
        }

        if (arrayEnd < 0) return [];

        const ranges = [];
        inString = false;
        escaped = false;
        let braceDepth = 0;
        let objectStart = -1;

        for (let i = arrayStart + 1; i < arrayEnd; i += 1) {
            const ch = text[i];
            if (inString) {
                if (escaped) { escaped = false; }
                else if (ch === "\\") { escaped = true; }
                else if (ch === '"') { inString = false; }
                continue;
            }
            if (ch === '"') { inString = true; }
            else if (ch === "{") {
                if (braceDepth === 0) objectStart = i;
                braceDepth += 1;
            } else if (ch === "}") {
                braceDepth -= 1;
                if (braceDepth === 0 && objectStart >= 0) {
                    ranges.push({ start: objectStart, end: i });
                    objectStart = -1;
                }
            }
        }

        return ranges;
    }

    function buildSourceIndexFromText(text) {
        const lineOffsets = buildLineStartOffsets(text);
        const lines = text.split(/\r?\n/);
        const ranges = extractGraphObjectRanges(text);
        const index = {};

        ranges.forEach(range => {
            const blockText = text.slice(range.start, range.end + 1);
            const idMatch = /"@id"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/.exec(blockText);
            if (!idMatch) return;
            let nodeId = idMatch[1];
            try { nodeId = JSON.parse(`"${idMatch[1]}"`); } catch (err) { nodeId = idMatch[1]; }

            const startLine = findLineForOffset(lineOffsets, range.start);
            const endLine = findLineForOffset(lineOffsets, range.end);
            index[nodeId] = {
                block: { startLine, endLine },
                referenceLines: [],
                allLines: [],
            };
        });

        Object.entries(index).forEach(([nodeId, entry]) => {
            const quotedId = JSON.stringify(nodeId);
            const references = [];
            lines.forEach((line, lineNumber) => {
                if (line.includes(quotedId)) references.push(lineNumber);
            });

            const all = new Set(references);
            for (let line = entry.block.startLine; line <= entry.block.endLine; line += 1) {
                all.add(line);
            }

            entry.referenceLines = references.filter(
                line => line < entry.block.startLine || line > entry.block.endLine,
            );
            entry.allLines = Array.from(all).sort((a, b) => a - b);
        });

        return index;
    }

    function clearSourceHighlights() {
        if (!jsonldEditor) return;
        highlightedSourceLines.forEach(item => {
            jsonldEditor.removeLineClass(item.line, "background", item.className);
        });
        highlightedSourceLines = [];
        updateMinimapMarkers();
    }

    function highlightSourceForNode(nodeId, scrollToFirst = true, suppressStatus = false) {
        if (!jsonldEditor || !nodeId) return;
        clearSourceHighlights();

        const entry = sourceIndex[nodeId];
        if (!entry) {
            if (!suppressStatus) setJsonldStatus(`No JSON-LD block found for node "${nodeId}".`, "error");
            return;
        }

        for (let line = entry.block.startLine; line <= entry.block.endLine; line += 1) {
            jsonldEditor.addLineClass(line, "background", "cm-node-line");
            highlightedSourceLines.push({ line, className: "cm-node-line" });
        }

        entry.referenceLines.forEach(line => {
            if (line < entry.block.startLine || line > entry.block.endLine) {
                jsonldEditor.addLineClass(line, "background", "cm-node-ref-line");
                highlightedSourceLines.push({ line, className: "cm-node-ref-line" });
            }
        });

        if (scrollToFirst) scrollEditorToLine(entry.block.startLine, true);
        else updateMinimapViewport();

        updateMinimapMarkers();

        if (!suppressStatus) {
            setJsonldStatus(
                `Highlighted ${entry.block.endLine - entry.block.startLine + 1} node lines and ${entry.referenceLines.length} reference lines for "${nodeId}".`,
                "info",
            );
        }
    }

    function applyJsonldChanges(validationLookupById, applyGraphDataFn, activeDataTab, selectedNode) {
        const text = getJsonldText();
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            const msg = err && err.message ? err.message : "Invalid JSON.";
            const posMatch = /position\s+(\d+)/i.exec(msg);
            if (posMatch) {
                const pos = Number(posMatch[1]);
                const lc = getLineAndColumnForOffset(text, pos);
                setJsonldStatus(`Invalid JSON at line ${lc.line}, column ${lc.column}: ${msg}`, "error");
            } else {
                setJsonldStatus(`Invalid JSON: ${msg}`, "error");
            }
            return;
        }

        try {
            const nextGraphData = buildGraphDataFromJsonld(parsed, validationLookupById);
            sourceIndex = buildSourceIndexFromText(text);
            applyGraphDataFn(nextGraphData, activeDataTab);
            if (selectedNode && isJsonldEditorOpen()) {
                highlightSourceForNode(selectedNode, false);
            }
            setJsonldStatus(
                `Applied JSON-LD successfully: ${nextGraphData.metadata.nodeCount} nodes, ${nextGraphData.metadata.edgeCount} edges.`,
                "success",
            );
        } catch (err) {
            setJsonldStatus(err && err.message ? err.message : "Failed to apply JSON-LD.", "error");
        }
    }

    function downloadJsonldText() {
        const blob = new Blob([getJsonldText()], { type: "application/ld+json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "jsonld_output.edited.json";
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        setJsonldStatus("Downloaded edited JSON-LD file.", "success");
    }

    function initJsonldEditor(initialText, selectedNodeGetter) {
        if (typeof CodeMirror === "undefined") {
            jsonldTextarea.value = initialText;
            sourceIndex = buildSourceIndexFromText(initialText);
            jsonldToggleMinimapBtn.disabled = true;
            setMinimapVisibility(false);
            setJsonldStatus("CodeMirror failed to load; using plain textarea editor.", "error");
            return;
        }

        jsonldEditor = CodeMirror.fromTextArea(jsonldTextarea, {
            mode: { name: "javascript", json: true },
            lineNumbers: true,
            lineWrapping: false,
            tabSize: 2,
            viewportMargin: 20,
        });
        jsonldEditor.setValue(initialText);
        sourceIndex = buildSourceIndexFromText(initialText);
        jsonldEditor.on("changes", () => {
            sourceIndex = buildSourceIndexFromText(jsonldEditor.getValue());
            const sel = selectedNodeGetter();
            if (sel && highlightedSourceLines.length > 0 && isJsonldEditorOpen()) {
                highlightSourceForNode(sel, false, true);
            } else {
                updateMinimapMarkers();
            }
            updateMinimapViewport();
        });
        jsonldEditor.on("scroll", () => updateMinimapViewport());
        setMinimapButtonState();
        setJsonldStatus("Editor ready. Select a node and click 'Edit in JSON-LD'.", "info");
    }

    // Wire up minimap click
    jsonldMinimap.addEventListener("click", event => {
        if (!jsonldEditor || !minimapVisible) return;
        const rect = jsonldMinimap.getBoundingClientRect();
        if (!rect.height) return;
        const ratio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
        const line = Math.floor(ratio * Math.max(0, jsonldEditor.lineCount() - 1));
        scrollEditorToLine(line, true);
    });

    jsonldToggleMinimapBtn.addEventListener("click", () => toggleMinimap());
    jsonldDownloadBtn.addEventListener("click", () => downloadJsonldText());

    return {
        initJsonldEditor,
        openJsonldEditor,
        closeJsonldEditor,
        toggleJsonldEditor,
        isJsonldEditorOpen,
        syncJsonldEditorToggleState,
        setNodeEditButtonState,
        highlightSourceForNode,
        clearSourceHighlights,
        applyJsonldChanges,
        getJsonldText,
        // Expose DOM elements for wiring
        jsonldEditorToggle,
        openJsonldEditorBtn,
        editNodeJsonldBtn,
        jsonldApplyBtn,
    };
}
