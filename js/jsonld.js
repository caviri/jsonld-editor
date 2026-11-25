/* ==============================================
   JSON-LD Graph Visualization — JSON-LD processing
   ==============================================

   A small, synchronous JSON-LD reader for the editor. It understands the parts
   of JSON-LD 1.1 that shape a graph — @context (prefixes, term definitions,
   @vocab, @base, @language, type coercion, containers), @graph, @included,
   nested node objects, value objects, lists — and keeps enough of the original
   spelling (raw ids and keys) to map every node back to the source text.

   It is not a conformance-complete processor: the authoritative RDF conversion
   is done by the rete engine (js/rete.js). This module's job is visualisation,
   editing and linting, so it is deliberately forgiving and records problems as
   warnings instead of throwing.
*/

const JsonLd = (function () {
    const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
    const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
    const XSD = "http://www.w3.org/2001/XMLSchema#";
    const RDF_TYPE = RDF + "type";

    // Remote contexts we can resolve without a network request. The engine
    // fetches nothing either, so these are also inlined before an RDF build.
    const KNOWN_REMOTE_CONTEXTS = {
        "http://schema.org": { "@vocab": "http://schema.org/" },
        "http://schema.org/": { "@vocab": "http://schema.org/" },
        "https://schema.org": { "@vocab": "http://schema.org/" },
        "https://schema.org/": { "@vocab": "http://schema.org/" },
        "https://schema.org/docs/jsonldcontext.jsonld": { "@vocab": "http://schema.org/" },
        "https://w3id.org/security/v2": {},
        "https://www.w3.org/ns/activitystreams": { "as": "https://www.w3.org/ns/activitystreams#", "@vocab": "https://www.w3.org/ns/activitystreams#" },
    };

    // URI schemes that are legitimately written as "scheme:rest" without a prefix.
    const COMMON_SCHEMES = new Set([
        "http", "https", "urn", "mailto", "tel", "file", "ftp", "data", "tag", "did",
        "doi", "ark", "info", "geo", "ws", "wss", "ipfs", "isbn", "issn", "uuid",
    ]);

    const GEN_DELIMS = new Set([":", "/", "?", "#", "[", "]", "@"]);
    const KEYWORDS = new Set([
        "@base", "@container", "@context", "@direction", "@graph", "@id", "@import",
        "@included", "@index", "@json", "@language", "@list", "@nest", "@none",
        "@prefix", "@propagate", "@protected", "@reverse", "@set", "@type", "@value",
        "@version", "@vocab",
    ]);

    function isAbsoluteIri(value) {
        return typeof value === "string" && /^[A-Za-z][A-Za-z0-9+.\-]*:[^\s<>"{}|\\^`]*$/.test(value);
    }

    function isBlankId(value) {
        return typeof value === "string" && value.startsWith("_:");
    }

    function isKeyword(value) {
        return typeof value === "string" && KEYWORDS.has(value);
    }

    function localName(iri) {
        if (!iri) return "";
        const m = /[#/:]([^#/:]+)\/?$/.exec(iri);
        return m ? m[1] : iri;
    }

    function namespaceOf(iri) {
        if (!iri) return "";
        const hash = iri.lastIndexOf("#");
        if (hash >= 0) return iri.slice(0, hash + 1);
        const slash = iri.lastIndexOf("/");
        if (slash >= 0 && slash < iri.length - 1) return iri.slice(0, slash + 1);
        return iri;
    }

    function asArray(value) {
        if (value === undefined || value === null) return [];
        return Array.isArray(value) ? value : [value];
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    // ── Context processing ────────────────────

    function emptyContext(documentBase) {
        return {
            terms: {},           // term -> { id, type, container, reverse, prefix, simple }
            vocab: null,
            base: documentBase || null,
            language: null,
            reverseIndex: null,  // iri -> [term], built lazily for compaction
        };
    }

    function copyContext(ctx) {
        return {
            terms: Object.assign({}, ctx.terms),
            vocab: ctx.vocab,
            base: ctx.base,
            language: ctx.language,
            reverseIndex: null,
        };
    }

    /**
     * Apply a local @context (object, string, array or null) to an active context.
     * `warnings` collects { code, message, detail } entries.
     */
    function processContext(active, local, warnings, documentBase) {
        let result = copyContext(active);
        for (const item of asArray(local === null ? [null] : local)) {
            if (item === null) {
                result = emptyContext(documentBase);
                continue;
            }
            if (typeof item === "string") {
                const known = KNOWN_REMOTE_CONTEXTS[item] || remoteContextCache[item];
                if (known) {
                    result = processContext(result, known, warnings, documentBase);
                } else {
                    warnings.push({
                        code: "remote-context",
                        message: `Remote @context "${item}" is not loaded; its terms are unknown here.`,
                        detail: item,
                    });
                }
                continue;
            }
            if (typeof item !== "object" || Array.isArray(item)) continue;

            if ("@base" in item) {
                const base = item["@base"];
                if (base === null) result.base = null;
                else if (typeof base === "string") result.base = resolveRelative(base, result.base) || base;
            }
            if ("@vocab" in item) {
                const vocab = item["@vocab"];
                if (vocab === null) result.vocab = null;
                else if (typeof vocab === "string") {
                    result.vocab = vocab === "" ? (result.base || "") : expandIri(result, vocab, { vocab: true, documentRelative: true });
                }
            }
            if ("@language" in item) result.language = item["@language"];

            // Term definitions may refer to each other in any order: resolve lazily.
            const pending = {};
            Object.keys(item).forEach(key => {
                if (key.startsWith("@")) return;
                pending[key] = item[key];
            });
            const defining = new Set();
            const define = (term) => {
                if (!(term in pending)) return;
                if (defining.has(term)) {
                    warnings.push({ code: "cyclic-term", message: `Cyclic term definition for "${term}".`, detail: term });
                    delete pending[term];
                    return;
                }
                defining.add(term);
                const raw = pending[term];
                // Resolve referenced prefix first so expandIri can see it.
                const target = typeof raw === "string" ? raw : (raw && typeof raw === "object" ? raw["@id"] : undefined);
                if (typeof target === "string" && target.includes(":")) {
                    const prefix = target.split(":")[0];
                    if (prefix !== term && prefix in pending) define(prefix);
                }
                delete pending[term];
                defining.delete(term);
                result.terms[term] = buildTermDefinition(result, term, raw, warnings);
            };
            Object.keys(pending).forEach(define);
        }
        return result;
    }

    function buildTermDefinition(ctx, term, raw, warnings) {
        if (raw === null) return { id: null, simple: true };
        if (typeof raw === "string") {
            const id = isKeyword(raw) ? raw : expandIri(ctx, raw, { vocab: true, documentRelative: false, forDefinition: term });
            const lastChar = id ? id[id.length - 1] : "";
            return { id, simple: true, prefix: GEN_DELIMS.has(lastChar) || isBlankId(id) };
        }
        if (typeof raw !== "object") return { id: null, simple: true };
        const def = { simple: false };
        if ("@reverse" in raw) {
            def.reverse = true;
            def.id = expandIri(ctx, raw["@reverse"], { vocab: true });
        } else if ("@id" in raw && raw["@id"] !== null) {
            def.id = isKeyword(raw["@id"]) ? raw["@id"] : expandIri(ctx, raw["@id"], { vocab: true, forDefinition: term });
        } else if (term.includes(":")) {
            def.id = expandIri(ctx, term, { vocab: true, forDefinition: term });
        } else if (ctx.vocab) {
            def.id = ctx.vocab + term;
        } else {
            def.id = null;
            warnings.push({ code: "term-no-iri", message: `Term "${term}" has no @id and there is no @vocab.`, detail: term });
        }
        if ("@type" in raw) {
            const t = raw["@type"];
            def.type = (t === "@id" || t === "@vocab" || t === "@json" || t === "@none") ? t : expandIri(ctx, t, { vocab: true });
        }
        if ("@container" in raw) def.container = asArray(raw["@container"]);
        if ("@language" in raw) def.language = raw["@language"];
        if ("@prefix" in raw) def.prefix = Boolean(raw["@prefix"]);
        return def;
    }

    function resolveRelative(value, base) {
        if (!base) return null;
        try {
            return new URL(value, base).href;
        } catch (_) {
            return null;
        }
    }

    /**
     * IRI expansion (JSON-LD 1.1 §5.2, simplified).
     *   vocab: true          — keys, @type values and @vocab-coerced values
     *   documentRelative     — @id values: resolve relative IRIs against @base
     */
    function expandIri(ctx, value, opts = {}) {
        if (value === null || value === undefined || typeof value !== "string") return value;
        if (isKeyword(value)) return value;
        if (value.startsWith("@") && /^@[A-Za-z]+$/.test(value)) return null; // keyword-like: ignored
        if (opts.vocab && ctx.terms[value] && value !== opts.forDefinition) {
            const def = ctx.terms[value];
            return def.id === undefined ? null : def.id;
        }
        const colon = value.indexOf(":");
        if (colon > 0) {
            const prefix = value.slice(0, colon);
            const suffix = value.slice(colon + 1);
            if (prefix === "_") return value;
            if (suffix.startsWith("//")) return value;
            const def = ctx.terms[prefix];
            if (def && def.id && (def.prefix || def.simple) && prefix !== opts.forDefinition) {
                return def.id + suffix;
            }
            if (isAbsoluteIri(value)) return value;
        }
        if (opts.vocab && ctx.vocab !== null && ctx.vocab !== undefined) return ctx.vocab + value;
        if (opts.documentRelative) {
            const resolved = resolveRelative(value, ctx.base);
            if (resolved) return resolved;
        }
        return value;
    }

    function buildReverseIndex(ctx) {
        if (ctx.reverseIndex) return ctx.reverseIndex;
        const index = {};
        Object.entries(ctx.terms).forEach(([term, def]) => {
            if (!def || !def.id || def.reverse) return;
            (index[def.id] = index[def.id] || []).push({ term, def });
        });
        // Prefer short, coercion-free terms.
        Object.values(index).forEach(list => list.sort((a, b) =>
            (a.def.simple === b.def.simple ? 0 : a.def.simple ? -1 : 1) || a.term.length - b.term.length));
        ctx.reverseIndex = index;
        return index;
    }

    /** All prefix definitions usable for compaction: [{ prefix, namespace }]. */
    function prefixesOf(ctx) {
        const out = [];
        Object.entries(ctx.terms).forEach(([term, def]) => {
            if (!def || !def.id || term.includes(":")) return;
            if (def.prefix || (def.simple && GEN_DELIMS.has(def.id[def.id.length - 1]))) {
                out.push({ prefix: term, namespace: def.id });
            }
        });
        out.sort((a, b) => b.namespace.length - a.namespace.length);
        return out;
    }

    /**
     * IRI compaction. `vocab: true` allows term aliases and @vocab-relative
     * names (keys, @type values). `preferCurie` keeps "prefix:local" over an
     * alias, matching documents that spell keys as CURIEs.
     */
    function compactIri(ctx, iri, opts = {}) {
        if (!iri || typeof iri !== "string" || isKeyword(iri) || isBlankId(iri)) return iri;
        if (opts.vocab && !opts.preferCurie) {
            const hits = buildReverseIndex(ctx)[iri];
            if (hits && hits.length) return hits[0].term;
        }
        let curie = null;
        for (const { prefix, namespace } of prefixesOf(ctx)) {
            if (iri.startsWith(namespace) && iri.length > namespace.length) {
                const local = iri.slice(namespace.length);
                if (!local.startsWith("//") && !/[\s"<>]/.test(local)) {
                    curie = `${prefix}:${local}`;
                    break;
                }
            }
        }
        if (opts.vocab && ctx.vocab && iri.startsWith(ctx.vocab)) {
            const local = iri.slice(ctx.vocab.length);
            if (local && !local.includes(":") && !ctx.terms[local] && /^[A-Za-z_][\w.\-]*$/.test(local)) {
                if (!curie || opts.preferVocab) return local;
            }
        }
        if (curie) return curie;
        if (opts.vocab && opts.preferCurie) {
            const hits = buildReverseIndex(ctx)[iri];
            if (hits && hits.length) return hits[0].term;
        }
        if (!opts.vocab && ctx.base && iri.startsWith(ctx.base) && iri.length > ctx.base.length) {
            const rel = iri.slice(ctx.base.length);
            if (!rel.includes(":") || rel.indexOf(":") > rel.indexOf("/")) return rel;
        }
        return iri;
    }

    // ── Remote contexts (optional prefetch) ───

    const remoteContextCache = {};

    function collectRemoteContextUrls(value, out = new Set()) {
        if (Array.isArray(value)) value.forEach(v => collectRemoteContextUrls(v, out));
        else if (value && typeof value === "object") {
            Object.entries(value).forEach(([key, v]) => {
                if (key === "@context") {
                    asArray(v).forEach(c => {
                        if (typeof c === "string" && !KNOWN_REMOTE_CONTEXTS[c] && !remoteContextCache[c]) out.add(c);
                    });
                }
                if (v && typeof v === "object") collectRemoteContextUrls(v, out);
            });
        }
        return out;
    }

    /** Try to fetch remote contexts (CORS permitting). Failures stay warnings. */
    async function prefetchRemoteContexts(doc, timeoutMs = 6000) {
        const urls = [...collectRemoteContextUrls(doc)].filter(u => /^https?:\/\//.test(u));
        await Promise.all(urls.map(async url => {
            const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
            const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
            try {
                const res = await fetch(url, { headers: { Accept: "application/ld+json, application/json" }, signal: ctrl && ctrl.signal });
                if (!res.ok) return;
                const json = await res.json();
                if (json && typeof json === "object" && json["@context"] !== undefined) {
                    remoteContextCache[url] = json["@context"];
                }
            } catch (_) {
                // Not reachable from the browser; the warning stays.
            } finally {
                if (timer) clearTimeout(timer);
            }
        }));
    }

    /** A copy of the document with every resolvable remote context inlined. */
    function inlineRemoteContexts(doc) {
        const copy = clone(doc);
        const walk = (value) => {
            if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === "object") {
                if ("@context" in value) {
                    const inline = (c) => (typeof c === "string" && (KNOWN_REMOTE_CONTEXTS[c] || remoteContextCache[c])) ? (KNOWN_REMOTE_CONTEXTS[c] || remoteContextCache[c]) : c;
                    value["@context"] = Array.isArray(value["@context"]) ? value["@context"].map(inline) : inline(value["@context"]);
                }
                Object.values(value).forEach(walk);
            }
        };
        walk(copy);
        return copy;
    }

    // ── Document model ────────────────────────

    /**
     * Build a graph model from a parsed JSON-LD document.
     * Returns { context, nodes: Map, order, warnings, rawIdIndex }.
     */
    function buildModel(doc, options = {}) {
        const warnings = [];
        const nodes = new Map();
        const order = [];
        const rawIdIndex = new Map();   // every spelling of an id -> node id
        let blankCounter = 0;
        const documentBase = options.documentBase || null;
        let topContext = emptyContext(documentBase);

        function ensureNode(id) {
            let node = nodes.get(id);
            if (!node) {
                node = {
                    id,
                    rawId: null,
                    rawForms: new Set(),
                    blank: isBlankId(id),
                    generatedId: false,
                    types: [],
                    rawTypes: [],
                    props: new Map(),
                    rawKeys: new Map(),
                    definitions: 0,
                    nested: false,
                    invalidId: false,
                    graphName: null,
                    context: null,
                };
                nodes.set(id, node);
                order.push(id);
            }
            return node;
        }

        function addValue(node, predicate, rawKey, value) {
            if (!node.props.has(predicate)) node.props.set(predicate, []);
            node.props.get(predicate).push(value);
            if (!node.rawKeys.has(predicate)) node.rawKeys.set(predicate, rawKey);
        }

        function literalFromScalar(ctx, def, raw) {
            if (typeof raw === "boolean") return { kind: "literal", value: String(raw), datatype: XSD + "boolean", raw };
            if (typeof raw === "number") {
                const dt = def && def.type && def.type !== "@id" && def.type !== "@vocab" ? def.type
                    : (Number.isInteger(raw) ? XSD + "integer" : XSD + "double");
                return { kind: "literal", value: String(raw), datatype: dt, raw };
            }
            const lit = { kind: "literal", value: String(raw), datatype: null, lang: null, raw };
            if (def && def.type && !def.type.startsWith("@")) lit.datatype = def.type;
            else if (def && "language" in def) lit.lang = def.language;
            else if (ctx.language) lit.lang = ctx.language;
            return lit;
        }

        function processValue(ctx, def, raw, parent, graphName) {
            if (raw === null || raw === undefined) return [];
            if (Array.isArray(raw)) return raw.flatMap(item => processValue(ctx, def, item, parent, graphName));
            if (def && def.type === "@json") return [{ kind: "literal", value: JSON.stringify(raw), datatype: RDF + "JSON", raw }];
            if (typeof raw === "object") {
                if ("@value" in raw) {
                    const v = raw["@value"];
                    if (v === null) return [];
                    const lit = { kind: "literal", value: typeof v === "string" ? v : String(v), datatype: null, lang: null, raw };
                    if (raw["@type"]) lit.datatype = expandIri(ctx, raw["@type"], { vocab: true });
                    else if (typeof v === "number") lit.datatype = Number.isInteger(v) ? XSD + "integer" : XSD + "double";
                    else if (typeof v === "boolean") lit.datatype = XSD + "boolean";
                    if (raw["@language"]) lit.lang = raw["@language"];
                    return [lit];
                }
                if ("@list" in raw) {
                    return [{ kind: "list", items: processValue(ctx, def, raw["@list"], parent, graphName), raw }];
                }
                if ("@set" in raw) return processValue(ctx, def, raw["@set"], parent, graphName);
                const keys = Object.keys(raw).filter(k => k !== "@context");
                if (keys.length === 1 && keys[0] === "@id" && !("@context" in raw)) {
                    const id = expandIri(ctx, raw["@id"], { documentRelative: true });
                    registerReference(raw["@id"], id);
                    return [{ kind: "iri", iri: id, raw: raw["@id"] }];
                }
                const childId = processNode(raw, ctx, graphName, true);
                return childId ? [{ kind: "iri", iri: childId, raw: raw["@id"] || null, embedded: true }] : [];
            }
            if (typeof raw === "string" && def && (def.type === "@id" || def.type === "@vocab")) {
                const id = expandIri(ctx, raw, { documentRelative: true, vocab: def.type === "@vocab" });
                registerReference(raw, id);
                return [{ kind: "iri", iri: id, raw }];
            }
            return [literalFromScalar(ctx, def, raw)];
        }

        function registerReference(raw, id) {
            if (typeof raw === "string" && typeof id === "string" && !rawIdIndex.has(raw)) {
                rawIdIndex.set(raw, id);
            }
        }

        function processNode(obj, parentCtx, graphName, nested) {
            let ctx = parentCtx;
            if ("@context" in obj) ctx = processContext(parentCtx, obj["@context"], warnings, documentBase);

            const hasOnlyGraph = "@graph" in obj && Object.keys(obj).every(k => k === "@graph" || k === "@context" || k === "@id");
            if (hasOnlyGraph) {
                if (!nested && ctx !== parentCtx && parentCtx === topContext) topContext = ctx;
                const graphId = obj["@id"] ? expandIri(ctx, obj["@id"], { documentRelative: true }) : graphName;
                asArray(obj["@graph"]).forEach(item => {
                    if (item && typeof item === "object" && !Array.isArray(item)) processNode(item, ctx, graphId, false);
                });
                return null;
            }

            let id;
            const rawId = obj["@id"];
            if (typeof rawId === "string") {
                id = expandIri(ctx, rawId, { documentRelative: true });
            } else {
                id = `_:b${blankCounter++}`;
            }
            const node = ensureNode(id);
            node.definitions += 1;
            node.context = node.context || ctx;
            if (graphName && !node.graphName) node.graphName = graphName;
            if (nested) node.nested = true;
            if (typeof rawId === "string") {
                node.rawId = node.rawId || rawId;
                node.rawForms.add(rawId);
                rawIdIndex.set(rawId, id);
                if (!isBlankId(id) && !isAbsoluteIri(id)) node.invalidId = true;
            } else {
                node.generatedId = true;
            }

            Object.entries(obj).forEach(([key, value]) => {
                if (key === "@context" || key === "@id") return;
                const keyDef = ctx.terms[key];
                const expandedKey = keyDef && keyDef.id && isKeyword(keyDef.id) ? keyDef.id : key;

                if (expandedKey === "@type") {
                    asArray(value).forEach(t => {
                        if (typeof t !== "string") return;
                        const iri = expandIri(ctx, t, { vocab: true, documentRelative: true });
                        if (iri && !node.types.includes(iri)) {
                            node.types.push(iri);
                            node.rawTypes.push(t);
                        }
                    });
                    return;
                }
                if (expandedKey === "@graph" || expandedKey === "@included") {
                    asArray(value).forEach(item => {
                        if (item && typeof item === "object" && !Array.isArray(item)) processNode(item, ctx, graphName, false);
                    });
                    return;
                }
                if (expandedKey === "@reverse") {
                    if (value && typeof value === "object") {
                        Object.entries(value).forEach(([rk, rv]) => {
                            const pred = expandIri(ctx, rk, { vocab: true });
                            processValue(ctx, ctx.terms[rk], rv, node, graphName).forEach(v => {
                                if (v.kind === "iri") {
                                    const src = ensureNode(v.iri);
                                    addValue(src, pred, rk, { kind: "iri", iri: id, raw: rawId || null, reverse: true });
                                }
                            });
                        });
                    }
                    return;
                }
                if (key.startsWith("@")) return;

                const def = keyDef;
                let predicate = def && def.id ? def.id : expandIri(ctx, key, { vocab: true });
                const unmapped = !predicate || (!isAbsoluteIri(predicate) && !isBlankId(predicate));
                const values = processValue(ctx, def, value, node, graphName);
                if (def && def.reverse) {
                    values.forEach(v => {
                        if (v.kind === "iri") addValue(ensureNode(v.iri), predicate, key, { kind: "iri", iri: id, raw: rawId || null, reverse: true });
                    });
                    return;
                }
                if (unmapped) {
                    warnings.push({
                        code: "unmapped-key",
                        message: `Key "${key}" does not expand to an IRI; JSON-LD processors drop it.`,
                        detail: key,
                        node: id,
                    });
                    predicate = "urn:unmapped:" + key;
                }
                values.forEach(v => {
                    if (unmapped) v.unmapped = true;
                    addValue(node, predicate, key, v);
                });
            });
            return id;
        }

        // Top level: object (maybe with @graph), or array of node objects.
        const roots = Array.isArray(doc) ? doc : [doc];
        roots.forEach(root => {
            if (!root || typeof root !== "object" || Array.isArray(root)) return;
            if ("@context" in root) {
                topContext = processContext(topContext, root["@context"], warnings, documentBase);
                const rest = Object.assign({}, root);
                delete rest["@context"];
                processNode(rest, topContext, null, false);
            } else {
                processNode(root, topContext, null, false);
            }
        });

        // Drop the placeholder node a bare {"@context", "@graph"} wrapper would create.
        // (processNode returns null for graph-only wrappers, so nothing to drop.)

        // Heuristic links: string literals spelled exactly like a node id.
        const linkStrings = options.linkStrings !== false;
        nodes.forEach(node => {
            node.props.forEach(values => {
                values.forEach(v => {
                    if (v.kind !== "literal" || typeof v.raw !== "string" || v.datatype) return;
                    const target = rawIdIndex.get(v.raw) || (nodes.has(v.raw) ? v.raw : null);
                    if (target && nodes.has(target) && target !== node.id) {
                        v.matchesNode = target;
                        if (linkStrings) v.linksTo = target;
                    }
                });
            });
        });

        // Record every spelling used to reference a node (for source highlighting).
        rawIdIndex.forEach((id, raw) => {
            const node = nodes.get(id);
            if (node) node.rawForms.add(raw);
        });

        return { context: topContext, nodes, order, warnings, rawIdIndex };
    }

    // ── Editing helpers (operate on the raw parsed document) ──

    /** The array new nodes should be appended to, normalising the document if needed. */
    function ensureGraphArray(doc) {
        if (Array.isArray(doc)) return { doc, graph: doc };
        if (!doc || typeof doc !== "object") {
            const fresh = { "@context": {}, "@graph": [] };
            return { doc: fresh, graph: fresh["@graph"] };
        }
        if (Array.isArray(doc["@graph"])) return { doc, graph: doc["@graph"] };
        const ctx = doc["@context"];
        const node = Object.assign({}, doc);
        delete node["@context"];
        const fresh = {};
        if (ctx !== undefined) fresh["@context"] = ctx;
        fresh["@graph"] = Object.keys(node).length ? [node] : [];
        return { doc: fresh, graph: fresh["@graph"] };
    }

    /** Find the raw object(s) that define a node id (expanded), searching nested objects too. */
    function findRawNodes(doc, nodeId, options = {}) {
        const found = [];
        const documentBase = options.documentBase || null;
        const walk = (value, ctx) => {
            if (Array.isArray(value)) { value.forEach(v => walk(v, ctx)); return; }
            if (!value || typeof value !== "object") return;
            let local = ctx;
            if ("@context" in value) local = processContext(ctx, value["@context"], [], documentBase);
            if (typeof value["@id"] === "string" && Object.keys(value).some(k => k !== "@id" && k !== "@context")) {
                if (expandIri(local, value["@id"], { documentRelative: true }) === nodeId) found.push({ object: value, context: local });
            }
            Object.entries(value).forEach(([k, v]) => {
                if (k !== "@context" && v && typeof v === "object") walk(v, local);
            });
        };
        walk(doc, emptyContext(documentBase));
        return found;
    }

    /** The top-level @context object of a document, created if absent or not an object. */
    function ensureContextObject(doc) {
        const target = Array.isArray(doc) ? null : doc;
        if (!target) return null;
        let ctx = target["@context"];
        if (ctx === undefined || ctx === null) {
            ctx = {};
            // Keep @context as the first key for readability.
            const rest = Object.assign({}, target);
            Object.keys(target).forEach(k => delete target[k]);
            target["@context"] = ctx;
            Object.assign(target, rest);
            return ctx;
        }
        if (Array.isArray(ctx)) {
            let obj = ctx.find(c => c && typeof c === "object" && !Array.isArray(c));
            if (!obj) { obj = {}; ctx.push(obj); }
            return obj;
        }
        if (typeof ctx === "string") {
            const obj = {};
            target["@context"] = [ctx, obj];
            return obj;
        }
        return ctx;
    }

    /** Value of a node property as plain strings (for labels/tables). */
    function displayValue(value, ctx) {
        if (!value) return "";
        if (value.kind === "iri") return ctx ? compactIri(ctx, value.iri) : value.iri;
        if (value.kind === "list") return value.items.map(v => displayValue(v, ctx)).join(", ");
        return value.value;
    }

    return {
        RDF, RDFS, XSD, RDF_TYPE,
        KNOWN_REMOTE_CONTEXTS,
        COMMON_SCHEMES,
        isAbsoluteIri,
        isBlankId,
        isKeyword,
        localName,
        namespaceOf,
        asArray,
        clone,
        emptyContext,
        processContext,
        expandIri,
        compactIri,
        prefixesOf,
        prefetchRemoteContexts,
        inlineRemoteContexts,
        buildModel,
        ensureGraphArray,
        findRawNodes,
        ensureContextObject,
        displayValue,
    };
})();
