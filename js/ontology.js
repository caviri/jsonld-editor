/* ==============================================
   JSON-LD Graph Visualization — Ontology workbench
   ==============================================

   The right-hand panel for designing ontologies by reuse:

     Find      search terms in the document, the bundled vocabularies, any
               vocabulary loaded through rete, OLS (EBI) and Wikidata; insert
               them, add them to the selected node, subclass or declare them.
     Create    classes, object/datatype properties, instances (pre-filled with
               the properties that apply to the chosen class) and an ontology
               header. While you type a name, existing terms with similar names
               are suggested so you reuse before you mint.
     Library   bundled and loadable vocabularies, custom URLs/files (.ttl, .nt,
               .jsonld, .rete) and a reuse report for the document.
     @context  prefixes and aliases of the document.

   All edits go through app.mutate(), so they are undoable in the editor.
*/

function createWorkbench(app) {
    const vocab = app.vocab;
    const wrapper = document.getElementById("workbench-wrapper");
    const toggleBtn = document.getElementById("workbench-toggle");
    const openBtn = document.getElementById("open-workbench-btn");
    const tabs = document.querySelectorAll(".wb-tab");
    const panes = document.querySelectorAll(".wb-pane");

    const KIND_CLASS = { C: "kind-class", O: "kind-object", D: "kind-datatype", A: "kind-annotation", P: "kind-property", T: "kind-dtype", I: "kind-individual" };
    const KIND_SHORT = { C: "Class", O: "Object prop.", D: "Data prop.", A: "Annotation", P: "Property", T: "Datatype", I: "Individual" };
    const OWL = "http://www.w3.org/2002/07/owl#";
    const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
    const XSD = "http://www.w3.org/2001/XMLSchema#";
    const TYPE_FOR_KIND = {
        C: OWL + "Class", O: OWL + "ObjectProperty", D: OWL + "DatatypeProperty", A: OWL + "AnnotationProperty",
        P: "http://www.w3.org/1999/02/22-rdf-syntax-ns#Property", T: RDFS + "Datatype", I: OWL + "NamedIndividual",
    };

    let activeTab = "find";
    const findState = { query: "", kind: "all", sources: { document: true, library: true, ols: false, wikidata: false }, forClass: null, forNode: null };
    let searchTimer = null;
    let remoteToken = 0;

    // ── Panel open/close ──────────────────────

    const toggleArrow = toggleBtn.querySelector(".toggle-arrow") || toggleBtn;
    makePanelResizable({
        wrapper,
        handle: document.getElementById("workbench-resize"),
        cssVar: "--workbench-width",
        edge: "left",
        min: 320,
        defaultWidth: 400,
        maxFn: () => document.getElementById("main-content").clientWidth - 360,
        storageKey: "jsonld-editor:workbench-width",
        onResize: () => app.refreshGraph(),
    });

    function isOpen() { return !wrapper.classList.contains("collapsed"); }
    function open(tab, opts = {}) {
        wrapper.classList.remove("collapsed");
        toggleArrow.textContent = "▶";
        if (tab) switchTab(tab);
        if (opts.find) applyFindOptions(opts.find);
        setTimeout(() => app.refreshGraph(), 320);
        vocab.loadBuiltin();
    }
    function close() {
        wrapper.classList.add("collapsed");
        toggleArrow.textContent = "◀";
        setTimeout(() => app.refreshGraph(), 320);
    }
    toggleBtn.addEventListener("click", () => (isOpen() ? close() : open()));
    if (openBtn) openBtn.addEventListener("click", () => open("find"));
    document.getElementById("workbench-close").addEventListener("click", close);

    function switchTab(tab) {
        activeTab = tab;
        tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
        panes.forEach(p => p.classList.toggle("active", p.dataset.pane === tab));
        if (tab === "find") { renderFind(); setTimeout(() => searchInput.focus(), 50); }
        if (tab === "library") renderLibrary();
        if (tab === "context") renderContext();
        if (tab === "create") refreshCreateForm();
    }
    tabs.forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));

    // ── Shared helpers ────────────────────────

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function compact(iri) {
        const model = app.getModel();
        if (!model) return iri;
        const c = JsonLd.compactIri(model.context, iri, { vocab: true, preferCurie: true });
        if (c !== iri) return c;
        const suggestion = vocab.suggestPrefix(iri);
        if (suggestion && iri.startsWith(suggestion[1])) return `${suggestion[0]}:${iri.slice(suggestion[1].length)}`;
        return iri;
    }

    function copyText(text) {
        try {
            navigator.clipboard.writeText(text).then(() => app.notify(`Copied ${text}`, "success"), () => app.notify("Clipboard not available", "warning"));
        } catch (_) {
            app.notify("Clipboard not available", "warning");
        }
    }

    function selectedNodeInfo() {
        const id = app.getSelectedNode();
        const model = app.getModel();
        if (!id || !model || app.getView() !== "instances") return null;
        const node = model.nodes.get(id);
        if (!node || node.definitions === 0) return null;
        return node;
    }

    // ── Term picker widget ────────────────────

    /**
     * A small autocomplete input that collects terms as chips.
     * opts: { kind, multiple, placeholder, onChange, extra: [{iri,label}] }
     */
    function createTermPicker(container, opts = {}) {
        const values = [];
        const root = el("div", "term-picker");
        const chips = el("div", "term-picker-chips");
        const input = el("input", "term-picker-input");
        input.type = "text";
        input.placeholder = opts.placeholder || "Search or type a CURIE / IRI…";
        input.autocomplete = "off";
        const dropdown = el("div", "term-picker-dropdown");
        root.appendChild(chips);
        root.appendChild(input);
        root.appendChild(dropdown);
        container.appendChild(root);
        let items = [];
        let active = -1;

        function renderChips() {
            chips.innerHTML = "";
            values.forEach((v, i) => {
                const chip = el("span", "term-chip");
                chip.title = v.iri;
                chip.appendChild(el("span", "", v.label || compact(v.iri)));
                const x = el("button", "term-chip-x", "×");
                x.type = "button";
                x.title = "Remove";
                x.addEventListener("click", () => { values.splice(i, 1); renderChips(); if (opts.onChange) opts.onChange(values); });
                chip.appendChild(x);
                chips.appendChild(chip);
            });
            input.style.display = !opts.multiple && values.length ? "none" : "";
        }

        function add(iri, label) {
            if (!iri || values.some(v => v.iri === iri)) return;
            if (!opts.multiple) values.length = 0;
            values.push({ iri, label: label || compact(iri) });
            input.value = "";
            dropdown.classList.remove("open");
            renderChips();
            if (opts.onChange) opts.onChange(values);
        }

        function resolveTyped(text) {
            const t = text.trim();
            if (!t) return null;
            if (/^[a-z][\w+.\-]*:\/\//i.test(t)) return t;
            const m = /^([A-Za-z][\w.\-]*):(.+)$/.exec(t);
            if (m) {
                const model = app.getModel();
                const expanded = model ? JsonLd.expandIri(model.context, t, { vocab: true }) : t;
                if (expanded !== t && JsonLd.isAbsoluteIri(expanded)) return expanded;
                const ns = vocab.namespaceForPrefix(m[1]);
                if (ns) return ns + m[2];
            }
            return null;
        }

        function renderDropdown() {
            dropdown.innerHTML = "";
            const q = input.value;
            const results = q.trim()
                ? vocab.search(q, { kind: opts.kind || "all", limit: 8 })
                : (opts.extra || []).map(e => ({ term: { iri: e.iri, label: e.label, kind: "T", vocabPrefix: "xsd", local: e.label }, source: "library" }));
            items = results.map(r => ({ iri: r.term.iri, label: r.term.label, kind: r.term.kind, source: r.source }));
            const typed = resolveTyped(q);
            if (typed && !items.some(i => i.iri === typed)) items.unshift({ iri: typed, label: compact(typed), kind: null, source: "typed" });
            if (!items.length) { dropdown.classList.remove("open"); return; }
            items.forEach((item, i) => {
                const row = el("div", "term-picker-item" + (i === active ? " active" : ""));
                if (item.kind) row.appendChild(el("span", `kind-dot ${KIND_CLASS[item.kind] || ""}`));
                row.appendChild(el("span", "term-picker-label", item.label));
                row.appendChild(el("span", "term-picker-curie", item.source === "typed" ? "use as typed" : compact(item.iri)));
                row.addEventListener("mousedown", e => { e.preventDefault(); add(item.iri, item.label); });
                dropdown.appendChild(row);
            });
            dropdown.classList.add("open");
        }

        input.addEventListener("input", () => { active = -1; renderDropdown(); });
        input.addEventListener("focus", () => { if (input.value || (opts.extra && opts.extra.length)) renderDropdown(); });
        input.addEventListener("blur", () => setTimeout(() => dropdown.classList.remove("open"), 150));
        input.addEventListener("keydown", e => {
            if (e.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); renderDropdown(); e.preventDefault(); }
            else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); renderDropdown(); e.preventDefault(); }
            else if (e.key === "Enter") {
                e.preventDefault();
                const pick = items[active >= 0 ? active : 0];
                if (pick) add(pick.iri, pick.label);
            } else if (e.key === "Backspace" && !input.value && values.length) {
                values.pop();
                renderChips();
                if (opts.onChange) opts.onChange(values);
            }
        });
        renderChips();
        return {
            get: () => values.map(v => v.iri),
            set: list => { values.length = 0; (list || []).forEach(iri => values.push({ iri, label: compact(iri) })); renderChips(); },
            add,
            clear: () => { values.length = 0; input.value = ""; renderChips(); },
            setKind: kind => { opts.kind = kind; },
            setExtra: extra => { opts.extra = extra; },
        };
    }

    // ── Find tab ──────────────────────────────

    const searchInput = document.getElementById("term-search");
    const resultsEl = document.getElementById("term-results");
    const kindChips = document.getElementById("term-kind-chips");
    const sourceChips = document.getElementById("term-source-chips");
    const contextBanner = document.getElementById("term-context-banner");

    kindChips.addEventListener("click", e => {
        const chip = e.target.closest("[data-kind]");
        if (!chip) return;
        findState.kind = chip.dataset.kind;
        kindChips.querySelectorAll("[data-kind]").forEach(c => c.classList.toggle("active", c === chip));
        renderFind();
    });
    sourceChips.addEventListener("click", e => {
        const chip = e.target.closest("[data-source]");
        if (!chip) return;
        const s = chip.dataset.source;
        findState.sources[s] = !findState.sources[s];
        chip.classList.toggle("active", findState.sources[s]);
        renderFind();
    });
    searchInput.addEventListener("input", () => {
        findState.query = searchInput.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(renderFind, 120);
    });
    searchInput.addEventListener("keydown", e => {
        if (e.key === "Escape") { searchInput.value = ""; findState.query = ""; renderFind(); }
    });

    function applyFindOptions(o) {
        if (o.query !== undefined) { findState.query = o.query; searchInput.value = o.query; }
        if (o.kind) {
            findState.kind = o.kind;
            kindChips.querySelectorAll("[data-kind]").forEach(c => c.classList.toggle("active", c.dataset.kind === o.kind));
        }
        findState.forClass = o.forClass || null;
        findState.forNode = o.forNode || null;
        renderFind();
    }

    function renderBanner() {
        contextBanner.innerHTML = "";
        const node = selectedNodeInfo();
        if (findState.forClass) {
            const box = el("div", "wb-banner");
            box.appendChild(el("span", "", `Properties that apply to ${compact(findState.forClass)}${findState.forNode ? " — “Add” puts them on the selected node" : ""}.`));
            const clear = el("button", "wb-link-btn", "Clear");
            clear.type = "button";
            clear.addEventListener("click", () => { findState.forClass = null; findState.forNode = null; renderFind(); });
            box.appendChild(clear);
            contextBanner.appendChild(box);
        } else if (node) {
            const box = el("div", "wb-banner subtle");
            box.textContent = `Selected: ${compact(node.id)} — classes can be added as @type, properties as new keys.`;
            contextBanner.appendChild(box);
        }
    }

    function termActions(term, source) {
        const actions = [];
        const node = selectedNodeInfo();
        const isClass = term.kind === "C";
        const isProp = ["O", "D", "A", "P"].includes(term.kind);
        actions.push({ label: "Insert", title: "Insert the term at the editor cursor (adds the prefix if needed)", run: () => app.insertTerm(term.iri) });
        if (node && isClass) actions.push({ label: "Use as type", title: `Add as @type of ${compact(node.id)}`, run: () => app.addTypeToNode(node.id, term.iri) });
        if (node && isProp) actions.push({ label: "Add to node", title: `Add ${compact(term.iri)} to ${compact(node.id)}`, run: () => app.addPropertyToNode(node.id, term.iri, term) });
        if (isClass) actions.push({ label: "Subclass…", title: "Create a new class that specialises this one", run: () => { prefillCreate({ kind: "C", super: [term.iri] }); switchTab("create"); } });
        if (isClass) actions.push({ label: "New instance…", title: "Create an instance of this class with its usual properties", run: () => { prefillCreate({ kind: "I", type: [term.iri] }); switchTab("create"); } });
        if (isProp) actions.push({ label: "Sub-property…", title: "Create a property that specialises this one", run: () => { prefillCreate({ kind: term.kind === "D" ? "D" : "O", superProp: [term.iri], domain: term.domain, range: term.range }); switchTab("create"); } });
        if (source !== "document" || (source === "document" && term.defined === false)) {
            actions.push({ label: "Declare", title: "Add a declaration of this term to the document (label, comment, rdfs:isDefinedBy)", run: () => app.declareTerm(term) });
        }
        actions.push({ label: "Copy", title: "Copy the full IRI", run: () => copyText(term.iri) });
        return actions;
    }

    function termCard(result) {
        const { term, source } = result;
        const card = el("div", "term-card");
        const head = el("div", "term-card-head");
        head.appendChild(el("span", `kind-badge ${KIND_CLASS[term.kind] || ""}`, KIND_SHORT[term.kind] || "Term"));
        const title = el("span", "term-card-label", term.label);
        head.appendChild(title);
        const curie = el("span", "term-card-curie", compact(term.iri));
        curie.title = term.iri;
        head.appendChild(curie);
        card.appendChild(head);

        const meta = el("div", "term-card-meta");
        const v = term.remoteSource || (source === "document" ? (term.defined ? "defined in this document" : `used ${term.uses || 0}× · not declared`) : ((vocab.listVocabularies().find(x => x.id === term.vocab) || {}).title || term.vocab));
        meta.appendChild(el("span", "term-card-vocab", v));
        if (term.flags === "p") meta.appendChild(el("span", "term-flag", "pending"));
        if (term.flags === "u") meta.appendChild(el("span", "term-flag", "unstable"));
        const href = safeHref(term.homepage || term.iri);
        if (href) {
            const a = el("a", "term-card-open", "↗");
            a.href = href;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.title = "Open the term's page";
            meta.appendChild(a);
        }
        card.appendChild(meta);

        if (term.comment) card.appendChild(el("div", "term-card-comment", term.comment));
        if (term.domain.length || term.range.length) {
            const dr = el("div", "term-card-dr");
            dr.textContent = `${term.domain.length ? term.domain.map(compact).join(" | ") : "∗"}  →  ${term.range.length ? term.range.map(compact).join(" | ") : "∗"}`;
            card.appendChild(dr);
        } else if (term.super.length) {
            card.appendChild(el("div", "term-card-dr", `⊑ ${term.super.map(compact).join(", ")}`));
        }

        const actions = el("div", "term-card-actions");
        termActions(term, source).forEach(a => {
            const b = el("button", "wb-mini-btn", a.label);
            b.type = "button";
            b.title = a.title;
            b.addEventListener("click", e => { e.stopPropagation(); a.run(); });
            actions.appendChild(b);
        });
        card.appendChild(actions);
        card.addEventListener("click", () => card.classList.toggle("expanded"));
        return card;
    }

    function section(title, count) {
        const h = el("div", "wb-section-title");
        h.appendChild(el("span", "", title));
        if (count !== undefined) h.appendChild(el("span", "wb-count", String(count)));
        return h;
    }

    function renderFind() {
        renderBanner();
        resultsEl.innerHTML = "";
        const q = findState.query.trim();

        if (!vocab.isReady()) {
            resultsEl.appendChild(el("p", "wb-note", "Loading the vocabulary index…"));
            vocab.loadBuiltin().then(ok => { if (activeTab === "find") renderFind(); if (!ok) resultsEl.innerHTML = '<p class="wb-note">The bundled vocabulary index could not be loaded (serve the app over HTTP).</p>'; });
        }

        // Properties for a class (no query): the reuse shortcut.
        if (findState.forClass && !q) {
            const props = vocab.propertiesForClass(findState.forClass);
            resultsEl.appendChild(section(`Properties for ${compact(findState.forClass)}`, props.length));
            if (!props.length) resultsEl.appendChild(el("p", "wb-note", "No properties declare this class (or its superclasses) as their domain. Search by name instead."));
            props.forEach(p => resultsEl.appendChild(termCard({ term: p.term, source: p.source })));
            return;
        }

        const local = vocab.search(q, {
            kind: findState.kind,
            sources: { document: findState.sources.document, library: findState.sources.library },
            limit: 60,
        });
        const docResults = local.filter(r => r.source === "document");
        const libResults = local.filter(r => r.source !== "document");
        if (findState.sources.document && (docResults.length || !q)) {
            resultsEl.appendChild(section("This document", docResults.length));
            if (!docResults.length) resultsEl.appendChild(el("p", "wb-note", "No classes or properties are declared in this document yet. Use Create, or Declare a reused term."));
            docResults.slice(0, q ? 20 : 40).forEach(r => resultsEl.appendChild(termCard(r)));
        }
        if (findState.sources.library && q) {
            resultsEl.appendChild(section("Vocabulary library", libResults.length));
            if (!libResults.length && vocab.isReady()) resultsEl.appendChild(el("p", "wb-note", "Nothing in the loaded vocabularies. Try OLS or Wikidata, or load more vocabularies in the Library tab."));
            libResults.forEach(r => resultsEl.appendChild(termCard(r)));
        }
        if (!q && !findState.forClass) {
            const tip = el("div", "wb-tips");
            tip.innerHTML = "<strong>Tips</strong><ul>" +
                "<li>Type a word (<em>creator</em>, <em>dataset</em>) or a prefixed name (<em>prov:was</em>, <em>schema:date</em>).</li>" +
                "<li>Select a node, then use its <em>Add property</em> button to see the properties that apply to its class.</li>" +
                "<li>Turn on OLS (270+ ontologies) or Wikidata for terms beyond the bundled vocabularies.</li>" +
                "<li>Ctrl+Space in the editor suggests the same terms inline.</li></ul>";
            resultsEl.appendChild(tip);
        }

        const token = ++remoteToken;
        ["ols", "wikidata"].forEach(service => {
            if (!findState.sources[service] || q.length < 2) return;
            const holder = el("div", "wb-remote");
            holder.appendChild(section(TERM_SEARCH_SERVICES[service].label));
            const status = el("p", "wb-note", "Searching…");
            holder.appendChild(status);
            resultsEl.appendChild(holder);
            vocab.searchRemote(service, q, findState.kind).then(list => {
                if (token !== remoteToken) return;
                status.remove();
                holder.querySelector(".wb-section-title").appendChild(el("span", "wb-count", String(list.length)));
                if (!list.length) holder.appendChild(el("p", "wb-note", "No results."));
                list.forEach(r => holder.appendChild(termCard(r)));
            }).catch(err => {
                if (token !== remoteToken) return;
                status.textContent = `${TERM_SEARCH_SERVICES[service].label} is not reachable: ${err.message}`;
            });
        });
    }

    // ── Create tab ────────────────────────────

    const form = document.getElementById("create-form");
    const kindSelect = document.getElementById("create-kind");
    const labelInput = document.getElementById("create-label");
    const nsSelect = document.getElementById("create-namespace");
    const localInput = document.getElementById("create-local");
    const iriPreview = document.getElementById("create-iri-preview");
    const commentInput = document.getElementById("create-comment");
    const reuseHint = document.getElementById("create-reuse-hint");
    const suggestedProps = document.getElementById("create-suggested-props");
    let localEdited = false;

    const pickers = {
        super: createTermPicker(document.getElementById("create-super"), { kind: "classes", multiple: true, placeholder: "e.g. schema:CreativeWork, prov:Entity" }),
        equivalent: createTermPicker(document.getElementById("create-equivalent"), { kind: "classes", multiple: true, placeholder: "Equivalent class (optional)" }),
        domain: createTermPicker(document.getElementById("create-domain"), { kind: "classes", multiple: true, placeholder: "Class(es) this property describes" }),
        range: createTermPicker(document.getElementById("create-range"), { kind: "classes", multiple: true, placeholder: "Class or datatype of the values" }),
        superProp: createTermPicker(document.getElementById("create-superprop"), { kind: "properties", multiple: true, placeholder: "e.g. dcterms:creator" }),
        inverse: createTermPicker(document.getElementById("create-inverse"), { kind: "properties", multiple: false, placeholder: "Inverse property (optional)" }),
        type: createTermPicker(document.getElementById("create-type"), { kind: "classes", multiple: true, placeholder: "Class of the instance", onChange: () => renderSuggestedProps() }),
    };
    const XSD_CHOICES = ["string", "integer", "decimal", "double", "boolean", "date", "dateTime", "gYear", "anyURI", "duration"]
        .map(n => ({ iri: XSD + n, label: `xsd:${n}` }));
    pickers.range.setExtra(XSD_CHOICES);

    function camel(text, upper) {
        const words = String(text || "").trim().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter(Boolean);
        return words.map((w, i) => {
            if (i === 0 && !upper) return w.charAt(0).toLowerCase() + w.slice(1);
            return w.charAt(0).toUpperCase() + w.slice(1);
        }).join("");
    }
    function slug(text) {
        return String(text || "").trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
    }

    function namespaceOptions() {
        const model = app.getModel();
        const opts = [];
        const seen = new Set();
        const push = (value, label, own) => { if (value && !seen.has(value)) { seen.add(value); opts.push({ value, label, own }); } };
        if (model) {
            const ctx = model.context;
            // Ontology's preferred namespace first.
            model.nodes.forEach(node => {
                if (!node.types.includes(OWL + "Ontology")) return;
                const ns = (node.props.get("http://purl.org/vocab/vann/preferredNamespaceUri") || [])[0];
                if (ns) push(ns.kind === "iri" ? ns.iri : ns.value, "ontology namespace", true);
            });
            if (ctx.vocab) push(ctx.vocab, "@vocab", true);
            JsonLd.prefixesOf(ctx).forEach(p => {
                const library = vocab.vocabularyFor(p.namespace);
                const own = !library || library.namespace !== p.namespace;
                push(p.namespace, `${p.prefix}:`, own);
            });
            if (ctx.base) push(ctx.base, "@base", true);
        }
        push(DEFAULT_NAMESPACE, "ex: (example namespace)", true);
        return opts.sort((a, b) => (b.own - a.own));
    }

    function refreshNamespaceSelect() {
        const current = nsSelect.value;
        nsSelect.innerHTML = "";
        namespaceOptions().forEach(o => {
            const opt = el("option", "", `${o.label}  ${o.value}`);
            opt.value = o.value;
            if (!o.own) opt.textContent += "  (external vocabulary)";
            nsSelect.appendChild(opt);
        });
        if (current && [...nsSelect.options].some(o => o.value === current)) nsSelect.value = current;
    }

    function currentKind() { return kindSelect.value; }

    function updateKindVisibility() {
        const kind = currentKind();
        form.querySelectorAll("[data-for]").forEach(row => {
            row.style.display = row.dataset.for.split(" ").includes(kind) ? "" : "none";
        });
        pickers.range.setKind(kind === "D" ? "datatypes" : "classes");
        pickers.range.setExtra(kind === "D" ? XSD_CHOICES : []);
        updateLocalName();
    }

    function updateLocalName() {
        const kind = currentKind();
        if (!localEdited) {
            const label = labelInput.value;
            localInput.value = kind === "C" ? camel(label, true) : kind === "I" ? slug(label) : kind === "H" ? "" : camel(label, false);
        }
        const ns = nsSelect.value;
        iriPreview.textContent = kind === "H" ? (localInput.value || ns.replace(/[#/]$/, "")) : (localInput.value ? ns + localInput.value : "—");
        renderReuseHint();
    }

    function renderReuseHint() {
        reuseHint.innerHTML = "";
        const kind = currentKind();
        const label = labelInput.value.trim();
        if (label.length < 3 || kind === "H" || kind === "I") return;
        const group = kind === "C" ? "classes" : "properties";
        // The whole label first, then its words — the last one is usually the head noun
        // ("research dataset" → dataset), which is what an existing term is named after.
        const seen = new Map();
        const consider = (query, minScore) => vocab.search(query, { kind: group, sources: { document: true, library: true }, limit: 8 })
            .filter(r => r.score >= minScore)
            .forEach(r => { if (!seen.has(r.term.iri) || seen.get(r.term.iri).score < r.score) seen.set(r.term.iri, r); });
        consider(label, 60);
        const words = splitCamel(label).split(/\s+/).filter(w => w.length >= 4);
        if (words.length > 1) {
            consider(words[words.length - 1], 95);
            words.slice(0, -1).forEach(w => consider(w, 100));
        }
        const hits = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 6);
        if (!hits.length) return;
        reuseHint.appendChild(el("div", "reuse-hint-title", "Existing terms with this name — reuse one, or specialise it:"));
        hits.forEach(r => {
            const row = el("div", "reuse-hint-row");
            row.appendChild(el("span", `kind-dot ${KIND_CLASS[r.term.kind] || ""}`));
            const name = el("span", "reuse-hint-name", compact(r.term.iri));
            name.title = r.term.comment || r.term.iri;
            row.appendChild(name);
            if (r.term.comment) row.appendChild(el("span", "reuse-hint-comment", r.term.comment));
            const spec = el("button", "wb-mini-btn", kind === "C" ? "Subclass it" : "Sub-property");
            spec.type = "button";
            spec.addEventListener("click", () => (kind === "C" ? pickers.super : pickers.superProp).add(r.term.iri, compact(r.term.iri)));
            row.appendChild(spec);
            const use = el("button", "wb-mini-btn", "Find it");
            use.type = "button";
            use.addEventListener("click", () => { switchTab("find"); applyFindOptions({ query: compact(r.term.iri), kind: group }); });
            row.appendChild(use);
            reuseHint.appendChild(row);
        });
    }

    function renderSuggestedProps() {
        suggestedProps.innerHTML = "";
        const types = pickers.type.get();
        if (!types.length) {
            suggestedProps.appendChild(el("p", "wb-note", "Pick a class to see the properties that apply to it."));
            return;
        }
        const seen = new Set();
        const list = [];
        types.forEach(t => vocab.propertiesForClass(t, 400).forEach(p => { if (!seen.has(p.term.iri)) { seen.add(p.term.iri); list.push(p); } }));
        if (!list.length) {
            suggestedProps.appendChild(el("p", "wb-note", "No declared properties for this class. You can add properties after creating the instance."));
            return;
        }
        // Own properties (domain = the class itself) are pre-selected; inherited ones are offered.
        const own = list.filter(p => !p.generic && p.depth === 0);
        const inherited = list.filter(p => !p.generic && p.depth > 0);
        const generic = list.filter(p => p.generic);
        const renderGroup = (title, group, checkAll) => {
            if (!group.length) return;
            suggestedProps.appendChild(el("div", "wb-subtitle", `${title} (${group.length})`));
            group.slice(0, 60).forEach(p => {
                const row = el("label", "suggested-prop");
                const cb = el("input");
                cb.type = "checkbox";
                cb.value = p.term.iri;
                cb.checked = checkAll && own.length <= 12;
                row.appendChild(cb);
                row.appendChild(el("span", "suggested-prop-name", compact(p.term.iri)));
                if (p.term.range.length) row.appendChild(el("span", "suggested-prop-range", p.term.range.map(compact).join(" | ")));
                row.title = p.term.comment || "";
                suggestedProps.appendChild(row);
            });
        };
        renderGroup("Declared for this class", own, true);
        renderGroup("Inherited from superclasses", inherited, false);
        renderGroup("Generic (Thing)", generic, false);
        // Pre-check one name/label property so the label has somewhere to go.
        const nameBox = [...suggestedProps.querySelectorAll("input")].find(cb => /(#|\/)(name|title|prefLabel)$/.test(cb.value));
        if (nameBox) nameBox.checked = true;
    }

    function prefillCreate(o) {
        resetCreate();
        if (o.kind) kindSelect.value = o.kind;
        if (o.label) labelInput.value = o.label;
        if (o.local) { localInput.value = o.local; localEdited = true; }
        if (o.namespace) {
            refreshNamespaceSelect();
            if (![...nsSelect.options].some(x => x.value === o.namespace)) {
                const opt = el("option", "", o.namespace);
                opt.value = o.namespace;
                nsSelect.appendChild(opt);
            }
            nsSelect.value = o.namespace;
        }
        if (o.comment) commentInput.value = o.comment;
        if (o.super) pickers.super.set(o.super);
        if (o.superProp) pickers.superProp.set(o.superProp);
        if (o.domain) pickers.domain.set(o.domain);
        if (o.range) pickers.range.set(o.range);
        if (o.type) pickers.type.set(o.type);
        updateKindVisibility();
        renderSuggestedProps();
    }

    function resetCreate() {
        labelInput.value = "";
        localInput.value = "";
        commentInput.value = "";
        localEdited = false;
        Object.values(pickers).forEach(p => p.clear());
        form.querySelectorAll("input[type=text].header-field, input[type=url].header-field").forEach(i => { i.value = ""; });
        document.getElementById("create-functional").checked = false;
        reuseHint.innerHTML = "";
        refreshNamespaceSelect();
        updateKindVisibility();
        renderSuggestedProps();
    }

    function refreshCreateForm() {
        refreshNamespaceSelect();
        updateKindVisibility();
        if (currentKind() === "I") renderSuggestedProps();
    }

    kindSelect.addEventListener("change", () => { localEdited = false; updateKindVisibility(); if (currentKind() === "I") renderSuggestedProps(); });
    labelInput.addEventListener("input", updateLocalName);
    localInput.addEventListener("input", () => { localEdited = Boolean(localInput.value); updateLocalName(); });
    nsSelect.addEventListener("change", updateLocalName);
    document.getElementById("create-reset").addEventListener("click", resetCreate);

    form.addEventListener("submit", e => {
        e.preventDefault();
        const kind = currentKind();
        const label = labelInput.value.trim();
        const ns = nsSelect.value;
        const local = localInput.value.trim();
        if (kind === "H") {
            const iri = local || ns.replace(/[#/]$/, "");
            app.createOntologyHeader({
                iri,
                namespace: ns,
                title: label,
                description: commentInput.value.trim(),
                version: document.getElementById("create-version").value.trim(),
                license: document.getElementById("create-license").value.trim(),
                creator: document.getElementById("create-creator").value.trim(),
                prefix: document.getElementById("create-prefix").value.trim(),
            });
            return;
        }
        if (!label && !local) { app.notify("Give the new term a label (or a local name).", "warning"); labelInput.focus(); return; }
        if (!local) { app.notify("The local name is empty.", "warning"); return; }
        const iri = ns + local;
        if (/[\s<>"{}|\\^`]/.test(local)) { app.notify("The local name contains characters that are not allowed in an IRI.", "warning"); return; }
        const spec = { kind, iri, namespace: ns, label, comment: commentInput.value.trim() };
        if (kind === "C") { spec.super = pickers.super.get(); spec.equivalent = pickers.equivalent.get(); }
        if (kind === "O" || kind === "D") {
            spec.domain = pickers.domain.get();
            spec.range = pickers.range.get();
            spec.superProp = pickers.superProp.get();
            spec.inverse = kind === "O" ? pickers.inverse.get() : [];
            spec.functional = document.getElementById("create-functional").checked;
        }
        if (kind === "I") {
            spec.types = pickers.type.get();
            spec.properties = [...suggestedProps.querySelectorAll("input:checked")].map(cb => cb.value);
        }
        if (app.createTerm(spec)) {
            localEdited = false;
            labelInput.value = "";
            commentInput.value = "";
            localInput.value = "";
            Object.values(pickers).forEach(p => p.clear());
            updateLocalName();
            renderSuggestedProps();
        }
    });

    // ── Library tab ───────────────────────────

    const libraryEl = document.getElementById("library-content");

    function reuseReport() {
        const model = app.getModel();
        if (!model) return null;
        const uses = new Map(); // namespace -> { terms:Set, uses }
        const note = (iri) => {
            if (!JsonLd.isAbsoluteIri(iri) || iri.startsWith("urn:unmapped:")) return;
            const v = vocab.vocabularyFor(iri);
            const key = v ? v.id : JsonLd.namespaceOf(iri);
            const entry = uses.get(key) || { title: v ? v.title : key, vocab: v, terms: new Set(), uses: 0, unknown: 0 };
            entry.terms.add(iri);
            entry.uses += 1;
            uses.set(key, entry);
        };
        model.nodes.forEach(node => {
            node.types.forEach(note);
            node.props.forEach((values, pred) => note(pred));
        });
        let reused = 0;
        let total = 0;
        uses.forEach(entry => {
            entry.known = 0;
            entry.terms.forEach(t => { total += 1; if (vocab.isKnownTerm(t)) { reused += 1; entry.known += 1; } });
        });
        return { uses: [...uses.values()].sort((a, b) => b.terms.size - a.terms.size), reused, total };
    }

    function renderLibrary() {
        libraryEl.innerHTML = "";

        // Reuse report
        const report = reuseReport();
        if (report && report.total) {
            const card = el("div", "wb-card");
            card.appendChild(el("div", "wb-card-title", "Reuse report"));
            const pct = Math.round((report.reused / report.total) * 100);
            const bar = el("div", "reuse-bar");
            const fill = el("div", "reuse-bar-fill");
            fill.style.width = `${pct}%`;
            bar.appendChild(fill);
            card.appendChild(bar);
            card.appendChild(el("p", "wb-note", `${report.reused} of ${report.total} distinct classes and properties (${pct}%) come from established vocabularies. The rest are minted in this document or in vocabularies the editor doesn't know.`));
            const table = el("table", "wb-table");
            report.uses.forEach(u => {
                const tr = el("tr");
                tr.appendChild(el("td", "", u.vocab ? u.title : u.title));
                tr.appendChild(el("td", "num", `${u.terms.size} term${u.terms.size === 1 ? "" : "s"}`));
                tr.appendChild(el("td", u.vocab ? "ok" : "warn", u.vocab ? (u.known === u.terms.size ? "✓ all known" : `${u.terms.size - u.known} unknown`) : "local / unknown"));
                table.appendChild(tr);
            });
            card.appendChild(table);
            libraryEl.appendChild(card);
        }

        // Engine status
        const engine = el("div", "wb-card");
        engine.appendChild(el("div", "wb-card-title", "rete engine"));
        const st = Rete.getState();
        engine.appendChild(el("p", "wb-note", st === "ready" ? `Loaded (rete-graph ${RETE_CONFIG.version}). Vocabularies, SPARQL, SHACL and exports run in this tab.`
            : st === "loading" ? "Loading…" : `Not loaded yet. It loads on demand (≈8.5 MB WebAssembly, rete-graph ${RETE_CONFIG.version}) when you load a vocabulary, query, validate or export.`));
        libraryEl.appendChild(engine);

        // Bundled + live vocabularies
        const list = vocab.listVocabularies();
        const loaded = el("div", "wb-card");
        loaded.appendChild(el("div", "wb-card-title", `Loaded vocabularies (${list.length})`));
        list.forEach(v => {
            const row = el("div", "vocab-row");
            const name = el("div", "vocab-name");
            name.appendChild(el("strong", "", v.title));
            name.appendChild(el("span", "vocab-ns", `${v.prefix}: ${v.namespace}`));
            row.appendChild(name);
            row.appendChild(el("span", "wb-count", String(v.count)));
            const add = el("button", "wb-mini-btn", "+ prefix");
            add.type = "button";
            add.title = `Add "${v.prefix}" to the document's @context`;
            add.addEventListener("click", () => app.addPrefix(v.prefix, v.namespace));
            row.appendChild(add);
            const browse = el("button", "wb-mini-btn", "Browse");
            browse.type = "button";
            browse.addEventListener("click", () => { switchTab("find"); applyFindOptions({ query: `${v.prefix}:`, kind: "all" }); });
            row.appendChild(browse);
            if (v.origin !== "builtin") {
                const rm = el("button", "wb-mini-btn danger", "Remove");
                rm.type = "button";
                rm.addEventListener("click", () => { vocab.removeVocabulary(v.id); renderLibrary(); });
                row.appendChild(rm);
            }
            loaded.appendChild(row);
        });
        libraryEl.appendChild(loaded);

        // Catalog
        const catalog = el("div", "wb-card");
        catalog.appendChild(el("div", "wb-card-title", "Load more vocabularies"));
        catalog.appendChild(el("p", "wb-note", "Fetched from their publishers and parsed in the browser by rete. Kept in this browser for next time."));
        VOCAB_CATALOG.forEach(entry => {
            const isLoaded = list.some(v => v.namespace === entry.namespace);
            const row = el("div", "vocab-row");
            const name = el("div", "vocab-name");
            name.appendChild(el("strong", "", entry.title));
            name.appendChild(el("span", "vocab-ns", `${entry.prefix}: ${entry.namespace}`));
            row.appendChild(name);
            const btn = el("button", "wb-mini-btn" + (isLoaded ? "" : " primary"), isLoaded ? "Reload" : "Load");
            btn.type = "button";
            btn.addEventListener("click", () => loadVocabulary(entry, btn));
            row.appendChild(btn);
            catalog.appendChild(row);
        });
        libraryEl.appendChild(catalog);

        // Custom
        const custom = el("div", "wb-card");
        custom.appendChild(el("div", "wb-card-title", "Your own vocabulary"));
        custom.appendChild(el("p", "wb-note", "Any ontology as Turtle, N-Triples, JSON-LD or a .rete file — e.g. your team's shared ontology, so its terms show up in search and autocomplete."));
        const urlRow = el("div", "wb-inline");
        const urlInput = el("input", "wb-input");
        urlInput.type = "url";
        urlInput.placeholder = "https://… (.ttl, .nt, .jsonld, .rete)";
        const urlBtn = el("button", "wb-mini-btn primary", "Load URL");
        urlBtn.type = "button";
        urlBtn.addEventListener("click", () => {
            const url = urlInput.value.trim();
            if (!/^https?:\/\//.test(url)) { app.notify("Enter an http(s) URL.", "warning"); return; }
            loadVocabulary({ url }, urlBtn);
        });
        urlRow.appendChild(urlInput);
        urlRow.appendChild(urlBtn);
        custom.appendChild(urlRow);
        const fileRow = el("div", "wb-inline");
        const fileInput = el("input");
        fileInput.type = "file";
        fileInput.accept = ".ttl,.nt,.nq,.trig,.jsonld,.json,.rete";
        fileInput.style.display = "none";
        const fileBtn = el("button", "wb-mini-btn", "Load file…");
        fileBtn.type = "button";
        fileBtn.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", async () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file) return;
            const format = Rete.formatFromName(file.name) || "ttl";
            const contents = format === "rete" ? new Uint8Array(await file.arrayBuffer()) : await file.text();
            loadVocabulary({ name: file.name, format }, fileBtn, contents);
            fileInput.value = "";
        });
        const docBtn = el("button", "wb-mini-btn", "Use this document");
        docBtn.type = "button";
        docBtn.title = "Add the classes and properties of the open document to the library";
        docBtn.addEventListener("click", () => loadVocabulary({ name: "this-document.jsonld", format: "jsonld", title: app.getFileName() }, docBtn, app.getTextForEngine()));
        fileRow.appendChild(fileBtn);
        fileRow.appendChild(fileInput);
        fileRow.appendChild(docBtn);
        custom.appendChild(fileRow);
        libraryEl.appendChild(custom);
    }

    async function loadVocabulary(entry, button, contents) {
        const label = button.textContent;
        button.disabled = true;
        button.textContent = Rete.getState() === "ready" ? "Loading…" : "Loading engine…";
        try {
            const v = await vocab.loadLive(entry, contents);
            app.notify(`Loaded ${v.title}: ${v.count} terms.`, "success");
            app.relint();
        } catch (err) {
            app.notify(`Could not load vocabulary: ${err.message}`, "error");
        } finally {
            button.disabled = false;
            button.textContent = label;
            if (activeTab === "library") renderLibrary();
        }
    }

    // ── @context tab ──────────────────────────

    const contextEl = document.getElementById("context-content");

    function renderContext() {
        contextEl.innerHTML = "";
        const model = app.getModel();
        if (!model) return;
        const ctx = model.context;

        const basics = el("div", "wb-card");
        basics.appendChild(el("div", "wb-card-title", "Defaults"));
        const t = el("table", "wb-table");
        [["@vocab", ctx.vocab || "—"], ["@base", ctx.base || "—"], ["@language", ctx.language || "—"]].forEach(([k, v]) => {
            const tr = el("tr");
            tr.appendChild(el("td", "mono", k));
            tr.appendChild(el("td", "mono", v));
            t.appendChild(tr);
        });
        basics.appendChild(t);
        contextEl.appendChild(basics);

        // Prefixes in use
        const counts = new Map();
        const prefixes = JsonLd.prefixesOf(ctx);
        const countNs = iri => { const p = prefixes.find(x => iri.startsWith(x.namespace)); if (p) counts.set(p.prefix, (counts.get(p.prefix) || 0) + 1); };
        model.nodes.forEach(node => {
            countNs(node.id);
            node.types.forEach(countNs);
            node.props.forEach((values, pred) => { countNs(pred); values.forEach(v => { if (v.kind === "iri") countNs(v.iri); }); });
        });

        const card = el("div", "wb-card");
        card.appendChild(el("div", "wb-card-title", `Prefixes (${prefixes.length})`));
        const table = el("table", "wb-table");
        prefixes.slice().sort((a, b) => a.prefix.localeCompare(b.prefix)).forEach(p => {
            const tr = el("tr");
            tr.appendChild(el("td", "mono strong", p.prefix));
            tr.appendChild(el("td", "mono", p.namespace));
            tr.appendChild(el("td", "num", String(counts.get(p.prefix) || 0)));
            const td = el("td");
            const known = vocab.vocabularyFor(p.namespace);
            if (known && known.namespace === p.namespace) td.appendChild(el("span", "ok", "✓"));
            tr.appendChild(td);
            table.appendChild(tr);
        });
        card.appendChild(table);
        const addRow = el("div", "wb-inline");
        const pIn = el("input", "wb-input short");
        pIn.placeholder = "prefix";
        const nIn = el("input", "wb-input");
        nIn.placeholder = "namespace IRI";
        pIn.setAttribute("list", "common-prefix-list");
        pIn.addEventListener("input", () => { const ns = vocab.namespaceForPrefix(pIn.value.trim()); if (ns && !nIn.value) nIn.value = ns; });
        const addBtn = el("button", "wb-mini-btn primary", "Add");
        addBtn.type = "button";
        addBtn.addEventListener("click", () => {
            const p = pIn.value.trim();
            const n = nIn.value.trim();
            if (!/^[A-Za-z][\w.\-]*$/.test(p) || !JsonLd.isAbsoluteIri(n)) { app.notify("Enter a prefix (letters, digits, - _ .) and an absolute namespace IRI.", "warning"); return; }
            app.addPrefix(p, n);
        });
        addRow.appendChild(pIn);
        addRow.appendChild(nIn);
        addRow.appendChild(addBtn);
        card.appendChild(addRow);
        contextEl.appendChild(card);

        // Namespaces used with full IRIs but no prefix
        const missing = new Map();
        const noteMissing = iri => {
            if (!JsonLd.isAbsoluteIri(iri) || prefixes.some(p => iri.startsWith(p.namespace))) return;
            const s = vocab.suggestPrefix(iri);
            if (s && !ctx.terms[s[0]]) missing.set(s[0], s[1]);
        };
        model.nodes.forEach(node => { node.types.forEach(noteMissing); node.props.forEach((values, pred) => noteMissing(pred)); });
        if (missing.size) {
            const sug = el("div", "wb-card");
            sug.appendChild(el("div", "wb-card-title", "Suggested prefixes"));
            sug.appendChild(el("p", "wb-note", "These namespaces are written as full IRIs. A prefix makes the document shorter and easier to read."));
            missing.forEach((ns, p) => {
                const row = el("div", "vocab-row");
                row.appendChild(el("span", "mono", `${p}: ${ns}`));
                const b = el("button", "wb-mini-btn", "Add");
                b.type = "button";
                b.addEventListener("click", () => app.addPrefix(p, ns));
                row.appendChild(b);
                sug.appendChild(row);
            });
            contextEl.appendChild(sug);
        }

        // Aliases
        const aliases = Object.entries(ctx.terms).filter(([term, def]) => def && def.id && !term.includes(":") && !(def.prefix && /[#/:]$/.test(def.id)));
        if (aliases.length) {
            const card2 = el("div", "wb-card");
            card2.appendChild(el("div", "wb-card-title", `Term aliases (${aliases.length})`));
            const t2 = el("table", "wb-table");
            aliases.slice(0, 200).forEach(([term, def]) => {
                const tr = el("tr");
                tr.appendChild(el("td", "mono strong", term));
                tr.appendChild(el("td", "mono", compact(def.id)));
                tr.appendChild(el("td", "mono muted", def.type ? (def.type === "@id" ? "→ IRI" : compact(def.type)) : ""));
                t2.appendChild(tr);
            });
            card2.appendChild(t2);
            contextEl.appendChild(card2);
        }
    }

    // Prefix datalist for the @context tab.
    const datalist = document.createElement("datalist");
    datalist.id = "common-prefix-list";
    Object.keys(COMMON_PREFIXES).forEach(p => { const o = document.createElement("option"); o.value = p; datalist.appendChild(o); });
    document.body.appendChild(datalist);

    vocab.onChange(() => {
        if (!isOpen()) return;
        if (activeTab === "find") renderFind();
        if (activeTab === "library") renderLibrary();
    });

    return {
        open,
        close,
        isOpen,
        switchTab,
        findTerms: (o) => { open("find"); applyFindOptions(o || {}); },
        createTerm: (o) => { open("create"); prefillCreate(o || {}); },
        onDocumentChanged: () => {
            if (!isOpen()) return;
            if (activeTab === "context") renderContext();
            if (activeTab === "library") renderLibrary();
            if (activeTab === "find") renderBanner();
            if (activeTab === "create") refreshNamespaceSelect();
        },
        onSelectionChanged: () => { if (isOpen() && activeTab === "find") renderFind(); },
    };
}
