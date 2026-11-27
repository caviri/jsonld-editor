/* ==============================================
   JSON-LD Graph Visualization — Editor
   ============================================== */

/**
 * Create the JSON-LD editor module (CodeMirror 5 wrapper).
 * @returns {object} Editor API
 */
function createEditor() {
    let cm = null;
    let sourceIndex = { blocks: new Map(), strings: new Map(), keys: new Map() };
    let highlightedSourceLines = [];
    let minimapVisible = false;
    let resolveRawForms = nodeId => [nodeId];
    let hintProvider = null;
    let onPickTerm = null;
    const changeListeners = new Set();
    let suppressChange = false;
    let problemLines = [];
    let format = "jsonld";            // "jsonld" | "ttl"
    let turtleSubjectForms = nodeId => [nodeId];

    /**
     * Syntax overlay for JSON-LD: absolute IRIs, prefixed names (prefix dimmed),
     * blank node ids, and brackets coloured by nesting depth.
     */
    function jsonldModeSpec() {
        return typeof CodeMirror !== "undefined" && CodeMirror.modes["jsonld-highlight"] ? "jsonld-highlight" : { name: "javascript", jsonld: true };
    }

    const jsonldOverlay = {
        startState: () => ({ depth: 0, curieLocal: false }),
        copyState: s => ({ depth: s.depth, curieLocal: s.curieLocal }),
        token(stream, state) {
            if (state.curieLocal) {
                state.curieLocal = false;
                stream.match(/^(?:[^"\\]|\\.)*"?/);
                return "jsonld-local";
            }
            const ch = stream.peek();
            if (ch === '"') {
                const m = stream.match(/^"((?:[^"\\]|\\.)*)"?/, false);
                const content = m ? m[1] : "";
                if (/^(?:https?|urn|mailto|ftp|file|did|doi|tag|data|geo|tel|ipfs):/i.test(content)) {
                    stream.match(/^"(?:[^"\\]|\\.)*"?/);
                    return "jsonld-iri";
                }
                if (/^_:/.test(content)) {
                    stream.match(/^"(?:[^"\\]|\\.)*"?/);
                    return "jsonld-bnode";
                }
                const curie = /^([A-Za-z][\w.\-]*):(?!\/\/)(?=\S)/.exec(content);
                if (curie) {
                    stream.next();
                    stream.match(curie[0]);
                    state.curieLocal = true;
                    return "jsonld-prefix";
                }
                stream.match(/^"(?:[^"\\]|\\.)*"?/);
                return null;
            }
            if (ch === "{" || ch === "[") {
                stream.next();
                const d = state.depth % 3;
                state.depth += 1;
                return `jsonld-bracket-${d}`;
            }
            if (ch === "}" || ch === "]") {
                stream.next();
                state.depth = Math.max(0, state.depth - 1);
                return `jsonld-bracket-${state.depth % 3}`;
            }
            stream.next();
            while (!stream.eol() && !/["{}\[\]]/.test(stream.peek())) stream.next();
            return null;
        },
    };

    // DOM elements
    const jsonldEditorWrapper = document.getElementById("jsonld-editor-wrapper");
    const jsonldEditorToggle = document.getElementById("jsonld-editor-toggle");
    const openJsonldEditorBtn = document.getElementById("open-jsonld-editor-btn");
    const editNodeJsonldBtn = document.getElementById("edit-node-jsonld-btn");
    const jsonldApplyBtn = document.getElementById("jsonld-apply-btn");
    const jsonldDownloadBtn = document.getElementById("jsonld-download-btn");
    const jsonldFormatBtn = document.getElementById("jsonld-format-btn");
    const jsonldAutoApplyBtn = document.getElementById("jsonld-autoapply-btn");
    const jsonldToggleMinimapBtn = document.getElementById("jsonld-toggle-minimap-btn");
    const jsonldStatusEl = document.getElementById("jsonld-editor-status");
    const jsonldTextarea = document.getElementById("jsonld-editor-textarea");
    const jsonldMinimap = document.getElementById("jsonld-minimap");
    const jsonldMinimapMarkers = document.getElementById("jsonld-minimap-markers");
    const jsonldMinimapViewport = document.getElementById("jsonld-minimap-viewport");

    function setJsonldStatus(message, level = "info") {
        jsonldStatusEl.classList.remove("success", "error", "warning");
        if (level === "success" || level === "error" || level === "warning") jsonldStatusEl.classList.add(level);
        jsonldStatusEl.textContent = message;
    }

    function getJsonldText() {
        return cm ? cm.getValue() : jsonldTextarea.value;
    }

    function isJsonldEditorOpen() {
        return !jsonldEditorWrapper.classList.contains("collapsed");
    }

    function syncJsonldEditorToggleState() {
        const arrow = jsonldEditorToggle.querySelector(".toggle-arrow");
        if (arrow) arrow.textContent = isJsonldEditorOpen() ? "◀" : "▶";
        else jsonldEditorToggle.textContent = isJsonldEditorOpen() ? "◀" : "▶";
    }

    function refreshSoon(sigmaInstance) {
        setTimeout(() => {
            if (cm) {
                cm.refresh();
                updateMinimapMarkers();
                updateMinimapViewport();
            }
            if (sigmaInstance) sigmaInstance.refresh();
        }, 350);
    }

    function openJsonldEditor(sigmaInstance, selectedNode, highlightSourceForNodeFn) {
        if (!isJsonldEditorOpen()) {
            jsonldEditorWrapper.classList.remove("collapsed");
            syncJsonldEditorToggleState();
            setTimeout(() => {
                if (cm) {
                    cm.refresh();
                    if (selectedNode && highlightSourceForNodeFn) highlightSourceForNodeFn(selectedNode, true);
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
            refreshSoon(sigmaInstance);
        }
    }

    function toggleJsonldEditor(sigmaInstance, selectedNode, highlightSourceForNodeFn) {
        if (isJsonldEditorOpen()) closeJsonldEditor(sigmaInstance);
        else openJsonldEditor(sigmaInstance, selectedNode, highlightSourceForNodeFn);
    }

    function setNodeEditButtonState(nodeId, graph) {
        const enabled = Boolean(nodeId && graph && graph.hasNode(nodeId));
        editNodeJsonldBtn.disabled = !enabled;
        editNodeJsonldBtn.dataset.nodeId = enabled ? nodeId : "";
    }

    function scrollEditorToLine(line, focus = false) {
        if (!cm) return;
        const maxLine = Math.max(0, cm.lineCount() - 1);
        const safeLine = Math.max(0, Math.min(line, maxLine));
        cm.scrollIntoView({ line: safeLine, ch: 0 }, 120);
        cm.setCursor({ line: safeLine, ch: 0 });
        if (focus) cm.focus();
        updateMinimapViewport();
    }

    // ── Minimap ───────────────────────────────

    function setMinimapButtonState() {
        jsonldToggleMinimapBtn.classList.toggle("active", minimapVisible);
        jsonldToggleMinimapBtn.textContent = minimapVisible ? "Hide minimap" : "Minimap";
        jsonldToggleMinimapBtn.setAttribute("aria-pressed", minimapVisible ? "true" : "false");
    }

    function updateMinimapViewport() {
        if (!cm || !minimapVisible) return;
        const scrollInfo = cm.getScrollInfo();
        const fullHeight = Math.max(scrollInfo.height, 1);
        const viewHeight = Math.max(scrollInfo.clientHeight, 1);
        if (fullHeight <= viewHeight) {
            jsonldMinimapViewport.style.top = "0%";
            jsonldMinimapViewport.style.height = "100%";
            return;
        }
        const topRatio = Math.max(0, Math.min(1, scrollInfo.top / (fullHeight - viewHeight)));
        const heightRatio = Math.max(0.02, Math.min(1, viewHeight / fullHeight));
        jsonldMinimapViewport.style.top = `${topRatio * (1 - heightRatio) * 100}%`;
        jsonldMinimapViewport.style.height = `${heightRatio * 100}%`;
    }

    function updateMinimapMarkers() {
        if (!minimapVisible) return;
        jsonldMinimapMarkers.innerHTML = "";
        if (!cm) return;
        const lineCount = Math.max(1, cm.lineCount());
        const markerMap = new Map();
        problemLines.forEach(p => markerMap.set(p.line, p.severity === "error" ? "error" : "warning"));
        highlightedSourceLines.forEach(item => {
            const kind = item.className === "cm-node-line" ? "node" : "ref";
            if (!markerMap.has(item.line) || kind === "node") markerMap.set(item.line, kind);
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
        if (cm) {
            setTimeout(() => {
                cm.refresh();
                updateMinimapMarkers();
                updateMinimapViewport();
            }, 0);
        }
    }

    // ── Source index ──────────────────────────
    // One pass over the text: every object that carries an "@id" (at any depth)
    // and every string literal's line, so references can be found quickly.

    function buildSourceIndexFromText(text) {
        const blocks = new Map();    // raw id -> { startLine, endLine, keys }
        const strings = new Map();   // string value -> [lines]
        const keyLines = new Map();  // object key -> [lines]
        const stack = [];
        let line = 0;
        let i = 0;
        const n = text.length;
        let pendingKey = null;

        while (i < n) {
            const ch = text[i];
            if (ch === "\n") { line += 1; i += 1; continue; }
            if (ch === '"') {
                const startLine = line;
                let j = i + 1;
                let value = "";
                let escaped = false;
                while (j < n) {
                    const c = text[j];
                    if (escaped) { value += "\\" + c; escaped = false; }
                    else if (c === "\\") escaped = true;
                    else if (c === '"') break;
                    else { if (c === "\n") line += 1; value += c; }
                    j += 1;
                }
                if (value.includes("\\")) {
                    try { value = JSON.parse(`"${value}"`); } catch (_) { /* keep raw */ }
                }
                i = j + 1;
                // Key or value?
                let k = i;
                while (k < n && (text[k] === " " || text[k] === "\t" || text[k] === "\r" || text[k] === "\n")) k += 1;
                const top = stack[stack.length - 1];
                if (text[k] === ":" && top && top.type === "object") {
                    pendingKey = value;
                    top.keys += 1;
                    if (!keyLines.has(value)) keyLines.set(value, []);
                    const kl = keyLines.get(value);
                    if (kl[kl.length - 1] !== startLine) kl.push(startLine);
                } else {
                    if (!strings.has(value)) strings.set(value, []);
                    const lines = strings.get(value);
                    if (lines[lines.length - 1] !== startLine) lines.push(startLine);
                    if (pendingKey === "@id" && top && top.type === "object" && top.rawId === null) top.rawId = value;
                    pendingKey = null;
                }
                continue;
            }
            if (ch === "{") {
                stack.push({ type: "object", startLine: line, rawId: null, keys: 0 });
                pendingKey = null;
            } else if (ch === "[") {
                stack.push({ type: "array" });
                pendingKey = null;
            } else if (ch === "}" || ch === "]") {
                const top = stack.pop();
                if (top && top.type === "object" && top.rawId !== null) {
                    const entry = { startLine: top.startLine, endLine: line, keys: top.keys };
                    const existing = blocks.get(top.rawId);
                    // Prefer the definition (most keys) over bare {"@id": ...} references.
                    if (!existing || entry.keys > existing.keys) blocks.set(top.rawId, entry);
                }
                pendingKey = null;
            } else if (ch === ",") {
                pendingKey = null;
            }
            i += 1;
        }
        return { blocks, strings, keys: keyLines };
    }

    function rebuildSourceIndex() {
        sourceIndex = format === "ttl" ? buildTurtleIndex(getJsonldText()) : buildSourceIndexFromText(getJsonldText());
    }

    /**
     * Turtle view: the serialiser writes one subject per block, starting at
     * column 0 and ending with " ." — index those blocks by their subject token,
     * and index every token occurrence for reference lines.
     */
    function buildTurtleIndex(text) {
        const blocks = new Map();
        const strings = new Map();
        const lines = text.split("\n");
        let current = null;
        lines.forEach((line, i) => {
            if (current === null && line && !/^[\s@#]/.test(line)) {
                const subject = line.trim().split(/\s+/)[0];
                current = { subject, startLine: i };
            }
            (line.match(/<[^>\s]+>|[A-Za-z][\w.\-]*:[\w.\-]*|_:[\w\-]+/g) || []).forEach(tok => {
                if (!strings.has(tok)) strings.set(tok, []);
                const l = strings.get(tok);
                if (l[l.length - 1] !== i) l.push(i);
            });
            if (current && /\s\.\s*$/.test(line)) {
                blocks.set(current.subject, { startLine: current.startLine, endLine: i, keys: i - current.startLine + 1 });
                current = null;
            }
        });
        return { blocks, strings, keys: new Map() };
    }

    function clearSourceHighlights() {
        if (!cm) return;
        highlightedSourceLines.forEach(item => cm.removeLineClass(item.line, "background", item.className));
        highlightedSourceLines = [];
        updateMinimapMarkers();
    }

    function locateNode(nodeId) {
        const forms = format === "ttl" ? turtleSubjectForms(nodeId) : (resolveRawForms(nodeId) || [nodeId]);
        let block = null;
        forms.forEach(f => {
            const b = sourceIndex.blocks.get(f);
            if (b && (!block || b.keys > block.keys)) block = b;
        });
        const refs = new Set();
        forms.forEach(f => (sourceIndex.strings.get(f) || []).forEach(l => refs.add(l)));
        return { block, refs };
    }

    function highlightSourceForNode(nodeId, scrollToFirst = true, suppressStatus = false) {
        if (!cm || !nodeId) return false;
        clearSourceHighlights();
        const { block, refs } = locateNode(nodeId);
        if (!block) {
            if (!suppressStatus) setJsonldStatus(`"${nodeId}" is referenced but not described in this document.`, "warning");
            if (refs.size) {
                [...refs].forEach(l => {
                    cm.addLineClass(l, "background", "cm-node-ref-line");
                    highlightedSourceLines.push({ line: l, className: "cm-node-ref-line" });
                });
                if (scrollToFirst) scrollEditorToLine(Math.min(...refs), true);
                updateMinimapMarkers();
            }
            return false;
        }
        for (let l = block.startLine; l <= block.endLine; l += 1) {
            cm.addLineClass(l, "background", "cm-node-line");
            highlightedSourceLines.push({ line: l, className: "cm-node-line" });
        }
        let refCount = 0;
        refs.forEach(l => {
            if (l < block.startLine || l > block.endLine) {
                cm.addLineClass(l, "background", "cm-node-ref-line");
                highlightedSourceLines.push({ line: l, className: "cm-node-ref-line" });
                refCount += 1;
            }
        });
        if (scrollToFirst) scrollEditorToLine(block.startLine, true);
        else updateMinimapViewport();
        updateMinimapMarkers();
        if (!suppressStatus) {
            setJsonldStatus(`Lines ${block.startLine + 1}–${block.endLine + 1} describe this node; ${refCount} other line${refCount === 1 ? "" : "s"} reference it.`, "info");
        }
        return true;
    }

    /** Lines (0-based) where a string occurs as a value or as a key. */
    function linesOf(value) {
        const out = new Set([...(sourceIndex.strings.get(value) || []), ...(sourceIndex.keys.get(value) || [])]);
        return [...out].sort((a, b) => a - b);
    }

    /** The source block describing a node, or null. */
    function blockOf(nodeId) {
        return locateNode(nodeId).block;
    }

    /** Select the first occurrence of `needle` (exact text), optionally at or after a line. */
    function findText(needle, focus = true, fromLine = 0) {
        if (!cm || !needle) return false;
        const text = cm.getValue();
        const start = fromLine ? cm.indexFromPos({ line: fromLine, ch: 0 }) : 0;
        let idx = text.indexOf(needle, start);
        if (idx < 0 && start > 0) idx = text.indexOf(needle);
        if (idx < 0) return false;
        const from = cm.posFromIndex(idx);
        const to = cm.posFromIndex(idx + needle.length);
        cm.setSelection(from, to);
        cm.scrollIntoView({ from, to }, 120);
        if (focus) cm.focus();
        return true;
    }

    /** Line number (0-based) of the first occurrence of a string, or -1. */
    function lineOf(needle) {
        if (!needle) return -1;
        const text = getJsonldText();
        const idx = text.indexOf(needle);
        if (idx < 0) return -1;
        let line = 0;
        for (let i = 0; i < idx; i += 1) if (text.charCodeAt(i) === 10) line += 1;
        return line;
    }

    // ── Problem markers ───────────────────────

    function setProblems(list) {
        problemLines = [];
        if (!cm) return;
        cm.clearGutter("cm-problems");
        const byLine = new Map();
        list.forEach(p => {
            if (p.line === undefined || p.line < 0) return;
            const existing = byLine.get(p.line);
            if (!existing || (p.severity === "error" && existing.severity !== "error")) byLine.set(p.line, { severity: p.severity, messages: [] });
            byLine.get(p.line).messages.push(p.message);
        });
        byLine.forEach((info, line) => {
            const marker = document.createElement("span");
            marker.className = `cm-problem-marker cm-problem-${info.severity}`;
            marker.textContent = info.severity === "error" ? "●" : info.severity === "warning" ? "▲" : "i";
            marker.title = info.messages.join("\n\n");
            cm.setGutterMarker(line, "cm-problems", marker);
            problemLines.push({ line, severity: info.severity });
        });
        updateMinimapMarkers();
    }

    // ── Text manipulation ─────────────────────

    /** Replace the whole text, keeping undo history (Ctrl+Z restores). */
    function setText(text, opts = {}) {
        if (!cm) {
            jsonldTextarea.value = text;
            rebuildSourceIndex();
            return;
        }
        suppressChange = Boolean(opts.silent);
        const scroll = cm.getScrollInfo();
        const cursor = cm.getCursor();
        cm.operation(() => {
            const last = cm.lastLine();
            cm.replaceRange(text, { line: 0, ch: 0 }, { line: last, ch: cm.getLine(last).length }, "+replace");
        });
        if (opts.clearHistory) cm.clearHistory();
        if (opts.keepPosition !== false) {
            cm.setCursor(Math.min(cursor.line, cm.lastLine()), cursor.ch);
            cm.scrollTo(scroll.left, scroll.top);
        }
        suppressChange = false;
        rebuildSourceIndex();
    }

    function insertAtCursor(text) {
        if (!cm) return false;
        cm.replaceSelection(text, "end");
        cm.focus();
        return true;
    }

    /** Insert text right after the opening brace of the top-level @context object. */
    function insertIntoContext(snippet) {
        const text = getJsonldText();
        const m = /"@context"\s*:\s*\{/.exec(text);
        if (!m || !cm) return false;
        const pos = m.index + m[0].length;
        const after = text.slice(pos);
        const indentMatch = /^\s*\n([ \t]*)"/.exec(after);
        const indent = indentMatch ? indentMatch[1] : "    ";
        const isEmpty = /^\s*\}/.test(after);
        const insertion = isEmpty ? `\n${indent}${snippet}\n` : `\n${indent}${snippet},`;
        cm.replaceRange(insertion, cm.posFromIndex(pos), undefined, "+context");
        return true;
    }

    function formatDocument() {
        try {
            const parsed = JSON.parse(getJsonldText());
            setText(JSON.stringify(parsed, null, 2) + "\n");
            setJsonldStatus("Formatted.", "success");
        } catch (err) {
            reportJsonError(getJsonldText(), err);
        }
    }

    function reportJsonError(text, err) {
        const msg = err && err.message ? err.message : "Invalid JSON.";
        let line = null;
        let column = null;
        const pos = /position\s+(\d+)/i.exec(msg);
        const lc = /line\s+(\d+)\s+column\s+(\d+)/i.exec(msg);
        if (lc) { line = Number(lc[1]); column = Number(lc[2]); }
        else if (pos) {
            const offset = Number(pos[1]);
            line = 1; column = 1;
            for (let i = 0; i < offset && i < text.length; i += 1) {
                if (text[i] === "\n") { line += 1; column = 1; } else column += 1;
            }
        }
        if (line !== null) {
            setJsonldStatus(`Invalid JSON at line ${line}, column ${column}: ${msg}`, "error");
            if (cm) setProblems([{ line: line - 1, severity: "error", message: msg }]);
        } else {
            setJsonldStatus(`Invalid JSON: ${msg}`, "error");
        }
        return { line, column, message: msg };
    }

    function downloadText(text, fileName, mime) {
        const blob = text instanceof Blob ? text : new Blob([text], { type: mime || "application/ld+json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ── Autocomplete ──────────────────────────

    /** What is the cursor in? { inString, isKey, key, word, from, to } */
    function cursorContext() {
        if (!cm) return null;
        const cur = cm.getCursor();
        if (format === "ttl") {
            // Turtle: complete the prefixed name / word under the cursor.
            const line = cm.getLine(cur.line);
            let start = cur.ch;
            while (start > 0 && /[\w:.\-]/.test(line[start - 1])) start -= 1;
            let end = cur.ch;
            while (end < line.length && /[\w:.\-]/.test(line[end])) end += 1;
            const before = line.slice(0, start).trim();
            const position = !before || /[;.]$/.test(before) ? "subject-or-predicate" : (/\ba$/.test(before) || /rdf:type$/.test(before) ? "type" : "object");
            return {
                inString: true,
                turtle: true,
                isKey: /;$/.test(before) || (before && !/[,;.]$/.test(before) && before.split(/\s+/).length === 1),
                key: position === "type" ? "@type" : null,
                word: line.slice(start, cur.ch),
                from: { line: cur.line, ch: start },
                to: { line: cur.line, ch: end },
            };
        }
        const token = cm.getTokenAt(cur);
        const lineText = cm.getLine(cur.line);
        const inString = token.type === "string" || token.type === "string property" || (token.string && token.string.startsWith('"'));
        if (!inString) return { inString: false };
        const start = token.start + 1;
        const end = token.string.endsWith('"') && token.string.length > 1 && token.end > cur.ch - 0 ? token.end - 1 : token.end;
        const word = lineText.slice(start, cur.ch);
        const rest = lineText.slice(token.end);
        const isKey = /^\s*:/.test(rest) || token.type === "string property";
        let key = null;
        if (!isKey) {
            // Find the key this value belongs to: scan back over the line (and previous lines for arrays).
            for (let l = cur.line; l >= Math.max(0, cur.line - 40); l -= 1) {
                const text = l === cur.line ? lineText.slice(0, token.start) : cm.getLine(l);
                const m = /"((?:[^"\\]|\\.)*)"\s*:\s*\[?[^:]*$/.exec(text);
                if (m) { key = m[1]; break; }
                if (/[{}]/.test(text) && l !== cur.line) break;
            }
        }
        return {
            inString: true,
            isKey,
            key,
            word,
            from: { line: cur.line, ch: start },
            to: { line: cur.line, ch: Math.max(cur.ch, Math.min(end, lineText.length)) },
        };
    }

    function showHints(auto) {
        if (!cm || !hintProvider || typeof cm.showHint !== "function") return;
        cm.showHint({
            completeSingle: false,
            closeCharacters: /[\s()\[\]{};>,"]/,
            hint: () => {
                const ctx = cursorContext();
                if (!ctx || !ctx.inString) return null;
                if (auto && ctx.word.length < 2) return null;
                const items = hintProvider(ctx) || [];
                if (!items.length) return null;
                const list = items.map(item => ({
                    text: item.text,
                    displayText: item.displayText || item.text,
                    className: item.className || "",
                    render: (el, self, data) => {
                        el.innerHTML = "";
                        const main = document.createElement("span");
                        main.className = "hint-main";
                        main.textContent = data.displayText;
                        el.appendChild(main);
                        if (item.detail) {
                            const detail = document.createElement("span");
                            detail.className = "hint-detail";
                            detail.textContent = item.detail;
                            el.appendChild(detail);
                        }
                    },
                    hint: (editor, self, data) => {
                        const c = cursorContext();
                        if (c && c.turtle) {
                            editor.replaceRange(data.text, c.from, c.to, "complete");
                            if (onPickTerm && item.iri) onPickTerm(item.iri, data.text);
                            return;
                        }
                        // Replace the string's contents, not its quotes.
                        const from = c && c.inString ? c.from : self.from;
                        const lineText = editor.getLine(from.line);
                        let toCh = from.ch;
                        while (toCh < lineText.length && lineText[toCh] !== '"') toCh += 1;
                        editor.replaceRange(data.text, from, { line: from.line, ch: toCh }, "complete");
                        if (onPickTerm && item.iri) onPickTerm(item.iri, data.text);
                    },
                }));
                return { list, from: ctx.from, to: ctx.to };
            },
        });
    }

    function setHintProvider(provider, pickCallback) {
        hintProvider = provider;
        onPickTerm = pickCallback || null;
    }

    function setSourceResolver(fn) {
        resolveRawForms = fn;
    }

    function onTextChange(fn) {
        changeListeners.add(fn);
        return () => changeListeners.delete(fn);
    }

    // ── Init ──────────────────────────────────

    function initJsonldEditor(initialText, selectedNodeGetter) {
        if (typeof CodeMirror === "undefined") {
            jsonldTextarea.value = initialText;
            rebuildSourceIndex();
            jsonldToggleMinimapBtn.disabled = true;
            setMinimapVisibility(false);
            setJsonldStatus("CodeMirror failed to load; using a plain textarea.", "error");
            jsonldTextarea.addEventListener("input", () => changeListeners.forEach(fn => fn(getJsonldText())));
            return;
        }

        const hasFold = typeof CodeMirror.fold !== "undefined";
        // JSON-LD mode + the stateful overlay (needs addon/mode/overlay.js).
        if (typeof CodeMirror.overlayMode === "function" && !CodeMirror.modes["jsonld-highlight"]) {
            CodeMirror.defineMode("jsonld-highlight", config =>
                CodeMirror.overlayMode(CodeMirror.getMode(config, { name: "javascript", jsonld: true }), jsonldOverlay, true));
        }
        const coarsePointer = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
        cm = CodeMirror.fromTextArea(jsonldTextarea, {
            mode: jsonldModeSpec(),
            // Phones and tablets: contenteditable works with on-screen keyboards and selection handles.
            inputStyle: coarsePointer ? "contenteditable" : "textarea",
            lineNumbers: true,
            lineWrapping: false,
            tabSize: 2,
            indentUnit: 2,
            viewportMargin: 20,
            matchBrackets: true,
            autoCloseBrackets: true,
            styleActiveLine: true,
            foldGutter: hasFold,
            gutters: ["cm-problems", "CodeMirror-linenumbers"].concat(hasFold ? ["CodeMirror-foldgutter"] : []),
            extraKeys: {
                "Ctrl-Space": () => showHints(false),
                "Cmd-Space": () => showHints(false),
                "Ctrl-Enter": () => jsonldApplyBtn.click(),
                "Cmd-Enter": () => jsonldApplyBtn.click(),
                "Shift-Alt-F": () => formatDocument(),
                "Ctrl-S": () => { jsonldDownloadBtn.click(); },
                "Cmd-S": () => { jsonldDownloadBtn.click(); },
                "Ctrl-Q": editor => { if (editor.foldCode) editor.foldCode(editor.getCursor()); },
            },
        });
        cm.setValue(initialText);
        cm.clearHistory();
        rebuildSourceIndex();
        cm.on("changes", () => {
            rebuildSourceIndex();
            const sel = selectedNodeGetter();
            if (sel && highlightedSourceLines.length > 0 && isJsonldEditorOpen()) highlightSourceForNode(sel, false, true);
            else updateMinimapMarkers();
            updateMinimapViewport();
            if (!suppressChange) changeListeners.forEach(fn => fn(getJsonldText()));
        });
        cm.on("inputRead", (editor, change) => {
            if (!hintProvider || editor.state.completionActive || format === "ttl") return;
            const ch = change.text && change.text[0];
            if (ch && /^[A-Za-z:@]$/.test(ch)) {
                const ctx = cursorContext();
                if (ctx && ctx.inString && (ctx.isKey || ctx.key === "@type" || /subClassOf|domain|range|subPropertyOf|equivalent/i.test(ctx.key || ""))) {
                    showHints(true);
                }
            }
        });
        cm.on("scroll", () => updateMinimapViewport());
        setMinimapButtonState();
        setJsonldStatus("Ready. Ctrl+Space suggests terms · Ctrl+Enter applies · Ctrl+S downloads.", "info");
    }

    jsonldMinimap.addEventListener("click", event => {
        if (!cm || !minimapVisible) return;
        const rect = jsonldMinimap.getBoundingClientRect();
        if (!rect.height) return;
        const ratio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
        scrollEditorToLine(Math.floor(ratio * Math.max(0, cm.lineCount() - 1)), true);
    });
    jsonldToggleMinimapBtn.addEventListener("click", () => setMinimapVisibility(!minimapVisible));
    if (jsonldFormatBtn) jsonldFormatBtn.addEventListener("click", () => formatDocument());

    // ── Source format (JSON-LD / Turtle) ──────

    /** Switch the editor between JSON-LD and Turtle, replacing its text (undoable). */
    function setFormat(next, text) {
        format = next;
        document.querySelectorAll(".fmt-btn").forEach(b => b.classList.toggle("active", b.dataset.fmt === next));
        jsonldFormatBtn.disabled = next === "ttl";
        if (cm) {
            cm.setOption("mode", next === "ttl" ? "text/turtle" : jsonldModeSpec());
            cm.setOption("autoCloseBrackets", next !== "ttl");
            cm.clearGutter("cm-problems");
        }
        problemLines = [];
        clearSourceHighlights();
        setText(text, { keepPosition: false, silent: true });
    }

    function getFormat() { return format; }

    function setTurtleSubjectResolver(fn) { turtleSubjectForms = fn; }

    /** Add an @prefix line at the top of the Turtle text, if missing. */
    function insertTurtlePrefix(prefix, namespace) {
        if (!cm || format !== "ttl") return false;
        const text = cm.getValue();
        if (new RegExp(`^@prefix\\s+${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m").test(text)) return false;
        cm.replaceRange(`@prefix ${prefix}: <${namespace}> .\n`, { line: 0, ch: 0 }, undefined, "+prefix");
        return true;
    }

    // ── Resizable editor panel ────────────────

    const resizer = makePanelResizable({
        wrapper: jsonldEditorWrapper,
        handle: document.getElementById("jsonld-editor-resize"),
        cssVar: "--editor-width",
        edge: "right",
        min: 300,
        defaultWidth: 440,
        maxFn: () => {
            const main = document.getElementById("main-content");
            const sidebar = document.getElementById("sidebar");
            return main.clientWidth - (sidebar ? sidebar.getBoundingClientRect().width : 0) - 220;
        },
        storageKey: "jsonld-editor:editor-width",
        onResize: () => { if (cm) cm.refresh(); updateMinimapViewport(); },
    });
    const expandBtn = document.getElementById("jsonld-expand-btn");
    if (expandBtn) {
        expandBtn.addEventListener("click", () => {
            if (!isJsonldEditorOpen()) openJsonldEditor(null, null, null);
            const half = resizer.toggleHalf();
            expandBtn.classList.toggle("active", half);
            setTimeout(() => { if (cm) cm.refresh(); }, 340);
        });
    }

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
        getJsonldText,
        setText,
        insertAtCursor,
        insertIntoContext,
        findText,
        lineOf,
        linesOf,
        blockOf,
        setProblems,
        setJsonldStatus,
        reportJsonError,
        downloadText,
        setHintProvider,
        setSourceResolver,
        onTextChange,
        cursorContext,
        setFormat,
        getFormat,
        setTurtleSubjectResolver,
        insertTurtlePrefix,
        refresh: () => { if (cm) cm.refresh(); },
        // DOM elements for wiring
        jsonldEditorToggle,
        openJsonldEditorBtn,
        editNodeJsonldBtn,
        jsonldApplyBtn,
        jsonldDownloadBtn,
        jsonldAutoApplyBtn,
    };
}
