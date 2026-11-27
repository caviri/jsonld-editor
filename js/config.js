/* ==============================================
   JSON-LD Graph Visualization — Configuration
   ==============================================

   Everything here is optional styling or catalog data: any JSON-LD document
   renders without it. Types and predicates that are not listed get a stable
   colour from PALETTE and a label from the document's own @context.
*/

// ── Optional per-type styling ─────────────────
// Keys may be compact IRIs (as written with the document's prefixes) or full IRIs.
const ENTITY_TYPE_CONFIG = {
    "schema:Person": { color: "#3b82f6", label: "Person", ring: 1, size_base: 12 },
    "schema:SoftwareSourceCode": { color: "#22c55e", label: "Repository", ring: 2, size_base: 14 },
    "org:Organization": { color: "#f97316", label: "Organization", ring: 0, size_base: 16 },
    "org:Membership": { color: "#a855f7", label: "Membership", ring: 3, size_base: 8 },
    "pulse:Contribution": { color: "#06b6d4", label: "Contribution", ring: 3, size_base: 8 },
    "schema:ScholarlyArticle": { color: "#ef4444", label: "Article", ring: 2, size_base: 10 },
};

// ── Optional per-predicate styling ────────────
const EDGE_TYPE_CONFIG = {
    "org:hasMembership": { label: "has membership", color: "#a855f7" },
    "pulse:hasContribution": { label: "has contribution", color: "#06b6d4" },
    "pulse:owns": { label: "owns", color: "#22c55e" },
    "pulse:ownedBy": { label: "owned by", color: "#22c55e" },
    "schema:author": { label: "author", color: "#3b82f6" },
    "pulse:contributionTo": { label: "contributes to", color: "#06b6d4" },
    "org:organization": { label: "organization", color: "#f97316" },
    "org:hasUnit": { label: "has unit", color: "#f97316" },
    "org:unitOf": { label: "unit of", color: "#f97316" },
    "pulse:isForkOf": { label: "fork of", color: "#94a3b8" },
    "schema:sourceOrganization": { label: "source org", color: "#f97316" },
};

// Ontology building blocks get fixed, recognisable styles (keyed by full IRI).
const ONTOLOGY_TYPE_STYLE = {
    "http://www.w3.org/2002/07/owl#Ontology": { color: "#0f766e", label: "Ontology", size_base: 18, kind: "ontology" },
    "http://www.w3.org/2002/07/owl#Class": { color: "#7c3aed", label: "Class", size_base: 14, kind: "class" },
    "http://www.w3.org/2000/01/rdf-schema#Class": { color: "#7c3aed", label: "Class", size_base: 14, kind: "class" },
    "http://www.w3.org/2002/07/owl#ObjectProperty": { color: "#db2777", label: "Object property", size_base: 9, kind: "property" },
    "http://www.w3.org/2002/07/owl#DatatypeProperty": { color: "#ea580c", label: "Datatype property", size_base: 9, kind: "property" },
    "http://www.w3.org/2002/07/owl#AnnotationProperty": { color: "#a16207", label: "Annotation property", size_base: 8, kind: "property" },
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#Property": { color: "#be185d", label: "Property", size_base: 9, kind: "property" },
    "http://www.w3.org/2002/07/owl#NamedIndividual": { color: "#0891b2", label: "Individual", size_base: 9, kind: "individual" },
    "http://www.w3.org/2004/02/skos/core#ConceptScheme": { color: "#15803d", label: "Concept scheme", size_base: 16, kind: "ontology" },
    "http://www.w3.org/2004/02/skos/core#Concept": { color: "#16a34a", label: "Concept", size_base: 10, kind: "individual" },
    "http://www.w3.org/ns/shacl#NodeShape": { color: "#475569", label: "Node shape", size_base: 12, kind: "shape" },
    "http://www.w3.org/ns/shacl#PropertyShape": { color: "#64748b", label: "Property shape", size_base: 8, kind: "shape" },
};

// Stable colours for everything not configured above (hashed by IRI).
const PALETTE = [
    "#3b82f6", "#22c55e", "#f97316", "#a855f7", "#06b6d4", "#ef4444", "#eab308",
    "#14b8a6", "#ec4899", "#8b5cf6", "#84cc16", "#f43f5e", "#0ea5e9", "#d946ef",
    "#10b981", "#f59e0b", "#6366f1", "#65a30d",
];
const EXTERNAL_NODE_COLOR = "#94a3b8";
const UNTYPED_NODE_COLOR = "#64748b";

// Predicates tried, in order, for a node's display label (full IRIs).
const LABEL_PREDICATES = [
    "http://www.w3.org/2000/01/rdf-schema#label",
    "http://www.w3.org/2004/02/skos/core#prefLabel",
    "http://schema.org/name",
    "https://schema.org/name",
    "http://xmlns.com/foaf/0.1/name",
    "http://purl.org/dc/terms/title",
    "http://purl.org/dc/elements/1.1/title",
    "http://schema.org/headline",
    "http://www.w3.org/ns/shacl#name",
];

// Predicates that point from a term to its definition/structure in an ontology.
const SCHEMA_PREDICATES = {
    subClassOf: "http://www.w3.org/2000/01/rdf-schema#subClassOf",
    subPropertyOf: "http://www.w3.org/2000/01/rdf-schema#subPropertyOf",
    domain: "http://www.w3.org/2000/01/rdf-schema#domain",
    range: "http://www.w3.org/2000/01/rdf-schema#range",
    domainIncludes: "http://schema.org/domainIncludes",
    rangeIncludes: "http://schema.org/rangeIncludes",
    equivalentClass: "http://www.w3.org/2002/07/owl#equivalentClass",
    equivalentProperty: "http://www.w3.org/2002/07/owl#equivalentProperty",
    inverseOf: "http://www.w3.org/2002/07/owl#inverseOf",
    isDefinedBy: "http://www.w3.org/2000/01/rdf-schema#isDefinedBy",
    label: "http://www.w3.org/2000/01/rdf-schema#label",
    comment: "http://www.w3.org/2000/01/rdf-schema#comment",
};

// ── Well-known prefixes ───────────────────────
// Used to add a missing prefix to @context when a term is reused, and to
// compact IRIs when importing Turtle / N-Triples / .rete files.
const COMMON_PREFIXES = {
    rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    rdfs: "http://www.w3.org/2000/01/rdf-schema#",
    owl: "http://www.w3.org/2002/07/owl#",
    xsd: "http://www.w3.org/2001/XMLSchema#",
    skos: "http://www.w3.org/2004/02/skos/core#",
    schema: "http://schema.org/",
    dcterms: "http://purl.org/dc/terms/",
    dc: "http://purl.org/dc/elements/1.1/",
    foaf: "http://xmlns.com/foaf/0.1/",
    prov: "http://www.w3.org/ns/prov#",
    org: "http://www.w3.org/ns/org#",
    dcat: "http://www.w3.org/ns/dcat#",
    time: "http://www.w3.org/2006/time#",
    sh: "http://www.w3.org/ns/shacl#",
    vann: "http://purl.org/vocab/vann/",
    void: "http://rdfs.org/ns/void#",
    sosa: "http://www.w3.org/ns/sosa/",
    ssn: "http://www.w3.org/ns/ssn/",
    geo: "http://www.w3.org/2003/01/geo/wgs84_pos#",
    geosparql: "http://www.opengis.net/ont/geosparql#",
    locn: "http://www.w3.org/ns/locn#",
    vcard: "http://www.w3.org/2006/vcard/ns#",
    adms: "http://www.w3.org/ns/adms#",
    dqv: "http://www.w3.org/ns/dqv#",
    odrl: "http://www.w3.org/ns/odrl/2/",
    ldp: "http://www.w3.org/ns/ldp#",
    as: "https://www.w3.org/ns/activitystreams#",
    bibo: "http://purl.org/ontology/bibo/",
    cito: "http://purl.org/spar/cito/",
    doap: "http://usefulinc.com/ns/doap#",
    spdx: "http://spdx.org/rdf/terms#",
    qudt: "http://qudt.org/schema/qudt/",
    unit: "http://qudt.org/vocab/unit/",
    wd: "http://www.wikidata.org/entity/",
    wdt: "http://www.wikidata.org/prop/direct/",
    dbo: "http://dbpedia.org/ontology/",
    dbr: "http://dbpedia.org/resource/",
    obo: "http://purl.obolibrary.org/obo/",
    sio: "http://semanticscience.org/resource/",
    cc: "http://creativecommons.org/ns#",
    ex: "http://example.org/",
};

// ── Vocabulary library ────────────────────────
// Offline index built by tools/build_vocab_index.py.
const VOCAB_INDEX_URL = "data/vocabularies/index.json";

// Vocabularies that can be loaded on demand in the browser. They are fetched
// from their publishers (CORS-enabled Turtle) and parsed by the rete engine.
const VOCAB_CATALOG = [
    { prefix: "sosa", namespace: "http://www.w3.org/ns/sosa/", title: "SOSA (sensors, observations)", url: "https://www.w3.org/ns/sosa/", format: "ttl" },
    { prefix: "ssn", namespace: "http://www.w3.org/ns/ssn/", title: "SSN (semantic sensor network)", url: "https://www.w3.org/ns/ssn/", format: "ttl" },
    { prefix: "vcard", namespace: "http://www.w3.org/2006/vcard/ns#", title: "vCard", url: "https://www.w3.org/2006/vcard/ns.ttl", format: "ttl" },
    { prefix: "locn", namespace: "http://www.w3.org/ns/locn#", title: "ISA Core Location", url: "https://www.w3.org/ns/locn.ttl", format: "ttl" },
    { prefix: "adms", namespace: "http://www.w3.org/ns/adms#", title: "ADMS (asset description)", url: "https://www.w3.org/ns/adms.ttl", format: "ttl" },
    { prefix: "dqv", namespace: "http://www.w3.org/ns/dqv#", title: "Data Quality Vocabulary", url: "https://www.w3.org/ns/dqv.ttl", format: "ttl" },
    { prefix: "odrl", namespace: "http://www.w3.org/ns/odrl/2/", title: "ODRL (rights & policies)", url: "https://www.w3.org/ns/odrl/2/ODRL22.ttl", format: "ttl" },
    { prefix: "ldp", namespace: "http://www.w3.org/ns/ldp#", title: "Linked Data Platform", url: "https://www.w3.org/ns/ldp.ttl", format: "ttl" },
    { prefix: "as", namespace: "https://www.w3.org/ns/activitystreams#", title: "Activity Streams 2.0", url: "https://www.w3.org/ns/activitystreams-owl", format: "ttl" },
    { prefix: "bibo", namespace: "http://purl.org/ontology/bibo/", title: "Bibliographic Ontology", url: "https://purl.org/ontology/bibo/", format: "ttl" },
    { prefix: "unit", namespace: "http://qudt.org/vocab/unit/", title: "QUDT units (4 MB)", url: "https://qudt.org/vocab/unit/", format: "ttl" },
];

// Remote term search services (CORS-enabled, no key required).
const TERM_SEARCH_SERVICES = {
    ols: {
        label: "OLS (EBI)",
        title: "EMBL-EBI Ontology Lookup Service — 270+ ontologies",
        url: "https://www.ebi.ac.uk/ols4/api/search",
    },
    wikidata: {
        label: "Wikidata",
        title: "Wikidata items and properties",
        url: "https://www.wikidata.org/w/api.php",
    },
};

// ── rete engine (https://github.com/caviri/rete) ──
// The single-file WebAssembly build, loaded only when a rete feature is used
// (export .rete, Turtle/N-Triples, SPARQL, SHACL, importing RDF, live vocabularies).
const RETE_CONFIG = {
    version: "0.7.8",
    scriptUrl: "https://cdn.jsdelivr.net/npm/rete-graph@0.7.8/dist/rete-graph.min.js",
    docs: "https://caviri.github.io/rete/docs/",
    playground: "https://caviri.github.io/rete/docs/playground.html",
    // Opening a .rete file larger than this asks before converting it to JSON-LD.
    maxImportTriples: 20000,
};

// ── WebMCP (tools for in-browser AI agents) ──
// https://webmachinelearning.github.io/webmcp/ — the editor registers its tools on
// document.modelContext when the browser provides it (Chrome: origin trial, or
// chrome://flags/#enable-webmcp-testing). The MCP-B bridge is opt-in, loaded only
// when the user switches it on in the Agents tab.
const WEBMCP_CONFIG = {
    // Origin-trial token for the deployed origin (e.g. https://<user>.github.io).
    // Register at https://developer.chrome.com/origintrials/ ("WebMCP") and paste it here.
    originTrialToken: "",
    mcpbScriptUrl: "https://cdn.jsdelivr.net/npm/@mcp-b/global@6.2.0/dist/index.iife.js",
    mcpbExtension: "https://chromewebstore.google.com/detail/mcp-b-extension/daohopfhkdelnpemnhlekblhnikhdhfa",
    docs: "https://developer.chrome.com/docs/ai/webmcp",
    // Largest text a tool returns in one call (characters).
    maxTextChars: 60000,
};

// Where the ontology designer mints new terms when the document has no @vocab.
const DEFAULT_NAMESPACE = "https://example.org/ontology#";

// ── Derived lookups (used by the UI) ──────────
const ENTITY_CONFIG = {};
for (const [, v] of Object.entries(ENTITY_TYPE_CONFIG)) {
    ENTITY_CONFIG[v.label] = { color: v.color };
}
const EDGE_CONFIG = {};
for (const [, v] of Object.entries(EDGE_TYPE_CONFIG)) {
    EDGE_CONFIG[v.label] = { color: v.color };
}

function hashColor(key) {
    let h = 2166136261;
    for (let i = 0; i < key.length; i += 1) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return PALETTE[Math.abs(h) % PALETTE.length];
}
