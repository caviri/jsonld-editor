/* ==============================================
   JSON-LD Graph Visualization — Configuration
   ============================================== */

// Entity type configuration (keyed by RDF type)
const ENTITY_TYPE_CONFIG = {
    "schema:Person": {
        color: "#3b82f6",
        label: "Person",
        ring: 1,
        size_base: 12,
    },
    "schema:SoftwareSourceCode": {
        color: "#22c55e",
        label: "Repository",
        ring: 2,
        size_base: 14,
    },
    "org:Organization": {
        color: "#f97316",
        label: "Organization",
        ring: 0,
        size_base: 16,
    },
    "org:Membership": {
        color: "#a855f7",
        label: "Membership",
        ring: 3,
        size_base: 8,
    },
    "pulse:Contribution": {
        color: "#06b6d4",
        label: "Contribution",
        ring: 3,
        size_base: 8,
    },
    "schema:ScholarlyArticle": {
        color: "#ef4444",
        label: "Article",
        ring: 2,
        size_base: 10,
    },
};

// Edge relationship configuration (keyed by RDF predicate)
const EDGE_TYPE_CONFIG = {
    "org:hasMembership":       { label: "has membership",  color: "#a855f7" },
    "pulse:hasContribution":   { label: "has contribution", color: "#06b6d4" },
    "pulse:owns":              { label: "owns",            color: "#22c55e" },
    "pulse:ownedBy":           { label: "owned by",        color: "#22c55e" },
    "schema:author":           { label: "author",          color: "#3b82f6" },
    "pulse:contributionTo":    { label: "contributes to",  color: "#06b6d4" },
    "org:organization":        { label: "organization",    color: "#f97316" },
    "org:hasUnit":             { label: "has unit",        color: "#f97316" },
    "org:unitOf":              { label: "unit of",         color: "#f97316" },
    "pulse:isForkOf":          { label: "fork of",         color: "#94a3b8" },
    "schema:sourceOrganization": { label: "source org",    color: "#f97316" },
};

// Cross-reference fields to extract edges from
const CROSS_REF_FIELDS = [
    "org:hasMembership",
    "pulse:hasContribution",
    "pulse:owns",
    "pulse:ownedBy",
    "schema:author",
    "pulse:contributionTo",
    "org:organization",
    "org:hasUnit",
    "org:unitOf",
    "pulse:isForkOf",
    "schema:sourceOrganization",
];

// Label-keyed entity config (for UI tabs/filters)
const ENTITY_CONFIG = {};
for (const [, v] of Object.entries(ENTITY_TYPE_CONFIG)) {
    ENTITY_CONFIG[v.label] = { color: v.color };
}

// Label-keyed edge config (for UI legend)
const EDGE_CONFIG = {};
for (const [, v] of Object.entries(EDGE_TYPE_CONFIG)) {
    EDGE_CONFIG[v.label] = { color: v.color };
}
