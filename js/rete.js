/* ==============================================
   JSON-LD Graph Visualization — rete integration
   ==============================================

   Bridges the editor to rete (https://github.com/caviri/rete), a single-file,
   range-queryable RDF graph format with a WebAssembly engine. The engine is
   loaded on first use (~8.5 MB from jsDelivr) and gives the editor:

     • a spec-grade JSON-LD → RDF conversion (what the graph *really* says),
     • export to .rete (optionally with a Dataset Card), N-Triples, N-Quads, Turtle,
     • import of .rete, Turtle, N-Triples, N-Quads and TriG into JSON-LD,
     • SPARQL 1.1 queries and SHACL Core validation over the current document,
     • parsing of live vocabularies for the Term Finder.

   Everything runs in the page; nothing is uploaded anywhere.
*/

const Rete = (function () {
    let loadPromise = null;
    let state = "idle";          // idle | loading | ready | error
    let lastError = null;
    const listeners = new Set();
    let cache = { text: null, bytes: null, graph: null };

    const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
    const XSD = "http://www.w3.org/2001/XMLSchema#";
    const XSD_STRING = XSD + "string";
    const RDF_LANG = "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";

    function emit() {
        listeners.forEach(fn => { try { fn(state, lastError); } catch (_) { /* ignore */ } });
    }

    function onStatus(fn) {
        listeners.add(fn);
        fn(state, lastError);
        return () => listeners.delete(fn);
    }

    function getState() { return state; }

    /** Load the engine (once). Resolves to the global `rete` object. */
    function ensure() {
        if (state === "ready" && window.rete) return Promise.resolve(window.rete);
        if (loadPromise) return loadPromise;
        state = "loading";
        lastError = null;
        emit();
        loadPromise = new Promise((resolve, reject) => {
            const done = async () => {
                try {
                    if (!window.rete) throw new Error("rete bundle loaded but did not define `rete`");
                    if (typeof window.rete.init === "function") await window.rete.init();
                    state = "ready";
                    emit();
                    resolve(window.rete);
                } catch (err) {
                    fail(err);
                }
            };
            const fail = (err) => {
                state = "error";
                lastError = err instanceof Error ? err : new Error(String(err));
                loadPromise = null;
                emit();
                reject(lastError);
            };
            if (window.rete) { done(); return; }
            const script = document.createElement("script");
            script.src = RETE_CONFIG.scriptUrl;
            script.async = true;
            script.crossOrigin = "anonymous";
            script.onload = done;
            script.onerror = () => fail(new Error(`Could not load the rete engine from ${RETE_CONFIG.scriptUrl}`));
            document.head.appendChild(script);
        });
        return loadPromise;
    }

    // ── Build / open ──────────────────────────

    /** Build .rete bytes from RDF text. `card` (object) embeds a Dataset Card. */
    async function buildBytes(text, format, card) {
        const r = await ensure();
        if (card && Object.keys(card).length) {
            const out = r.wasm.build_with_card(text, format, JSON.stringify(card));
            return out instanceof Uint8Array ? out : new Uint8Array(out);
        }
        return r.build(text, format);
    }

    async function openBytes(bytes) {
        const r = await ensure();
        return r.open(bytes);
    }

    /** JSON-LD text as prepared for the engine (known remote contexts inlined). */
    function prepareJsonld(text) {
        const doc = JSON.parse(text);
        return JSON.stringify(JsonLd.inlineRemoteContexts(doc));
    }

    /** The current document as an open rete graph (cached per text). */
    async function graphForJsonld(text) {
        if (cache.text === text && cache.graph) return cache;
        const bytes = await buildBytes(prepareJsonld(text), "jsonld");
        const graph = await openBytes(bytes);
        cache = { text, bytes, graph };
        return cache;
    }

    function invalidate() { cache = { text: null, bytes: null, graph: null }; }

    async function allTriples(bytes, limit) {
        const r = await ensure();
        const q = `CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }${limit ? ` LIMIT ${limit}` : ""}`;
        const env = JSON.parse(r.wasm.query(bytes, q, "json"));
        return env.triples || [];
    }

    // ── N-Triples term tokens ─────────────────

    function unescapeNt(s) {
        return s.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[tbnrf"'\\])/g, (_, e) => {
            switch (e[0]) {
                case "t": return "\t";
                case "b": return "\b";
                case "n": return "\n";
                case "r": return "\r";
                case "f": return "\f";
                case "u": case "U": return String.fromCodePoint(parseInt(e.slice(1), 16));
                default: return e;
            }
        });
    }

    /** Parse one engine term token: <iri> | _:b | "lit"(@lang|^^<dt>)? | << s p o >> */
    function parseTerm(token) {
        if (token.startsWith("<<")) return { kind: "triple", value: token };
        if (token.startsWith("<")) return { kind: "iri", value: token.slice(1, -1) };
        if (token.startsWith("_:")) return { kind: "bnode", value: token };
        if (token.startsWith('"')) {
            const end = token.lastIndexOf('"');
            const lex = unescapeNt(token.slice(1, end));
            const rest = token.slice(end + 1);
            if (rest.startsWith("@")) return { kind: "literal", value: lex, lang: rest.slice(1), datatype: RDF_LANG };
            if (rest.startsWith("^^")) return { kind: "literal", value: lex, datatype: rest.slice(3, -1) };
            return { kind: "literal", value: lex, datatype: XSD_STRING };
        }
        return { kind: "iri", value: token };
    }

    // ── Prefix handling for serialisers ───────

    /**
     * Choose prefixes for serialisation. Order of preference: the caller's
     * prefixes (e.g. the document's @context), well-known prefixes, a readable
     * name for every vocabulary namespace (predicates, types, datatypes), and
     * one prefix for the namespace most data IRIs share.
     */
    function buildPrefixMap(triples, preferred = {}) {
        const map = {};
        Object.entries(preferred).forEach(([p, ns]) => { if (typeof ns === "string" && /^[A-Za-z][\w.\-]*$/.test(p)) map[p] = ns; });
        const taken = new Set(Object.values(map));
        const vocabNs = new Map();
        const dataIris = new Set();
        const inc = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };
        const nsOf = (iri) => { const ns = JsonLd.namespaceOf(iri); return ns && ns !== iri ? ns : null; };
        triples.forEach(([s, p, o]) => {
            const st = parseTerm(s), pt = parseTerm(p), ot = parseTerm(o);
            if (pt.kind === "iri") inc(vocabNs, nsOf(pt.value));
            if (st.kind === "iri") dataIris.add(st.value);
            if (ot.kind === "iri") { if (pt.value === RDF_TYPE) inc(vocabNs, nsOf(ot.value)); else dataIris.add(ot.value); }
            if (ot.kind === "literal" && ot.datatype && ot.datatype !== XSD_STRING && ot.datatype !== RDF_LANG) inc(vocabNs, nsOf(ot.datatype));
        });
        const unique = (p) => {
            const stem = p || "ns";
            let candidate = stem;
            let n = 1;
            while (candidate in map) candidate = `${stem}${n++}`;
            return candidate;
        };
        const assign = (prefix, ns) => { map[prefix] = ns; taken.add(ns); };

        // 1. Well-known prefixes for namespaces that occur.
        const dataNs = new Set([...dataIris].map(nsOf).filter(Boolean));
        Object.entries(COMMON_PREFIXES).forEach(([p, ns]) => {
            if ((vocabNs.has(ns) || dataNs.has(ns)) && !taken.has(ns) && !(p in map)) assign(p, ns);
        });
        // 2. Every vocabulary namespace gets a readable prefix.
        [...vocabNs.entries()].sort((a, b) => b[1] - a[1]).forEach(([ns]) => {
            if (!taken.has(ns)) assign(unique(guessPrefix(ns, false)), ns);
        });
        // 3. The namespace shared by most data IRIs (ancestor paths count too).
        const coverage = new Map();
        dataIris.forEach(iri => {
            if ([...taken].some(ns => iri.startsWith(ns))) return;
            ancestorNamespaces(iri).forEach(ns => inc(coverage, ns));
        });
        let best = null;
        coverage.forEach((count, ns) => {
            if (count < 3) return;
            if (!best || count > best[1] || (count === best[1] && ns.length > best[0].length)) best = [ns, count];
        });
        if (best) assign(unique(guessPrefix(best[0], true) || "data"), best[0]);
        return map;
    }

    /** Namespaces (ending in / or #) that contain an IRI, below the host. */
    function ancestorNamespaces(iri) {
        const out = [];
        try {
            const u = new URL(iri);
            if (u.hash) out.push(iri.slice(0, iri.indexOf("#") + 1));
            const parts = u.pathname.split("/");
            let path = "";
            for (let i = 1; i < parts.length - 1; i += 1) {
                path += "/" + parts[i];
                out.push(`${u.protocol}//${u.host}${path}/`);
            }
        } catch (_) { /* not a URL */ }
        return out;
    }

    const GENERIC_SEGMENTS = /^(ontology|ontologies|ns|vocab|vocabulary|schema|core|terms|def|resource|resources|id|owl|rdf|v?\d+(\.\d+)*|latest|index|www)$/i;

    function guessPrefix(ns, isData) {
        let u;
        try { u = new URL(ns); } catch (_) { return null; }
        const segments = u.pathname.split("/").map(s => s.replace(/\.(ttl|owl|rdf|jsonld|nt)$/i, "")).filter(Boolean);
        const candidates = [...segments].reverse().filter(s => isData || !GENERIC_SEGMENTS.test(s));
        const hostLabels = u.hostname.split(".").filter(l => !/^(www|w3id|purl|data|ns)$/i.test(l));
        if (hostLabels.length > 1) candidates.push(hostLabels[hostLabels.length - 2]);
        else if (hostLabels.length) candidates.push(hostLabels[0]);
        for (const c of candidates) {
            const word = c.toLowerCase().replace(/[^a-z0-9]/g, "");
            if (word.length < 2 || word.length > 12 || !/^[a-z]/.test(word)) continue;
            if (COMMON_PREFIXES[word] && COMMON_PREFIXES[word] !== ns) continue;
            return word;
        }
        return null;
    }

    function compactWith(map, iri) {
        let best = null;
        Object.entries(map).forEach(([p, ns]) => {
            if (iri.startsWith(ns) && iri.length > ns.length && (!best || ns.length > best[1].length)) best = [p, ns];
        });
        if (!best) return null;
        const local = iri.slice(best[1].length);
        return { prefix: best[0], local };
    }

    // ── Turtle serialiser ─────────────────────

    const PN_LOCAL = /^[A-Za-z0-9_](?:[A-Za-z0-9_.\-]*[A-Za-z0-9_\-])?$/;

    function ttlString(s) {
        const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r");
        if (escaped.includes("\n")) return `"""${escaped.replace(/"""/g, '\\"\\"\\"')}"""`;
        return `"${escaped}"`;
    }

    function ttlIri(map, iri) {
        const c = compactWith(map, iri);
        if (c && (c.local === "" || PN_LOCAL.test(c.local))) return `${c.prefix}:${c.local}`;
        return `<${iri}>`;
    }

    function ttlTerm(map, token, isPredicate) {
        const t = parseTerm(token);
        if (t.kind === "iri") {
            if (isPredicate && t.value === RDF_TYPE) return "a";
            return ttlIri(map, t.value);
        }
        if (t.kind === "bnode" || t.kind === "triple") return token;
        const lex = t.value;
        if (t.lang) return `${ttlString(lex)}@${t.lang}`;
        if (!t.datatype || t.datatype === XSD_STRING) return ttlString(lex);
        if (t.datatype === XSD + "integer" && /^[+-]?\d+$/.test(lex)) return lex;
        if (t.datatype === XSD + "decimal" && /^[+-]?\d*\.\d+$/.test(lex)) return lex;
        if (t.datatype === XSD + "boolean" && (lex === "true" || lex === "false")) return lex;
        return `${ttlString(lex)}^^${ttlIri(map, t.datatype)}`;
    }

    function triplesToTurtle(triples, preferredPrefixes) {
        const map = buildPrefixMap(triples, preferredPrefixes);
        const bySubject = new Map();
        triples.forEach(([s, p, o]) => {
            if (!bySubject.has(s)) bySubject.set(s, new Map());
            const preds = bySubject.get(s);
            if (!preds.has(p)) preds.set(p, []);
            preds.get(p).push(o);
        });
        const used = new Set();
        const body = [];
        const mark = (s) => { const m = /^([A-Za-z][\w.\-]*|):/.exec(s); if (m && !s.startsWith("<") && !s.startsWith('"') && !s.startsWith("_:")) used.add(m[1]); };
        bySubject.forEach((preds, s) => {
            const subj = ttlTerm(map, s, false);
            mark(subj);
            const lines = [];
            const entries = [...preds.entries()].sort((a, b) => (a[0] === `<${RDF_TYPE}>` ? -1 : b[0] === `<${RDF_TYPE}>` ? 1 : 0));
            entries.forEach(([p, objs]) => {
                const pred = ttlTerm(map, p, true);
                mark(pred);
                const os = objs.map(o => { const t = ttlTerm(map, o, false); mark(t); return t; });
                lines.push(`    ${pred} ${os.join(" ,\n        ")}`);
            });
            body.push(`${subj}\n${lines.join(" ;\n")} .`);
        });
        // Datatype prefixes inside literals.
        body.forEach(chunk => { (chunk.match(/\^\^([A-Za-z][\w.\-]*):/g) || []).forEach(m => used.add(m.slice(2, -1))); });
        const header = Object.entries(map).filter(([p]) => used.has(p))
            .map(([p, ns]) => `@prefix ${p}: <${ns}> .`);
        return `${header.join("\n")}${header.length ? "\n\n" : ""}${body.join("\n\n")}\n`;
    }

    function triplesToNTriples(triples) {
        return triples.map(([s, p, o]) => `${s} ${p} ${o} .`).join("\n") + (triples.length ? "\n" : "");
    }

    // ── Triples → compact JSON-LD ─────────────

    function triplesToJsonld(triples, preferredPrefixes = {}) {
        const map = buildPrefixMap(triples, preferredPrefixes);
        const curie = (iri) => {
            const c = compactWith(map, iri);
            if (c && c.local && !c.local.includes("//") && !/[\s"<>]/.test(c.local)) return `${c.prefix}:${c.local}`;
            return iri;
        };
        const usedPrefixes = new Set();
        const note = (s) => { const i = s.indexOf(":"); if (i > 0 && !s.startsWith("_:") && map[s.slice(0, i)]) usedPrefixes.add(s.slice(0, i)); return s; };

        const subjects = new Map();
        const objectRefs = new Map();
        triples.forEach(([s, p, o]) => {
            if (!subjects.has(s)) subjects.set(s, []);
            subjects.get(s).push([p, o]);
            if (o.startsWith("_:")) objectRefs.set(o, (objectRefs.get(o) || 0) + 1);
        });

        // RDF collections (rdf:first / rdf:rest chains of blank nodes) become @list.
        const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
        const FIRST = `<${RDF_NS}first>`;
        const REST = `<${RDF_NS}rest>`;
        const NIL = `<${RDF_NS}nil>`;
        const restTargets = new Set();
        triples.forEach(([, p, o]) => { if (p === REST) restTargets.add(o); });
        const listItems = new Map();
        const consumed = new Set();
        const chain = (head) => {
            const items = [];
            const nodes = new Set();
            let cur = head;
            while (cur !== NIL) {
                if (!cur.startsWith("_:") || nodes.has(cur) || (objectRefs.get(cur) || 0) !== 1) return null;
                const props = subjects.get(cur) || [];
                const first = props.filter(([p]) => p === FIRST);
                const rest = props.filter(([p]) => p === REST);
                if (props.length !== 2 || first.length !== 1 || rest.length !== 1) return null;
                nodes.add(cur);
                items.push(first[0][1]);
                cur = rest[0][1];
            }
            return { items, nodes };
        };
        subjects.forEach((_, s) => {
            if (!s.startsWith("_:") || restTargets.has(s)) return;
            const c = chain(s);
            if (!c) return;
            listItems.set(s, c.items);
            c.nodes.forEach(n => consumed.add(n));
        });

        const embeddable = new Set([...objectRefs.entries()].filter(([b, n]) => n === 1 && subjects.has(b) && !consumed.has(b)).map(([b]) => b));

        const valueOf = (tok, building) => {
            if (listItems.has(tok)) return { "@list": listItems.get(tok).map(item => valueOf(item, building)) };
            if (tok === NIL) return { "@list": [] };
            const t = parseTerm(tok);
            if (t.kind === "iri") return { "@id": note(curie(t.value)) };
            if (t.kind === "bnode") {
                if (embeddable.has(tok) && !building.has(tok)) {
                    building.add(tok);
                    const nested = nodeObject(tok, building, true);
                    building.delete(tok);
                    return nested;
                }
                return { "@id": tok };
            }
            if (t.kind === "triple") return { "@value": tok };
            if (t.lang) return { "@value": t.value, "@language": t.lang };
            if (!t.datatype || t.datatype === XSD_STRING) return t.value;
            if (t.datatype === XSD + "integer" && /^[+-]?\d{1,15}$/.test(t.value)) return Number(t.value);
            if (t.datatype === XSD + "boolean" && (t.value === "true" || t.value === "false")) return t.value === "true";
            return { "@value": t.value, "@type": note(curie(t.datatype)) };
        };

        function nodeObject(subject, building, embedded) {
            const obj = {};
            if (!embedded) obj["@id"] = subject.startsWith("_:") ? subject : note(curie(parseTerm(subject).value));
            const types = [];
            const props = new Map();
            (subjects.get(subject) || []).forEach(([p, o]) => {
                const pred = parseTerm(p).value;
                if (pred === RDF_TYPE && o.startsWith("<")) { types.push(note(curie(parseTerm(o).value))); return; }
                const key = note(curie(pred));
                if (!props.has(key)) props.set(key, []);
                props.get(key).push(valueOf(o, building));
            });
            if (types.length) obj["@type"] = types.length === 1 ? types[0] : types;
            props.forEach((vals, key) => { obj[key] = vals.length === 1 ? vals[0] : vals; });
            return obj;
        }

        const graph = [];
        const ontologyFirst = [...subjects.keys()].sort((a, b) => {
            const rank = (s) => (subjects.get(s) || []).some(([p, o]) => parseTerm(p).value === RDF_TYPE && o === "<http://www.w3.org/2002/07/owl#Ontology>") ? 0 : 1;
            return rank(a) - rank(b);
        });
        ontologyFirst.forEach(s => {
            if (embeddable.has(s) || consumed.has(s)) return;
            graph.push(nodeObject(s, new Set([s]), false));
        });

        const context = {};
        Object.entries(map).forEach(([p, ns]) => { if (usedPrefixes.has(p)) context[p] = ns; });
        return { "@context": context, "@graph": graph };
    }

    // ── High-level operations ─────────────────

    function formatFromName(name) {
        const n = (name || "").toLowerCase().replace(/\.(gz)$/, "");
        if (n.endsWith(".rete")) return "rete";
        if (n.endsWith(".ttl") || n.endsWith(".turtle")) return "ttl";
        if (n.endsWith(".nt") || n.endsWith(".ntriples")) return "nt";
        if (n.endsWith(".nq") || n.endsWith(".nquads")) return "nq";
        if (n.endsWith(".trig")) return "trig";
        if (n.endsWith(".jsonld") || n.endsWith(".json")) return "jsonld";
        if (n.endsWith(".yamlld")) return "yamlld";
        return null;
    }

    /**
     * Import RDF (text or .rete bytes) and return { doc, triples, total, truncated, card }.
     * `preferredPrefixes` seeds the generated @context.
     */
    async function importRdf(input, format, preferredPrefixes = {}) {
        let bytes;
        if (format === "rete") {
            bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        } else {
            bytes = await buildBytes(input, format);
        }
        const graph = await openBytes(bytes);
        const info = graph.info();
        const total = info.quads;
        const limit = RETE_CONFIG.maxImportTriples;
        const triples = await allTriples(bytes, total > limit ? limit : 0);
        let card = null;
        try { card = graph.card(); } catch (_) { card = null; }
        return { doc: triplesToJsonld(triples, preferredPrefixes), triples: triples.length, total, truncated: total > limit, card, namedGraphs: info.namedGraphs };
    }

    /** Export the JSON-LD document. kind: "rete" | "ttl" | "nt" | "nq". */
    async function exportDocument(text, kind, opts = {}) {
        if (kind === "rete") {
            const bytes = await buildBytes(prepareJsonld(text), "jsonld", opts.card);
            return { data: bytes, mime: "application/vnd.rete", ext: "rete" };
        }
        const { bytes, graph } = await graphForJsonld(text);
        if (kind === "nq") {
            const nq = await graph.toNQuads();
            return { data: nq, mime: "application/n-quads", ext: "nq" };
        }
        const triples = await allTriples(bytes);
        if (kind === "nt") return { data: triplesToNTriples(triples), mime: "application/n-triples", ext: "nt" };
        return { data: triplesToTurtle(triples, opts.prefixes || {}), mime: "text/turtle", ext: "ttl" };
    }

    /** Facts about the current document as RDF: { quads, terms, subjects:Set } */
    async function inspect(text) {
        const { graph } = await graphForJsonld(text);
        const info = graph.info();
        const subjects = new Set();
        graph.query("SELECT DISTINCT ?s WHERE { ?s ?p ?o }").forEach(row => { if (row.s) subjects.add(row.s.value); });
        return { quads: info.quads, terms: info.terms, subjects, schema: graph.schema() };
    }

    /** SPARQL over the document. Returns the engine's raw envelope. */
    async function sparql(text, query, opts = {}) {
        const { graph } = await graphForJsonld(text);
        const started = performance.now();
        const env = graph.queryRaw(query, { reason: Boolean(opts.reason) });
        return { env, ms: performance.now() - started, warnings: graph.lastWarnings ? graph.lastWarnings() : [] };
    }

    /**
     * SHACL Core validation of the document against Turtle shapes.
     * Returns { conforms, results: [...], targets: Map(nodeId -> shapes[]) }.
     */
    async function shacl(text, shapesTurtle) {
        const { graph } = await graphForJsonld(text);
        const report = graph.shacl(shapesTurtle, { format: "json" });
        const parsed = typeof report === "string" ? JSON.parse(report) : report;
        // Which nodes were targeted? Ask the shapes graph for its targets.
        const targets = new Map();
        try {
            const shapesGraph = await openBytes(await buildBytes(shapesTurtle, "ttl"));
            const rows = shapesGraph.query(`PREFIX sh: <http://www.w3.org/ns/shacl#>
                SELECT ?shape ?class ?node WHERE {
                  { ?shape sh:targetClass ?class } UNION { ?shape sh:targetNode ?node }
                  UNION { ?shape a sh:NodeShape , <http://www.w3.org/2000/01/rdf-schema#Class> BIND(?shape AS ?class) }
                }`);
            const classTargets = rows.filter(r => r.class).map(r => ({ shape: r.shape.value, cls: r.class.value }));
            const nodeTargets = rows.filter(r => r.node).map(r => ({ shape: r.shape.value, node: r.node.value }));
            if (classTargets.length) {
                const values = classTargets.map(t => `<${t.cls}>`).join(" ");
                graph.query(`SELECT ?s ?c WHERE { VALUES ?c { ${values} } ?s a ?c }`).forEach(r => {
                    const shapes = classTargets.filter(t => t.cls === r.c.value).map(t => t.shape);
                    targets.set(r.s.value, (targets.get(r.s.value) || []).concat(shapes));
                });
            }
            nodeTargets.forEach(t => targets.set(t.node, (targets.get(t.node) || []).concat([t.shape])));
        } catch (_) {
            // Target discovery is best effort; violations are still reported.
        }
        return { conforms: Boolean(parsed.conforms), results: parsed.results || [], targets };
    }

    const TERMS_QUERY = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX schema: <http://schema.org/>
PREFIX dcterms: <http://purl.org/dc/terms/>
SELECT ?t ?type ?label ?comment ?domain ?range ?super WHERE {
  ?t a ?type .
  FILTER(isIRI(?t))
  VALUES ?type { owl:Class rdfs:Class owl:ObjectProperty owl:DatatypeProperty owl:AnnotationProperty rdf:Property rdfs:Datatype owl:NamedIndividual skos:Concept }
  OPTIONAL { ?t rdfs:label ?label }
  OPTIONAL { ?t rdfs:comment ?comment }
  OPTIONAL { ?t rdfs:domain|schema:domainIncludes ?domain FILTER(isIRI(?domain)) }
  OPTIONAL { ?t rdfs:range|schema:rangeIncludes ?range FILTER(isIRI(?range)) }
  OPTIONAL { ?t rdfs:subClassOf|rdfs:subPropertyOf ?super FILTER(isIRI(?super)) }
}`;
    const KIND_BY_TYPE = {
        "http://www.w3.org/2002/07/owl#Class": "C",
        "http://www.w3.org/2000/01/rdf-schema#Class": "C",
        "http://www.w3.org/2002/07/owl#ObjectProperty": "O",
        "http://www.w3.org/2002/07/owl#DatatypeProperty": "D",
        "http://www.w3.org/2002/07/owl#AnnotationProperty": "A",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#Property": "P",
        "http://www.w3.org/2000/01/rdf-schema#Datatype": "T",
        "http://www.w3.org/2002/07/owl#NamedIndividual": "I",
        "http://www.w3.org/2004/02/skos/core#Concept": "I",
    };
    const KIND_RANK = { C: 6, T: 5, O: 4, D: 4, A: 3, P: 2, I: 1 };

    /**
     * Extract vocabulary terms from RDF (text or .rete bytes).
     * Returns [{ iri, kind, label, comment, domain[], range[], super[] }] and
     * the ontology's own metadata { namespace, prefix, title }.
     */
    async function extractTerms(input, format) {
        const bytes = format === "rete" ? (input instanceof Uint8Array ? input : new Uint8Array(input)) : await buildBytes(input, format);
        const graph = await openBytes(bytes);
        const rows = graph.query(TERMS_QUERY);
        const byIri = new Map();
        const pickText = (current, term) => {
            if (!term) return current;
            if (!current) return term;
            const en = term.lang && /^en/i.test(term.lang);
            const curEn = current.lang && /^en/i.test(current.lang);
            if (en && !curEn) return term;
            if (!current.lang && term.lang && !en) return current;
            return current;
        };
        rows.forEach(r => {
            const iri = r.t.value;
            const kind = KIND_BY_TYPE[r.type.value] || "P";
            let rec = byIri.get(iri);
            if (!rec) { rec = { iri, kind, labelTerm: null, commentTerm: null, domain: new Set(), range: new Set(), super: new Set() }; byIri.set(iri, rec); }
            if (KIND_RANK[kind] > KIND_RANK[rec.kind]) rec.kind = kind;
            rec.labelTerm = pickText(rec.labelTerm, r.label);
            rec.commentTerm = pickText(rec.commentTerm, r.comment);
            if (r.domain) rec.domain.add(r.domain.value);
            if (r.range) rec.range.add(r.range.value);
            if (r.super) rec.super.add(r.super.value);
        });
        let meta = {};
        try {
            const m = graph.query(`PREFIX owl: <http://www.w3.org/2002/07/owl#>
                PREFIX vann: <http://purl.org/vocab/vann/>
                PREFIX dcterms: <http://purl.org/dc/terms/>
                PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
                SELECT ?o ?prefix ?ns ?title WHERE { ?o a owl:Ontology .
                  OPTIONAL { ?o vann:preferredNamespacePrefix ?prefix }
                  OPTIONAL { ?o vann:preferredNamespaceUri ?ns }
                  OPTIONAL { ?o dcterms:title|rdfs:label ?title } } LIMIT 1`);
            if (m.length) {
                meta = {
                    ontology: m[0].o.value,
                    prefix: m[0].prefix ? m[0].prefix.value : null,
                    namespace: m[0].ns ? m[0].ns.value : null,
                    title: m[0].title ? m[0].title.value : null,
                };
            }
        } catch (_) { /* optional */ }
        const terms = [...byIri.values()].map(rec => ({
            iri: rec.iri,
            kind: rec.kind,
            label: rec.labelTerm ? rec.labelTerm.value : null,
            comment: rec.commentTerm ? rec.commentTerm.value.replace(/\s+/g, " ").slice(0, 400) : null,
            domain: [...rec.domain],
            range: [...rec.range],
            super: [...rec.super],
        }));
        return { terms, meta, quads: graph.info().quads };
    }

    return {
        ensure,
        onStatus,
        getState,
        buildBytes,
        openBytes,
        graphForJsonld,
        invalidate,
        importRdf,
        exportDocument,
        inspect,
        sparql,
        shacl,
        extractTerms,
        formatFromName,
        parseTerm,
        triplesToTurtle,
        triplesToJsonld,
    };
})();
