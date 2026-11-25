/* ==============================================
   JSON-LD Graph Visualization — Tools (bottom panel)
   ==============================================

   Problems   results of lintModel() with quick fixes, plus an optional
              "Verify with rete" pass that compares the document with its
              actual RDF conversion.
   SPARQL     queries over the document (rete engine, optional OWL 2 QL
              reasoning); CONSTRUCT results can be opened as a new document.
   SHACL      SHACL Core shapes (Turtle): generate starter shapes from the
              document, validate, and show the results on the graph.
*/

function createTools(app) {
    let problems = [];
    let rdfCheck = null;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function makeCodeArea(parent, mode, value, height) {
        const ta = el("textarea", "tool-textarea");
        ta.value = value || "";
        parent.appendChild(ta);
        if (typeof CodeMirror === "undefined") return { getValue: () => ta.value, setValue: v => { ta.value = v; }, refresh: () => {}, focus: () => ta.focus() };
        const cm = CodeMirror.fromTextArea(ta, {
            mode, lineNumbers: true, tabSize: 2, indentUnit: 2, matchBrackets: true, autoCloseBrackets: true,
            extraKeys: { "Ctrl-Enter": () => runners[mode] && runners[mode](), "Cmd-Enter": () => runners[mode] && runners[mode]() },
        });
        cm.setSize(null, height || "100%");
        return cm;
    }
    const runners = {};

    function compactTerm(token) {
        const t = Rete.parseTerm(token);
        const model = app.getModel();
        if (t.kind === "iri") return { text: model ? JsonLd.compactIri(model.context, t.value) : t.value, iri: t.value };
        if (t.kind === "literal") return { text: t.lang ? `${t.value} @${t.lang}` : t.value, datatype: t.datatype };
        return { text: token };
    }

    // ── Problems ──────────────────────────────

    const problemsRoot = el("div", "tool-root problems-root");

    function severityIcon(sev) { return sev === "error" ? "●" : sev === "warning" ? "▲" : "i"; }

    function renderProblems() {
        problemsRoot.innerHTML = "";
        const bar = el("div", "tool-bar");
        const counts = { error: 0, warning: 0, info: 0 };
        problems.forEach(p => { counts[p.severity] += 1; });
        bar.appendChild(el("span", "tool-summary", problems.length ? `${counts.error} errors · ${counts.warning} warnings · ${counts.info} notes` : "No problems found."));
        const verify = el("button", "tool-btn", rdfCheck && rdfCheck.running ? "Verifying…" : "Verify with rete");
        verify.type = "button";
        verify.title = "Convert the document to RDF with the rete engine and report anything that gets lost";
        verify.disabled = Boolean(rdfCheck && rdfCheck.running);
        verify.addEventListener("click", runRdfCheck);
        bar.appendChild(verify);
        problemsRoot.appendChild(bar);

        if (rdfCheck && !rdfCheck.running) {
            const box = el("div", `rdf-check ${rdfCheck.error ? "fail" : rdfCheck.lost.length ? "warn" : "ok"}`);
            if (rdfCheck.error) box.textContent = `rete could not read this document: ${rdfCheck.error}`;
            else {
                box.textContent = `As RDF: ${rdfCheck.quads} triples about ${rdfCheck.subjects} subjects. ` +
                    (rdfCheck.lost.length ? `${rdfCheck.lost.length} node${rdfCheck.lost.length === 1 ? " is" : "s are"} missing from the RDF: ${rdfCheck.lost.slice(0, 6).join(", ")}${rdfCheck.lost.length > 6 ? "…" : ""}` : "Every node of the document survives the conversion.");
            }
            problemsRoot.appendChild(box);
        }

        const list = el("div", "problem-list");
        problems.forEach(p => {
            const row = el("div", `problem-row sev-${p.severity}`);
            row.appendChild(el("span", "problem-icon", severityIcon(p.severity)));
            const body = el("div", "problem-body");
            body.appendChild(el("div", "problem-msg", p.message));
            const actions = el("div", "problem-actions");
            if (p.nodeId || p.find) {
                const show = el("button", "wb-mini-btn", "Show");
                show.type = "button";
                show.addEventListener("click", () => app.revealProblem(p));
                actions.appendChild(show);
            }
            (p.fixes || []).forEach(fix => {
                const b = el("button", "wb-mini-btn primary", fix.label);
                b.type = "button";
                b.addEventListener("click", () => app.runAction(fix.action));
                actions.appendChild(b);
            });
            body.appendChild(actions);
            row.appendChild(body);
            list.appendChild(row);
        });
        problemsRoot.appendChild(list);
    }

    async function runRdfCheck() {
        rdfCheck = { running: true };
        renderProblems();
        try {
            const text = app.getTextForEngine();
            const facts = await Rete.inspect(text);
            const model = app.getModel();
            const lost = [];
            model.nodes.forEach(node => {
                if (node.blank || node.definitions === 0) return;
                if (node.props.size === 0 && node.types.length === 0) return;
                if (!facts.subjects.has(node.id)) lost.push(node.rawId || node.id);
            });
            rdfCheck = { running: false, quads: facts.quads, subjects: facts.subjects.size, lost };
        } catch (err) {
            rdfCheck = { running: false, error: err.message };
        }
        renderProblems();
        updateBadges();
    }

    function setProblems(list) {
        problems = list;
        rdfCheck = null;
        renderProblems();
        refreshShapeSourceLabel();
        updateBadges();
    }

    function updateBadges() {
        const errors = problems.filter(p => p.severity === "error").length;
        const warnings = problems.filter(p => p.severity === "warning").length;
        app.ui.updateToolBadge("__problems__", problems.length || null, errors ? "error" : warnings ? "warning" : problems.length ? "info" : "ok");
    }

    // ── SPARQL ────────────────────────────────

    const SPARQL_EXAMPLES = [
        { title: "Classes and instance counts", query: "SELECT ?class (COUNT(?s) AS ?instances)\nWHERE { ?s a ?class }\nGROUP BY ?class\nORDER BY DESC(?instances)" },
        { title: "Properties used per class", query: "SELECT ?class ?property (COUNT(*) AS ?uses)\nWHERE { ?s a ?class ; ?property ?o }\nGROUP BY ?class ?property\nORDER BY ?class DESC(?uses)" },
        { title: "Class hierarchy", query: "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\nSELECT ?class ?super\nWHERE { ?class rdfs:subClassOf ?super }\nORDER BY ?super ?class" },
        { title: "Properties: domain → range", query: "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\nSELECT ?property ?domain ?range\nWHERE {\n  ?property rdfs:domain|rdfs:range ?x .\n  OPTIONAL { ?property rdfs:domain ?domain }\n  OPTIONAL { ?property rdfs:range ?range }\n}\nGROUP BY ?property ?domain ?range" },
        { title: "Terms without a label", query: "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\nPREFIX owl: <http://www.w3.org/2002/07/owl#>\nSELECT ?term ?type\nWHERE {\n  VALUES ?type { owl:Class owl:ObjectProperty owl:DatatypeProperty }\n  ?term a ?type .\n  FILTER NOT EXISTS { ?term rdfs:label ?l }\n}" },
        { title: "Everything about one subject (DESCRIBE)", query: "SELECT ?p ?o\nWHERE { ?s ?p ?o }\nLIMIT 50" },
        { title: "Extract the ontology module (CONSTRUCT)", query: "PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>\nPREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\nPREFIX owl: <http://www.w3.org/2002/07/owl#>\nCONSTRUCT { ?t ?p ?o }\nWHERE {\n  VALUES ?type { owl:Ontology owl:Class rdfs:Class owl:ObjectProperty owl:DatatypeProperty owl:AnnotationProperty rdf:Property }\n  ?t a ?type ; ?p ?o .\n}" },
        { title: "All triples", query: "SELECT ?s ?p ?o\nWHERE { ?s ?p ?o }\nLIMIT 200" },
    ];

    const sparqlRoot = el("div", "tool-root sparql-root");
    let sparqlEditor = null;
    const sparqlResults = el("div", "tool-results");
    let lastConstruct = null;

    function buildSparqlUi() {
        const left = el("div", "tool-pane-left");
        const bar = el("div", "tool-bar");
        const select = el("select", "tool-select");
        select.appendChild(new Option("Example queries…", ""));
        SPARQL_EXAMPLES.forEach((ex, i) => select.appendChild(new Option(ex.title, String(i))));
        select.addEventListener("change", () => { if (select.value !== "") { sparqlEditor.setValue(SPARQL_EXAMPLES[Number(select.value)].query); select.value = ""; } });
        bar.appendChild(select);
        const reasonLabel = el("label", "tool-check");
        const reason = el("input");
        reason.type = "checkbox";
        reasonLabel.appendChild(reason);
        reasonLabel.appendChild(document.createTextNode(" OWL 2 QL reasoning"));
        reasonLabel.title = "Answer with subclass/subproperty/domain/range entailment (query rewriting)";
        bar.appendChild(reasonLabel);
        const run = el("button", "tool-btn primary", "Run ▶");
        run.type = "button";
        run.title = "Run (Ctrl+Enter)";
        bar.appendChild(run);
        left.appendChild(bar);
        const area = el("div", "tool-code");
        left.appendChild(area);
        sparqlRoot.appendChild(left);
        sparqlRoot.appendChild(sparqlResults);
        sparqlEditor = makeCodeArea(area, "sparql", SPARQL_EXAMPLES[0].query);
        runners.sparql = () => runSparql(reason.checked);
        run.addEventListener("click", () => runSparql(reason.checked));
        sparqlResults.appendChild(el("p", "panel-empty", "Run a query to see results. The engine loads on first use."));
    }

    async function runSparql(reason) {
        sparqlResults.innerHTML = "";
        const status = el("p", "tool-status", Rete.getState() === "ready" ? "Running…" : "Loading the rete engine…");
        sparqlResults.appendChild(status);
        try {
            const { env, ms, warnings } = await Rete.sparql(app.getTextForEngine(), sparqlEditor.getValue(), { reason });
            sparqlResults.innerHTML = "";
            const info = el("div", "tool-status");
            if (env.kind === "select") {
                info.textContent = `${env.rows.length} row${env.rows.length === 1 ? "" : "s"} · ${ms.toFixed(1)} ms${reason ? " · with reasoning" : ""}`;
                sparqlResults.appendChild(info);
                sparqlResults.appendChild(resultTable(env.vars, env.rows));
            } else if (env.kind === "ask") {
                info.textContent = `ASK → ${env.boolean} · ${ms.toFixed(1)} ms`;
                sparqlResults.appendChild(info);
            } else if (env.kind === "construct") {
                const triples = env.triples || [];
                lastConstruct = triples;
                info.textContent = `${triples.length} triple${triples.length === 1 ? "" : "s"} · ${ms.toFixed(1)} ms`;
                const openBtn = el("button", "wb-mini-btn primary", "Open as new document");
                openBtn.type = "button";
                openBtn.title = "Load the constructed graph into the editor as JSON-LD (Ctrl+Z goes back)";
                openBtn.addEventListener("click", () => app.loadConstructResult(lastConstruct));
                info.appendChild(document.createTextNode("  "));
                info.appendChild(openBtn);
                sparqlResults.appendChild(info);
                const pre = el("pre", "tool-pre", Rete.triplesToTurtle(triples, app.getPrefixes()));
                sparqlResults.appendChild(pre);
            }
            (warnings || []).forEach(w => sparqlResults.appendChild(el("p", "tool-warning", `⚠ ${w.message}${w.hint ? " — " + w.hint : ""}`)));
        } catch (err) {
            sparqlResults.innerHTML = "";
            sparqlResults.appendChild(el("p", "tool-error", err.message || String(err)));
        }
    }

    function resultTable(vars, rows) {
        const wrap = el("div", "data-table-wrapper static");
        const table = el("table", "data-table");
        const thead = el("thead");
        const hr = el("tr");
        vars.forEach(v => hr.appendChild(el("th", "", `?${v}`)));
        thead.appendChild(hr);
        table.appendChild(thead);
        const tbody = el("tbody");
        rows.slice(0, 1000).forEach(row => {
            const tr = el("tr");
            vars.forEach(v => {
                const td = el("td");
                if (row[v] !== undefined) {
                    const term = compactTerm(row[v]);
                    td.textContent = term.text;
                    td.title = row[v];
                    if (term.iri && app.hasNode(term.iri)) {
                        td.classList.add("cell-link");
                        td.addEventListener("click", () => app.selectNode(term.iri));
                    }
                }
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        if (rows.length > 1000) wrap.appendChild(el("p", "tool-status", `Showing 1000 of ${rows.length} rows.`));
        return wrap;
    }

    // ── SHACL ─────────────────────────────────

    const SHACL_STORAGE = "jsonld-editor:shacl-shapes";
    const shaclRoot = el("div", "tool-root shacl-root");
    let shaclEditor = null;
    const shaclResults = el("div", "tool-results");

    function defaultShapes() {
        let saved = null;
        try { saved = localStorage.getItem(SHACL_STORAGE); } catch (_) { saved = null; }
        return saved || "# SHACL shapes (Turtle). Click “Generate from document” for a starting point.\n@prefix sh: <http://www.w3.org/ns/shacl#> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n";
    }

    let genMode = null;
    let shapesSource = null;
    const SH_TYPES = ["http://www.w3.org/ns/shacl#NodeShape", "http://www.w3.org/ns/shacl#PropertyShape"];

    function documentShapeCount() {
        const model = app.getModel();
        let n = 0;
        if (model) model.nodes.forEach(node => { if (node.definitions > 0 && node.types.some(t => SH_TYPES.includes(t))) n += 1; });
        return n;
    }

    function refreshShapeSourceLabel() {
        if (!shapesSource) return;
        const n = documentShapeCount();
        shapesSource.options[1].textContent = `Shapes in the document (${n})`;
        shapesSource.options[2].textContent = `Editor + document (${n})`;
        if (n && shapesSource.value === "editor" && !shapesSource.dataset.touched) shapesSource.value = "both";
    }

    function buildShaclUi() {
        const left = el("div", "tool-pane-left");
        const bar = el("div", "tool-bar");

        genMode = el("select", "tool-select");
        genMode.title = "What to derive starter shapes from";
        [["both", "Generate from data + ontology"], ["ontology", "Generate from ontology (domain/range)"], ["data", "Generate from data (observed values)"]]
            .forEach(([v, t]) => genMode.appendChild(new Option(t, v)));
        const gen = el("button", "tool-btn", "Generate");
        gen.type = "button";
        gen.title = "Write starter shapes into the editor below";

        const load = el("button", "tool-btn", "Load .ttl…");
        load.type = "button";
        load.title = "Load SHACL shapes from a Turtle file";
        const fileInput = el("input");
        fileInput.type = "file";
        fileInput.accept = ".ttl,.turtle,.nt,.shacl";
        fileInput.hidden = true;

        const addToDoc = el("button", "tool-btn", "Add to document");
        addToDoc.type = "button";
        addToDoc.title = "Store these shapes in the JSON-LD document, next to the ontology and the instances";

        shapesSource = el("select", "tool-select");
        shapesSource.title = "Which shapes to validate with";
        [["editor", "Shapes in the editor"], ["document", "Shapes in the document"], ["both", "Editor + document"]]
            .forEach(([v, t]) => shapesSource.appendChild(new Option(t, v)));
        shapesSource.addEventListener("change", () => { shapesSource.dataset.touched = "1"; });

        const validate = el("button", "tool-btn primary", "Validate ▶");
        validate.type = "button";
        validate.title = "Validate (Ctrl+Enter)";
        const dl = el("button", "tool-btn", "Download");
        dl.type = "button";
        const clear = el("button", "tool-btn", "Clear");
        clear.type = "button";
        clear.title = "Clear the validation results from the graph";

        [genMode, gen, load, fileInput, addToDoc].forEach(n => bar.appendChild(n));
        const bar2 = el("div", "tool-bar");
        [shapesSource, validate, dl, clear].forEach(n => bar2.appendChild(n));
        left.appendChild(bar);
        left.appendChild(bar2);
        const area = el("div", "tool-code");
        left.appendChild(area);
        shaclRoot.appendChild(left);
        shaclRoot.appendChild(shaclResults);
        shaclEditor = makeCodeArea(area, "turtle", defaultShapes());
        if (shaclEditor.on) shaclEditor.on("changes", () => { try { localStorage.setItem(SHACL_STORAGE, shaclEditor.getValue()); } catch (_) { /* ignore */ } });
        runners.turtle = runShacl;
        gen.addEventListener("click", () => {
            const shapes = generateShapes(app.getModel(), genMode.value);
            if (!shapes) { app.notify(genMode.value === "ontology" ? "No properties with rdfs:domain in the document to generate shapes from." : "No classes with instances or declared properties to generate shapes from.", "warning"); return; }
            shaclEditor.setValue(shapes);
            app.notify("Generated starter shapes. Review them, then Validate.", "success");
        });
        load.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", async () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file) return;
            shaclEditor.setValue(await file.text());
            fileInput.value = "";
            app.notify(`Loaded shapes from ${file.name}.`, "success");
        });
        addToDoc.addEventListener("click", async () => {
            addToDoc.disabled = true;
            try {
                const result = await Rete.importRdf(shaclEditor.getValue(), "ttl", app.getPrefixes());
                const shapes = (result.doc["@graph"] || []).length;
                if (!shapes) { app.notify("There are no shapes in the editor.", "warning"); return; }
                app.mergeDocument(result.doc, `Added ${shapes} shape node${shapes === 1 ? "" : "s"} to the document. The schema view links them to their target classes.`);
                shapesSource.value = "document";
                shapesSource.dataset.touched = "1";
                refreshShapeSourceLabel();
            } catch (err) {
                app.notify(`Could not read the shapes: ${err.message}`, "error");
            } finally {
                addToDoc.disabled = false;
            }
        });
        validate.addEventListener("click", runShacl);
        dl.addEventListener("click", () => app.download(shaclEditor.getValue(), "shapes.ttl", "text/turtle"));
        clear.addEventListener("click", () => { app.setShaclResults(null); shaclResults.innerHTML = ""; shaclResults.appendChild(el("p", "panel-empty", "Results cleared.")); });
        shaclResults.appendChild(el("p", "panel-empty", "Validate the document against SHACL shapes — written here, loaded from a .ttl file, or stored in the document itself. Results appear here and as ✓/✗ badges on the graph."));
        refreshShapeSourceLabel();
    }

    async function currentShapes() {
        const mode = shapesSource ? shapesSource.value : "editor";
        const parts = [];
        if (mode !== "document") parts.push(shaclEditor.getValue());
        if (mode !== "editor") {
            if (!documentShapeCount()) throw new Error("The document contains no sh:NodeShape or sh:PropertyShape nodes. Generate shapes and click “Add to document”, or validate with the editor's shapes.");
            const out = await Rete.exportDocument(app.getTextForEngine(), "ttl", { prefixes: app.getPrefixes() });
            parts.push(out.data);
        }
        return parts.join("\n");
    }

    async function runShacl() {
        shaclResults.innerHTML = "";
        shaclResults.appendChild(el("p", "tool-status", Rete.getState() === "ready" ? "Validating…" : "Loading the rete engine…"));
        try {
            const report = await Rete.shacl(app.getTextForEngine(), await currentShapes());
            const model = app.getModel();
            const byNode = new Map();
            report.targets.forEach((shapes, nodeId) => byNode.set(nodeId, { ok: true, source: "SHACL", shape: shapes.map(s => JsonLd.compactIri(model.context, s)).join(", "), errors: [] }));
            report.results.forEach(r => {
                const focus = r.focusNode;
                const entry = byNode.get(focus) || { ok: true, source: "SHACL", shape: "", errors: [] };
                const path = r.resultPath ? JsonLd.compactIri(model.context, String(r.resultPath).replace(/^<|>$/g, "")) : "";
                const comp = JsonLd.localName(r.sourceConstraintComponent || "").replace(/ConstraintComponent$/, "");
                const msg = (Array.isArray(r.resultMessage) ? r.resultMessage.join("; ") : r.resultMessage) || `${comp}${path ? ` on ${path}` : ""}`;
                const severity = JsonLd.localName(r.resultSeverity || "Violation");
                if (severity === "Violation") entry.ok = false;
                entry.errors.push(`${severity}: ${msg}${r.valueNode ? ` (value ${r.valueNode})` : ""}`);
                byNode.set(focus, entry);
            });
            app.setShaclResults(byNode);
            shaclResults.innerHTML = "";
            const violations = report.results.filter(r => /Violation$/.test(r.resultSeverity || "Violation")).length;
            const head = el("div", `rdf-check ${report.conforms ? "ok" : "fail"}`);
            head.textContent = report.conforms
                ? `Conforms. ${report.targets.size} focus node${report.targets.size === 1 ? "" : "s"} checked.`
                : `Does not conform: ${report.results.length} result${report.results.length === 1 ? "" : "s"} (${violations} violation${violations === 1 ? "" : "s"}) on ${new Set(report.results.map(r => r.focusNode)).size} node(s).`;
            shaclResults.appendChild(head);
            if (report.results.length) shaclResults.appendChild(shaclTable(report.results, model));
        } catch (err) {
            shaclResults.innerHTML = "";
            shaclResults.appendChild(el("p", "tool-error", err.message || String(err)));
        }
    }

    function shaclTable(results, model) {
        const short = iri => JsonLd.compactIri(model.context, String(iri || "").replace(/^<|>$/g, ""));
        const wrap = el("div", "data-table-wrapper static");
        const table = el("table", "data-table");
        const hr = el("tr");
        ["Focus node", "Path", "Constraint", "Severity", "Value", "Message"].forEach(h => hr.appendChild(el("th", "", h)));
        const thead = el("thead");
        thead.appendChild(hr);
        table.appendChild(thead);
        const tbody = el("tbody");
        results.forEach(r => {
            const tr = el("tr");
            const focus = el("td", app.hasNode(r.focusNode) ? "cell-link" : "", short(r.focusNode));
            focus.title = r.focusNode;
            if (app.hasNode(r.focusNode)) focus.addEventListener("click", () => app.selectNode(r.focusNode));
            tr.appendChild(focus);
            tr.appendChild(el("td", "", r.resultPath ? short(r.resultPath) : ""));
            tr.appendChild(el("td", "", JsonLd.localName(r.sourceConstraintComponent || "").replace(/ConstraintComponent$/, "")));
            const sev = JsonLd.localName(r.resultSeverity || "");
            tr.appendChild(el("td", sev === "Violation" ? "cell-fail" : "", sev));
            tr.appendChild(el("td", "", r.valueNode ? String(r.valueNode) : ""));
            tr.appendChild(el("td", "", Array.isArray(r.resultMessage) ? r.resultMessage.join("; ") : (r.resultMessage || "")));
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        return wrap;
    }

    /** Starter SHACL shapes from the document's instances and declared properties. */
    function generateShapes(model, mode = "both") {
        if (!model) return null;
        const ctx = model.context;
        const prefixes = Object.assign({ sh: "http://www.w3.org/ns/shacl#", xsd: "http://www.w3.org/2001/XMLSchema#" }, app.getPrefixes());
        const curie = iri => {
            let best = null;
            Object.entries(prefixes).forEach(([p, ns]) => { if (iri.startsWith(ns) && (!best || ns.length > best[1].length)) best = [p, ns]; });
            if (best) {
                const local = iri.slice(best[1].length);
                if (/^[A-Za-z0-9_](?:[A-Za-z0-9_.\-]*[A-Za-z0-9_\-])?$/.test(local)) return `${best[0]}:${local}`;
            }
            return `<${iri}>`;
        };
        const classes = new Map(); // class -> { instances, props: Map(pred -> {count, datatypes:Set, classes:Set, iri:boolean, literal:boolean, max}) }
        const ONTO = new Set(Object.keys(ONTOLOGY_TYPE_STYLE));
        model.nodes.forEach(node => {
            if (node.definitions === 0 || mode === "ontology") return;
            node.types.filter(t => !ONTO.has(t)).forEach(t => {
                const info = classes.get(t) || { instances: 0, props: new Map() };
                info.instances += 1;
                node.props.forEach((values, pred) => {
                    if (pred.startsWith("urn:unmapped:")) return;
                    const p = info.props.get(pred) || { count: 0, datatypes: new Set(), classes: new Set(), iri: false, literal: false, max: 0 };
                    p.count += 1;
                    p.max = Math.max(p.max, values.length);
                    values.forEach(v => {
                        const target = v.kind === "iri" ? v.iri : v.linksTo;
                        if (target) {
                            p.iri = true;
                            const tn = model.nodes.get(target);
                            if (tn) tn.types.forEach(tt => p.classes.add(tt));
                        } else if (v.kind === "literal") {
                            p.literal = true;
                            p.datatypes.add(v.datatype || (v.lang ? "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString" : "http://www.w3.org/2001/XMLSchema#string"));
                        }
                    });
                    info.props.set(pred, p);
                });
                classes.set(t, info);
            });
        });
        // Declared properties (ontology) contribute shapes for their domains.
        model.nodes.forEach(node => {
            if (mode === "data") return;
            if (!node.types.some(t => t.endsWith("#ObjectProperty") || t.endsWith("#DatatypeProperty"))) return;
            const domains = (node.props.get(SCHEMA_PREDICATES.domain) || []).filter(v => v.kind === "iri").map(v => v.iri);
            const ranges = (node.props.get(SCHEMA_PREDICATES.range) || []).filter(v => v.kind === "iri").map(v => v.iri);
            domains.forEach(d => {
                const info = classes.get(d) || { instances: 0, props: new Map() };
                if (!info.props.has(node.id)) {
                    const p = { count: 0, datatypes: new Set(), classes: new Set(), iri: false, literal: false, max: 0, declared: true };
                    ranges.forEach(r => { if (r.startsWith("http://www.w3.org/2001/XMLSchema#")) { p.literal = true; p.datatypes.add(r); } else { p.iri = true; p.classes.add(r); } });
                    info.props.set(node.id, p);
                }
                classes.set(d, info);
            });
        });
        if (!classes.size) return null;
        const usedPrefixes = new Set(["sh", "xsd"]);
        const out = [];
        // Mint shapes in the document's own namespace (e.g. ex:ProjectShape) when it has one.
        const own = (ctx.vocab ? [ctx.vocab] : []).concat(JsonLd.prefixesOf(ctx).map(p => p.namespace)
            .filter(ns => { const v = app.vocab.vocabularyFor(ns); return !v || v.namespace !== ns; })
            .filter(ns => !/w3\.org|schema\.org|purl\.org|xmlns\.com/.test(ns)));
        const shapeNs = own[0] || "urn:shapes:";
        classes.forEach((info, cls) => {
            const lines = [`${curie(shapeNs + JsonLd.localName(cls) + "Shape")}`, "    a sh:NodeShape ;", `    sh:targetClass ${curie(cls)} ;`];
            const props = [...info.props.entries()];
            props.forEach(([pred, p], i) => {
                const parts = [`sh:path ${curie(pred)}`];
                if (info.instances && p.count === info.instances) parts.push("sh:minCount 1");
                if (info.instances && p.max === 1 && p.count === info.instances) parts.push("sh:maxCount 1");
                if (p.literal && !p.iri && p.datatypes.size === 1) parts.push(`sh:datatype ${curie([...p.datatypes][0])}`);
                if (p.iri && !p.literal) {
                    parts.push("sh:nodeKind sh:IRI");
                    if (p.classes.size === 1) parts.push(`sh:class ${curie([...p.classes][0])}`);
                }
                lines.push(`    sh:property [ ${parts.join(" ; ")} ]${i === props.length - 1 ? " ." : " ;"}`);
            });
            if (!props.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/ ;$/, " .");
            const chunk = lines.join("\n");
            (chunk.match(/\b([A-Za-z][\w.\-]*):[A-Za-z0-9_]/g) || []).forEach(m => usedPrefixes.add(m.split(":")[0]));
            out.push(chunk);
        });
        const header = Object.entries(prefixes).filter(([p]) => usedPrefixes.has(p)).map(([p, ns]) => `@prefix ${p}: <${ns}> .`);
        return `${header.join("\n")}\n\n# Starter shapes generated from the document: review the cardinalities\n# (minCount 1 = every instance had a value) before relying on them.\n\n${out.join("\n\n")}\n`;
    }

    // ── Registration ──────────────────────────

    buildSparqlUi();
    buildShaclUi();

    const tabs = [
        { id: "__problems__", label: "⚠ Problems", render: c => { c.appendChild(problemsRoot); } },
        { id: "__sparql__", label: "SPARQL", render: c => { c.appendChild(sparqlRoot); setTimeout(() => sparqlEditor.refresh(), 0); } },
        { id: "__shacl__", label: "SHACL", render: c => { c.appendChild(shaclRoot); setTimeout(() => shaclEditor.refresh(), 0); } },
    ];

    return {
        tabs,
        setProblems,
        getProblems: () => problems,
        generateShapes,
    };
}
