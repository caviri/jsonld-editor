/* ==============================================
   JSON-LD Graph Visualization — WebMCP agent tools
   ==============================================

   Exposes the editor to AI agents running in the browser through WebMCP
   (https://webmachinelearning.github.io/webmcp/): every tool below is
   registered with document.modelContext.registerTool(), so an agent can read
   the document, search vocabularies, design the ontology, add instances,
   query, validate and export — on the user's behalf, in the user's page.

   Safety model
     • Read tools are annotated readOnlyHint; tools that return document or
       remote text are annotated untrustedContentHint (the content may carry
       instructions that are not the user's).
     • Edit tools go through app.mutate(), so every change is a normal editor
       edit: visible, undoable with Ctrl+Z, autosaved.
     • The user can switch off edits (or all tools) in the 🤖 Agents tab;
       every call is logged there and announced in a toast.
     • Tools that replace the document or write a file are consequentialHint.

   Availability
     • Native: Chrome with the WebMCP origin trial or
       chrome://flags/#enable-webmcp-testing (needs https:// or localhost).
     • Bridge: the opt-in MCP-B script (@mcp-b/global) adds a polyfill where
       there is no native support and connects the MCP-B browser extension.
*/

function createAgentTools(app) {
    const STORAGE_KEY = "jsonld-editor:agents";
    const OWL = "http://www.w3.org/2002/07/owl#";
    const VANN = "http://purl.org/vocab/vann/";
    const XSD = "http://www.w3.org/2001/XMLSchema#";
    const KIND_NAMES = { C: "class", O: "object property", D: "datatype property", A: "annotation property", P: "property", T: "datatype", I: "individual" };
    const MAX_TEXT = WEBMCP_CONFIG.maxTextChars || 60000;

    const settings = Object.assign({ expose: true, allowEdits: true, bridge: false }, readSettings());
    let controller = null;
    let registered = 0;
    let status = "idle";
    let statusDetail = "";
    let bridgeLoaded = false;
    let calls = 0;
    const log = [];

    function readSettings() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch (_) { return {}; }
    }
    function saveSettings() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) { /* storage blocked */ }
    }

    // Origin-trial token (so the deployed site gets native WebMCP without a flag).
    if (WEBMCP_CONFIG.originTrialToken && !document.querySelector('meta[http-equiv="origin-trial"]')) {
        const meta = document.createElement("meta");
        meta.httpEquiv = "origin-trial";
        meta.content = WEBMCP_CONFIG.originTrialToken;
        document.head.appendChild(meta);
    }

    // ── Helpers ───────────────────────────────

    const ok = (data = {}) => Object.assign({ ok: true }, data);
    const fail = (error, extra = {}) => Object.assign({ ok: false, error }, extra);
    const model = () => app.getModel();
    const context = () => model().context;
    const truncate = (text, max = MAX_TEXT, offset = 0) => {
        const s = String(text || "");
        const slice = s.slice(offset, offset + max);
        return { text: slice, totalChars: s.length, offset, truncated: offset + slice.length < s.length };
    };

    function compact(iri) {
        if (!iri) return iri;
        const c = JsonLd.compactIri(context(), iri, { vocab: true, preferCurie: true });
        if (c !== iri) return c;
        const s = app.vocab.suggestPrefix(iri);
        if (s && iri.startsWith(s[1]) && /^[\w.\-]+$/.test(iri.slice(s[1].length))) return `${s[0]}:${iri.slice(s[1].length)}`;
        return iri;
    }

    /** A node IRI as the document would write it (relative to @base, or a prefixed name). */
    function compactNode(iri) {
        if (!iri) return iri;
        const c = JsonLd.compactIri(context(), iri);
        return c !== iri ? c : compact(iri);
    }

    /** A class/property/datatype reference (CURIE, IRI, or @context alias) → absolute IRI, or null. */
    function resolveTerm(str) {
        if (!str || typeof str !== "string") return null;
        const s = str.trim().replace(/^<|>$/g, "");
        if (/^[a-z][\w+.\-]*:\/\//i.test(s) || /^urn:/i.test(s)) return s;
        const ctx = context();
        const m = /^([A-Za-z][\w.\-]*):(.+)$/.exec(s);
        if (m) {
            const def = ctx.terms[m[1]];
            if (def && def.id && /[#/:]$/.test(def.id)) return def.id + m[2];
            const ns = app.vocab.namespaceForPrefix(m[1]);
            return ns ? ns + m[2] : null;
        }
        const def = ctx.terms[s];
        if (def && def.id && JsonLd.isAbsoluteIri(def.id)) return def.id;
        return null;
    }

    /** A node reference (IRI, CURIE, raw @id as written, or relative to @base) → node IRI in the model, or null. */
    function resolveNode(str) {
        if (!str || typeof str !== "string") return null;
        const m = model();
        const s = str.trim().replace(/^<|>$/g, "");
        if (m.nodes.has(s)) return s;
        if (m.rawIdIndex.has(s) && m.nodes.has(m.rawIdIndex.get(s))) return m.rawIdIndex.get(s);
        const term = resolveTerm(s);
        if (term && m.nodes.has(term)) return term;
        const rel = JsonLd.expandIri(context(), s, { documentRelative: true });
        if (m.nodes.has(rel)) return rel;
        return null;
    }

    /** Node reference for a value: existing node, else CURIE/IRI, else relative to @base. */
    function resolveRef(str) {
        const node = resolveNode(str);
        if (node) return node;
        const term = resolveTerm(str);
        if (term) return term;
        const rel = JsonLd.expandIri(context(), String(str).trim(), { documentRelative: true });
        return JsonLd.isAbsoluteIri(rel) ? rel : null;
    }

    function resolveNamespace(input) {
        if (!input) return null;
        const s = String(input).trim();
        if (/^[a-z][\w+.\-]*:\/\//i.test(s) || /^urn:/i.test(s)) return s;
        const prefix = s.replace(/:$/, "");
        const def = context().terms[prefix];
        if (def && def.id) return def.id;
        return app.vocab.namespaceForPrefix(prefix);
    }

    function defaultNamespace() {
        const m = model();
        const ctx = m.context;
        let ns = null;
        m.nodes.forEach(node => {
            if (ns || !node.types.includes(OWL + "Ontology")) return;
            const v = (node.props.get(VANN + "preferredNamespaceUri") || [])[0];
            if (v) ns = v.kind === "iri" ? v.iri : v.value;
        });
        if (ns) return ns;
        if (ctx.vocab) return ctx.vocab;
        const common = new Set(Object.values(COMMON_PREFIXES));
        const own = JsonLd.prefixesOf(ctx).find(p => {
            const v = app.vocab.vocabularyFor(p.namespace);
            return (!v || v.namespace !== p.namespace) && !common.has(p.namespace);
        });
        return own ? own.namespace : DEFAULT_NAMESPACE;
    }

    function camel(text, upper) {
        const words = String(text || "").trim().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter(Boolean);
        return words.map((w, i) => (i === 0 && !upper ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join("");
    }
    function slug(text) {
        return String(text || "").trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
    }

    function resolveTerms(list, what) {
        const out = [];
        for (const item of [].concat(list || [])) {
            const iri = resolveTerm(item);
            if (!iri) throw new Error(`Unknown ${what} "${item}". Use a prefixed name with a known prefix (e.g. schema:Person) or a full IRI; search_terms finds terms.`);
            out.push(iri);
        }
        return out;
    }

    /** Agent-supplied value → JSON-LD value for the document. */
    function toJsonLd(w, v) {
        if (Array.isArray(v)) return v.map(x => toJsonLd(w, x));
        if (v === null || v === undefined) throw new Error("Values cannot be null.");
        if (typeof v === "object") {
            if (typeof v["@id"] === "string") {
                const iri = resolveRef(v["@id"]);
                if (!iri) throw new Error(`Cannot resolve the link target "${v["@id"]}".`);
                return { "@id": w.id(iri) };
            }
            if ("@value" in v) {
                const out = { "@value": v["@value"] };
                if (v["@language"]) out["@language"] = String(v["@language"]);
                else if (v["@type"]) {
                    const dt = resolveTerm(v["@type"]);
                    if (!dt) throw new Error(`Unknown datatype "${v["@type"]}".`);
                    out["@type"] = w.key(dt);
                }
                return out;
            }
            throw new Error('Object values must be a link {"@id": "…"} or a literal {"@value": …, "@language" or "@type": …}.');
        }
        return v;
    }

    function describeValue(v) {
        const m = model();
        if (v.kind === "iri") {
            const target = m.nodes.get(v.iri);
            return target && target.definitions > 0
                ? { "@id": compact(v.iri), label: extractNodeLabel(target, context()) }
                : { "@id": compact(v.iri) };
        }
        if (v.kind === "list") return { "@list": v.items.map(describeValue) };
        if (v.linksTo) return { "@value": v.value, note: `plain string that names the node ${compact(v.linksTo)}` };
        if (v.lang) return { "@value": v.value, "@language": v.lang };
        if (v.datatype && v.datatype !== XSD + "string") return { "@value": v.value, "@type": compact(v.datatype) };
        return v.value;
    }

    function termInfo(t, source) {
        return {
            iri: t.iri,
            curie: compact(t.iri),
            label: t.label,
            kind: KIND_NAMES[t.kind] || t.kind,
            source: t.remoteSource || (source === "document" ? (t.defined ? "this document" : "used in this document, not declared") : (app.vocab.listVocabularies().find(v => v.id === t.vocab) || {}).title || t.vocab),
            description: t.comment ? t.comment.slice(0, 300) : undefined,
            domain: t.domain && t.domain.length ? t.domain.map(compact) : undefined,
            range: t.range && t.range.length ? t.range.map(compact) : undefined,
            superTerms: t.super && t.super.length ? t.super.map(compact) : undefined,
        };
    }

    function hashKey(text) {
        let h = 2166136261;
        for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
        return (h >>> 0).toString(36);
    }
    const problemId = p => `${p.code}-${hashKey(p.message)}`;
    const AGENT_FIXES = new Set(["add-prefix", "coerce-id", "replace-term"]);

    function similarTerms(label, kind, exclude) {
        const seen = new Map();
        const add = (q, min) => app.vocab.search(q, { kind, limit: 6 }).forEach(r => { if (r.score >= min && r.term.iri !== exclude && !seen.has(r.term.iri)) seen.set(r.term.iri, r.score); });
        add(label, 80);
        const words = String(label).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4);
        if (words.length > 1) add(words[words.length - 1], 95);
        return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([iri]) => compact(iri));
    }

    function nodeExists(iri) {
        const n = model().nodes.get(iri);
        return Boolean(n && n.definitions > 0);
    }

    function rowsFromEnvelope(env, limit) {
        const short = tok => {
            const t = Rete.parseTerm(tok);
            if (t.kind === "iri") return compact(t.value);
            if (t.kind === "literal") return t.lang ? `${t.value}@${t.lang}` : t.value;
            return tok;
        };
        return env.rows.slice(0, limit).map(row => {
            const out = {};
            env.vars.forEach(v => { if (row[v] !== undefined) out[v] = short(row[v]); });
            return out;
        });
    }

    // ── Tool definitions ──────────────────────

    const STR = (description, extra = {}) => Object.assign({ type: "string", description }, extra);
    const ARR = (description) => ({ type: "array", items: { type: "string" }, description });
    const INT = (description, def) => ({ type: "integer", description, minimum: 0, default: def });
    const VALUE_SCHEMA = {
        description: 'A literal (string, number, boolean), a link {"@id": "prefix:local or IRI"}, a literal with language {"@value": "…", "@language": "en"} or datatype {"@value": "…", "@type": "xsd:date"}, or an array of these.',
    };

    const TOOLS = [
        // ── Read ──
        {
            name: "get_document_overview",
            title: "Document overview",
            description: "Summary of the JSON-LD document open in the editor: name, node and link counts, types with counts, prefixes, @vocab/@base, ontology terms and SHACL shapes declared, problem counts, current view and selection. Start here.",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true, untrustedContentHint: true },
            run: () => {
                const m = model();
                const typeCounts = new Map();
                let described = 0;
                let links = 0;
                const ontology = { classes: 0, properties: 0, shapes: 0, ontologyIri: null };
                m.nodes.forEach(node => {
                    if (node.definitions === 0) return;
                    described += 1;
                    node.types.forEach(t => typeCounts.set(t, (typeCounts.get(t) || 0) + 1));
                    node.props.forEach(values => values.forEach(v => { if (v.kind === "iri" || v.linksTo) links += 1; }));
                    if (node.types.some(t => t === OWL + "Class" || t.endsWith("rdf-schema#Class"))) ontology.classes += 1;
                    if (node.types.some(t => /#(Object|Datatype|Annotation)Property$|22-rdf-syntax-ns#Property$/.test(t))) ontology.properties += 1;
                    if (node.types.some(t => t.endsWith("shacl#NodeShape"))) ontology.shapes += 1;
                    if (node.types.includes(OWL + "Ontology")) ontology.ontologyIri = node.id;
                });
                const problems = app.getProblems();
                return ok({
                    name: app.getFileName(),
                    editorFormat: app.getEditorFormat(),
                    describedNodes: described,
                    links,
                    types: [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([t, n]) => ({ type: compact(t), count: n })),
                    prefixes: app.getPrefixes(),
                    vocab: m.context.vocab || null,
                    base: m.context.base || null,
                    ontology,
                    problems: {
                        errors: problems.filter(p => p.severity === "error").length,
                        warnings: problems.filter(p => p.severity === "warning").length,
                        notes: problems.filter(p => p.severity === "info").length,
                    },
                    view: app.getView(),
                    selectedNode: app.getSelectedNode() ? compact(app.getSelectedNode()) : null,
                    namespaceForNewTerms: defaultNamespace(),
                    advice: "Search existing vocabularies (search_terms, get_class_properties) before minting new terms. Edits are undoable by the user.",
                });
            },
        },
        {
            name: "get_document_source",
            title: "Read the document source",
            description: "The document as JSON-LD (as written) or as Turtle (converted with the rete engine). Long documents are paged with offset/max_chars.",
            inputSchema: {
                type: "object",
                properties: {
                    format: STR("jsonld or turtle", { enum: ["jsonld", "turtle"], default: "jsonld" }),
                    offset: INT("Character offset to start from", 0),
                    max_chars: INT("Maximum characters to return", 20000),
                },
            },
            annotations: { readOnlyHint: true, untrustedContentHint: true },
            run: async ({ format = "jsonld", offset = 0, max_chars = 20000 }) => {
                const text = format === "turtle"
                    ? (await Rete.exportDocument(app.getTextForEngine(), "ttl", { prefixes: app.getPrefixes() })).data
                    : app.getText();
                return ok(Object.assign({ format }, truncate(text, Math.min(max_chars, MAX_TEXT), offset)));
            },
        },
        {
            name: "list_nodes",
            title: "List nodes",
            description: "Nodes described in the document, optionally filtered by type (prefixed name or IRI) and/or text in the label or id.",
            inputSchema: {
                type: "object",
                properties: {
                    type: STR("Only nodes of this type, e.g. schema:Person"),
                    text: STR("Case-insensitive text to find in the label or id"),
                    limit: INT("Maximum nodes to return", 50),
                    offset: INT("Skip this many matches", 0),
                },
            },
            annotations: { readOnlyHint: true, untrustedContentHint: true },
            run: ({ type, text, limit = 50, offset = 0 }) => {
                const ctx = context();
                let typeIri = null;
                if (type) {
                    typeIri = resolveTerm(type);
                    if (!typeIri) return fail(`Unknown type "${type}".`);
                }
                const q = text ? String(text).toLowerCase() : null;
                const matches = [];
                model().nodes.forEach(node => {
                    if (node.definitions === 0) return;
                    if (typeIri && !node.types.includes(typeIri)) return;
                    const label = extractNodeLabel(node, ctx);
                    if (q && !label.toLowerCase().includes(q) && !node.id.toLowerCase().includes(q)) return;
                    matches.push({ id: compactNode(node.id), iri: node.id, label, types: node.types.map(compact) });
                });
                return ok({ total: matches.length, nodes: matches.slice(offset, offset + Math.min(limit, 500)) });
            },
        },
        {
            name: "describe_node",
            title: "Describe a node",
            description: "Everything the document says about one node: types, property values (links shown as {\"@id\"}), incoming links from other nodes, and related problems.",
            inputSchema: { type: "object", properties: { id: STR("The node's IRI, prefixed name, or @id as written in the document") }, required: ["id"] },
            annotations: { readOnlyHint: true, untrustedContentHint: true },
            run: ({ id }) => {
                const iri = resolveNode(id);
                if (!iri) return fail(`No node "${id}" in the document. list_nodes shows the available ids.`);
                const m = model();
                const node = m.nodes.get(iri);
                const properties = {};
                node.props.forEach((values, pred) => {
                    const key = node.rawKeys.get(pred) || compact(pred);
                    const shown = values.map(describeValue);
                    properties[key] = shown.length === 1 ? shown[0] : shown;
                });
                const incoming = [];
                m.nodes.forEach(other => {
                    if (other.id === iri) return;
                    other.props.forEach((values, pred) => {
                        if (values.some(v => v.iri === iri || v.linksTo === iri)) incoming.push({ from: compactNode(other.id), property: compact(pred) });
                    });
                });
                return ok({
                    iri,
                    id: compactNode(iri),
                    label: extractNodeLabel(node, context()),
                    types: node.types.map(compact),
                    describedInDocument: node.definitions > 0,
                    properties,
                    incoming: incoming.slice(0, 100),
                    problems: app.getProblems().filter(p => p.nodeId === iri).map(p => ({ id: problemId(p), severity: p.severity, message: p.message })),
                });
            },
        },
        {
            name: "search_terms",
            title: "Search vocabulary terms",
            description: "Find classes and properties to reuse: searches the document, the bundled vocabularies (schema.org, DCTerms, FOAF, SKOS, PROV-O, ORG, DCAT, OWL-Time, SHACL…), loaded vocabularies, and optionally OLS (EBI, 270+ ontologies) and Wikidata. Returns IRIs, prefixed names, descriptions, domain and range. Use before creating a new term.",
            inputSchema: {
                type: "object",
                properties: {
                    query: STR("Words or a prefixed name, e.g. \"creator\", \"date published\", \"dcat:Dat\""),
                    kind: STR("Kind of term", { enum: ["all", "classes", "properties", "datatypes", "individuals"], default: "all" }),
                    sources: { type: "array", items: { type: "string", enum: ["document", "library", "ols", "wikidata"] }, description: "Where to search (default: document and library)" },
                    limit: INT("Maximum results per source", 15),
                },
                required: ["query"],
            },
            annotations: { readOnlyHint: true, untrustedContentHint: true },
            run: async ({ query, kind = "all", sources = ["document", "library"], limit = 15 }) => {
                await app.vocab.loadBuiltin();
                const local = app.vocab.search(query, { kind, sources: { document: sources.includes("document"), library: sources.includes("library") }, limit: Math.min(limit * 2, 80) });
                const results = local.slice(0, limit * 2).map(r => termInfo(r.term, r.source));
                const remote = {};
                for (const service of ["ols", "wikidata"]) {
                    if (!sources.includes(service)) continue;
                    try {
                        remote[service] = (await app.vocab.searchRemote(service, query, kind)).slice(0, limit).map(r => termInfo(r.term, service));
                    } catch (err) {
                        remote[service] = { error: err.message };
                    }
                }
                return ok({ results, remote });
            },
        },
        {
            name: "get_class_properties",
            title: "Properties of a class",
            description: "Properties whose domain is the class or one of its superclasses (document first, then vocabularies) — what an instance of the class can have. Good for filling in instances and reusing existing properties.",
            inputSchema: { type: "object", properties: { class: STR("Class prefixed name or IRI, e.g. schema:Dataset"), limit: INT("Maximum properties", 60) }, required: ["class"] },
            annotations: { readOnlyHint: true },
            run: async ({ class: cls, limit = 60 }) => {
                await app.vocab.loadBuiltin();
                const iri = resolveTerm(cls);
                if (!iri) return fail(`Unknown class "${cls}".`);
                const list = app.vocab.propertiesForClass(iri, Math.min(limit, 400));
                return ok({
                    class: compact(iri),
                    superclasses: app.vocab.superClasses(iri).map(compact),
                    properties: list.map(p => Object.assign(termInfo(p.term, p.source), { inherited: p.depth > 0, generic: p.generic })),
                });
            },
        },
        {
            name: "list_problems",
            title: "List problems",
            description: "Issues found in the document: invalid IRIs that RDF tools drop, keys that do not map to an IRI, undefined prefixes, misspelled vocabulary terms, strings that should be links, undeclared terms, ontology gaps. Each has an id and the fixes apply_problem_fix can run.",
            inputSchema: { type: "object", properties: { severity: STR("Only this severity", { enum: ["error", "warning", "info"] }), limit: INT("Maximum problems", 50) } },
            annotations: { readOnlyHint: true, untrustedContentHint: true },
            run: ({ severity, limit = 50 }) => {
                const list = app.getProblems().filter(p => !severity || p.severity === severity);
                return ok({
                    total: list.length,
                    problems: list.slice(0, Math.min(limit, 300)).map(p => ({
                        id: problemId(p),
                        severity: p.severity,
                        code: p.code,
                        message: p.message,
                        node: p.nodeId ? compact(p.nodeId) : undefined,
                        fixes: (p.fixes || []).filter(f => AGENT_FIXES.has(f.action.type)).map(f => f.label),
                    })),
                });
            },
        },
        {
            name: "run_sparql",
            title: "Run a SPARQL query",
            description: "Run SPARQL 1.1 (SELECT, ASK, CONSTRUCT, DESCRIBE) over the document's RDF with the rete engine in the page. Optional OWL 2 QL reasoning (subclass, subproperty, domain/range). Does not modify the document.",
            inputSchema: {
                type: "object",
                properties: {
                    query: STR("The SPARQL query. Declare the prefixes you use."),
                    reasoning: { type: "boolean", description: "Answer with OWL 2 QL entailment", default: false },
                    limit: INT("Maximum rows to return", 200),
                },
                required: ["query"],
            },
            annotations: { readOnlyHint: true, untrustedContentHint: true },
            run: async ({ query, reasoning = false, limit = 200 }) => {
                const { env, ms, warnings } = await Rete.sparql(app.getTextForEngine(), query, { reason: reasoning });
                const out = { kind: env.kind, ms: Math.round(ms * 10) / 10 };
                if (env.kind === "select") Object.assign(out, { vars: env.vars, totalRows: env.rows.length, rows: rowsFromEnvelope(env, Math.min(limit, 2000)) });
                else if (env.kind === "ask") out.boolean = env.boolean;
                else if (env.kind === "construct") {
                    const triples = env.triples || [];
                    Object.assign(out, { triples: triples.length }, { turtle: truncate(Rete.triplesToTurtle(triples, app.getPrefixes())).text });
                }
                if (warnings && warnings.length) out.warnings = warnings.map(w => w.message);
                return ok(out);
            },
        },
        {
            name: "generate_shacl_shapes",
            title: "Generate SHACL shapes",
            description: "Write starter SHACL shapes (Turtle) from the ontology (rdfs:domain/range), from the data (observed values and cardinalities), or both. The shapes are put in the SHACL tab's editor and returned; nothing is added to the document.",
            inputSchema: { type: "object", properties: { from: STR("What to derive shapes from", { enum: ["both", "ontology", "data"], default: "both" }) } },
            annotations: { readOnlyHint: true },
            run: ({ from = "both" }) => {
                const turtle = app.tools.generateShapes(model(), from);
                if (!turtle) return fail("Nothing to derive shapes from (no classes with instances, or no properties with rdfs:domain).");
                app.tools.setShapesText(turtle);
                return ok({ turtle });
            },
        },
        {
            name: "validate_shacl",
            title: "Validate with SHACL",
            description: "Validate the document with SHACL Core (rete engine). Uses the given shapes (Turtle), or the shapes in the SHACL tab, the shapes stored in the document, or both. Results also appear as ✓/✗ badges on the user's graph.",
            inputSchema: {
                type: "object",
                properties: {
                    shapes: STR("SHACL shapes in Turtle. Omit to use `source`."),
                    source: STR("Which stored shapes to use when `shapes` is omitted", { enum: ["editor", "document", "both"], default: "both" }),
                },
            },
            annotations: { readOnlyHint: true },
            run: async ({ shapes, source = "both" }) => {
                const result = await app.tools.validate({ shapes, source: shapes ? "editor" : source });
                app.ui.openDataTab("__shacl__");
                if (result.error) return fail(result.error);
                return ok(Object.assign({}, result, { results: result.results.slice(0, 300) }));
            },
        },
        {
            name: "export_document",
            title: "Export as text",
            description: "The document converted to another RDF format, returned as text (nothing is downloaded): jsonld, turtle, ntriples, nquads, or ontology_module (only the ontology's classes and properties, as JSON-LD).",
            inputSchema: {
                type: "object",
                properties: {
                    format: STR("Output format", { enum: ["jsonld", "turtle", "ntriples", "nquads", "ontology_module"], default: "turtle" }),
                    max_chars: INT("Maximum characters to return", 20000),
                },
            },
            annotations: { readOnlyHint: true, untrustedContentHint: true },
            run: async ({ format = "turtle", max_chars = 20000 }) => {
                let text;
                if (format === "jsonld") text = app.getText();
                else if (format === "ontology_module") {
                    const out = app.io.ontologyModuleText();
                    if (!out) return fail("The document declares no ontology terms (owl:Class, owl:ObjectProperty, …).");
                    text = out.text;
                } else {
                    const kind = { turtle: "ttl", ntriples: "nt", nquads: "nq" }[format];
                    if (!kind) return fail(`Unknown format "${format}".`);
                    text = (await Rete.exportDocument(app.getTextForEngine(), kind, { prefixes: app.getPrefixes() })).data;
                }
                return ok(Object.assign({ format }, truncate(text, Math.min(max_chars, MAX_TEXT))));
            },
        },
        {
            name: "export_mermaid",
            title: "Diagram as Mermaid",
            description: "The graph as Mermaid text, as the box diagram shows it (visible types, groups, collapsed cards): a classDiagram for the schema view (classes with attributes, subClassOf as inheritance, associations, SHACL shapes) or a flowchart for the instance view. Paste it into Markdown or mermaid.live.",
            inputSchema: { type: "object", properties: { view: STR("Which view to export", { enum: ["current", "instances", "schema"], default: "current" }) } },
            annotations: { readOnlyHint: true, untrustedContentHint: true },
            run: ({ view = "current" }) => {
                const text = app.mermaidText(view === "current" ? undefined : view);
                if (!text) return fail("The diagram is empty.");
                return ok(Object.assign({ view: view === "current" ? app.getView() : view }, truncate(text)));
            },
        },
        {
            name: "list_vocabularies",
            title: "List vocabularies",
            description: "Vocabularies loaded in the term library (bundled and loaded), and the catalog of vocabularies that load_vocabulary can add.",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
            run: async () => {
                await app.vocab.loadBuiltin();
                const loaded = app.vocab.listVocabularies().map(v => ({ prefix: v.prefix, namespace: v.namespace, title: v.title, terms: v.count, origin: v.origin }));
                const catalog = VOCAB_CATALOG.filter(c => !loaded.some(l => l.namespace === c.namespace)).map(c => ({ prefix: c.prefix, title: c.title, namespace: c.namespace }));
                return ok({ loaded, catalog });
            },
        },
        {
            name: "show_in_graph",
            title: "Show in the graph",
            description: "Change what the user sees: select and focus a node, switch between the instance and schema views, and turn the box diagram on or off. Does not modify the document.",
            inputSchema: {
                type: "object",
                properties: {
                    id: STR("Node to select and focus"),
                    view: STR("Graph view", { enum: ["instances", "schema"] }),
                    diagram: { type: "boolean", description: "Show the box diagram instead of the network" },
                },
            },
            annotations: { readOnlyHint: true },
            run: ({ id, view, diagram }) => {
                if (view) app.setView(view);
                if (typeof diagram === "boolean") app.setDiagram(diagram);
                let selected = null;
                if (id) {
                    selected = resolveNode(id) || resolveTerm(id);
                    if (!selected || !app.hasNode(selected)) return fail(`"${id}" is not shown in the current view.`);
                    app.selectNode(selected);
                }
                return ok({ view: app.getView(), diagram: app.isDiagram(), selected: selected ? compact(selected) : null });
            },
        },

        // ── Edit ──
        {
            name: "create_class",
            title: "Create a class",
            description: "Declare a new owl:Class in the document (label, description, superclasses). Prefer reusing or subclassing an existing class found with search_terms. The IRI is minted in the document's namespace unless one is given.",
            write: true,
            inputSchema: {
                type: "object",
                properties: {
                    label: STR("Human label, e.g. \"Research dataset\""),
                    description: STR("One-sentence definition (rdfs:comment)"),
                    local_name: STR("Local part of the IRI (default: UpperCamelCase of the label)"),
                    namespace: STR("Namespace IRI or a prefix of the document (default: the document's own namespace)"),
                    subclass_of: ARR("Superclasses, e.g. [\"dcat:Dataset\"]"),
                    equivalent_to: ARR("Equivalent classes"),
                },
                required: ["label"],
            },
            annotations: { readOnlyHint: false },
            run: ({ label, description, local_name, namespace, subclass_of, equivalent_to }) => {
                const ns = namespace ? resolveNamespace(namespace) : defaultNamespace();
                if (!ns) return fail(`Unknown namespace "${namespace}".`);
                const local = local_name || camel(label, true);
                if (!local) return fail("Cannot derive a local name from the label.");
                const iri = ns + local;
                if (nodeExists(iri)) return fail(`${compact(iri)} already exists.`);
                const created = app.createTerm({ kind: "C", iri, namespace: ns, label, comment: description || "", super: resolveTerms(subclass_of, "class"), equivalent: resolveTerms(equivalent_to, "class") });
                if (!created) return fail("The class could not be created (see the editor status).");
                return ok({ iri, id: compact(iri), similarExistingClasses: similarTerms(label, "classes", iri) });
            },
            summarize: (input, r) => `created class ${r.id || input.label}`,
        },
        {
            name: "create_property",
            title: "Create a property",
            description: "Declare a new owl:ObjectProperty (links to other nodes) or owl:DatatypeProperty (literal values) with domain, range and superproperties. Prefer reusing an existing property found with search_terms.",
            write: true,
            inputSchema: {
                type: "object",
                properties: {
                    label: STR("Human label, e.g. \"principal investigator\""),
                    kind: STR("object (links to nodes) or datatype (text, numbers, dates…)", { enum: ["object", "datatype"] }),
                    description: STR("One-sentence definition (rdfs:comment)"),
                    local_name: STR("Local part of the IRI (default: lowerCamelCase of the label)"),
                    namespace: STR("Namespace IRI or a prefix of the document"),
                    domain: ARR("Classes this property describes"),
                    range: ARR("Classes (object) or datatypes such as xsd:string, xsd:date (datatype)"),
                    subproperty_of: ARR("Superproperties, e.g. [\"dcterms:creator\"]"),
                    inverse_of: STR("Inverse property (object properties only)"),
                    functional: { type: "boolean", description: "At most one value", default: false },
                },
                required: ["label", "kind"],
            },
            annotations: { readOnlyHint: false },
            run: ({ label, kind, description, local_name, namespace, domain, range, subproperty_of, inverse_of, functional = false }) => {
                const ns = namespace ? resolveNamespace(namespace) : defaultNamespace();
                if (!ns) return fail(`Unknown namespace "${namespace}".`);
                const local = local_name || camel(label, false);
                const iri = ns + local;
                if (nodeExists(iri)) return fail(`${compact(iri)} already exists.`);
                const created = app.createTerm({
                    kind: kind === "datatype" ? "D" : "O", iri, namespace: ns, label, comment: description || "",
                    domain: resolveTerms(domain, "class"), range: resolveTerms(range, kind === "datatype" ? "datatype" : "class"),
                    superProp: resolveTerms(subproperty_of, "property"), inverse: inverse_of ? resolveTerms([inverse_of], "property") : [],
                    functional,
                });
                if (!created) return fail("The property could not be created (see the editor status).");
                return ok({ iri, id: compact(iri), similarExistingProperties: similarTerms(label, "properties", iri) });
            },
            summarize: (input, r) => `created ${input.kind} property ${r.id || input.label}`,
        },
        {
            name: "create_instance",
            title: "Create an instance",
            description: "Add a node (an instance of one or more classes) with property values. Keys are prefixed names or IRIs; values are literals, links {\"@id\": …} or {\"@value\", \"@language\"/\"@type\"}. get_class_properties lists the usual properties of a class.",
            write: true,
            inputSchema: {
                type: "object",
                properties: {
                    types: ARR("Classes, e.g. [\"schema:Person\"]"),
                    label: STR("Name of the instance (stored as schema:name for schema.org types, otherwise rdfs:label, unless given in properties)"),
                    id: STR("Full IRI, prefixed name, or id relative to the document's @base (default: derived from the label)"),
                    namespace: STR("Namespace for the derived id (default: @base, else the document's namespace)"),
                    properties: { type: "object", description: "Property → value(s). " + VALUE_SCHEMA.description, additionalProperties: true },
                },
                required: ["types"],
            },
            annotations: { readOnlyHint: false },
            run: ({ types, label, id, namespace, properties = {} }) => {
                const typeIris = resolveTerms(types, "class");
                if (!typeIris.length) return fail("Give at least one type.");
                const ctx = context();
                let iri;
                if (id) {
                    iri = resolveTerm(id) || JsonLd.expandIri(ctx, id, { documentRelative: true });
                    if (!JsonLd.isAbsoluteIri(iri)) return fail(`"${id}" does not resolve to an absolute IRI.`);
                } else {
                    const ns = namespace ? resolveNamespace(namespace) : (ctx.base || defaultNamespace());
                    const local = slug(label) || `node-${Date.now().toString(36)}`;
                    iri = ns + local;
                }
                if (nodeExists(iri)) return fail(`${compact(iri)} already exists — use set_property to change it.`);
                const keys = Object.keys(properties).map(k => [k, resolveTerm(k)]);
                const unknown = keys.filter(([, v]) => !v).map(([k]) => k);
                if (unknown.length) return fail(`Unknown properties: ${unknown.join(", ")}.`);
                let error = null;
                const done = app.mutate(w => {
                    try {
                        const node = { "@id": w.id(iri), "@type": typeIris.length === 1 ? w.key(typeIris[0]) : typeIris.map(t => w.key(t)) };
                        keys.forEach(([k, pIri]) => { node[w.key(pIri)] = toJsonLd(w, properties[k]); });
                        const hasLabel = keys.some(([, p]) => LABEL_PREDICATES.includes(p));
                        if (label && !hasLabel) {
                            const pred = typeIris.some(t => t.startsWith("http://schema.org/")) ? "http://schema.org/name" : SCHEMA_PREDICATES.label;
                            node[w.key(pred)] = label;
                        }
                        w.graph().push(node);
                        return true;
                    } catch (err) {
                        error = err.message;
                        return false;
                    }
                }, { select: iri });
                if (error) return fail(error);
                if (!done) return fail("The instance could not be added (see the editor status).");
                return ok({ iri, id: compactNode(iri) });
            },
            summarize: (input, r) => `created ${r.id || input.label || "an instance"}`,
        },
        {
            name: "set_property",
            title: "Set a property value",
            description: "Add a value to a property of an existing node, or replace all its values. " + VALUE_SCHEMA.description,
            write: true,
            inputSchema: {
                type: "object",
                properties: {
                    node: STR("The node (IRI, prefixed name, or @id as written)"),
                    property: STR("Property prefixed name or IRI"),
                    value: VALUE_SCHEMA,
                    mode: STR("add (keep existing values) or replace", { enum: ["add", "replace"], default: "add" }),
                },
                required: ["node", "property", "value"],
            },
            annotations: { readOnlyHint: false },
            run: ({ node, property, value, mode = "add" }) => {
                const iri = resolveNode(node);
                if (!iri || !nodeExists(iri)) return fail(`No node "${node}" is described in the document.`);
                const pIri = resolveTerm(property);
                if (!pIri) return fail(`Unknown property "${property}".`);
                let error = null;
                const done = app.mutate(w => {
                    const obj = w.findNode(iri);
                    if (!obj) { error = "The node is only described inside another node; edit it in the source."; return false; }
                    try {
                        const key = Object.keys(obj).find(k => !k.startsWith("@") && JsonLd.expandIri(w.context(), k, { vocab: true }) === pIri) || w.key(pIri);
                        const vals = toJsonLd(w, value);
                        if (mode === "replace" || obj[key] === undefined) obj[key] = vals;
                        else {
                            const list = [].concat(obj[key], vals);
                            const seen = new Set();
                            const merged = list.filter(v => { const s = JSON.stringify(v); if (seen.has(s)) return false; seen.add(s); return true; });
                            obj[key] = merged.length === 1 ? merged[0] : merged;
                        }
                        return true;
                    } catch (err) {
                        error = err.message;
                        return false;
                    }
                }, { select: iri });
                if (error) return fail(error);
                return done ? ok({ node: compactNode(iri), property: compact(pIri) }) : fail("No change was made.");
            },
            summarize: input => `set ${input.property} on ${input.node}`,
        },
        {
            name: "remove_property",
            title: "Remove a property value",
            description: "Remove one value (when `value` is given) or all values of a property from a node.",
            write: true,
            inputSchema: {
                type: "object",
                properties: { node: STR("The node"), property: STR("Property prefixed name or IRI"), value: VALUE_SCHEMA },
                required: ["node", "property"],
            },
            annotations: { readOnlyHint: false },
            run: ({ node, property, value }) => {
                const iri = resolveNode(node);
                if (!iri || !nodeExists(iri)) return fail(`No node "${node}" is described in the document.`);
                const pIri = resolveTerm(property);
                if (!pIri) return fail(`Unknown property "${property}".`);
                let removed = 0;
                let error = null;
                app.mutate(w => {
                    const obj = w.findNode(iri);
                    if (!obj) { error = "The node is only described inside another node."; return false; }
                    const keys = Object.keys(obj).filter(k => !k.startsWith("@") && JsonLd.expandIri(w.context(), k, { vocab: true }) === pIri);
                    if (!keys.length) { error = `${compact(iri)} has no ${compact(pIri)}.`; return false; }
                    keys.forEach(k => {
                        if (value === undefined) { removed += [].concat(obj[k]).length; delete obj[k]; return; }
                        let target;
                        try { target = JSON.stringify(toJsonLd(w, value)); } catch (err) { error = err.message; return; }
                        const list = [].concat(obj[k]);
                        const keep = list.filter(v => JSON.stringify(v) !== target && !(typeof v === "object" && v && JSON.stringify(v["@id"]) === target));
                        removed += list.length - keep.length;
                        if (!keep.length) delete obj[k];
                        else obj[k] = keep.length === 1 ? keep[0] : keep;
                    });
                    return removed > 0;
                }, { select: iri });
                if (error) return fail(error);
                return removed ? ok({ removed }) : fail("No matching value.");
            },
            summarize: input => `removed ${input.property} from ${input.node}`,
        },
        {
            name: "add_type",
            title: "Add a type",
            description: "Add a class to a node's @type.",
            write: true,
            inputSchema: { type: "object", properties: { node: STR("The node"), class: STR("Class prefixed name or IRI") }, required: ["node", "class"] },
            annotations: { readOnlyHint: false },
            run: ({ node, class: cls }) => {
                const iri = resolveNode(node);
                if (!iri || !nodeExists(iri)) return fail(`No node "${node}" is described in the document.`);
                const cIri = resolveTerm(cls);
                if (!cIri) return fail(`Unknown class "${cls}".`);
                if (model().nodes.get(iri).types.includes(cIri)) return ok({ unchanged: true });
                return app.addTypeToNode(iri, cIri) ? ok({ node: compact(iri), type: compact(cIri) }) : fail("The type could not be added.");
            },
            summarize: input => `added type ${input.class} to ${input.node}`,
        },
        {
            name: "declare_reused_term",
            title: "Declare a reused term",
            description: "Add a declaration of an existing vocabulary term (type, label, definition, rdfs:isDefinedBy) to the document, so the ontology documents what it reuses. The term must be in the term library (search_terms).",
            write: true,
            inputSchema: { type: "object", properties: { term: STR("Prefixed name or IRI, e.g. dcat:Dataset") }, required: ["term"] },
            annotations: { readOnlyHint: false },
            run: async ({ term }) => {
                await app.vocab.loadBuiltin();
                const iri = resolveTerm(term);
                if (!iri) return fail(`Unknown term "${term}".`);
                if (nodeExists(iri)) return ok({ unchanged: true, id: compact(iri) });
                const t = app.vocab.describe(iri);
                if (!t || t.vocab === "document") return fail(`${compact(iri)} is not in a loaded vocabulary. Use create_class or create_property to declare a new term.`);
                app.declareTerm(t);
                return nodeExists(iri) ? ok({ id: compact(iri), vocabulary: t.vocabTitle }) : fail("The term could not be declared.");
            },
            summarize: input => `declared ${input.term}`,
        },
        {
            name: "add_prefix",
            title: "Add a prefix",
            description: "Add a prefix → namespace mapping to the document's @context.",
            write: true,
            inputSchema: { type: "object", properties: { prefix: STR("e.g. dcat"), namespace: STR("e.g. http://www.w3.org/ns/dcat#") }, required: ["prefix", "namespace"] },
            annotations: { readOnlyHint: false },
            run: ({ prefix, namespace }) => {
                if (!/^[A-Za-z][\w.\-]*$/.test(prefix || "")) return fail("Prefixes start with a letter and contain letters, digits, '.', '-' or '_'.");
                if (!JsonLd.isAbsoluteIri(namespace)) return fail("The namespace must be an absolute IRI.");
                return app.addPrefix(prefix, namespace) ? ok({ prefix, namespace }) : fail(`"${prefix}" is already defined with another namespace.`);
            },
            summarize: input => `added prefix ${input.prefix}:`,
        },
        {
            name: "apply_problem_fix",
            title: "Apply a problem's fix",
            description: "Run one of the automatic fixes listed by list_problems (add a missing prefix, turn a property's strings into links, replace a misspelled term).",
            write: true,
            inputSchema: {
                type: "object",
                properties: { problem_id: STR("The id from list_problems"), fix: STR("The fix label from list_problems (default: the first one)") },
                required: ["problem_id"],
            },
            annotations: { readOnlyHint: false },
            run: ({ problem_id, fix }) => {
                const p = app.getProblems().find(x => problemId(x) === problem_id);
                if (!p) return fail("That problem no longer exists; call list_problems again.");
                const fixes = (p.fixes || []).filter(f => AGENT_FIXES.has(f.action.type));
                const chosen = fix ? fixes.find(f => f.label === fix) : fixes[0];
                if (!chosen) return fail(`No automatic fix${fix ? ` "${fix}"` : ""} for this problem. Available: ${fixes.map(f => f.label).join(", ") || "none"}.`);
                app.runAction(chosen.action);
                return ok({ applied: chosen.label });
            },
            summarize: (input, r) => `fixed a problem (${r.applied || input.problem_id})`,
        },
        {
            name: "add_shapes_to_document",
            title: "Store SHACL shapes in the document",
            description: "Convert SHACL shapes (Turtle) to JSON-LD and add them to the document, next to the ontology and instances (shapes with the same IRI are replaced). Omit `shapes` to store the shapes in the SHACL tab.",
            write: true,
            inputSchema: { type: "object", properties: { shapes: STR("SHACL shapes in Turtle") } },
            annotations: { readOnlyHint: false },
            run: async ({ shapes }) => {
                const ttl = shapes || app.tools.getShapesText();
                const result = await Rete.importRdf(ttl, "ttl", app.getPrefixes());
                const n = (result.doc["@graph"] || []).length;
                if (!n) return fail("No shapes found in the Turtle.");
                return app.mergeDocument(result.doc, `🤖 Agent added ${n} shape node(s) to the document.`) ? ok({ nodes: n }) : fail("The shapes could not be added.");
            },
            summarize: (input, r) => `stored ${r.nodes || ""} SHACL shape node(s) in the document`,
        },
        {
            name: "delete_node",
            title: "Delete a node",
            description: "Remove a node's description from the document, and by default the links that point to it. The user can undo it with Ctrl+Z.",
            write: true,
            inputSchema: {
                type: "object",
                properties: { id: STR("The node"), remove_references: { type: "boolean", description: "Also remove links to it", default: true } },
                required: ["id"],
            },
            annotations: { readOnlyHint: false, consequentialHint: true },
            run: ({ id, remove_references = true }) => {
                const iri = resolveNode(id);
                if (!iri || !nodeExists(iri)) return fail(`No node "${id}" is described in the document.`);
                let removedNodes = 0;
                let removedRefs = 0;
                app.mutate(w => {
                    const ctx = w.context();
                    const expands = s => typeof s === "string" && JsonLd.expandIri(ctx, s, { documentRelative: true }) === iri;
                    const walk = (value) => {
                        if (Array.isArray(value)) {
                            for (let i = value.length - 1; i >= 0; i -= 1) {
                                const v = value[i];
                                if (v && typeof v === "object" && !Array.isArray(v) && expands(v["@id"]) && Object.keys(v).length > 1) { value.splice(i, 1); removedNodes += 1; continue; }
                                walk(v);
                            }
                            return;
                        }
                        if (!value || typeof value !== "object") return;
                        Object.keys(value).forEach(k => {
                            if (k === "@context" || k === "@id") return;
                            const def = ctx.terms[k];
                            const coerced = def && (def.type === "@id" || def.type === "@vocab");
                            const isRef = v => (v && typeof v === "object" && Object.keys(v).length === 1 && expands(v["@id"])) || (coerced && expands(v));
                            if (remove_references && k !== "@graph") {
                                const list = [].concat(value[k]);
                                const keep = list.filter(v => !isRef(v));
                                if (keep.length !== list.length) {
                                    removedRefs += list.length - keep.length;
                                    if (!keep.length) delete value[k];
                                    else value[k] = Array.isArray(value[k]) ? keep : keep[0];
                                }
                            }
                            if (value[k] && typeof value[k] === "object") walk(value[k]);
                        });
                    };
                    walk(w.root);
                    return removedNodes + removedRefs > 0;
                });
                return removedNodes ? ok({ removedNodes, removedReferences: removedRefs }) : fail("The node is only described inside another node; edit it in the source.");
            },
            summarize: input => `deleted ${input.id}`,
        },
        {
            name: "load_vocabulary",
            title: "Load a vocabulary",
            description: "Add a vocabulary to the term library so its terms can be searched and checked: a catalog prefix from list_vocabularies (e.g. sosa, vcard, odrl) or the URL of a Turtle, N-Triples, JSON-LD or .rete file (the server must allow CORS). Does not change the document.",
            inputSchema: { type: "object", properties: { source: STR("Catalog prefix or URL") }, required: ["source"] },
            annotations: { readOnlyHint: false },
            run: async ({ source }) => {
                const entry = VOCAB_CATALOG.find(c => c.prefix === source) || (/^https?:\/\//.test(source) ? { url: source } : null);
                if (!entry) return fail(`"${source}" is neither a catalog prefix nor an http(s) URL.`);
                const v = await app.vocab.loadLive(entry);
                app.relint();
                return ok({ prefix: v.prefix, namespace: v.namespace, title: v.title, terms: v.count });
            },
            summarize: input => `loaded vocabulary ${input.source}`,
        },
        {
            name: "create_ontology_header",
            title: "Describe the ontology",
            description: "Add an owl:Ontology node with title, description, version, licence, creator and preferred prefix/namespace (VANN).",
            write: true,
            inputSchema: {
                type: "object",
                properties: {
                    iri: STR("Ontology IRI, e.g. https://example.org/ontology"),
                    title: STR("Title"),
                    description: STR("Description"),
                    version: STR("Version, e.g. 0.1.0"),
                    license: STR("Licence URL"),
                    creator: STR("Creator name or ORCID IRI"),
                    prefix: STR("Preferred prefix, e.g. ex"),
                    namespace: STR("Namespace for the ontology's terms, e.g. https://example.org/ontology#"),
                },
                required: ["iri"],
            },
            annotations: { readOnlyHint: false },
            run: (o) => (app.createOntologyHeader(o) ? ok({ iri: o.iri }) : fail("The header could not be added (does the document already describe this ontology?).")),
            summarize: input => `described the ontology ${input.iri}`,
        },
        {
            name: "open_document",
            title: "Open a document",
            description: "Replace the open document with new content (JSON-LD, Turtle, N-Triples, N-Quads, TriG) or with a file fetched from a URL (CORS required; .rete supported). The previous document stays in the editor's undo history.",
            write: true,
            inputSchema: {
                type: "object",
                properties: {
                    content: STR("Document text"),
                    url: STR("URL to open instead of content"),
                    format: STR("Format of `content`", { enum: ["jsonld", "turtle", "ntriples", "nquads", "trig"] }),
                    name: STR("File name to show"),
                },
            },
            annotations: { readOnlyHint: false, consequentialHint: true },
            run: async ({ content, url, format, name }) => {
                if (url) {
                    await app.io.openUrl(url);
                } else if (typeof content === "string" && content.trim()) {
                    const fmt = format || (/^\s*[[{]/.test(content) ? "jsonld" : "turtle");
                    if (fmt === "jsonld") {
                        if (!app.loadText(content, name || "agent-document.jsonld")) return fail("The JSON is not valid; see the editor status.");
                    } else {
                        const code = { turtle: "ttl", ntriples: "nt", nquads: "nq", trig: "trig" }[fmt];
                        await app.io.importRdf(content, code, name || `agent-document.${code}`);
                    }
                } else {
                    return fail("Give `content` or `url`.");
                }
                return ok({ name: app.getFileName(), nodes: model().nodes.size });
            },
            summarize: input => `opened ${input.url || input.name || "a new document"}`,
        },
        {
            name: "download_file",
            title: "Download a file",
            description: "Save the document to the user's computer as jsonld, turtle, ntriples, nquads, mermaid (the diagram) or rete (a single-file, SPARQL-queryable graph, optionally with a Dataset Card: title, description, license, version, keywords, creators).",
            write: true,
            inputSchema: {
                type: "object",
                properties: {
                    format: STR("File format", { enum: ["jsonld", "turtle", "ntriples", "nquads", "rete", "mermaid"], default: "jsonld" }),
                    filename: STR("File name without extension"),
                    card: { type: "object", description: "Dataset Card for .rete: {title, description, license, version, keywords:[…], creators:[{name, orcid}], source}", additionalProperties: true },
                },
            },
            annotations: { readOnlyHint: false, consequentialHint: true },
            run: async ({ format = "jsonld", filename, card }) => {
                const base = (filename || app.io.baseName()).replace(/[\\/:*?"<>|]+/g, "-");
                if (format === "jsonld") {
                    app.download(app.getText(), `${base}.jsonld`, "application/ld+json");
                    return ok({ file: `${base}.jsonld` });
                }
                if (format === "mermaid") {
                    const text = app.mermaidText();
                    if (!text) return fail("The diagram is empty.");
                    app.download(text, `${base}.mmd`, "text/plain");
                    return ok({ file: `${base}.mmd` });
                }
                const kind = { turtle: "ttl", ntriples: "nt", nquads: "nq", rete: "rete" }[format];
                if (!kind) return fail(`Unknown format "${format}".`);
                const out = await Rete.exportDocument(app.getTextForEngine(), kind, { prefixes: app.getPrefixes(), card: kind === "rete" ? card : undefined });
                app.download(out.data instanceof Uint8Array ? new Blob([out.data], { type: out.mime }) : out.data, `${base}.${out.ext}`, out.mime);
                return ok({ file: `${base}.${out.ext}`, bytes: out.data.length });
            },
            summarize: (input, r) => `downloaded ${r.file || input.format}`,
        },
    ];

    // ── Registration ──────────────────────────

    function summarizeInput(input) {
        const s = JSON.stringify(input || {});
        return s.length > 160 ? s.slice(0, 157) + "…" : s;
    }

    function record(def, input, result, started) {
        calls += 1;
        const okFlag = result && result.ok !== false;
        const summary = okFlag
            ? (def.summarize ? def.summarize(input || {}, result || {}) : def.name.replace(/_/g, " "))
            : `${def.name} failed: ${result.error}`;
        log.unshift({ time: new Date(), name: def.name, write: Boolean(def.write), input: summarizeInput(input), ok: okFlag, summary, ms: Date.now() - started });
        if (log.length > 100) log.length = 100;
        if (def.write) app.notify(`🤖 Agent ${summary}${okFlag ? " — Ctrl+Z in the editor undoes it" : ""}`, okFlag ? "info" : "warning");
        updateBadge();
        renderLog();
    }

    function toWebMcpTool(def) {
        return {
            name: def.name,
            title: def.title,
            description: def.description,
            inputSchema: def.inputSchema,
            annotations: def.annotations,
            execute: async (input) => {
                const started = Date.now();
                let result;
                if (def.write && !settings.allowEdits) {
                    result = fail("The user has not allowed agents to edit the document (🤖 Agents tab → Allow edits). Read-only tools still work.");
                } else if (!app.getModel()) {
                    result = fail("No document is loaded yet.");
                } else {
                    try {
                        result = await def.run(input || {});
                    } catch (err) {
                        result = fail(err && err.message ? err.message : String(err));
                    }
                }
                record(def, input, result, started);
                return result;
            },
        };
    }

    function unregister() {
        if (controller) controller.abort();
        controller = null;
        registered = 0;
    }

    function loadBridge() {
        if (bridgeLoaded || document.querySelector("script[data-mcpb]")) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = WEBMCP_CONFIG.mcpbScriptUrl;
            s.crossOrigin = "anonymous";
            s.dataset.mcpb = "1";
            s.onload = () => { bridgeLoaded = true; resolve(); };
            s.onerror = () => reject(new Error(`Could not load the MCP-B bridge from ${WEBMCP_CONFIG.mcpbScriptUrl}`));
            document.head.appendChild(s);
        });
    }

    async function register() {
        unregister();
        if (!settings.expose) { status = "disabled"; statusDetail = ""; renderStatus(); return; }
        if (!window.isSecureContext) {
            status = "insecure";
            statusDetail = "WebMCP needs a secure page: https:// or http://localhost.";
            renderStatus();
            return;
        }
        if (settings.bridge && !bridgeLoaded) {
            try { await loadBridge(); } catch (err) { status = "error"; statusDetail = err.message; renderStatus(); return; }
        }
        const mc = document.modelContext;
        if (!mc || typeof mc.registerTool !== "function") {
            status = "unsupported";
            statusDetail = "";
            renderStatus();
            return;
        }
        controller = new AbortController();
        const errors = [];
        for (const def of TOOLS) {
            try {
                await mc.registerTool(toWebMcpTool(def), { signal: controller.signal });
                registered += 1;
            } catch (err) {
                errors.push(`${def.name}: ${err && err.message ? err.message : err}`);
            }
        }
        status = registered ? "registered" : "error";
        statusDetail = errors.join(" · ");
        renderStatus();
    }

    // ── Agents tab ────────────────────────────

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    const root = el("div", "tool-root agents-root");
    const left = el("div", "agents-left");
    const statusBox = el("div", "agents-status");
    const logBox = el("div", "agents-log");
    root.appendChild(left);
    root.appendChild(logBox);

    function toggle(label, hint, key, onChange) {
        const row = el("label", "agents-toggle");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = Boolean(settings[key]);
        cb.addEventListener("change", () => { settings[key] = cb.checked; saveSettings(); onChange(cb.checked); });
        row.appendChild(cb);
        const text = el("span");
        text.appendChild(el("strong", "", label));
        if (hint) text.appendChild(el("span", "agents-hint", hint));
        row.appendChild(text);
        return row;
    }

    function renderStatus() {
        statusBox.innerHTML = "";
        const native = typeof document.modelContext !== "undefined" && !bridgeLoaded;
        let cls = "warn";
        let text;
        if (status === "registered") {
            cls = "ok";
            text = `${registered} tools are available to AI agents in this browser${bridgeLoaded ? " (via the MCP-B bridge)" : " (native WebMCP)"}.`;
        } else if (status === "disabled") {
            text = "Tools are not exposed to agents.";
        } else if (status === "insecure") {
            cls = "fail";
            text = statusDetail;
        } else if (status === "unsupported") {
            text = "This browser does not offer WebMCP. In Chrome 149+, enable chrome://flags/#enable-webmcp-testing (or use the origin trial), or connect the MCP-B extension below.";
        } else if (status === "error") {
            cls = "fail";
            text = `Could not register the tools: ${statusDetail}`;
        } else {
            text = "Starting…";
        }
        const box = el("div", `rdf-check ${cls}`, text);
        statusBox.appendChild(box);
        if (status === "registered" && statusDetail) statusBox.appendChild(el("p", "wb-note", `Some tools failed: ${statusDetail}`));
        if (native === false && status !== "registered" && status !== "disabled") { /* hint already in text */ }
    }

    function renderLeft() {
        left.innerHTML = "";
        left.appendChild(el("div", "wb-card-title", "Agents (WebMCP)"));
        left.appendChild(el("p", "wb-note", "AI agents in your browser can use this editor for you: read the document, find terms to reuse, design the ontology, add instances, query, validate and export. Every call is listed here; every edit can be undone with Ctrl+Z."));
        left.appendChild(statusBox);
        left.appendChild(toggle("Expose tools to agents", "Register the tools with document.modelContext.", "expose", () => register()));
        left.appendChild(toggle("Allow agents to edit the document", "Off: agents can only read, search, query and validate.", "allowEdits", () => renderStatus()));
        left.appendChild(toggle("Connect the MCP-B extension", "Loads the @mcp-b/global bridge (jsDelivr). Adds WebMCP where the browser lacks it and lets the MCP-B extension reach these tools. Reload to disconnect.", "bridge", on => { if (on) register(); else app.notify("Reload the page to disconnect the MCP-B bridge.", "info"); }));
        const links = el("p", "wb-note");
        links.innerHTML = `<a href="${WEBMCP_CONFIG.docs}" target="_blank" rel="noopener noreferrer">About WebMCP</a> · <a href="${WEBMCP_CONFIG.mcpbExtension}" target="_blank" rel="noopener noreferrer">MCP-B extension</a>`;
        left.appendChild(links);
        const details = el("details", "agents-tools");
        details.appendChild(el("summary", "", `${TOOLS.length} tools`));
        const list = el("ul");
        TOOLS.forEach(t => {
            const li = el("li");
            li.appendChild(el("code", "", t.name));
            li.appendChild(el("span", `agents-badge ${t.write ? "write" : "read"}`, t.write ? "edit" : (t.annotations.readOnlyHint ? "read" : "library")));
            li.appendChild(el("span", "agents-tool-desc", t.description));
            list.appendChild(li);
        });
        details.appendChild(list);
        left.appendChild(details);
        renderStatus();
    }

    function renderLog() {
        logBox.innerHTML = "";
        const bar = el("div", "tool-bar");
        bar.appendChild(el("span", "tool-summary", calls ? `${calls} tool call${calls === 1 ? "" : "s"} this session` : "No agent activity yet."));
        if (log.length) {
            const clear = el("button", "tool-btn", "Clear");
            clear.type = "button";
            clear.addEventListener("click", () => { log.length = 0; renderLog(); });
            bar.appendChild(clear);
        }
        logBox.appendChild(bar);
        if (!log.length) {
            logBox.appendChild(el("p", "panel-empty", "When an agent calls a tool, it appears here with its input and result."));
            return;
        }
        const table = el("table", "data-table agents-table");
        const thead = el("thead");
        const hr = el("tr");
        ["Time", "Tool", "Result", "Input"].forEach(h => hr.appendChild(el("th", "", h)));
        thead.appendChild(hr);
        table.appendChild(thead);
        const tbody = el("tbody");
        log.forEach(entry => {
            const tr = el("tr", entry.ok ? "" : "row-fail");
            tr.appendChild(el("td", "muted", entry.time.toLocaleTimeString()));
            const tool = el("td");
            tool.appendChild(el("code", "", entry.name));
            if (entry.write) tool.appendChild(el("span", "agents-badge write", "edit"));
            tr.appendChild(tool);
            tr.appendChild(el("td", entry.ok ? "" : "cell-fail", entry.summary));
            const input = el("td", "mono", entry.input);
            input.title = entry.input;
            tr.appendChild(input);
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        const wrap = el("div", "data-table-wrapper static");
        wrap.appendChild(table);
        logBox.appendChild(wrap);
    }

    function updateBadge() {
        app.ui.updateToolBadge("__agents__", calls || null, null);
    }

    renderLeft();
    renderLog();

    return {
        tab: { id: "__agents__", label: "🤖 Agents", render: c => c.appendChild(root) },
        register,
        unregister,
        tools: TOOLS,
        /** Run a tool the way an agent would (for tests and the console). */
        call: (name, input) => {
            const def = TOOLS.find(t => t.name === name);
            if (!def) return Promise.reject(new Error(`Unknown tool ${name}`));
            return toWebMcpTool(def).execute(input || {});
        },
        getStatus: () => ({ status, registered, bridge: bridgeLoaded, settings: Object.assign({}, settings), detail: statusDetail }),
    };
}
