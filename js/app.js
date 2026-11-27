/* ==============================================
   JSON-LD Graph Visualization — App Entry Point
   ==============================================

   Owns the document state (text → parsed JSON → JsonLd model → graph data)
   and the editing API the workbench, tools and quick fixes use. Every edit is
   a text replacement in CodeMirror, so Ctrl+Z undoes it.
*/

(async function main() {
    const AUTOSAVE_KEY = "jsonld-editor:autosave";
    const container = document.getElementById("sigma-container");

    if (typeof graphology === "undefined" || typeof Sigma === "undefined") {
        container.innerHTML = '<p class="fatal">Error: the graph libraries (graphology / Sigma.js) failed to load. Check your connection.</p>';
        return;
    }

    // ── State ────────────────────────────────
    const state = {
        text: "",
        doc: null,
        model: null,
        graphData: null,
        fileName: "document.jsonld",
        view: "instances",
        showExternal: false,
        showTypeLinks: false,
        keyStyle: "curie",
        legacyValidation: {},
        shaclResults: null,
        problems: [],
        lastGoodText: null,
    };

    // ── Optional legacy validation results ──
    try {
        const valResponse = await fetch("data/validation_results.json");
        if (valResponse.ok) state.legacyValidation = buildLegacyValidationLookup(await valResponse.json());
    } catch (_) {
        // Optional file.
    }

    // ── Sigma renderers ──────────────────────

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    function drawLabel(context, data, settings) {
        if (!data.label) return;
        const fontSize = settings.labelSize || 12;
        const styles = getComputedStyle(document.documentElement);
        const fontColor = styles.getPropertyValue("--text-primary").trim() || "#1e293b";
        const typeColor = data.color || "#64748b";
        const { x, y, size } = data;
        const font = settings.labelFont || "sans-serif";

        if (data.external) {
            context.save();
            context.setLineDash([3, 3]);
            context.strokeStyle = typeColor;
            context.lineWidth = 1.5;
            context.beginPath();
            context.arc(x, y, size + 3, 0, Math.PI * 2);
            context.stroke();
            context.restore();
        }

        // Type badge above the node (skipped for external IRIs).
        if (!data.external && data.nodeType) {
            const badgeFontSize = Math.max(8, fontSize - 3);
            context.font = `bold ${badgeFontSize}px ${font}`;
            const text = data.nodeType.length > 28 ? data.nodeType.slice(0, 27) + "…" : data.nodeType;
            const badgeWidth = context.measureText(text).width + 8;
            const badgeHeight = badgeFontSize + 4;
            const badgeY = y - size - badgeHeight - 4;
            context.fillStyle = typeColor + "30";
            context.strokeStyle = typeColor;
            context.lineWidth = 1;
            roundRect(context, x - badgeWidth / 2, badgeY, badgeWidth, badgeHeight, 3);
            context.fill();
            context.stroke();
            context.fillStyle = typeColor;
            context.textAlign = "center";
            context.textBaseline = "middle";
            context.fillText(text, x, badgeY + badgeHeight / 2);
        }

        // Main label below the node.
        context.font = `${settings.labelWeight || "normal"} ${fontSize}px ${font}`;
        context.textAlign = "center";
        context.textBaseline = "top";
        let displayLabel = String(data.label);
        const maxWidth = 140;
        if (context.measureText(displayLabel).width > maxWidth) {
            while (context.measureText(displayLabel + "…").width > maxWidth && displayLabel.length > 0) displayLabel = displayLabel.slice(0, -1);
            displayLabel += "…";
        }
        const labelWidth = context.measureText(displayLabel).width;
        context.fillStyle = styles.getPropertyValue("--label-bg").trim() || "rgba(255,255,255,0.85)";
        context.fillRect(x - labelWidth / 2 - 3, y + size + 3, labelWidth + 6, fontSize + 4);
        context.fillStyle = data.external ? (styles.getPropertyValue("--text-secondary").trim() || fontColor) : fontColor;
        context.fillText(displayLabel, x, y + size + 5);

        // Badges: invalid IRI, validation.
        const badge = (bx, by, fill, glyph) => {
            const r = Math.max(4, size * 0.3);
            context.beginPath();
            context.arc(bx, by, r, 0, 2 * Math.PI);
            context.fillStyle = fill;
            context.fill();
            context.strokeStyle = styles.getPropertyValue("--badge-stroke").trim() || "white";
            context.lineWidth = 1.5;
            context.stroke();
            context.fillStyle = "white";
            context.font = `bold ${Math.max(6, r)}px sans-serif`;
            context.textAlign = "center";
            context.textBaseline = "middle";
            context.fillText(glyph, bx, by);
        };
        if (data.invalidId) badge(x - size * 0.7, y - size * 0.7, "#ef4444", "!");
        const v = data.validation;
        if (v !== undefined && v !== null) badge(x + size * 0.7, y - size * 0.7, v.ok ? "#22c55e" : "#ef4444", v.ok ? "✓" : "✗");
    }

    function drawHover(context, data, settings) {
        const styles = getComputedStyle(document.documentElement);
        const hoverBg = styles.getPropertyValue("--label-bg").trim() || "rgba(255,255,255,0.85)";
        const fontColor = styles.getPropertyValue("--text-primary").trim() || "#1e293b";
        const borderColor = data.color || "#64748b";
        const fontSize = (settings.labelSize || 12) + 2;
        const label = String(data.label || "");
        const nodeType = data.nodeType || "";
        const { x, y, size } = data;
        const font = settings.labelFont || "sans-serif";
        context.font = `bold ${fontSize}px ${font}`;
        const boxWidth = Math.max(context.measureText(label).width, context.measureText(nodeType).width) + 20;
        const boxHeight = fontSize * 2.8;
        const boxX = x + size + 4;
        const boxY = y - boxHeight / 2;
        roundRect(context, boxX, boxY, boxWidth, boxHeight, 6);
        context.fillStyle = hoverBg;
        context.fill();
        context.strokeStyle = borderColor;
        context.lineWidth = 1.5;
        context.stroke();
        context.font = `bold ${fontSize - 2}px ${font}`;
        context.fillStyle = borderColor;
        context.textAlign = "left";
        context.textBaseline = "top";
        context.fillText(nodeType, boxX + 10, boxY + 6);
        context.font = `${fontSize}px ${font}`;
        context.fillStyle = fontColor;
        context.textBaseline = "bottom";
        context.fillText(label, boxX + 10, boxY + boxHeight - 6);
    }

    const graph = new graphology.Graph({ multi: true });
    const sigmaInstance = new Sigma(graph, container, {
        renderEdgeLabels: false,
        enableEdgeEvents: true,
        labelRenderedSizeThreshold: 0,
        labelDensity: 1,
        labelGridCellSize: 50,
        zIndex: true,
        minCameraRatio: 0.05,
        maxCameraRatio: 20,
        zoomingRatio: 1.2,
        defaultEdgeType: "arrow",
        stagePadding: 60,
        // Side panels can squeeze the graph to zero width; don't throw when they do.
        allowInvalidContainer: true,
        labelRenderer: drawLabel,
        hoverRenderer: drawHover,
        labelFont: "sans-serif",
        labelSize: 11,
        labelWeight: "normal",
        labelColor: { color: "#1e293b" },
        edgeLabelSize: 10,
    });

    // Sigma only tracks window resizes; panels opening/closing resize the container too.
    if (typeof ResizeObserver !== "undefined") {
        let resizeFrame = null;
        new ResizeObserver(() => {
            cancelAnimationFrame(resizeFrame);
            resizeFrame = requestAnimationFrame(() => {
                if (container.offsetWidth > 0 && container.offsetHeight > 0) {
                    sigmaInstance.resize();
                    sigmaInstance.refresh();
                }
            });
        }).observe(container);
    }

    // ── Modules ──────────────────────────────
    const layoutManager = createLayouts(graph, sigmaInstance);
    const editor = createEditor();
    const ui = createUI(graph, sigmaInstance, layoutManager, editor);
    const vocab = createVocabulary();

    // ── Notifications ────────────────────────
    const toast = document.getElementById("toast");
    let toastTimer = null;
    function notify(message, level = "info") {
        toast.textContent = message;
        toast.className = `visible ${level}`;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toast.className = ""; }, level === "error" ? 9000 : 5000);
        editor.setJsonldStatus(message, level === "info" ? "info" : level);
    }
    toast.addEventListener("click", () => { toast.className = ""; });

    // ── Helpers ──────────────────────────────

    function detectIndent(text) {
        const m = /\n( +)"/.exec(text);
        return m ? Math.min(8, m[1].length) : 2;
    }

    function detectKeyStyle(model) {
        let curie = 0;
        let alias = 0;
        model.nodes.forEach(node => node.rawKeys.forEach(raw => {
            if (raw.startsWith("@")) return;
            if (raw.includes(":")) curie += 1; else alias += 1;
        }));
        return alias > curie * 2 ? "alias" : "curie";
    }

    function documentPrefixes() {
        if (!state.model) return {};
        const out = {};
        JsonLd.prefixesOf(state.model.context).forEach(p => { out[p.prefix] = p.namespace; });
        return out;
    }

    function textForEngine() {
        return state.text;
    }

    function hasOntologyTerms(model) {
        let found = false;
        model.nodes.forEach(node => {
            if (!found && node.types.some(t => ONTOLOGY_TYPE_STYLE[t] && ["class", "property"].includes(ONTOLOGY_TYPE_STYLE[t].kind))) found = true;
        });
        return found;
    }

    // ── Apply text ───────────────────────────

    let autosaveTimer = null;
    function autosave() {
        clearTimeout(autosaveTimer);
        autosaveTimer = setTimeout(() => {
            try {
                if (state.text.length < 4_000_000) localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ text: state.text, name: state.fileName, savedAt: new Date().toISOString() }));
            } catch (_) { /* storage blocked or full */ }
        }, 800);
    }

    function buildGraphData(viewOverride) {
        const describeIri = iri => {
            const t = vocab.describe(iri);
            return t ? { label: t.label, comment: t.comment, vocab: t.vocabTitle } : null;
        };
        if ((viewOverride || state.view) === "schema") return buildSchemaGraphData(state.model, { describeIri });
        return buildGraphDataFromModel(state.model, state.legacyValidation, {
            showExternal: state.showExternal,
            showTypeLinks: state.showTypeLinks,
            describeIri,
            shaclResults: state.shaclResults,
        });
    }

    function render(opts = {}) {
        state.graphData = buildGraphData();
        const big = state.graphData.nodes.length > 250;
        sigmaInstance.setSetting("renderEdgeLabels", (state.view === "schema" && !big) || state.graphData.edges.length <= 30);
        sigmaInstance.setSetting("labelDensity", big ? 0.35 : 1);
        sigmaInstance.setSetting("labelRenderedSizeThreshold", big ? 9 : 0);
        ui.applyGraphData(state.graphData, null, { keepPositions: opts.keepPositions });
        updateViewLabel();
        if (diagram && diagram.isActive()) diagram.render({ keepView: opts.keepPositions, keepPositions: opts.keepPositions });
    }

    function updateViewLabel() {
        const base = state.view === "schema" ? "Schema view (classes & shapes)" : "Instance view";
        document.getElementById("view-label").textContent = diagram && diagram.isActive() ? `${base} · box diagram` : base;
    }

    function relint() {
        if (!state.model) return;
        state.problems = lintModel(state.model, vocab);
        tools.setProblems(state.problems);
        if (editor.getFormat() === "ttl") { editor.setProblems([]); return; }
        const marks = [];
        state.problems.forEach(p => {
            let line = -1;
            if (p.find) {
                const raw = JSON.parse(p.find);
                const lines = editor.linesOf(raw);
                line = lines.length ? lines[0] : editor.lineOf(p.find);
            }
            if (line < 0 && p.nodeId) {
                const node = state.model.nodes.get(p.nodeId);
                if (node && node.rawId) { const l = editor.linesOf(node.rawId); line = l.length ? l[0] : -1; }
            }
            p.line = line;
            if (line >= 0 && p.severity !== "info") marks.push({ line, severity: p.severity, message: p.message });
        });
        editor.setProblems(marks);
    }

    /** Parse and render the given text. Returns false (and reports) on invalid JSON. */
    function applyText(text, opts = {}) {
        let doc;
        try {
            doc = JSON.parse(text);
        } catch (err) {
            editor.reportJsonError(text, err);
            return false;
        }
        state.text = text;
        state.doc = doc;
        state.model = JsonLd.buildModel(doc);
        state.keyStyle = detectKeyStyle(state.model);
        if (opts.fresh) {
            state.shaclResults = null;
            const onto = hasOntologyTerms(state.model);
            state.showExternal = onto;
            document.getElementById("toggle-external").classList.toggle("active", state.showExternal);
        }
        Rete.invalidate();
        vocab.setDocumentModel(state.model);
        render({ keepPositions: !opts.fresh });
        relint();
        if (!opts.quiet) {
            const md = state.graphData.metadata;
            const errs = state.problems.filter(p => p.severity === "error").length;
            editor.setJsonldStatus(`Applied: ${state.model.nodes.size} nodes, ${md.edgeCount} links${errs ? ` · ${errs} error${errs === 1 ? "" : "s"} in Problems` : ""}.`, errs ? "warning" : "success");
        }
        if (workbench) workbench.onDocumentChanged();
        state.lastGoodText = text;
        autosave();
        return true;
    }

    function loadText(text, name, opts = {}) {
        state.fileName = name || state.fileName;
        document.getElementById("doc-name").textContent = state.fileName;
        document.title = `${state.fileName} — JSON-LD Explorer`;
        if (editor.getFormat() === "ttl") {
            editor.setFormat("jsonld", text);
            document.getElementById("jsonld-editor-title").textContent = "Source";
        } else {
            editor.setText(text, { keepPosition: false, silent: true });
        }
        const ok = applyText(text, { fresh: true });
        if (ok) {
            layoutManager.applyLayout("force");
            setTimeout(() => sigmaInstance.getCamera().animatedReset({ duration: 300 }), 50);
        } else {
            editor.openJsonldEditor(sigmaInstance, null, null);
        }
        return ok;
    }

    // ── Mutations ────────────────────────────

    function createWriter(root) {
        let doc = Array.isArray(root) ? { "@graph": root } : root;
        let processed = null;
        const recompute = () => {
            processed = JsonLd.processContext(JsonLd.emptyContext(), doc["@context"] === undefined ? {} : doc["@context"], []);
        };
        recompute();
        const addPrefix = (prefix, ns) => {
            const ctx = JsonLd.ensureContextObject(doc);
            if (ctx[prefix] === ns) return prefix;
            const existing = Object.entries(ctx).find(([, v]) => v === ns);
            if (existing) return existing[0];
            let p = prefix;
            let n = 2;
            while (ctx[p] !== undefined && ctx[p] !== ns) p = `${prefix}${n++}`;
            ctx[p] = ns;
            recompute();
            return p;
        };
        const ensurePrefixFor = iri => {
            if (!JsonLd.isAbsoluteIri(iri)) return;
            const c = JsonLd.compactIri(processed, iri, { vocab: true, preferCurie: true });
            if (c !== iri) return;
            const s = vocab.suggestPrefix(iri);
            if (s && iri.startsWith(s[1])) addPrefix(s[0], s[1]);
        };
        const writer = {
            get root() { return doc; },
            context: () => processed,
            addPrefix,
            key(iri) {
                ensurePrefixFor(iri);
                return JsonLd.compactIri(processed, iri, { vocab: true, preferCurie: state.keyStyle === "curie" });
            },
            id(iri) {
                ensurePrefixFor(iri);
                return JsonLd.compactIri(processed, iri);
            },
            ref(iri) { return { "@id": writer.id(iri) }; },
            refs(list) {
                const out = list.map(i => writer.ref(i));
                return out.length === 1 ? out[0] : out;
            },
            graph() {
                const r = JsonLd.ensureGraphArray(doc);
                doc = r.doc;
                return r.graph;
            },
            findNode(nodeId) {
                const hit = JsonLd.findRawNodes(doc, nodeId)[0];
                return hit ? hit.object : null;
            },
        };
        return writer;
    }

    /**
     * Apply a structural edit: fn(writer) changes writer.root (or returns false
     * to cancel). The document is re-serialised; Ctrl+Z in the editor undoes it.
     */
    function mutate(fn, opts = {}) {
        const turtle = editor.getFormat() === "ttl";
        const text = turtle ? state.text : editor.getJsonldText();
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            editor.reportJsonError(text, err);
            editor.openJsonldEditor(sigmaInstance, null, null);
            notify("Fix the JSON syntax errors in the editor first.", "error");
            return false;
        }
        const writer = createWriter(parsed);
        const result = fn(writer);
        if (result === false) return false;
        const newText = JSON.stringify(writer.root, null, detectIndent(text)) + "\n";
        const orderBefore = graph.order;
        if (!turtle) editor.setText(newText, { silent: true });
        if (!applyText(newText, { quiet: true })) return false;
        if (turtle) refreshTurtleView();
        // New nodes move the layout: fit the view instead of keeping a stale zoom.
        if (graph.order > orderBefore) sigmaInstance.getCamera().animatedReset({ duration: 300 });
        if (opts.select && graph.hasNode(opts.select)) ui.selectNode(opts.select);
        if (opts.reveal) {
            editor.openJsonldEditor(sigmaInstance, null, null);
            setTimeout(() => {
                if (opts.select) editor.highlightSourceForNode(opts.select, true, true);
                if (opts.revealText) editor.findText(opts.revealText, true, opts.select ? undefined : 0);
            }, 380);
        }
        if (opts.message) notify(opts.message, "success");
        return true;
    }

    function nodeExists(iri) {
        const node = state.model && state.model.nodes.get(iri);
        return Boolean(node && node.definitions > 0);
    }

    function addValue(obj, key, value) {
        if (obj[key] === undefined) { obj[key] = value; return; }
        const list = Array.isArray(obj[key]) ? obj[key] : [obj[key]];
        const same = v => JSON.stringify(v) === JSON.stringify(value);
        if (!list.some(same)) list.push(value);
        obj[key] = list.length === 1 ? list[0] : list;
    }

    // ── Editing API ──────────────────────────

    function addPrefix(prefix, namespace) {
        const ctx = state.model ? state.model.context : null;
        if (ctx && ctx.terms[prefix] && ctx.terms[prefix].id === namespace) { notify(`${prefix}: is already defined.`, "info"); return true; }
        if (ctx && ctx.terms[prefix] && ctx.terms[prefix].id !== namespace) {
            notify(`"${prefix}" is already defined as ${ctx.terms[prefix].id}.`, "warning");
            return false;
        }
        // Prefer a targeted text insertion (keeps formatting); fall back to a structural edit.
        if (editor.getFormat() !== "ttl" && editor.insertIntoContext(`${JSON.stringify(prefix)}: ${JSON.stringify(namespace)}`)) {
            const text = editor.getJsonldText();
            if (applyText(text, { quiet: true })) { notify(`Added prefix ${prefix}: <${namespace}>.`, "success"); return true; }
        }
        return mutate(w => { w.addPrefix(prefix, namespace); }, { message: `Added prefix ${prefix}: <${namespace}>.` });
    }

    function insertTerm(iri) {
        if (!state.model) return;
        editor.openJsonldEditor(sigmaInstance, null, null);
        if (editor.getFormat() === "ttl") {
            const s = vocab.suggestPrefix(iri);
            let token = `<${iri}>`;
            if (s && iri.startsWith(s[1]) && /^[\w.\-]+$/.test(iri.slice(s[1].length))) {
                if (editor.insertTurtlePrefix(s[0], s[1])) notify(`Added @prefix ${s[0]}:.`, "info");
                token = `${s[0]}:${iri.slice(s[1].length)}`;
            }
            setTimeout(() => editor.insertAtCursor(token), 360);
            return;
        }
        let curie = JsonLd.compactIri(state.model.context, iri, { vocab: true, preferCurie: state.keyStyle === "curie" });
        if (curie === iri) {
            const s = vocab.suggestPrefix(iri);
            if (s && iri.startsWith(s[1]) && !state.model.context.terms[s[0]]) {
                if (editor.insertIntoContext(`${JSON.stringify(s[0])}: ${JSON.stringify(s[1])}`)) {
                    curie = `${s[0]}:${iri.slice(s[1].length)}`;
                    notify(`Added prefix ${s[0]}: to @context.`, "info");
                }
            }
        }
        setTimeout(() => {
            const ctx = editor.cursorContext();
            editor.insertAtCursor(ctx && ctx.inString ? curie : JSON.stringify(curie));
        }, 360);
    }

    function addTypeToNode(nodeId, classIri) {
        return mutate(w => {
            const obj = w.findNode(nodeId);
            if (!obj) { notify("That node is not described in the document.", "warning"); return false; }
            const t = w.key(classIri);
            const typeKey = Object.keys(obj).find(k => k === "@type" || (state.model.context.terms[k] && state.model.context.terms[k].id === "@type")) || "@type";
            const current = obj[typeKey] === undefined ? [] : (Array.isArray(obj[typeKey]) ? obj[typeKey] : [obj[typeKey]]);
            if (current.includes(t)) return false;
            current.push(t);
            obj[typeKey] = current.length === 1 ? current[0] : current;
            return true;
        }, { select: nodeId, message: `Added type ${JsonLd.compactIri(state.model.context, classIri, { vocab: true })}.` });
    }

    function addPropertyToNode(nodeId, propIri, term) {
        let keyWritten = null;
        const ok = mutate(w => {
            const obj = w.findNode(nodeId);
            if (!obj) { notify("That node is not described in the document.", "warning"); return false; }
            const key = w.key(propIri);
            keyWritten = key;
            if (obj[key] !== undefined) { notify(`${key} is already set on this node — edit it in the JSON-LD.`, "info"); return true; }
            const isObject = term && term.kind === "O";
            obj[key] = isObject ? { "@id": "" } : "";
            return true;
        }, { select: nodeId });
        if (ok && keyWritten) {
            editor.openJsonldEditor(sigmaInstance, null, null);
            setTimeout(() => {
                editor.highlightSourceForNode(nodeId, true, true);
                const block = editor.blockOf(nodeId);
                editor.findText(`${JSON.stringify(keyWritten)}:`, true, block ? block.startLine : 0);
            }, 380);
            notify(`Added ${keyWritten} — type its value in the editor.`, "success");
        }
        return ok;
    }

    /** Usage of a property/class in the document, for pre-filling declarations. */
    function inferUsage(iri) {
        const subjectTypes = new Map();
        const targetTypes = new Map();
        const datatypes = new Map();
        let literal = 0;
        let refs = 0;
        const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
        state.model.nodes.forEach(node => {
            const values = node.props.get(iri);
            if (!values) return;
            node.types.forEach(t => inc(subjectTypes, t));
            values.forEach(v => {
                const target = v.kind === "iri" ? v.iri : v.linksTo;
                if (target) {
                    refs += 1;
                    const tn = state.model.nodes.get(target);
                    if (tn) tn.types.forEach(t => inc(targetTypes, t));
                } else if (v.kind === "literal") {
                    literal += 1;
                    inc(datatypes, v.datatype || JsonLd.XSD + "string");
                }
            });
        });
        const top = (m, n = 2) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
        return {
            kind: literal >= refs ? "D" : "O",
            domain: top(subjectTypes),
            range: literal >= refs ? top(datatypes, 1) : top(targetTypes),
        };
    }

    function humanise(local, upper) {
        const words = splitCamel(local);
        return upper ? words.charAt(0).toUpperCase() + words.slice(1) : words;
    }

    /** Declare a term: library/remote terms are declared directly; terms of the document go through Create. */
    function declareTerm(term) {
        const known = vocab.vocabularyFor(term.iri);
        const isLibrary = term.vocab && term.vocab !== "document" && known && term.iri.startsWith(known.namespace);
        const kind = term.kind || "C";
        if (!isLibrary && !term.remoteSource) {
            const ns = JsonLd.namespaceOf(term.iri);
            const local = term.iri.slice(ns.length);
            const usage = kind === "C" ? null : inferUsage(term.iri);
            workbench.createTerm({
                kind: kind === "C" ? "C" : usage.kind,
                label: humanise(local, kind === "C"),
                local,
                namespace: ns,
                domain: usage ? usage.domain : undefined,
                range: usage ? usage.range : undefined,
            });
            notify(`Fill in the declaration of ${JsonLd.compactIri(state.model.context, term.iri)} and click Create.`, "info");
            return;
        }
        if (nodeExists(term.iri)) {
            ui.selectNode(term.iri);
            notify(`${JsonLd.compactIri(state.model.context, term.iri)} is already declared in this document.`, "info");
            return;
        }
        const typeIri = { C: "http://www.w3.org/2002/07/owl#Class", O: "http://www.w3.org/2002/07/owl#ObjectProperty", D: "http://www.w3.org/2002/07/owl#DatatypeProperty", A: "http://www.w3.org/2002/07/owl#AnnotationProperty", P: "http://www.w3.org/1999/02/22-rdf-syntax-ns#Property", T: "http://www.w3.org/2000/01/rdf-schema#Datatype", I: "http://www.w3.org/2002/07/owl#NamedIndividual" }[kind];
        mutate(w => {
            const node = { "@id": w.id(term.iri), "@type": w.key(typeIri) };
            if (term.label) node[w.key(SCHEMA_PREDICATES.label)] = term.label;
            if (term.comment) node[w.key(SCHEMA_PREDICATES.comment)] = term.comment;
            const definedBy = known ? known.namespace : (term.homepage || null);
            if (definedBy) node[w.key(SCHEMA_PREDICATES.isDefinedBy)] = { "@id": definedBy };
            w.graph().push(node);
            return true;
        }, { select: term.iri, message: `Declared ${JsonLd.compactIri(state.model.context, term.iri)} (reused from ${known ? known.title : term.remoteSource}).` });
    }

    function createTerm(spec) {
        if (nodeExists(spec.iri)) {
            notify(`${JsonLd.compactIri(state.model.context, spec.iri)} already exists in this document.`, "warning");
            ui.selectNode(spec.iri);
            return false;
        }
        const OWL = "http://www.w3.org/2002/07/owl#";
        const ok = mutate(w => {
            if (spec.namespace && spec.namespace === DEFAULT_NAMESPACE && !JsonLd.prefixesOf(w.context()).some(p => p.namespace === DEFAULT_NAMESPACE)) {
                w.addPrefix("ex", DEFAULT_NAMESPACE);
            }
            const node = { "@id": w.id(spec.iri) };
            if (spec.kind === "C") {
                node["@type"] = w.key(OWL + "Class");
            } else if (spec.kind === "O" || spec.kind === "D") {
                const types = [w.key(OWL + (spec.kind === "O" ? "ObjectProperty" : "DatatypeProperty"))];
                if (spec.functional) types.push(w.key(OWL + "FunctionalProperty"));
                node["@type"] = types.length === 1 ? types[0] : types;
            } else if (spec.kind === "I") {
                const types = spec.types.length ? spec.types.map(t => w.key(t)) : [w.key(OWL + "NamedIndividual")];
                node["@type"] = types.length === 1 ? types[0] : types;
            }
            const labelProps = spec.kind === "I" ? (spec.properties || []).filter(p => /(#|\/)(name|label|title|prefLabel)$/.test(p)) : [];
            if (spec.label) {
                if (spec.kind === "I" && labelProps.length) node[w.key(labelProps[0])] = spec.label;
                else node[w.key(SCHEMA_PREDICATES.label)] = spec.label;
            }
            if (spec.comment) node[w.key(spec.kind === "I" ? SCHEMA_PREDICATES.comment : SCHEMA_PREDICATES.comment)] = spec.comment;
            if (spec.kind === "C") {
                if (spec.super && spec.super.length) node[w.key(SCHEMA_PREDICATES.subClassOf)] = w.refs(spec.super);
                if (spec.equivalent && spec.equivalent.length) node[w.key(SCHEMA_PREDICATES.equivalentClass)] = w.refs(spec.equivalent);
            }
            if (spec.kind === "O" || spec.kind === "D") {
                if (spec.domain && spec.domain.length) node[w.key(SCHEMA_PREDICATES.domain)] = w.refs(spec.domain);
                if (spec.range && spec.range.length) node[w.key(SCHEMA_PREDICATES.range)] = w.refs(spec.range);
                if (spec.superProp && spec.superProp.length) node[w.key(SCHEMA_PREDICATES.subPropertyOf)] = w.refs(spec.superProp);
                if (spec.inverse && spec.inverse.length) node[w.key(SCHEMA_PREDICATES.inverseOf)] = w.refs(spec.inverse);
            }
            if (spec.kind === "I") {
                (spec.properties || []).forEach(p => {
                    const key = w.key(p);
                    if (node[key] !== undefined) return;
                    const t = vocab.describe(p);
                    node[key] = t && t.kind === "O" ? { "@id": "" } : "";
                });
            }
            w.graph().push(node);
            return true;
        }, { select: spec.iri, reveal: spec.kind === "I", message: `Created ${JsonLd.compactIri(state.model.context, spec.iri) || spec.iri}.` });
        return ok;
    }

    function createOntologyHeader(o) {
        if (!o.iri || !JsonLd.isAbsoluteIri(o.iri)) { notify("The ontology needs an absolute IRI.", "warning"); return false; }
        if (nodeExists(o.iri)) { ui.selectNode(o.iri); notify("This document already describes that ontology.", "info"); return false; }
        const DCT = "http://purl.org/dc/terms/";
        const VANN = "http://purl.org/vocab/vann/";
        return mutate(w => {
            if (o.prefix && o.namespace) w.addPrefix(o.prefix, o.namespace);
            ["dcterms", "vann", "owl"].forEach(p => w.addPrefix(p, COMMON_PREFIXES[p]));
            const node = { "@id": w.id(o.iri), "@type": w.key("http://www.w3.org/2002/07/owl#Ontology") };
            if (o.title) node[w.key(DCT + "title")] = o.title;
            if (o.description) node[w.key(DCT + "description")] = o.description;
            if (o.version) node[w.key("http://www.w3.org/2002/07/owl#versionInfo")] = o.version;
            if (o.license) node[w.key(DCT + "license")] = /^https?:\/\//.test(o.license) ? { "@id": o.license } : o.license;
            if (o.creator) node[w.key(DCT + "creator")] = o.creator;
            if (o.prefix) node[w.key(VANN + "preferredNamespacePrefix")] = o.prefix;
            if (o.namespace) node[w.key(VANN + "preferredNamespaceUri")] = o.namespace;
            w.graph().unshift(node);
            return true;
        }, { select: o.iri, message: "Added the ontology header." });
    }

    function replaceTerm(from, to) {
        return mutate(w => {
            const ctx = w.context();
            let count = 0;
            const toKey = w.key(to);
            const walk = value => {
                if (Array.isArray(value)) { value.forEach(walk); return; }
                if (!value || typeof value !== "object") return;
                // Rename matching keys in place, keeping the key order.
                const keys = Object.keys(value);
                if (keys.some(k => k !== "@context" && !k.startsWith("@") && JsonLd.expandIri(ctx, k, { vocab: true }) === from)) {
                    const entries = keys.map(k => [k, value[k]]);
                    keys.forEach(k => delete value[k]);
                    entries.forEach(([k, v]) => {
                        const rename = k !== "@context" && !k.startsWith("@") && JsonLd.expandIri(ctx, k, { vocab: true }) === from;
                        if (rename) count += 1;
                        value[rename ? toKey : k] = v;
                    });
                }
                Object.keys(value).forEach(k => {
                    if (k === "@type") {
                        const list = Array.isArray(value[k]) ? value[k] : [value[k]];
                        const next = list.map(t => (typeof t === "string" && JsonLd.expandIri(ctx, t, { vocab: true }) === from ? (count += 1, toKey) : t));
                        value[k] = next.length === 1 ? next[0] : next;
                    }
                });
                Object.entries(value).forEach(([k, v]) => { if (k !== "@context") walk(v); });
            };
            walk(w.root);
            if (!count) { notify("Nothing to replace.", "info"); return false; }
            notify(`Replaced ${count} use${count === 1 ? "" : "s"} with ${toKey}.`, "success");
            return true;
        });
    }

    /**
     * Merge a JSON-LD fragment ({@context: prefixes, @graph: [...]}) into the
     * document: its prefixes are added, nodes with the same @id are replaced.
     * The fragment must be compacted with the document's prefixes (see
     * Rete.importRdf(…, app.getPrefixes())), so no prefix can clash.
     */
    function mergeDocument(fragment, message) {
        return mutate(w => {
            const fctx = fragment["@context"] || {};
            Object.entries(fctx).forEach(([p, ns]) => { if (typeof ns === "string") w.addPrefix(p, ns); });
            const g = w.graph();
            const ctx = w.context();
            const expand = id => (typeof id === "string" ? JsonLd.expandIri(ctx, id, { documentRelative: true }) : null);
            (fragment["@graph"] || []).forEach(node => {
                const id = expand(node["@id"]);
                const idx = id && !JsonLd.isBlankId(id) ? g.findIndex(n => n && expand(n["@id"]) === id) : -1;
                if (idx >= 0) g[idx] = node; else g.push(node);
            });
            return true;
        }, { message });
    }

    function coerceToId(key, predicate) {
        return mutate(w => {
            const ctx = JsonLd.ensureContextObject(w.root);
            const existing = ctx[key];
            if (existing && typeof existing === "object") existing["@type"] = "@id";
            else ctx[key] = { "@id": key.includes(":") ? key : JsonLd.compactIri(w.context(), predicate, { vocab: false }), "@type": "@id" };
            return true;
        }, { message: `"${key}" values are now read as links (@type: @id).` });
    }

    function runAction(action) {
        if (!action) return;
        switch (action.type) {
            case "add-prefix": addPrefix(action.prefix, action.namespace); break;
            case "coerce-id": coerceToId(action.key, action.predicate); break;
            case "find-terms": workbench.findTerms({ query: action.query, kind: action.kind }); break;
            case "declare-term": declareTerm({ iri: action.iri, kind: action.kind === "class" ? "C" : "P", vocab: "document" }); break;
            case "replace-term": replaceTerm(action.from, action.to); break;
            default: break;
        }
    }

    function revealProblem(p) {
        if (p.nodeId && graph.hasNode(p.nodeId)) {
            ui.selectNode(p.nodeId);
            ui.focusNode(p.nodeId);
        }
        editor.openJsonldEditor(sigmaInstance, null, null);
        setTimeout(() => {
            const turtle = editor.getFormat() === "ttl";
            if (p.nodeId && (turtle || !p.find)) editor.highlightSourceForNode(p.nodeId, true);
            else if (p.find) editor.findText(turtle ? JSON.parse(p.find) : p.find, true);
        }, 380);
    }

    function setShaclResults(map) {
        state.shaclResults = map;
        if (state.view !== "instances") setView("instances");
        else render({ keepPositions: true });
        ui.refreshDetails();
    }

    function setView(view) {
        if (state.view === view) return;
        state.view = view;
        document.getElementById("toggle-schema").classList.toggle("active", view === "schema");
        render({ keepPositions: false });
        layoutManager.applyLayout("force");
        setTimeout(() => sigmaInstance.getCamera().animatedReset({ duration: 300 }), 50);
    }

    function loadConstructResult(triples) {
        const doc = Rete.triplesToJsonld(triples, documentPrefixes());
        loadText(JSON.stringify(doc, null, 2) + "\n", state.fileName.replace(/(\.jsonld|\.json)?$/, "-extract.jsonld"));
        notify(`Opened ${triples.length} constructed triples. Ctrl+Z in the editor returns to the previous document.`, "success");
    }

    /** The diagram as Mermaid text for a view (default: the current one). */
    function mermaidText(view) {
        if (!state.model) return null;
        const data = !view || view === state.view ? state.graphData : buildGraphData(view);
        return diagram.toMermaid({ data, title: state.fileName });
    }

    /** Download the diagram as .mmd, or as Markdown with a mermaid block (.md). */
    function exportMermaid(format = "mmd", view) {
        const text = mermaidText(view);
        if (!text) { notify("Nothing to export: the diagram is empty.", "warning"); return null; }
        const base = state.fileName.replace(/\.(jsonld|json|ttl|nt|nq|rete)$/i, "");
        const v = view || state.view;
        const name = `${base}-${v === "schema" ? "schema" : "graph"}`;
        if (format === "md") {
            const fence = "```";
            const md = `# ${state.fileName} — ${v === "schema" ? "schema" : "graph"}\n\n${fence}mermaid\n${text}${fence}\n`;
            download(md, `${name}.md`, "text/markdown");
            notify(`Downloaded ${name}.md — GitHub and many Markdown viewers render the diagram.`, "success");
            return `${name}.md`;
        }
        download(text, `${name}.mmd`, "text/plain");
        notify(`Downloaded ${name}.mmd — open it in mermaid.live or any Mermaid renderer.`, "success");
        return `${name}.mmd`;
    }

    function download(data, fileName, mime) {
        editor.downloadText(data instanceof Blob ? data : new Blob([data], { type: `${mime || "application/octet-stream"};charset=utf-8` }), fileName, mime);
    }

    // ── Turtle source mode ───────────────────
    // The document stays JSON-LD (state.text). The Turtle view is generated by
    // rete; edits to it are parsed by rete and applied back as JSON-LD.

    function turtlePrefixes(ttl) {
        const out = {};
        const re = /@prefix\s+([A-Za-z][\w.\-]*|):\s*<([^>]*)>/g;
        let m;
        while ((m = re.exec(ttl))) if (m[1]) out[m[1]] = m[2];
        return out;
    }

    async function refreshTurtleView() {
        try {
            const out = await Rete.exportDocument(textForEngine(), "ttl", { prefixes: documentPrefixes() });
            editor.setFormat("ttl", out.data);
            return true;
        } catch (err) {
            notify(`Could not show Turtle: ${err.message}`, "error");
            return false;
        }
    }

    let turtleWarned = false;
    async function setSourceFormat(fmt) {
        if (fmt === editor.getFormat()) return;
        if (fmt === "ttl") {
            // Make sure the latest JSON edits are applied before converting.
            const current = editor.getJsonldText();
            if (current !== state.text && !applyText(current, { quiet: true })) {
                notify("Fix the JSON syntax errors before switching to Turtle.", "error");
                return;
            }
            editor.setJsonldStatus(Rete.getState() === "ready" ? "Converting to Turtle…" : "Loading the rete engine…", "info");
            if (await refreshTurtleView()) {
                document.getElementById("jsonld-editor-title").textContent = "Source";
                editor.setJsonldStatus("Turtle view. Edits are parsed by rete and applied as JSON-LD (Live or Ctrl+Enter).", "info");
                if (!turtleWarned) {
                    notify("Editing Turtle regenerates the JSON-LD from the triples: prefixes are kept, term aliases and key order are not.", "info");
                    turtleWarned = true;
                }
            }
        } else {
            editor.setFormat("jsonld", state.text);
            editor.setJsonldStatus("JSON-LD view.", "info");
            relint();
        }
    }

    let turtleToken = 0;
    async function applyTurtle(ttl) {
        const token = ++turtleToken;
        try {
            const prefixes = Object.assign({}, documentPrefixes(), turtlePrefixes(ttl));
            const result = await Rete.importRdf(ttl, "ttl", prefixes);
            if (token !== turtleToken) return false;
            const json = JSON.stringify(result.doc, null, 2) + "\n";
            const ok = applyText(json, { quiet: true });
            if (ok) editor.setJsonldStatus(`Applied Turtle: ${result.triples} triples → ${state.model.nodes.size} nodes.`, "success");
            return ok;
        } catch (err) {
            if (token === turtleToken) editor.setJsonldStatus(`Turtle: ${err.message}`, "error");
            return false;
        }
    }

    document.querySelectorAll(".fmt-btn").forEach(btn => btn.addEventListener("click", () => setSourceFormat(btn.dataset.fmt)));

    editor.setTurtleSubjectResolver(nodeId => {
        const forms = [`<${nodeId}>`];
        if (JsonLd.isBlankId(nodeId)) forms.push(nodeId);
        Object.entries(turtlePrefixes(editor.getJsonldText())).forEach(([p, ns]) => {
            if (nodeId.startsWith(ns) && /^[\w.\-]*$/.test(nodeId.slice(ns.length))) forms.push(`${p}:${nodeId.slice(ns.length)}`);
        });
        return forms;
    });

    // ── App API for modules ──────────────────
    let workbench = null;
    let diagram = null;
    const app = {
        vocab,
        ui,
        notify,
        getModel: () => state.model,
        getText: () => (editor.getFormat() === "ttl" ? state.text : editor.getJsonldText()),
        getTextForEngine: textForEngine,
        getFileName: () => state.fileName,
        getPrefixes: documentPrefixes,
        getView: () => state.view,
        getSelectedNode: () => ui.getSelectedNode(),
        hasNode: id => graph.hasNode(id),
        selectNode: (id, opts = {}) => {
            if (!graph.hasNode(id)) return;
            ui.selectNode(id, { additive: Boolean(opts.additive) });
            if (opts.additive) return;
            if (opts.focus !== false) {
                ui.focusNode(id);
                if (diagram && diagram.isActive()) diagram.focusOn(id);
            }
        },
        clearSelection: () => ui.clearSelection(),
        getSelectedNodes: () => ui.getSelectedNodes(),
        getGraphData: () => state.graphData,
        revealInEditor: id => {
            editor.openJsonldEditor(sigmaInstance, null, null);
            setTimeout(() => editor.highlightSourceForNode(id, true), 380);
        },
        refreshGraph: () => sigmaInstance.refresh(),
        loadText,
        mutate,
        relint,
        addPrefix,
        insertTerm,
        addTypeToNode,
        addPropertyToNode,
        declareTerm,
        createTerm,
        createOntologyHeader,
        runAction,
        revealProblem,
        setShaclResults,
        setView,
        loadConstructResult,
        download,
        mergeDocument,
        mermaidText,
        exportMermaid,
        getEditorFormat: () => editor.getFormat(),
        getProblems: () => state.problems,
        setDiagram: on => setDiagram(on),
        isDiagram: () => Boolean(diagram && diagram.isActive()),
    };

    const tools = createTools(app);
    workbench = createWorkbench(app);
    const io = createIO(app);
    diagram = createDiagram(app, graph);
    app.tools = tools;
    app.io = io;
    ui.onSelectionChange((id, ids) => diagram.onSelection(id, ids));
    ui.onFiltersChange(() => { if (diagram.isActive()) diagram.render({ keepView: true }); });

    // Tools for in-browser AI agents (WebMCP): see js/webmcp.js.
    const agents = createAgentTools(app);
    ui.setToolTabs(tools.tabs.concat([agents.tab]));

    function setDiagram(on) {
        if (on === diagram.isActive()) return;
        document.getElementById("toggle-diagram").classList.toggle("active", on);
        diagram.setActive(on);
        updateViewLabel();
    }

    // ── Node actions (details panel) ─────────
    ui.setNodeActions((nodeId, attrs) => {
        const actions = [];
        const node = state.model && state.model.nodes.get(nodeId);
        if (state.view === "schema") {
            actions.push({ id: "props-for-class", label: "Properties", title: "Find properties that apply to this class" });
            actions.push({ id: "subclass", label: "Subclass…", title: "Create a subclass" });
            actions.push({ id: "instance", label: "New instance…", title: "Create an instance of this class" });
            if (!attrs.external) return actions;
            actions.push({ id: "declare", label: "Declare", title: "Declare this reused class in the document" });
            return actions;
        }
        if (attrs.external) {
            const t = vocab.describe(nodeId);
            actions.push({ id: "declare", label: "Declare", title: "Add a declaration of this term to the document" });
            if (t && t.kind === "C") actions.push({ id: "subclass", label: "Subclass…" });
            return actions;
        }
        if (node && node.definitions > 0) {
            actions.push({ id: "add-property", label: "Add property", title: "Find properties for this node's type and add one" });
            actions.push({ id: "add-type", label: "Add type", title: "Find a class to add as @type" });
        }
        if (node && node.types.some(t => t.endsWith("#Class"))) {
            actions.push({ id: "subclass", label: "Subclass…" });
            actions.push({ id: "instance", label: "New instance…" });
        }
        return actions;
    }, (actionId, nodeId) => {
        const node = state.model.nodes.get(nodeId);
        const types = node ? node.types.filter(t => !ONTOLOGY_TYPE_STYLE[t]) : [];
        switch (actionId) {
            case "add-property":
                workbench.findTerms(types.length ? { query: "", kind: "properties", forClass: types[0], forNode: nodeId } : { query: "", kind: "properties" });
                break;
            case "add-type":
                workbench.findTerms({ query: "", kind: "classes" });
                break;
            case "props-for-class":
                workbench.findTerms({ query: "", kind: "properties", forClass: nodeId });
                break;
            case "subclass":
                workbench.createTerm({ kind: "C", super: [nodeId] });
                break;
            case "instance":
                workbench.createTerm({ kind: "I", type: [nodeId] });
                break;
            case "declare": {
                const t = vocab.describe(nodeId);
                declareTerm(t || { iri: nodeId, kind: "C", label: JsonLd.localName(nodeId), vocab: "document" });
                break;
            }
            default: break;
        }
    });

    // ── Editor integration ───────────────────
    editor.setSourceResolver(nodeId => {
        const node = state.model && state.model.nodes.get(nodeId);
        if (!node) return [nodeId];
        const forms = new Set(node.rawForms);
        forms.add(nodeId);
        const compact = JsonLd.compactIri(state.model.context, nodeId);
        if (compact) forms.add(compact);
        return [...forms];
    });

    const JSONLD_KEYWORDS = ["@context", "@id", "@type", "@graph", "@value", "@language", "@list", "@set", "@reverse", "@vocab", "@base", "@container", "@included", "@nest"];
    editor.setHintProvider(ctx => {
        if (!state.model) return [];
        const word = ctx.word || "";
        if (ctx.isKey && word.startsWith("@")) {
            return JSONLD_KEYWORDS.filter(k => k.startsWith(word)).map(k => ({ text: k, detail: "JSON-LD keyword" }));
        }
        let kind = "all";
        if (ctx.isKey) kind = "properties";
        else if (ctx.key === "@type" || /subClassOf|equivalentClass|domain|range|targetClass|sh:class|Includes$/i.test(ctx.key || "")) kind = "classes";
        else if (/subPropertyOf|inverseOf|equivalentProperty|sh:path/i.test(ctx.key || "")) kind = "properties";
        const results = vocab.search(word, { kind, limit: 40 });
        if (/range/i.test(ctx.key || "") && word.length) {
            vocab.search(word, { kind: "datatypes", limit: 8 }).forEach(r => results.push(r));
        }
        return results.map(r => {
            let text = ctx.turtle ? r.term.iri : JsonLd.compactIri(state.model.context, r.term.iri, { vocab: true, preferCurie: state.keyStyle === "curie" });
            if (ctx.turtle) {
                const tp = turtlePrefixes(editor.getJsonldText());
                const hit = Object.entries(tp).find(([, ns]) => r.term.iri.startsWith(ns));
                text = hit ? `${hit[0]}:${r.term.iri.slice(hit[1].length)}` : `<${r.term.iri}>`;
            }
            if (text === r.term.iri || (ctx.turtle && text.startsWith("<"))) {
                const s = vocab.suggestPrefix(r.term.iri);
                if (s && r.term.iri.startsWith(s[1])) text = `${s[0]}:${r.term.iri.slice(s[1].length)}`;
            }
            return {
                text,
                displayText: text,
                detail: `${r.term.label !== JsonLd.localName(r.term.iri) ? r.term.label + " · " : ""}${vocab.KIND_LABELS[r.term.kind] || ""}${r.source === "document" ? " · this document" : ""}`,
                className: `hint-kind-${r.term.kind}`,
                iri: r.term.iri,
            };
        });
    }, (iri, text) => {
        // A picked term with a prefix the document lacks: add it to @context.
        const i = text.indexOf(":");
        if (i <= 0 || text.includes("://") || text.startsWith("<")) return;
        const prefix = text.slice(0, i);
        const ns = iri.slice(0, iri.length - (text.length - i - 1));
        if (editor.getFormat() === "ttl") {
            if (editor.insertTurtlePrefix(prefix, ns)) notify(`Added @prefix ${prefix}:.`, "info");
            return;
        }
        if (state.model && state.model.context.terms[prefix]) return;
        if (editor.insertIntoContext(`${JSON.stringify(prefix)}: ${JSON.stringify(ns)}`)) notify(`Added prefix ${prefix}: to @context.`, "info");
    });

    // Live apply (debounced) while typing.
    let autoApply = true;
    let applyTimer = null;
    editor.onTextChange(text => {
        if (!autoApply) return;
        clearTimeout(applyTimer);
        applyTimer = setTimeout(() => {
            if (text.length > 2_000_000) return;
            if (editor.getFormat() === "ttl") { applyTurtle(text); return; }
            try { JSON.parse(text); } catch (_) { editor.setJsonldStatus("Editing… (invalid JSON — the graph shows the last valid version)", "warning"); return; }
            applyText(text, { quiet: false });
        }, editor.getFormat() === "ttl" ? 1000 : 700);
    });
    const autoBtn = editor.jsonldAutoApplyBtn;
    autoBtn.classList.add("active");
    autoBtn.addEventListener("click", () => {
        autoApply = !autoApply;
        autoBtn.classList.toggle("active", autoApply);
        autoBtn.textContent = autoApply ? "Live ✓" : "Live";
        notify(autoApply ? "Live apply on: the graph follows your edits." : "Live apply off: click Apply (Ctrl+Enter) to update the graph.", "info");
    });
    editor.jsonldApplyBtn.addEventListener("click", () => {
        if (editor.getFormat() === "ttl") applyTurtle(editor.getJsonldText());
        else applyText(editor.getJsonldText());
    });
    editor.jsonldDownloadBtn.addEventListener("click", () => {
        if (editor.getFormat() === "ttl") {
            const name = state.fileName.replace(/\.(jsonld|json)$/i, "") + ".ttl";
            download(editor.getJsonldText(), name, "text/turtle");
            notify(`Downloaded ${name}.`, "success");
            return;
        }
        download(editor.getJsonldText(), state.fileName.endsWith(".jsonld") || state.fileName.endsWith(".json") ? state.fileName : `${state.fileName}.jsonld`, "application/ld+json");
        notify(`Downloaded ${state.fileName}.`, "success");
    });

    // ── Controls ─────────────────────────────
    document.getElementById("toggle-schema").addEventListener("click", () => setView(state.view === "schema" ? "instances" : "schema"));
    document.getElementById("toggle-diagram").addEventListener("click", () => {
        const on = !diagram.isActive();
        setDiagram(on);
        if (on) notify("Box diagram: drag the background to pan, the wheel to zoom, a card to move it; double-click a card for its source.", "info");
    });
    // In diagram mode the zoom buttons drive the diagram instead of the network view.
    [["zoom-in", () => diagram.zoomIn()], ["zoom-out", () => diagram.zoomOut()], ["zoom-fit", () => diagram.fit()], ["reset-view", () => diagram.render()]].forEach(([id, fn]) => {
        document.getElementById(id).addEventListener("click", e => {
            if (!diagram.isActive()) return;
            e.stopImmediatePropagation();
            fn();
        }, true);
    });
    document.getElementById("toggle-external").addEventListener("click", e => {
        state.showExternal = !state.showExternal;
        e.currentTarget.classList.toggle("active", state.showExternal);
        if (state.view === "instances") { render({ keepPositions: true }); }
        notify(state.showExternal ? "Showing referenced IRIs that are not described in the document." : "Hiding external references.", "info");
    });
    document.getElementById("toggle-type-links").addEventListener("click", e => {
        state.showTypeLinks = !state.showTypeLinks;
        e.currentTarget.classList.toggle("active", state.showTypeLinks);
        if (state.view === "instances") render({ keepPositions: true });
    });

    // Keyboard: Ctrl+K opens the term finder.
    document.addEventListener("keydown", e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
            e.preventDefault();
            workbench.open("find");
        }
    });

    // Theme
    document.getElementById("theme-toggle").addEventListener("click", () => window.themeManager.toggle());
    window.themeManager.updateToggleButton();
    window.addEventListener("theme-changed", () => {
        if (diagram.isActive()) diagram.render({ keepView: true });
        const styles = getComputedStyle(document.documentElement);
        sigmaInstance.setSetting("labelColor", { color: styles.getPropertyValue("--text-primary").trim() });
        sigmaInstance.setSetting("edgeLabelColor", { color: styles.getPropertyValue("--text-secondary").trim() });
        ui.resetHighlight();
        sigmaInstance.refresh();
    });

    // Resizable data panel.
    (function wireDataPanelResize() {
        const panel = document.getElementById("data-panel");
        const handle = document.getElementById("data-panel-resize");
        let startY = 0;
        let startH = 0;
        const move = e => {
            const h = Math.max(120, Math.min(window.innerHeight * 0.75, startH + (startY - e.clientY)));
            panel.style.setProperty("--data-panel-height", `${h}px`);
        };
        const up = () => {
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
            document.body.classList.remove("resizing");
            sigmaInstance.refresh();
        };
        handle.addEventListener("mousedown", e => {
            if (panel.classList.contains("collapsed")) return;
            startY = e.clientY;
            startH = panel.getBoundingClientRect().height;
            document.body.classList.add("resizing");
            document.addEventListener("mousemove", move);
            document.addEventListener("mouseup", up);
            e.preventDefault();
        });
    })();

    // ── Initial document ─────────────────────
    let initialText = null;
    let initialName = "sample.jsonld";
    let restored = null;
    const params = new URLSearchParams(location.search);
    const src = params.get("src") || params.get("url");

    ui.init({ view: "instances", nodes: [], edges: [], metadata: { nodeCount: 0, edgeCount: 0, validation: { total: 0 } } });
    editor.initJsonldEditor("", () => ui.getSelectedNode());

    if (src) {
        try {
            await io.openUrl(src);
            initialText = editor.getJsonldText();
        } catch (err) {
            notify(`Could not open ${src}: ${err.message}`, "error");
        }
    }
    if (!initialText) {
        try {
            const saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || "null");
            if (saved && typeof saved.text === "string" && saved.text.trim()) { restored = saved; initialText = saved.text; initialName = saved.name || initialName; }
        } catch (_) { restored = null; }
    }
    if (!initialText) {
        try {
            const response = await fetch("data/sample.jsonld.json");
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            initialText = await response.text();
        } catch (err) {
            container.innerHTML = `<p class="fatal">Failed to load data/sample.jsonld.json: ${escapeHtml(err.message)}. Serve the folder over HTTP (not file://), or open a file with Open ▾.</p>`;
            initialText = JSON.stringify(DOCUMENT_TEMPLATES.ontology.doc, null, 2);
            initialName = DOCUMENT_TEMPLATES.ontology.name;
        }
    }
    if (!src || editor.getJsonldText() !== initialText) {
        loadText(initialText, initialName);
    }
    if (restored) {
        const when = restored.savedAt ? new Date(restored.savedAt).toLocaleString() : "earlier";
        notify(`Restored your last session (${restored.name || "document"}, saved ${when}). New ▾ → Open Pulse sample reloads the sample.`, "info");
    }

    // Vocabulary index in the background, then re-check unknown terms.
    vocab.loadBuiltin().then(ok => { if (ok) relint(); });
    vocab.onChange(() => { /* document terms refresh happens on apply */ });

    // Offer the editor's tools to in-browser AI agents once a document is loaded.
    agents.register();

    // Expose for debugging in the console.
    window.jsonldEditor = { app, state, vocab, Rete, JsonLd, sigma: sigmaInstance, graph, agents };
})();
