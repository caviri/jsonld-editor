/* ==============================================
   JSON-LD Graph Visualization — Files (new / open / export)
   ============================================== */

const DOCUMENT_TEMPLATES = {
    ontology: {
        name: "ontology.jsonld",
        title: "Ontology starter",
        description: "owl:Ontology header, one class and one property that reuse schema.org",
        doc: {
            "@context": {
                "ex": "https://example.org/ontology#",
                "owl": "http://www.w3.org/2002/07/owl#",
                "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
                "xsd": "http://www.w3.org/2001/XMLSchema#",
                "dcterms": "http://purl.org/dc/terms/",
                "vann": "http://purl.org/vocab/vann/",
                "schema": "http://schema.org/",
            },
            "@graph": [
                {
                    "@id": "https://example.org/ontology",
                    "@type": "owl:Ontology",
                    "dcterms:title": "Example ontology",
                    "dcterms:description": "Describe what this ontology is for.",
                    "owl:versionInfo": "0.1.0",
                    "dcterms:license": { "@id": "https://creativecommons.org/licenses/by/4.0/" },
                    "vann:preferredNamespacePrefix": "ex",
                    "vann:preferredNamespaceUri": "https://example.org/ontology#",
                },
                {
                    "@id": "ex:ResearchProject",
                    "@type": "owl:Class",
                    "rdfs:label": "Research project",
                    "rdfs:comment": "A project that produces research outputs.",
                    "rdfs:subClassOf": { "@id": "schema:Project" },
                },
                {
                    "@id": "ex:principalInvestigator",
                    "@type": "owl:ObjectProperty",
                    "rdfs:label": "principal investigator",
                    "rdfs:comment": "The person who leads a research project.",
                    "rdfs:domain": { "@id": "ex:ResearchProject" },
                    "rdfs:range": { "@id": "schema:Person" },
                    "rdfs:subPropertyOf": { "@id": "schema:member" },
                },
            ],
        },
    },
    skos: {
        name: "concept-scheme.jsonld",
        title: "SKOS concept scheme",
        description: "A small taxonomy: a scheme with broader/narrower concepts",
        doc: {
            "@context": {
                "skos": "http://www.w3.org/2004/02/skos/core#",
                "dcterms": "http://purl.org/dc/terms/",
                "ex": "https://example.org/concepts/",
            },
            "@graph": [
                { "@id": "ex:scheme", "@type": "skos:ConceptScheme", "skos:prefLabel": { "@value": "Research fields", "@language": "en" }, "dcterms:description": "Fields used to classify projects." },
                { "@id": "ex:natural-sciences", "@type": "skos:Concept", "skos:prefLabel": { "@value": "Natural sciences", "@language": "en" }, "skos:topConceptOf": { "@id": "ex:scheme" }, "skos:inScheme": { "@id": "ex:scheme" } },
                { "@id": "ex:physics", "@type": "skos:Concept", "skos:prefLabel": { "@value": "Physics", "@language": "en" }, "skos:broader": { "@id": "ex:natural-sciences" }, "skos:inScheme": { "@id": "ex:scheme" }, "skos:exactMatch": { "@id": "http://www.wikidata.org/entity/Q413" } },
            ],
        },
    },
    dataset: {
        name: "data.jsonld",
        title: "Empty dataset",
        description: "schema.org context, ready for instances",
        doc: {
            "@context": {
                "@base": "https://example.org/data/",
                "schema": "http://schema.org/",
                "xsd": "http://www.w3.org/2001/XMLSchema#",
            },
            "@graph": [],
        },
    },
};

function createIO(app) {
    const fileInput = document.getElementById("file-open-input");
    const menus = document.querySelectorAll("[data-menu]");

    // ── Menus ─────────────────────────────────

    function closeMenus() { document.querySelectorAll(".file-menu.open").forEach(m => m.classList.remove("open")); }
    menus.forEach(btn => {
        btn.addEventListener("click", e => {
            e.stopPropagation();
            const menu = document.getElementById(btn.dataset.menu);
            const wasOpen = menu.classList.contains("open");
            closeMenus();
            if (!wasOpen) menu.classList.add("open");
        });
    });
    document.addEventListener("click", closeMenus);
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenus(); });

    document.querySelectorAll("[data-action]").forEach(item => {
        item.addEventListener("click", e => {
            e.stopPropagation();
            closeMenus();
            const action = item.dataset.action;
            const arg = item.dataset.arg;
            if (action === "new") newDocument(arg);
            else if (action === "open-file") fileInput.click();
            else if (action === "open-url") openUrlDialog();
            else if (action === "export") exportAs(arg);
        });
    });

    // ── New ───────────────────────────────────

    async function newDocument(kind) {
        if (kind === "sample") {
            try {
                const res = await fetch("data/sample.jsonld.json");
                const text = await res.text();
                app.loadText(text, "sample.jsonld", { origin: "sample" });
            } catch (err) {
                app.notify(`Could not load the sample: ${err.message}`, "error");
            }
            return;
        }
        const tpl = DOCUMENT_TEMPLATES[kind];
        if (!tpl) return;
        app.loadText(JSON.stringify(tpl.doc, null, 2) + "\n", tpl.name, { origin: "template" });
        if (kind === "ontology") app.setView("schema");
        app.notify(`New ${tpl.title.toLowerCase()}. Your previous document is in the editor's undo history (Ctrl+Z).`, "success");
    }

    // ── Open ──────────────────────────────────

    async function openFile(file) {
        if (!file) return;
        const format = Rete.formatFromName(file.name);
        try {
            if (!format || format === "jsonld") {
                const text = await file.text();
                app.loadText(text, file.name, { origin: "file" });
                return;
            }
            const input = format === "rete" ? new Uint8Array(await file.arrayBuffer()) : await file.text();
            await importRdf(input, format, file.name);
        } catch (err) {
            app.notify(`Could not open ${file.name}: ${err.message}`, "error");
        }
    }

    async function importRdf(input, format, name) {
        app.notify(Rete.getState() === "ready" ? `Converting ${name} to JSON-LD…` : `Loading the rete engine to read ${name}…`, "info");
        const result = await Rete.importRdf(input, format, {});
        const text = JSON.stringify(result.doc, null, 2) + "\n";
        const base = name.replace(/\.(rete|ttl|nt|nq|trig|turtle)$/i, "");
        app.loadText(text, `${base}.jsonld`, { origin: "import" });
        let msg = `Imported ${result.triples} triples from ${name}`;
        if (result.truncated) msg += ` (first ${result.triples} of ${result.total}; the file is larger than the editor's ${RETE_CONFIG.maxImportTriples}-triple import limit)`;
        if (result.namedGraphs) msg += `. Named graphs were merged into one graph`;
        if (result.card && result.card.title) msg += `. Dataset Card: “${result.card.title}”`;
        app.notify(msg + ".", result.truncated ? "warning" : "success");
    }

    async function openUrl(url) {
        const format = Rete.formatFromName(new URL(url, location.href).pathname);
        app.notify(`Fetching ${url}…`, "info");
        const res = await fetch(url, { headers: { Accept: "application/ld+json, application/json;q=0.9, text/turtle;q=0.8, */*;q=0.5" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const type = (res.headers.get("content-type") || "").toLowerCase();
        const name = decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() || "document.jsonld");
        if (format === "rete") { await importRdf(new Uint8Array(await res.arrayBuffer()), "rete", name); return; }
        const text = await res.text();
        const looksJson = /^\s*[\[{]/.test(text);
        if (looksJson || type.includes("json")) { app.loadText(text, name.endsWith(".json") || name.endsWith(".jsonld") ? name : `${name}.jsonld`, { origin: "url", url }); return; }
        const rdfFormat = format && format !== "jsonld" ? format : type.includes("n-triples") ? "nt" : type.includes("n-quads") ? "nq" : type.includes("trig") ? "trig" : "ttl";
        await importRdf(text, rdfFormat, name);
    }

    function openUrlDialog() {
        const overlay = document.getElementById("url-modal-overlay");
        const input = document.getElementById("url-modal-input");
        overlay.classList.remove("hidden");
        setTimeout(() => input.focus(), 50);
    }
    (function wireUrlModal() {
        const overlay = document.getElementById("url-modal-overlay");
        const input = document.getElementById("url-modal-input");
        const close = () => overlay.classList.add("hidden");
        document.getElementById("url-modal-cancel").addEventListener("click", close);
        overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
        document.getElementById("url-modal-form").addEventListener("submit", async e => {
            e.preventDefault();
            const url = input.value.trim();
            if (!/^https?:\/\//.test(url)) { app.notify("Enter an http(s) URL.", "warning"); return; }
            close();
            try { await openUrl(url); } catch (err) { app.notify(`Could not open ${url}: ${err.message}. The server must allow cross-origin requests (CORS).`, "error"); }
        });
        document.addEventListener("keydown", e => { if (e.key === "Escape" && !overlay.classList.contains("hidden")) close(); });
    })();

    fileInput.addEventListener("change", () => {
        openFile(fileInput.files && fileInput.files[0]);
        fileInput.value = "";
    });

    // Drag & drop anywhere.
    const dropZone = document.getElementById("drop-overlay");
    let dragDepth = 0;
    window.addEventListener("dragenter", e => {
        if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
        dragDepth += 1;
        dropZone.classList.add("visible");
    });
    window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropZone.classList.remove("visible"); });
    window.addEventListener("dragover", e => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
    window.addEventListener("drop", e => {
        if (!e.dataTransfer || !e.dataTransfer.files.length) return;
        e.preventDefault();
        dragDepth = 0;
        dropZone.classList.remove("visible");
        openFile(e.dataTransfer.files[0]);
    });

    // ── Export ────────────────────────────────

    function baseName() {
        return (app.getFileName() || "document.jsonld").replace(/\.(jsonld|json|ttl|nt|nq|rete)$/i, "");
    }

    async function exportAs(kind) {
        const text = app.getText();
        try { JSON.parse(text); } catch (err) { app.notify("Fix the JSON syntax errors before exporting.", "error"); return; }
        if (kind === "jsonld") { app.download(text, `${baseName()}.jsonld`, "application/ld+json"); return; }
        if (kind === "ontology") { exportOntologyModule(); return; }
        if (kind === "rete") { openReteDialog(); return; }
        try {
            app.notify(Rete.getState() === "ready" ? "Converting…" : "Loading the rete engine…", "info");
            const out = await Rete.exportDocument(app.getTextForEngine(), kind, { prefixes: app.getPrefixes() });
            app.download(out.data, `${baseName()}.${out.ext}`, out.mime);
            app.notify(`Exported ${baseName()}.${out.ext}.`, "success");
        } catch (err) {
            app.notify(`Export failed: ${err.message}`, "error");
        }
    }

    /** Only the ontology: owl:Ontology, classes, properties, datatypes, individuals declared as such. */
    function exportOntologyModule() {
        let doc;
        try { doc = JSON.parse(app.getText()); } catch (_) { return; }
        const model = app.getModel();
        const TERM_TYPES = new Set(Object.entries(ONTOLOGY_TYPE_STYLE).filter(([, s]) => s.kind !== "shape").map(([iri]) => iri));
        const keep = new Set();
        model.nodes.forEach(node => { if (node.types.some(t => TERM_TYPES.has(t))) keep.add(node.id); });
        if (!keep.size) { app.notify("No ontology terms (owl:Class, owl:ObjectProperty, …) in this document.", "warning"); return; }
        const { graph } = JsonLd.ensureGraphArray(JsonLd.clone(doc));
        const ctx = model.context;
        const out = graph.filter(item => item && typeof item === "object" && typeof item["@id"] === "string" && keep.has(JsonLd.expandIri(ctx, item["@id"], { documentRelative: true })));
        const result = {};
        if (!Array.isArray(doc) && doc["@context"] !== undefined) result["@context"] = doc["@context"];
        result["@graph"] = out;
        app.download(JSON.stringify(result, null, 2) + "\n", `${baseName()}-ontology.jsonld`, "application/ld+json");
        app.notify(`Exported ${out.length} ontology terms — share this file so others can load it as a vocabulary.`, "success");
    }

    // ── .rete dialog with Dataset Card ────────

    const reteOverlay = document.getElementById("rete-modal-overlay");
    const reteForm = document.getElementById("rete-modal-form");
    const reteResult = document.getElementById("rete-modal-result");

    function literal(node, ...preds) {
        if (!node) return "";
        for (const p of preds) {
            const v = (node.props.get(p) || [])[0];
            if (v) return v.kind === "iri" ? v.iri : v.value;
        }
        return "";
    }

    function openReteDialog() {
        // Pre-fill the card from an ontology / dataset description in the document.
        const model = app.getModel();
        let meta = null;
        const META_TYPES = ["http://www.w3.org/2002/07/owl#Ontology", "http://www.w3.org/ns/dcat#Dataset", "http://schema.org/Dataset", "http://www.w3.org/2004/02/skos/core#ConceptScheme"];
        model.nodes.forEach(node => { if (!meta && node.types.some(t => META_TYPES.includes(t))) meta = node; });
        const DCT = "http://purl.org/dc/terms/";
        const SCHEMA = "http://schema.org/";
        const set = (id, value) => { const input = document.getElementById(id); if (!input.dataset.touched) input.value = value || ""; };
        set("card-title", literal(meta, DCT + "title", SCHEMA + "name", SCHEMA_PREDICATES.label, "http://www.w3.org/2004/02/skos/core#prefLabel") || baseName());
        set("card-description", literal(meta, DCT + "description", SCHEMA + "description", SCHEMA_PREDICATES.comment));
        set("card-license", literal(meta, DCT + "license", SCHEMA + "license"));
        set("card-version", literal(meta, "http://www.w3.org/2002/07/owl#versionInfo", SCHEMA + "version"));
        set("card-source", meta && !meta.blank ? meta.id : "");
        reteResult.innerHTML = "";
        reteOverlay.classList.remove("hidden");
    }

    reteForm.querySelectorAll("input, textarea").forEach(i => i.addEventListener("input", () => { i.dataset.touched = "1"; }));
    document.getElementById("rete-modal-cancel").addEventListener("click", () => reteOverlay.classList.add("hidden"));
    reteOverlay.addEventListener("click", e => { if (e.target === reteOverlay) reteOverlay.classList.add("hidden"); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !reteOverlay.classList.contains("hidden")) reteOverlay.classList.add("hidden"); });

    reteForm.addEventListener("submit", async e => {
        e.preventDefault();
        const submit = document.getElementById("rete-modal-build");
        const withCard = document.getElementById("card-include").checked;
        const card = {};
        if (withCard) {
            const v = id => document.getElementById(id).value.trim();
            if (v("card-title")) card.title = v("card-title");
            if (v("card-description")) card.description = v("card-description");
            if (v("card-license")) card.license = v("card-license");
            if (v("card-version")) card.version = v("card-version");
            if (v("card-source")) card.source = v("card-source");
            const keywords = v("card-keywords").split(",").map(s => s.trim()).filter(Boolean);
            if (keywords.length) card.keywords = keywords;
            const creator = v("card-creator");
            const orcid = v("card-orcid");
            if (creator) card.creators = [orcid ? { name: creator, orcid: /^https?:/.test(orcid) ? orcid : `https://orcid.org/${orcid}` } : { name: creator }];
            card.created = new Date().toISOString().slice(0, 10);
        }
        submit.disabled = true;
        submit.textContent = Rete.getState() === "ready" ? "Building…" : "Loading engine…";
        reteResult.innerHTML = "";
        try {
            const out = await Rete.exportDocument(app.getTextForEngine(), "rete", { card: withCard ? card : null });
            const fileName = `${baseName()}.rete`;
            app.download(new Blob([out.data], { type: out.mime }), fileName, out.mime);
            const g = await Rete.openBytes(out.data);
            const info = g.info();
            reteResult.innerHTML = "";
            const p = document.createElement("p");
            p.className = "rdf-check ok";
            p.textContent = `Built ${fileName}: ${info.quads} triples, ${info.terms} terms, ${(out.data.length / 1024).toFixed(1)} KB${withCard ? ", with a Dataset Card" : ""}.`;
            reteResult.appendChild(p);
            const hint = document.createElement("p");
            hint.className = "wb-note";
            hint.innerHTML = `Put it on any static host that serves HTTP range requests and query it with SPARQL from the <a href="${RETE_CONFIG.playground}" target="_blank" rel="noopener noreferrer">rete playground</a>, <code>rete query ${escapeHtml(fileName)}</code>, Python or JavaScript — no database server. <a href="${RETE_CONFIG.docs}" target="_blank" rel="noopener noreferrer">rete docs</a>`;
            reteResult.appendChild(hint);
        } catch (err) {
            reteResult.innerHTML = "";
            const p = document.createElement("p");
            p.className = "rdf-check fail";
            p.textContent = `Build failed: ${err.message}`;
            reteResult.appendChild(p);
        } finally {
            submit.disabled = false;
            submit.textContent = "Build & download";
        }
    });

    return { openFile, openUrl, newDocument, importRdf };
}
