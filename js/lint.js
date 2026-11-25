/* ==============================================
   JSON-LD Graph Visualization — Document checks
   ==============================================

   lintModel(model, vocab) inspects a JsonLd model and returns problems:

     { severity: "error" | "warning" | "info",
       code, message,
       nodeId?        node to select when the problem is clicked
       find?          text to locate in the editor
       fixes?: [{ label, action }] }

   Actions are plain objects interpreted by the app (js/app.js):
     { type: "add-prefix", prefix, namespace }
     { type: "coerce-id", key, predicate }
     { type: "find-terms", query, kind }
     { type: "declare-term", iri, kind }
     { type: "replace-term", from, to }
*/

function lintModel(model, vocab) {
    const problems = [];
    const ctx = model.context;
    const definedPrefixes = new Set(Object.keys(ctx.terms));
    const compact = iri => JsonLd.compactIri(ctx, iri, { vocab: true, preferCurie: true });
    const SKIP_NAMESPACES = [
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
        "http://www.w3.org/2000/01/rdf-schema#",
        "http://www.w3.org/2002/07/owl#",
        "http://www.w3.org/2001/XMLSchema#",
    ];

    // ── Processing warnings (unmapped keys, remote contexts, cycles) ──
    const seenWarnings = new Set();
    model.warnings.forEach(w => {
        const key = `${w.code}|${w.detail}`;
        if (seenWarnings.has(key)) return;
        seenWarnings.add(key);
        if (w.code === "unmapped-key") {
            problems.push({
                severity: "error",
                code: w.code,
                message: `Key "${w.detail}" does not map to an IRI, so it is dropped when the document is read as RDF (and by rete, SPARQL and SHACL). Define it in @context or use a prefixed name.`,
                nodeId: w.node,
                find: JSON.stringify(w.detail),
                fixes: [{ label: "Find a term to use", action: { type: "find-terms", query: w.detail, kind: "properties" } }],
            });
        } else if (w.code === "remote-context") {
            problems.push({
                severity: "warning",
                code: w.code,
                message: `${w.message} The rete engine fetches nothing either, so inline the context to export or query this document.`,
                find: JSON.stringify(w.detail),
            });
        } else {
            problems.push({ severity: "warning", code: w.code, message: w.message, find: w.detail ? JSON.stringify(w.detail) : undefined });
        }
    });

    // ── Prefixes used but never defined ──
    const undefinedPrefixes = new Map();
    const notePrefix = (raw, where) => {
        if (typeof raw !== "string") return;
        const colon = raw.indexOf(":");
        if (colon <= 0) return;
        const prefix = raw.slice(0, colon);
        const rest = raw.slice(colon + 1);
        if (prefix === "_" || rest.startsWith("//") || definedPrefixes.has(prefix)) return;
        if (JsonLd.COMMON_SCHEMES.has(prefix.toLowerCase())) return;
        if (!/^[A-Za-z][\w.\-]*$/.test(prefix)) return;
        if (!undefinedPrefixes.has(prefix)) undefinedPrefixes.set(prefix, { count: 0, example: raw, where });
        undefinedPrefixes.get(prefix).count += 1;
    };

    // ── Per-node checks ──
    const usedTerms = new Map();  // iri -> { kind: "class"|"property", count, example }
    const noteUse = (iri, kind, raw) => {
        if (!iri || !JsonLd.isAbsoluteIri(iri) || iri.startsWith("urn:unmapped:")) return;
        const u = usedTerms.get(iri) || { kind, count: 0, raw };
        u.count += 1;
        usedTerms.set(iri, u);
    };

    model.nodes.forEach(node => {
        if (node.invalidId) {
            const raw = node.rawId || node.id;
            const scheme = raw.split(":")[0];
            problems.push({
                severity: "error",
                code: "invalid-iri",
                message: `"${raw}" is not a valid IRI. Because it contains "://", JSON-LD reads it as an absolute IRI with the scheme "${scheme}:", which is not a valid scheme. RDF tools (rete included) drop this node and every triple that mentions it. Remove or percent-encode the "://" part (for example "${raw.replace(/:\/\//g, "-").replace(/\//g, "-")}").`,
                nodeId: node.id,
                find: JSON.stringify(raw),
            });
        }
        (node.rawTypes || []).forEach(t => notePrefix(t, "@type"));
        node.types.forEach((t, i) => noteUse(t, "class", node.rawTypes[i]));
        node.rawKeys.forEach((rawKey, pred) => {
            notePrefix(rawKey, "key");
            noteUse(pred, "property", rawKey);
        });
        node.props.forEach((values, pred) => {
            values.forEach(v => {
                if (v.kind === "iri" && typeof v.raw === "string" && v.raw !== "") {
                    notePrefix(v.raw, "value");
                    if (!JsonLd.isAbsoluteIri(v.iri) && !JsonLd.isBlankId(v.iri)) {
                        problems.push({
                            severity: "warning",
                            code: "invalid-reference",
                            message: `Reference "${v.raw}" (${compact(pred)}) is not a valid IRI; the triple is dropped in RDF.`,
                            nodeId: node.id,
                            find: JSON.stringify(v.raw),
                        });
                    }
                }
                if (v.kind === "literal" && v.matchesNode && !v.datatype) {
                    const key = node.rawKeys.get(pred) || compact(pred);
                    problems.push({
                        severity: "warning",
                        code: "string-reference",
                        message: `${key}: "${v.raw}" names a node in this document, but it is a plain string in RDF, not a link. Declare "${key}" with "@type": "@id" in @context (or write {"@id": "${v.raw}"}).`,
                        nodeId: node.id,
                        find: JSON.stringify(v.raw),
                        group: `string-reference|${pred}`,
                        fixes: [{ label: `Make ${key} a link`, action: { type: "coerce-id", key, predicate: pred } }],
                    });
                }
            });
        });
        if (node.definitions > 1 && !node.nested) {
            problems.push({
                severity: "info",
                code: "duplicate-node",
                message: `${compact(node.id)} is described ${node.definitions} times; the descriptions are merged.`,
                nodeId: node.id,
                find: node.rawId ? JSON.stringify(node.rawId) : undefined,
            });
        }
    });

    undefinedPrefixes.forEach((info, prefix) => {
        const ns = vocab ? vocab.namespaceForPrefix(prefix) : COMMON_PREFIXES[prefix];
        problems.push({
            severity: "warning",
            code: "undefined-prefix",
            message: `Prefix "${prefix}:" is not defined in @context (used ${info.count}×, e.g. "${info.example}"). JSON-LD reads "${info.example}" as an IRI with the scheme "${prefix}:".`,
            find: JSON.stringify(info.example),
            fixes: ns ? [{ label: `Add ${prefix}: <${ns}>`, action: { type: "add-prefix", prefix, namespace: ns } }] : [],
        });
    });

    // Collapse repeated string-reference warnings per predicate.
    const grouped = new Map();
    for (let i = problems.length - 1; i >= 0; i -= 1) {
        const p = problems[i];
        if (!p.group) continue;
        if (grouped.has(p.group)) {
            grouped.get(p.group).count += 1;
            problems.splice(i, 1);
        } else {
            grouped.set(p.group, p);
            p.count = 1;
        }
    }
    grouped.forEach(p => { if (p.count > 1) p.message += ` (${p.count} values)`; });

    // ── Terms: unknown in a known vocabulary, or used but never declared ──
    const definedHere = new Set();
    model.nodes.forEach(node => { if (node.definitions > 0 && !node.blank) definedHere.add(node.id); });
    const libraryReady = vocab && vocab.isReady();

    usedTerms.forEach((use, iri) => {
        if (definedHere.has(iri)) return;
        if (SKIP_NAMESPACES.some(ns => iri.startsWith(ns)) && (!vocab || vocab.isKnownTerm(iri))) return;
        const known = vocab && vocab.vocabularyFor(iri);
        if (libraryReady && known && known.namespace && !vocab.isKnownTerm(iri)) {
            const similar = vocab.suggestSimilar(iri, 3, use.kind);
            problems.push({
                severity: "warning",
                code: "unknown-term",
                message: `${compact(iri)} is not a term of ${known.title}${similar.length ? ` — did you mean ${similar.map(t => compact(t.iri)).join(", ")}?` : "."} Used ${use.count}×.`,
                find: use.raw ? JSON.stringify(use.raw) : undefined,
                fixes: similar.slice(0, 2).map(t => ({ label: `Use ${compact(t.iri)}`, action: { type: "replace-term", from: iri, to: t.iri } }))
                    .concat([{ label: "Search terms", action: { type: "find-terms", query: JsonLd.localName(iri), kind: use.kind === "class" ? "classes" : "properties" } }]),
            });
            return;
        }
        if (!known) {
            const local = JsonLd.localName(iri);
            const reusable = vocab && libraryReady ? vocab.findReusable(splitCamel(local), use.kind === "class" ? "classes" : "properties", 3) : [];
            problems.push({
                severity: "info",
                code: "undeclared-term",
                message: `${compact(iri)} is used ${use.count}× but not declared anywhere the editor knows. Declare it (label, description${use.kind === "property" ? ", domain, range" : ""}) so others can reuse it${reusable.length ? `, or reuse an existing term such as ${reusable.map(r => compact(r.term.iri)).join(", ")}` : ""}.`,
                find: use.raw ? JSON.stringify(use.raw) : undefined,
                fixes: [
                    { label: "Declare", action: { type: "declare-term", iri, kind: use.kind } },
                    { label: "Find reusable terms", action: { type: "find-terms", query: splitCamel(local), kind: use.kind === "class" ? "classes" : "properties" } },
                ],
            });
        }
    });

    // ── Ontology quality ──
    const CLASS_TYPES = ["http://www.w3.org/2002/07/owl#Class", "http://www.w3.org/2000/01/rdf-schema#Class"];
    const PROP_TYPES = [
        "http://www.w3.org/2002/07/owl#ObjectProperty", "http://www.w3.org/2002/07/owl#DatatypeProperty",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#Property", "http://www.w3.org/2002/07/owl#AnnotationProperty",
    ];
    const knownClass = iri => definedHere.has(iri) || (vocab && vocab.isKnownTerm(iri)) || iri.startsWith("http://www.w3.org/2001/XMLSchema#");
    model.nodes.forEach(node => {
        if (node.blank || node.definitions === 0) return;
        const isClass = node.types.some(t => CLASS_TYPES.includes(t));
        const isProp = node.types.some(t => PROP_TYPES.includes(t));
        if (!isClass && !isProp) return;
        const name = compact(node.id);
        const has = pred => (node.props.get(pred) || []).length > 0;
        if (!has(SCHEMA_PREDICATES.label) && !has("http://www.w3.org/2004/02/skos/core#prefLabel")) {
            problems.push({ severity: "info", code: "missing-label", message: `${name} has no rdfs:label.`, nodeId: node.id, find: node.rawId ? JSON.stringify(node.rawId) : undefined });
        }
        if (!has(SCHEMA_PREDICATES.comment) && !has("http://www.w3.org/2004/02/skos/core#definition")) {
            problems.push({ severity: "info", code: "missing-comment", message: `${name} has no rdfs:comment (definition).`, nodeId: node.id, find: node.rawId ? JSON.stringify(node.rawId) : undefined });
        }
        if (isProp && node.types.includes("http://www.w3.org/2002/07/owl#ObjectProperty") || isProp && node.types.includes("http://www.w3.org/2002/07/owl#DatatypeProperty")) {
            if (!has(SCHEMA_PREDICATES.domain) && !has(SCHEMA_PREDICATES.domainIncludes)) {
                problems.push({ severity: "info", code: "missing-domain", message: `${name} has no rdfs:domain.`, nodeId: node.id, find: node.rawId ? JSON.stringify(node.rawId) : undefined });
            }
            if (!has(SCHEMA_PREDICATES.range) && !has(SCHEMA_PREDICATES.rangeIncludes)) {
                problems.push({ severity: "info", code: "missing-range", message: `${name} has no rdfs:range.`, nodeId: node.id, find: node.rawId ? JSON.stringify(node.rawId) : undefined });
            }
        }
        [SCHEMA_PREDICATES.subClassOf, SCHEMA_PREDICATES.domain, SCHEMA_PREDICATES.range].forEach(pred => {
            (node.props.get(pred) || []).forEach(v => {
                if (v.kind !== "iri" || JsonLd.isBlankId(v.iri) || knownClass(v.iri)) return;
                if (vocab && !vocab.vocabularyFor(v.iri)) {
                    problems.push({
                        severity: "warning",
                        code: "unknown-class",
                        message: `${name} → ${compact(pred)} ${compact(v.iri)}: that class is not defined in this document or any loaded vocabulary.`,
                        nodeId: node.id,
                        find: typeof v.raw === "string" ? JSON.stringify(v.raw) : undefined,
                        fixes: [{ label: "Declare class", action: { type: "declare-term", iri: v.iri, kind: "class" } }],
                    });
                }
            });
        });
    });

    const order = { error: 0, warning: 1, info: 2 };
    problems.sort((a, b) => order[a.severity] - order[b.severity]);
    return problems;
}

function splitCamel(text) {
    return String(text || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-]+/g, " ").toLowerCase().trim();
}
