/* ==============================================
   JSON-LD Graph Visualization — Graph Logic
   ==============================================

   Pure functions (no DOM) that turn a JsonLd model into the node/edge lists
   Sigma renders. Two views:

     instances — one node per JSON-LD node object, edges for IRI-valued
                 properties, optional "external" nodes for referenced IRIs
                 that are not described in the document.
     schema    — one node per class: classes used as @type, classes declared
                 in the document (owl:Class / rdfs:Class) and their
                 superclasses; edges for subClassOf, declared domain → range,
                 and the class-to-class links observed in the data.
*/

const RDF_TYPE_IRI = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const CLASS_TYPES = new Set([
    "http://www.w3.org/2002/07/owl#Class",
    "http://www.w3.org/2000/01/rdf-schema#Class",
]);
const PROPERTY_TYPES = new Set([
    "http://www.w3.org/2002/07/owl#ObjectProperty",
    "http://www.w3.org/2002/07/owl#DatatypeProperty",
    "http://www.w3.org/2002/07/owl#AnnotationProperty",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#Property",
]);
const LITERAL_RANGE_PREFIXES = [
    "http://www.w3.org/2001/XMLSchema#",
    "http://www.w3.org/2000/01/rdf-schema#Literal",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString",
    "http://schema.org/Text", "http://schema.org/Number", "http://schema.org/Boolean",
    "http://schema.org/Date", "http://schema.org/DateTime", "http://schema.org/URL",
    "http://schema.org/Integer", "http://schema.org/Float", "http://schema.org/Time",
];

function isLiteralRange(iri) {
    return LITERAL_RANGE_PREFIXES.some(p => iri === p || iri.startsWith(p));
}

/** Look up optional styling for a type or predicate in a config keyed by CURIE or IRI. */
function lookupConfig(config, iri, ctx) {
    if (config[iri]) return config[iri];
    const curie = JsonLd.compactIri(ctx, iri, { vocab: true, preferCurie: true });
    if (config[curie]) return config[curie];
    // Also try the common prefixes, so "schema:Person" config works for any document.
    for (const [prefix, ns] of Object.entries(COMMON_PREFIXES)) {
        if (iri.startsWith(ns) && config[`${prefix}:${iri.slice(ns.length)}`]) return config[`${prefix}:${iri.slice(ns.length)}`];
    }
    return null;
}

/** Choose a display label for a node. */
function extractNodeLabel(node, ctx) {
    for (const pred of LABEL_PREDICATES) {
        const values = node.props.get(pred);
        if (!values || !values.length) continue;
        const literals = values.filter(v => v.kind === "literal");
        const english = literals.find(v => v.lang && /^en\b/i.test(v.lang));
        const plain = literals.find(v => !v.lang);
        const pick = english || plain || literals[0];
        if (pick) return pick.value;
    }
    if (node.blank) {
        return node.types.length ? `[${shortTypeLabel(node.types[0], ctx)}]` : "[blank node]";
    }
    const id = node.rawId || node.id;
    const compact = JsonLd.compactIri(ctx, node.id);
    if (compact !== node.id && compact.length < 40) return compact.includes(":") ? compact.split(":").slice(1).join(":") || compact : compact;
    if (id.includes("/") || id.includes("#") || /^urn:/i.test(id)) {
        const local = JsonLd.localName(id);
        if (local) return local;
    }
    return id;
}

function shortTypeLabel(iri, ctx) {
    const style = ONTOLOGY_TYPE_STYLE[iri];
    if (style) return style.label;
    return JsonLd.compactIri(ctx, iri, { vocab: true });
}

/**
 * Display info for a type IRI: { key, label, color, sizeBase, ring, kind }.
 * `labels` keeps labels unique across the document (two "Person" classes
 * from different vocabularies fall back to their CURIEs).
 */
function describeType(iri, ctx, labels) {
    const style = ONTOLOGY_TYPE_STYLE[iri] || lookupConfig(ENTITY_TYPE_CONFIG, iri, ctx);
    let label = style && style.label;
    if (!label) {
        const alias = JsonLd.compactIri(ctx, iri, { vocab: true });
        label = alias;
    }
    if (labels) {
        const owner = labels.get(label);
        if (owner && owner !== iri) label = JsonLd.compactIri(ctx, iri, { vocab: true, preferCurie: true });
        labels.set(label, iri);
    }
    return {
        key: iri,
        label,
        color: (style && style.color) || hashColor(iri),
        sizeBase: (style && style.size_base) || 10,
        ring: style && style.ring !== undefined ? style.ring : null,
        kind: (style && style.kind) || "entity",
    };
}

function describePredicate(iri, ctx) {
    const style = lookupConfig(EDGE_TYPE_CONFIG, iri, ctx);
    const label = (style && style.label) || JsonLd.compactIri(ctx, iri, { vocab: true });
    return { label, color: (style && style.color) || hashColor(iri), curie: JsonLd.compactIri(ctx, iri, { vocab: true, preferCurie: true }) };
}

/** Group nodes into rings by type and place them on circles (initial positions). */
function calculateRadialPositions(nodes) {
    const groups = new Map();
    nodes.forEach(node => {
        const key = node.nodeType;
        if (!groups.has(key)) groups.set(key, { ring: node.ring, nodes: [] });
        groups.get(key).nodes.push(node);
    });
    const ordered = [...groups.entries()].sort((a, b) => {
        const ra = a[1].ring ?? 99;
        const rb = b[1].ring ?? 99;
        return ra - rb || b[1].nodes.length - a[1].nodes.length;
    });
    const positions = {};
    let ringIndex = 0;
    ordered.forEach(([, group]) => {
        const radius = 150 * ringIndex + (ringIndex === 0 && group.nodes.length === 1 ? 0 : 80);
        group.nodes.forEach((node, idx) => {
            const angle = (2 * Math.PI * idx / group.nodes.length) - Math.PI / 2 + ringIndex * 0.4;
            positions[node.id] = { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
        });
        ringIndex += 1;
    });
    return positions;
}

/** Legacy validation lookup (validation_results.json): match by id or last path segment. */
function matchValidation(node, validationLookup) {
    if (!validationLookup) return null;
    const candidates = [node.id, node.rawId].filter(Boolean);
    for (const c of candidates) {
        if (validationLookup[c]) return validationLookup[c];
        if (c.includes("/")) {
            const shortId = c.split("/").slice(-1)[0];
            if (validationLookup[shortId]) return validationLookup[shortId];
        }
    }
    return null;
}

function normaliseValidation(val) {
    if (!val) return null;
    if ("ok" in val) return val;
    const strict = Boolean(val.strict);
    const agent = Boolean(val.agent);
    const errors = [...(val.strict_errors || []), ...(val.agent_errors || [])]
        .map(e => (typeof e === "string" ? e : (e && (e.message || JSON.stringify(e))) || ""));
    return {
        ok: strict && agent,
        source: "validation_results.json",
        shape: val.shape || "",
        errors,
        detail: `Strict: ${strict ? "pass" : "fail"} · Agent: ${agent ? "pass" : "fail"}`,
    };
}

/** Plain-JS property map for display: compact key -> value or array of values. */
function displayProperties(node, ctx) {
    const props = {};
    node.props.forEach((values, pred) => {
        const key = node.rawKeys.get(pred) || JsonLd.compactIri(ctx, pred, { vocab: true });
        const shown = values.map(v => {
            if (v.kind === "iri") return { iri: v.iri, text: JsonLd.compactIri(ctx, v.iri) };
            if (v.kind === "list") return v.items.map(item => JsonLd.displayValue(item, ctx)).join(", ");
            if (v.linksTo) return { iri: v.linksTo, text: v.value };
            return v.lang ? `${v.value} @${v.lang}` : v.value;
        });
        props[key] = shown.length === 1 ? shown[0] : shown;
    });
    return props;
}

/**
 * Instance view.
 * options: { showExternal, showTypeLinks, describeIri(iri) -> {label}|null, shaclResults: Map }
 */
function buildGraphDataFromModel(model, validationLookup, options = {}) {
    const ctx = model.context;
    const labels = new Map();
    const typeInfo = new Map();
    const getType = iri => {
        if (!typeInfo.has(iri)) typeInfo.set(iri, describeType(iri, ctx, labels));
        return typeInfo.get(iri);
    };

    const nodes = [];
    const nodeIndex = new Map();
    let validCount = 0;
    let invalidCount = 0;
    let noValidationCount = 0;

    model.order.forEach(id => {
        const node = model.nodes.get(id);
        if (!node) return;
        // Pure references (no definition, no properties) are rendered as external nodes later.
        if (node.definitions === 0 && node.props.size === 0 && node.types.length === 0) return;
        const primary = node.types.length ? getType(node.types[0]) : null;
        const legacy = normaliseValidation(matchValidation(node, validationLookup));
        const shacl = options.shaclResults ? options.shaclResults.get(id) : undefined;
        const validation = shacl || legacy || null;
        if (validation) { if (validation.ok) validCount += 1; else invalidCount += 1; } else noValidationCount += 1;

        const record = {
            id,
            label: extractNodeLabel(node, ctx),
            x: 0, y: 0,
            size: primary ? primary.sizeBase : 9,
            color: primary ? primary.color : UNTYPED_NODE_COLOR,
            nodeType: primary ? primary.label : "Untyped",
            entityType: primary ? primary.key : "",
            types: node.types.map(t => JsonLd.compactIri(ctx, t, { vocab: true })),
            kind: primary ? primary.kind : "entity",
            ring: primary ? primary.ring : null,
            properties: displayProperties(node, ctx),
            validation,
            invalidId: node.invalidId,
            external: false,
            blank: node.blank,
            rawId: node.rawId,
        };
        nodes.push(record);
        nodeIndex.set(id, record);
    });

    const edges = [];
    const edgeSet = new Set();
    const pairCounts = new Map();
    const externals = new Map();

    function addEdge(source, target, predicate) {
        const key = `${source}|${target}|${predicate}`;
        if (edgeSet.has(key)) return;
        edgeSet.add(key);
        const p = describePredicate(predicate, ctx);
        edges.push({ source, target, label: p.label, color: p.color, type: predicate, curie: p.curie });
        const pair = `${source}|${target}`;
        pairCounts.set(pair, (pairCounts.get(pair) || 0) + 1);
    }

    function ensureExternal(iri) {
        if (nodeIndex.has(iri)) return true;
        if (!options.showExternal) return false;
        if (!externals.has(iri)) {
            const known = options.describeIri ? options.describeIri(iri) : null;
            const compact = JsonLd.compactIri(ctx, iri);
            const record = {
                id: iri,
                label: (known && known.label) || compact,
                x: 0, y: 0,
                size: 6,
                color: EXTERNAL_NODE_COLOR,
                nodeType: "External",
                entityType: "",
                types: [],
                kind: "external",
                ring: 98,
                properties: Object.assign({ IRI: { iri, text: compact } }, known && known.comment ? { description: known.comment } : {}, known && known.vocab ? { vocabulary: known.vocab } : {}),
                validation: undefined,
                invalidId: !JsonLd.isAbsoluteIri(iri) && !JsonLd.isBlankId(iri),
                external: true,
                blank: JsonLd.isBlankId(iri),
                rawId: null,
            };
            externals.set(iri, record);
        }
        return true;
    }

    model.order.forEach(id => {
        const node = model.nodes.get(id);
        if (!node || !nodeIndex.has(id)) return;
        node.props.forEach((values, pred) => {
            const visit = v => {
                if (v.kind === "list") { v.items.forEach(visit); return; }
                const target = v.kind === "iri" ? v.iri : v.linksTo;
                if (!target || target === id) return;
                if (ensureExternal(target)) addEdge(id, target, pred);
            };
            values.forEach(visit);
        });
        if (options.showTypeLinks) {
            node.types.forEach(t => { if (ensureExternal(t)) addEdge(id, t, RDF_TYPE_IRI); });
        }
    });

    externals.forEach(record => { nodes.push(record); nodeIndex.set(record.id, record); });

    // Degree-based sizing.
    const degree = new Map();
    edges.forEach(e => {
        degree.set(e.source, (degree.get(e.source) || 0) + 1);
        degree.set(e.target, (degree.get(e.target) || 0) + 1);
    });
    nodes.forEach(n => { n.size += Math.min((degree.get(n.id) || 0) * 1.5, 10); });

    edges.forEach(edge => {
        const reverse = pairCounts.has(`${edge.target}|${edge.source}`);
        edge.curvature = reverse ? 0.3 : 0;
    });

    const positions = calculateRadialPositions(nodes);
    nodes.forEach(n => { const p = positions[n.id]; if (p) { n.x = p.x; n.y = p.y; } });

    return {
        view: "instances",
        nodes,
        edges,
        metadata: {
            generated: new Date().toISOString(),
            nodeCount: nodes.length,
            edgeCount: edges.length,
            externalCount: externals.size,
            entityTypes: [...typeInfo.keys()],
            validation: {
                valid: validCount,
                invalid: invalidCount,
                noData: noValidationCount,
                total: validCount + invalidCount + noValidationCount,
            },
        },
    };
}

/** Collect the IRIs of a class expression value list (skipping blank-node unions). */
function iriValues(node, predicate) {
    return (node.props.get(predicate) || []).filter(v => v.kind === "iri").map(v => v.iri);
}

/** Class-level view of the document (schema / ontology design view). */
function buildSchemaGraphData(model, options = {}) {
    const ctx = model.context;
    const classes = new Map();   // iri -> info
    const edges = new Map();     // key -> edge
    const properties = [];

    function classInfo(iri) {
        if (!classes.has(iri)) {
            const node = model.nodes.get(iri);
            classes.set(iri, {
                iri,
                defined: Boolean(node && node.definitions > 0),
                instances: 0,
                attributes: new Map(),   // predicate -> { count, ranges:Set }
                declaredProps: [],
                node,
            });
        }
        return classes.get(iri);
    }
    function addEdge(source, target, predicate, kind, count = 1) {
        const key = `${source}|${target}|${predicate}|${kind}`;
        const existing = edges.get(key);
        if (existing) { existing.count += count; return; }
        edges.set(key, { source, target, predicate, kind, count });
    }

    model.nodes.forEach(node => {
        const isClass = node.types.some(t => CLASS_TYPES.has(t));
        const isProperty = node.types.some(t => PROPERTY_TYPES.has(t));
        if (isClass && node.definitions > 0) classInfo(node.id);
        if (isProperty) properties.push(node);
        if (isClass) {
            iriValues(node, SCHEMA_PREDICATES.subClassOf).forEach(sup => { classInfo(node.id); classInfo(sup); addEdge(node.id, sup, SCHEMA_PREDICATES.subClassOf, "subclass"); });
            iriValues(node, SCHEMA_PREDICATES.equivalentClass).forEach(eq => { classInfo(node.id); classInfo(eq); addEdge(node.id, eq, SCHEMA_PREDICATES.equivalentClass, "equivalent"); });
        }
    });

    // Instance data: types, attributes, class-to-class links.
    model.nodes.forEach(node => {
        if (node.types.some(t => CLASS_TYPES.has(t) || PROPERTY_TYPES.has(t))) return;
        const types = node.types.filter(t => !ONTOLOGY_TYPE_STYLE[t] || ONTOLOGY_TYPE_STYLE[t].kind === "individual");
        types.forEach(t => { classInfo(t).instances += 1; });
        node.props.forEach((values, pred) => {
            values.forEach(v => {
                const target = v.kind === "iri" ? v.iri : v.linksTo;
                const targetNode = target ? model.nodes.get(target) : null;
                if (targetNode && targetNode.types.length) {
                    types.forEach(t => targetNode.types.forEach(tt => { classInfo(tt); addEdge(t, tt, pred, "observed"); }));
                } else {
                    types.forEach(t => {
                        const info = classInfo(t);
                        const attr = info.attributes.get(pred) || { count: 0, ranges: new Set() };
                        attr.count += 1;
                        if (v.kind === "literal") attr.ranges.add(v.datatype ? JsonLd.compactIri(ctx, v.datatype) : (v.lang ? "rdf:langString" : "xsd:string"));
                        else if (v.kind === "iri") attr.ranges.add("IRI");
                        info.attributes.set(pred, attr);
                    });
                }
            });
        });
    });

    // Declared properties: domain -> range.
    properties.forEach(prop => {
        const domains = [...iriValues(prop, SCHEMA_PREDICATES.domain), ...iriValues(prop, SCHEMA_PREDICATES.domainIncludes)];
        const ranges = [...iriValues(prop, SCHEMA_PREDICATES.range), ...iriValues(prop, SCHEMA_PREDICATES.rangeIncludes)];
        const classRanges = ranges.filter(r => !isLiteralRange(r));
        const literalRanges = ranges.filter(r => isLiteralRange(r));
        domains.forEach(d => {
            const info = classInfo(d);
            info.declaredProps.push({ iri: prop.id, ranges: ranges.map(r => JsonLd.compactIri(ctx, r)) });
            if (literalRanges.length || !classRanges.length) {
                const attr = info.attributes.get(prop.id) || { count: 0, ranges: new Set(), declared: true };
                attr.declared = true;
                literalRanges.forEach(r => attr.ranges.add(JsonLd.compactIri(ctx, r)));
                info.attributes.set(prop.id, attr);
            }
            classRanges.forEach(r => { classInfo(r); addEdge(d, r, prop.id, "declared"); });
        });
        if (!domains.length) {
            classRanges.forEach(r => classInfo(r));
        }
    });

    // SHACL shapes: one node per sh:NodeShape, linked to the classes it targets.
    const SH = "http://www.w3.org/ns/shacl#";
    const shapes = [];
    model.nodes.forEach(node => {
        if (node.definitions === 0 || !node.types.includes(SH + "NodeShape")) return;
        const targets = iriValues(node, SH + "targetClass");
        if (node.types.some(t => CLASS_TYPES.has(t))) targets.push(node.id); // implicit class target
        targets.forEach(t => { classInfo(t); addEdge(node.id, t, SH + "targetClass", "shape"); });
        const constraints = [];
        (node.props.get(SH + "property") || []).forEach(v => {
            const ps = v.kind === "iri" ? model.nodes.get(v.iri) : null;
            if (!ps) return;
            const one = p => {
                const x = (ps.props.get(SH + p) || [])[0];
                if (!x) return null;
                return x.kind === "iri" ? JsonLd.compactIri(ctx, x.iri) : x.value;
            };
            const path = iriValues(ps, SH + "path")[0];
            const min = one("minCount");
            const max = one("maxCount");
            const card = min !== null || max !== null ? ` [${min || 0}..${max === null ? "*" : max}]` : "";
            const type = one("datatype") || one("class") || one("nodeKind") || "";
            const extra = ["pattern", "in", "hasValue", "minInclusive", "maxInclusive"].map(k => one(k) !== null ? `${k} ${one(k)}` : null).filter(Boolean);
            constraints.push(`${path ? JsonLd.compactIri(ctx, path, { vocab: true }) : "(path?)"}${type ? " : " + type : ""}${card}${extra.length ? " · " + extra.join(" · ") : ""}`);
        });
        shapes.push({ node, targets, constraints });
    });

    const labels = new Map();
    const nodes = [];
    shapes.forEach(({ node, targets, constraints }) => {
        const style = ONTOLOGY_TYPE_STYLE[SH + "NodeShape"];
        const props = { IRI: { iri: node.id, text: JsonLd.compactIri(ctx, node.id) } };
        if (targets.length) props.targets = targets.map(t => ({ iri: t, text: JsonLd.compactIri(ctx, t, { vocab: true }) }));
        if (constraints.length) props.constraints = constraints;
        nodes.push({
            id: node.id,
            label: extractNodeLabel(node, ctx),
            x: 0, y: 0,
            size: 9 + Math.min(constraints.length, 8),
            color: style.color,
            nodeType: "Shape",
            entityType: SH + "NodeShape",
            types: [],
            kind: "shape",
            ring: 3,
            properties: props,
            validation: undefined,
            invalidId: false,
            external: false,
            rawId: node.rawId,
            schemaInfo: { shape: true, constraints },
        });
    });
    classes.forEach(info => {
        const style = describeType(info.iri, ctx, null);
        const node = info.node;
        const label = node && node.definitions > 0 ? extractNodeLabel(node, ctx) : (options.describeIri && options.describeIri(info.iri) ? options.describeIri(info.iri).label : null);
        let display = label || JsonLd.compactIri(ctx, info.iri, { vocab: true });
        if (labels.has(display) && labels.get(display) !== info.iri) display = JsonLd.compactIri(ctx, info.iri, { vocab: true, preferCurie: true });
        labels.set(display, info.iri);
        const props = {
            IRI: { iri: info.iri, text: JsonLd.compactIri(ctx, info.iri) },
            status: info.defined ? "defined in this document" : "reused (defined elsewhere)",
        };
        if (info.instances) props.instances = String(info.instances);
        if (node) {
            const comment = (node.props.get(SCHEMA_PREDICATES.comment) || []).find(v => v.kind === "literal");
            if (comment) props.comment = comment.value;
        }
        const attrs = [...info.attributes.entries()].map(([pred, a]) => {
            const ranges = [...a.ranges].join(" | ");
            return `${JsonLd.compactIri(ctx, pred, { vocab: true })}${ranges ? " : " + ranges : ""}${a.count ? ` (${a.count})` : ""}`;
        });
        if (attrs.length) props.attributes = attrs;
        nodes.push({
            id: info.iri,
            label: display,
            x: 0, y: 0,
            size: 10 + Math.min(Math.sqrt(info.instances) * 3, 14) + (info.defined ? 2 : 0),
            // Defined classes share the class colour; classes only used by instances keep
            // the colour they have in the instance view; reused ones are grey.
            color: info.defined ? ONTOLOGY_TYPE_STYLE["http://www.w3.org/2002/07/owl#Class"].color : (info.instances ? style.color : EXTERNAL_NODE_COLOR),
            nodeType: info.defined ? "Defined class" : (info.instances ? "Used class" : "Reused class"),
            entityType: info.iri,
            types: [],
            kind: "class",
            ring: info.defined ? 0 : (info.instances ? 1 : 2),
            properties: props,
            validation: undefined,
            invalidId: !JsonLd.isAbsoluteIri(info.iri),
            external: !info.defined,
            rawId: node ? node.rawId : null,
            schemaInfo: { instances: info.instances, defined: info.defined },
        });
    });
    if (!nodes.length) {
        return { view: "schema", nodes: [], edges: [], metadata: { nodeCount: 0, edgeCount: 0, entityTypes: [], validation: { total: 0 } } };
    }

    const EDGE_KIND_COLORS = { subclass: "#7c3aed", equivalent: "#0f766e", declared: "#db2777", observed: "#64748b", shape: "#475569" };
    const outEdges = [];
    const pairs = new Set();
    edges.forEach(e => pairs.add(`${e.source}|${e.target}`));
    edges.forEach(e => {
        const predLabel = e.kind === "subclass" ? "subClassOf" : e.kind === "equivalent" ? "equivalentClass" : e.kind === "shape" ? "sh:targetClass" : JsonLd.compactIri(ctx, e.predicate, { vocab: true });
        outEdges.push({
            source: e.source,
            target: e.target,
            label: e.kind === "observed" && e.count > 1 ? `${predLabel} (${e.count})` : predLabel,
            color: EDGE_KIND_COLORS[e.kind],
            type: e.predicate,
            kind: e.kind,
            curvature: pairs.has(`${e.target}|${e.source}`) ? 0.3 : 0,
        });
    });

    const positions = calculateRadialPositions(nodes);
    nodes.forEach(n => { const p = positions[n.id]; if (p) { n.x = p.x; n.y = p.y; } });

    return {
        view: "schema",
        nodes,
        edges: outEdges,
        metadata: {
            generated: new Date().toISOString(),
            nodeCount: nodes.length,
            edgeCount: outEdges.length,
            entityTypes: [],
            validation: { valid: 0, invalid: 0, noData: 0, total: 0 },
        },
    };
}

/** Backwards-compatible entry point: parse-level JSON-LD object -> graph data. */
function buildGraphDataFromJsonld(jsonld, validationLookup, options = {}) {
    const model = JsonLd.buildModel(jsonld, options);
    return buildGraphDataFromModel(model, validationLookup, options);
}

/** Populate a graphology Graph instance from graph data. */
function addGraphDataToGraph(graph, data) {
    graph.clear();
    data.nodes.forEach(node => {
        if (graph.hasNode(node.id)) return;
        graph.addNode(node.id, {
            label: node.label,
            x: node.x,
            y: node.y,
            size: node.size,
            color: node.color,
            nodeType: node.nodeType,
            entityType: node.entityType,
            types: node.types,
            kind: node.kind,
            properties: node.properties,
            validation: node.validation,
            invalidId: node.invalidId,
            external: node.external,
            originalColor: node.color,
            originalSize: node.size,
        });
    });

    data.edges.forEach((edge, index) => {
        if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
            graph.addEdgeWithKey(`edge-${index}`, edge.source, edge.target, {
                label: edge.label,
                color: edge.color,
                size: 2,
                type: "arrow",
                edgeType: edge.type,
                edgeKind: edge.kind,
                originalColor: edge.color,
                curvature: edge.curvature,
            });
        }
    });
}

/** Build a validation lookup (legacy format) from a parsed validation_results.json. */
function buildLegacyValidationLookup(data) {
    if (!data) return {};
    const lookup = {};
    for (const mode of ["strict", "agent"]) {
        const modeData = data[mode] || {};
        for (const [shapeName, shapeResult] of Object.entries(modeData)) {
            for (const instance of (shapeResult.instances || [])) {
                const instId = instance.id || "";
                if (!lookup[instId]) {
                    lookup[instId] = { strict: true, agent: true, strict_errors: [], agent_errors: [], shape: shapeName };
                }
                lookup[instId][mode] = instance.valid !== false;
                lookup[instId][mode + "_errors"] = instance.errors || [];
            }
        }
    }
    return lookup;
}
