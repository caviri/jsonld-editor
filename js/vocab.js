/* ==============================================
   JSON-LD Graph Visualization — Vocabulary library
   ==============================================

   The term index behind the Term Finder, the ontology designer, editor
   autocomplete and the "unknown term" checks. Sources:

     document  terms defined or used in the open document
     builtin   data/vocabularies/index.json (schema.org, DCTerms, FOAF, SKOS,
               PROV-O, ORG, DCAT, OWL-Time, SHACL, OWL, RDFS, RDF, XSD)
     live      vocabularies loaded on demand through the rete engine
               (catalog entries, any Turtle/N-Triples/JSON-LD URL or file,
               or a .rete file)
     remote    OLS (EBI) and Wikidata search APIs, queried on request
*/

function createVocabulary() {
    const KIND_LABELS = {
        C: "Class", O: "Object property", D: "Datatype property", A: "Annotation property",
        P: "Property", T: "Datatype", I: "Individual",
    };
    const KIND_GROUPS = {
        all: null,
        classes: new Set(["C"]),
        properties: new Set(["O", "D", "A", "P"]),
        datatypes: new Set(["T"]),
        individuals: new Set(["I"]),
    };
    const STORAGE_KEY = "jsonld-editor:live-vocabularies";

    const vocabs = new Map();       // id -> vocab
    const terms = new Map();        // iri -> term (library terms only)
    let docTerms = new Map();       // iri -> term (document)
    let docAliases = new Map();     // iri -> [alias]
    let docNamespaces = new Set();  // namespaces used by the document
    let builtinPromise = null;
    const listeners = new Set();

    function notify() { listeners.forEach(fn => { try { fn(); } catch (_) { /* ignore */ } }); }
    function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

    // ── Indexing ──────────────────────────────

    function makeTerm(vocab, iri, kind, label, comment, domain, range, sup, flags) {
        const local = JsonLd.localName(iri) || iri;
        const text = label || local;
        return {
            iri,
            local,
            kind,
            label: text,
            comment: comment || "",
            domain: domain || [],
            range: range || [],
            super: sup || [],
            flags: flags || "",
            vocab: vocab ? vocab.id : "document",
            vocabPrefix: vocab ? vocab.prefix : "",
            localLC: local.toLowerCase(),
            labelLC: text.toLowerCase(),
            words: splitWords(local + " " + text),
        };
    }

    function splitWords(text) {
        return text
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/[_\-./#:]+/g, " ")
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
    }

    function registerVocab(entry) {
        const id = entry.id || entry.prefix || entry.namespace;
        const vocab = Object.assign({ id, count: 0, origin: "live", order: vocabs.size }, entry, { id });
        vocabs.set(id, vocab);
        return vocab;
    }

    function addTerm(term) {
        const existing = terms.get(term.iri);
        // Keep the richer record when a vocabulary is loaded twice.
        if (existing && (existing.comment || "").length >= (term.comment || "").length && existing.domain.length >= term.domain.length) return;
        terms.set(term.iri, term);
    }

    function expandRef(ref, prefixTable) {
        if (!ref) return ref;
        if (ref.includes("://")) return ref;
        const i = ref.indexOf(":");
        if (i > 0 && prefixTable[ref.slice(0, i)]) return prefixTable[ref.slice(0, i)] + ref.slice(i + 1);
        return ref;
    }

    /** Load the bundled index (once). */
    function loadBuiltin() {
        if (builtinPromise) return builtinPromise;
        builtinPromise = fetch(VOCAB_INDEX_URL)
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then(data => {
                const prefixTable = Object.assign({}, COMMON_PREFIXES);
                const list = data.vocabularies.map((v, i) => {
                    prefixTable[v.prefix] = v.namespace;
                    return registerVocab({
                        id: v.prefix, prefix: v.prefix, namespace: v.namespace, title: v.title,
                        homepage: v.homepage, source: v.source, origin: "builtin", order: i,
                    });
                });
                data.terms.forEach(rec => {
                    const [vi, local, kind, label, comment, domain, range, sup, flags] = rec;
                    const vocab = list[vi];
                    const iri = vocab.namespace + local;
                    addTerm(makeTerm(vocab, iri, kind, label || local, comment || "",
                        domain.map(r => expandRef(r, prefixTable)),
                        range.map(r => expandRef(r, prefixTable)),
                        sup.map(r => expandRef(r, prefixTable)),
                        flags || ""));
                    vocab.count += 1;
                });
                restoreLiveVocabularies();
                notify();
                return true;
            })
            .catch(err => {
                console.warn("Vocabulary index not available:", err);
                builtinPromise = Promise.resolve(false);
                return false;
            });
        return builtinPromise;
    }

    function isReady() {
        return [...vocabs.values()].some(v => v.origin === "builtin");
    }

    // ── Live vocabularies (via rete) ──────────

    function storeLive() {
        try {
            const payload = [...vocabs.values()].filter(v => v.origin === "live" && v.cache).map(v => ({
                prefix: v.prefix, namespace: v.namespace, title: v.title, url: v.url, format: v.format,
                loadedAt: v.loadedAt, terms: v.cache,
            }));
            const text = JSON.stringify(payload);
            if (text.length > 3_000_000) return; // stay well within the storage quota
            localStorage.setItem(STORAGE_KEY, text);
        } catch (_) {
            // Storage full or blocked: live vocabularies just won't survive a reload.
        }
    }

    function restoreLiveVocabularies() {
        let saved = [];
        try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch (_) { saved = []; }
        saved.forEach(entry => {
            try { ingestLive(entry, entry.terms, false); } catch (_) { /* skip a corrupt entry */ }
        });
    }

    function ingestLive(entry, termRecords, persist = true) {
        const id = entry.prefix || entry.namespace || entry.url;
        if (vocabs.has(id) && vocabs.get(id).origin === "builtin") {
            // Loading a newer copy of a bundled vocabulary: merge into it.
        }
        const vocab = registerVocab({
            id, prefix: entry.prefix || id, namespace: entry.namespace || "", title: entry.title || id,
            url: entry.url, format: entry.format, origin: vocabs.has(id) && vocabs.get(id).origin === "builtin" ? "builtin" : "live",
            loadedAt: entry.loadedAt || new Date().toISOString(),
        });
        vocab.cache = termRecords;
        vocab.count = 0;
        termRecords.forEach(t => {
            if (vocab.namespace && !t.iri.startsWith(vocab.namespace)) return;
            addTerm(makeTerm(vocab, t.iri, t.kind, t.label || null, t.comment || "", t.domain, t.range, t.super, ""));
            vocab.count += 1;
        });
        if (persist) storeLive();
        notify();
        return vocab;
    }

    /** Guess the namespace that most extracted terms share. */
    function dominantNamespace(termRecords) {
        const counts = new Map();
        termRecords.forEach(t => {
            const ns = JsonLd.namespaceOf(t.iri);
            counts.set(ns, (counts.get(ns) || 0) + 1);
        });
        let best = null;
        counts.forEach((n, ns) => { if (!best || n > best[1]) best = [ns, n]; });
        return best ? best[0] : "";
    }

    function prefixForNamespace(ns) {
        for (const v of vocabs.values()) if (v.namespace === ns && v.prefix) return v.prefix;
        for (const [p, n] of Object.entries(COMMON_PREFIXES)) if (n === ns) return p;
        return null;
    }

    /**
     * Load a vocabulary from a URL (Turtle, N-Triples, JSON-LD or .rete) or
     * from file contents. entry: { url?, name?, prefix?, namespace?, title?, format? }
     */
    async function loadLive(entry, contents) {
        let format = entry.format || Rete.formatFromName(entry.url || entry.name || "") || "ttl";
        let input = contents;
        if (input === undefined) {
            const res = await fetch(entry.url, { headers: { Accept: "text/turtle, application/n-triples, application/ld+json;q=0.9, */*;q=0.5" } });
            if (!res.ok) throw new Error(`HTTP ${res.status} for ${entry.url}`);
            const type = (res.headers.get("content-type") || "").toLowerCase();
            if (format === "rete") input = new Uint8Array(await res.arrayBuffer());
            else {
                input = await res.text();
                if (type.includes("json")) format = "jsonld";
                else if (type.includes("n-triples")) format = "nt";
                else if (type.includes("rdf+xml") || /^\s*<\?xml|^\s*<rdf:RDF/.test(input)) {
                    throw new Error("This vocabulary is only served as RDF/XML, which the rete engine does not read. Convert it to Turtle first.");
                }
            }
        }
        const { terms: extracted, meta } = await Rete.extractTerms(input, format);
        if (!extracted.length) throw new Error("No classes or properties found in that vocabulary.");
        const namespace = entry.namespace || meta.namespace || dominantNamespace(extracted);
        const prefix = entry.prefix || meta.prefix || prefixForNamespace(namespace) || JsonLd.localName(namespace.replace(/[#/]+$/, "")).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "vocab";
        const records = extracted.filter(t => t.iri.startsWith(namespace));
        return ingestLive({
            prefix, namespace, title: entry.title || meta.title || prefix,
            url: entry.url || entry.name, format,
        }, records.length ? records : extracted);
    }

    function removeVocabulary(id) {
        const vocab = vocabs.get(id);
        if (!vocab || vocab.origin === "builtin") return;
        [...terms.values()].forEach(t => { if (t.vocab === id) terms.delete(t.iri); });
        vocabs.delete(id);
        storeLive();
        notify();
    }

    // ── Document terms ────────────────────────

    const CLASS_TYPES_SET = new Set(["http://www.w3.org/2002/07/owl#Class", "http://www.w3.org/2000/01/rdf-schema#Class"]);
    const KIND_FROM_TYPE = {
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

    function literalOf(node, pred) {
        const v = (node.props.get(pred) || []).find(x => x.kind === "literal");
        return v ? v.value : "";
    }
    function irisOf(node, ...preds) {
        const out = [];
        preds.forEach(p => (node.props.get(p) || []).forEach(v => { if (v.kind === "iri") out.push(v.iri); }));
        return out;
    }

    /** Recompute document terms from a JsonLd model. */
    function setDocumentModel(model) {
        const next = new Map();
        const uses = new Map(); // iri -> { kind, count }
        const ctx = model.context;
        model.nodes.forEach(node => {
            let kind = null;
            node.types.forEach(t => { if (KIND_FROM_TYPE[t] && (!kind || kind === "I")) kind = KIND_FROM_TYPE[t]; });
            if (kind && !node.blank) {
                const label = literalOf(node, SCHEMA_PREDICATES.label) || literalOf(node, "http://www.w3.org/2004/02/skos/core#prefLabel");
                const term = makeTerm(null, node.id, kind, label, literalOf(node, SCHEMA_PREDICATES.comment),
                    irisOf(node, SCHEMA_PREDICATES.domain, SCHEMA_PREDICATES.domainIncludes),
                    irisOf(node, SCHEMA_PREDICATES.range, SCHEMA_PREDICATES.rangeIncludes),
                    kind === "I" ? node.types.filter(t => !KIND_FROM_TYPE[t]) : irisOf(node, SCHEMA_PREDICATES.subClassOf, SCHEMA_PREDICATES.subPropertyOf),
                    "");
                term.defined = true;
                next.set(node.id, term);
            }
            node.types.forEach(t => {
                const u = uses.get(t) || { kind: "C", count: 0 };
                u.count += 1;
                uses.set(t, u);
            });
            node.props.forEach((values, pred) => {
                if (pred.startsWith("urn:unmapped:")) return;
                const literal = values.every(v => v.kind === "literal" && !v.linksTo);
                const u = uses.get(pred) || { kind: literal ? "D" : "O", count: 0 };
                u.count += values.length;
                uses.set(pred, u);
            });
        });
        // Terms used but not defined in the document and unknown to the library.
        uses.forEach((u, iri) => {
            if (next.has(iri)) { next.get(iri).uses = u.count; return; }
            if (terms.has(iri) || KIND_FROM_TYPE[iri]) return;
            if (!JsonLd.isAbsoluteIri(iri)) return;
            const term = makeTerm(null, iri, u.kind, null, "", [], [], [], "");
            term.defined = false;
            term.uses = u.count;
            next.set(iri, term);
        });
        docTerms = next;

        docAliases = new Map();
        Object.entries(ctx.terms).forEach(([alias, def]) => {
            if (!def || !def.id || alias.includes(":") || JsonLd.isKeyword(def.id)) return;
            if (def.prefix && /[#/:]$/.test(def.id)) return;
            if (!docAliases.has(def.id)) docAliases.set(def.id, []);
            docAliases.get(def.id).push(alias);
        });

        docNamespaces = new Set();
        JsonLd.prefixesOf(ctx).forEach(p => docNamespaces.add(p.namespace));
        if (ctx.vocab) docNamespaces.add(ctx.vocab);
        uses.forEach((_, iri) => docNamespaces.add(JsonLd.namespaceOf(iri)));
        notify();
    }

    // ── Lookup ────────────────────────────────

    function describe(iri) {
        const t = docTerms.get(iri) || terms.get(iri);
        if (!t) return null;
        const vocab = vocabs.get(t.vocab);
        return Object.assign({}, t, { vocabTitle: vocab ? vocab.title : (t.vocab === "document" ? "This document" : "") });
    }

    function vocabularyFor(iri) {
        let best = null;
        vocabs.forEach(v => {
            if (v.namespace && iri.startsWith(v.namespace) && (!best || v.namespace.length > best.namespace.length)) best = v;
        });
        return best;
    }

    function isKnownTerm(iri) {
        return terms.has(iri);
    }

    /** Edit distance where swapping two adjacent letters counts as one edit (typos). */
    function editDistance(a, b, max = 3) {
        if (Math.abs(a.length - b.length) > max) return max + 1;
        const rows = [];
        for (let i = 0; i <= a.length; i += 1) {
            rows.push(new Array(b.length + 1).fill(0));
            rows[i][0] = i;
        }
        for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
        for (let i = 1; i <= a.length; i += 1) {
            let rowMin = Infinity;
            for (let j = 1; j <= b.length; j += 1) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                let v = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
                if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2][j - 2] + 1);
                rows[i][j] = v;
                if (v < rowMin) rowMin = v;
            }
            if (rowMin > max) return max + 1;
        }
        return rows[a.length][b.length];
    }

    /**
     * Terms of the same vocabulary that look like a misspelling of `iri`.
     * `use` ("class" | "property") prefers terms of the same kind.
     */
    function suggestSimilar(iri, limit = 3, use = null) {
        const vocab = vocabularyFor(iri);
        if (!vocab) return [];
        const local = iri.slice(vocab.namespace.length);
        const localLC = local.toLowerCase();
        const wantProperty = use ? use === "property" : /^[a-z]/.test(local);
        const scored = [];
        terms.forEach(t => {
            if (t.vocab !== vocab.id) return;
            const sameKind = wantProperty === KIND_GROUPS.properties.has(t.kind);
            if (t.localLC === localLC) { scored.push([0, sameKind ? 0 : 1, t]); return; }
            const d = editDistance(localLC, t.localLC, 2);
            if (d <= 2) scored.push([d, sameKind ? 0 : 1, t]);
        });
        return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].local.length - b[2].local.length)
            .slice(0, limit).map(entry => entry[2]);
    }

    /** Library terms whose local name or label resembles a given name (for reuse hints). */
    function findReusable(name, kindGroup, limit = 5) {
        return search(name, { kind: kindGroup, sources: { document: false, library: true }, limit }).filter(r => r.score >= 55);
    }

    // ── Class helpers ─────────────────────────

    function superClasses(iri, seen = new Set()) {
        if (seen.has(iri)) return [];
        seen.add(iri);
        const t = docTerms.get(iri) || terms.get(iri);
        if (!t) return [];
        const out = [];
        t.super.forEach(s => { out.push(s); out.push(...superClasses(s, seen)); });
        return [...new Set(out)];
    }

    /**
     * Properties that apply to a class: declared with it (or a superclass) as
     * domain, in the document first, then the library. Generic properties of
     * owl:Thing / schema:Thing come last.
     */
    function propertiesForClass(classIri, limit = 80) {
        const chain = [classIri, ...superClasses(classIri)];
        const generic = new Set(["http://www.w3.org/2002/07/owl#Thing", "http://schema.org/Thing"]);
        const out = [];
        const seen = new Set();
        const consider = (t, source) => {
            if (seen.has(t.iri) || !KIND_GROUPS.properties.has(t.kind)) return;
            const idx = chain.findIndex(c => t.domain.includes(c));
            if (idx < 0) return;
            seen.add(t.iri);
            out.push({ term: t, depth: idx, generic: generic.has(chain[idx]), source });
        };
        docTerms.forEach(t => consider(t, "document"));
        terms.forEach(t => consider(t, "library"));
        out.sort((a, b) => (a.generic - b.generic) || (a.source === b.source ? 0 : a.source === "document" ? -1 : 1) || a.depth - b.depth || a.term.local.localeCompare(b.term.local));
        return out.slice(0, limit);
    }

    // ── Search ────────────────────────────────

    function scoreTerm(t, q, tokens, aliases) {
        let score = 0;
        const local = t.localLC;
        const label = t.labelLC;
        const names = [local, label, ...(aliases || []).map(a => a.toLowerCase())];
        if (names.some(n => n === q)) score = 100;
        else if (names.some(n => n.startsWith(q))) score = 82 - Math.min(10, Math.min(...names.filter(n => n.startsWith(q)).map(n => n.length - q.length)) * 0.6);
        else if (t.words.some(w => w.startsWith(q))) score = 64;
        else if (names.some(n => n.includes(q))) score = 48;
        else if (tokens.length > 1 && tokens.every(tok => t.words.some(w => w.startsWith(tok)))) score = 42;
        else if (q.length >= 4 && t.comment && t.comment.toLowerCase().includes(q)) score = 14;
        return score;
    }

    /**
     * search(query, { kind: "all"|"classes"|"properties"|"datatypes"|"individuals",
     *                 sources: { document, library }, limit, vocab })
     * Returns [{ term, score, source }].
     */
    function search(query, opts = {}) {
        const limit = opts.limit || 60;
        const kinds = KIND_GROUPS[opts.kind || "all"];
        let q = (query || "").trim().toLowerCase();
        let vocabFilter = opts.vocab || null;
        const m = /^([a-z][\w\-]*):(.*)$/i.exec(q);
        if (m && !q.includes("//")) {
            const prefix = m[1];
            const vocab = [...vocabs.values()].find(v => v.prefix && v.prefix.toLowerCase() === prefix);
            if (vocab) { vocabFilter = vocab.id; q = m[2]; }
        }
        const tokens = q.split(/\s+/).filter(Boolean);
        const sources = Object.assign({ document: true, library: true }, opts.sources || {});
        const results = [];
        const consider = (t, source) => {
            if (kinds && !kinds.has(t.kind)) return;
            if (vocabFilter && t.vocab !== vocabFilter) return;
            let score;
            if (!q) score = source === "document" ? 50 : 1;
            else score = scoreTerm(t, q, tokens, docAliases.get(t.iri));
            if (score <= 0) return;
            if (source === "document") score += 22;
            else {
                const vocab = vocabs.get(t.vocab);
                if (vocab && docNamespaces.has(vocab.namespace)) score += 10;
                if (vocab && vocab.origin === "builtin") score += Math.max(0, 6 - vocab.order * 0.5);
                if (t.flags) score -= 8;
            }
            if (!q && source !== "document" && !vocabFilter) return;
            results.push({ term: t, score, source });
        };
        if (sources.document) docTerms.forEach(t => consider(t, "document"));
        if (sources.library) terms.forEach(t => { if (!docTerms.has(t.iri) || !docTerms.get(t.iri).defined) consider(t, "library"); });
        results.sort((a, b) => b.score - a.score || a.term.local.length - b.term.local.length || a.term.local.localeCompare(b.term.local));
        return results.slice(0, limit);
    }

    // ── Remote search ─────────────────────────

    async function searchRemote(service, query, kind = "all") {
        const q = (query || "").trim();
        if (q.length < 2) return [];
        if (service === "ols") {
            const params = new URLSearchParams({
                q, rows: "25",
                fieldList: "iri,label,description,ontology_prefix,ontology_name,type,short_form",
            });
            if (kind === "classes") params.set("type", "class");
            else if (kind === "properties") params.set("type", "property");
            else if (kind === "individuals") params.set("type", "individual");
            const res = await fetch(`${TERM_SEARCH_SERVICES.ols.url}?${params}`);
            if (!res.ok) throw new Error(`OLS answered HTTP ${res.status}`);
            const data = await res.json();
            const docs = (data.response && data.response.docs) || [];
            const seen = new Set();
            return docs.filter(d => d.iri && !seen.has(d.iri) && seen.add(d.iri)).map(d => {
                const k = d.type === "class" ? "C" : d.type === "property" ? "P" : "I";
                const term = makeTerm({ id: "ols:" + (d.ontology_prefix || d.ontology_name || ""), prefix: (d.ontology_prefix || "").toLowerCase() }, d.iri, k, d.label, (d.description || [])[0] || "", [], [], [], "");
                term.remoteSource = `OLS · ${d.ontology_prefix || d.ontology_name || "?"}`;
                return { term, score: 0, source: "ols" };
            });
        }
        if (service === "wikidata") {
            const type = kind === "properties" ? "property" : "item";
            const params = new URLSearchParams({
                action: "wbsearchentities", search: q, language: "en", uselang: "en",
                type, format: "json", origin: "*", limit: "20",
            });
            const res = await fetch(`${TERM_SEARCH_SERVICES.wikidata.url}?${params}`);
            if (!res.ok) throw new Error(`Wikidata answered HTTP ${res.status}`);
            const data = await res.json();
            return (data.search || []).map(item => {
                const iri = type === "property" ? `http://www.wikidata.org/prop/direct/${item.id}` : `http://www.wikidata.org/entity/${item.id}`;
                const term = makeTerm({ id: "wikidata", prefix: type === "property" ? "wdt" : "wd" }, iri, type === "property" ? "P" : "I", item.label || item.id, item.description || "", [], [], [], "");
                term.remoteSource = `Wikidata · ${item.id}`;
                term.homepage = item.concepturi || `https://www.wikidata.org/wiki/${item.id}`;
                return { term, score: 0, source: "wikidata" };
            });
        }
        return [];
    }

    // ── Prefix suggestions ────────────────────

    /** A [prefix, namespace] pair suitable for adding to @context for an IRI. */
    function suggestPrefix(iri) {
        const vocab = vocabularyFor(iri);
        if (vocab && vocab.prefix && !vocab.id.startsWith("ols:")) return [vocab.prefix, vocab.namespace];
        let best = null;
        Object.entries(COMMON_PREFIXES).forEach(([p, ns]) => {
            if (iri.startsWith(ns) && (!best || ns.length > best[1].length)) best = [p, ns];
        });
        return best;
    }

    function namespaceForPrefix(prefix) {
        const v = vocabs.get(prefix);
        if (v && v.namespace) return v.namespace;
        return COMMON_PREFIXES[prefix] || null;
    }

    function listVocabularies() {
        return [...vocabs.values()].sort((a, b) => (a.origin === b.origin ? a.order - b.order : a.origin === "builtin" ? -1 : 1));
    }

    function documentTerms() { return [...docTerms.values()]; }

    return {
        KIND_LABELS,
        loadBuiltin,
        isReady,
        loadLive,
        removeVocabulary,
        listVocabularies,
        setDocumentModel,
        documentTerms,
        describe,
        vocabularyFor,
        isKnownTerm,
        suggestSimilar,
        findReusable,
        superClasses,
        propertiesForClass,
        search,
        searchRemote,
        suggestPrefix,
        namespaceForPrefix,
        onChange,
    };
}
