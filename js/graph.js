/* ==============================================
   JSON-LD Graph Visualization — Graph Logic
   ============================================== */

/**
 * Build an index mapping all possible identifiers to their nodes.
 */
function buildIdIndex(graphNodes) {
    const index = {};
    const identifierFields = [
        "pulse:orcidIdentifier",
        "pulse:orcid",
        "pulse:githubUsername",
        "pulse:githubRepositoryHandle",
        "pulse:githubOrganizationHandle",
        "pulse:infosciencePersonIdentifier",
        "pulse:infoscienceOrganizationIdentifier",
        "pulse:ror",
        "schema:identifier",
        "pulse:composite",
        "uuid",
    ];

    graphNodes.forEach(node => {
        const nodeId = node["@id"] || "";
        if (!nodeId) return;
        index[nodeId] = node;

        if (nodeId.includes("/")) {
            const shortId = nodeId.split("/").slice(-1)[0];
            if (!index[shortId]) {
                index[shortId] = node;
            }
        }

        identifierFields.forEach(field => {
            const value = node[field];
            if (typeof value === "string" && !index[value]) {
                index[value] = node;
            }
        });
    });

    return index;
}

/**
 * Extract a display label for a node.
 */
function extractNodeLabel(node) {
    if (node["schema:name"]) return node["schema:name"];
    const nodeId = node["@id"] || "unknown";
    if (nodeId.includes("/")) {
        return nodeId.split("/").slice(-1)[0];
    }
    return nodeId;
}

/**
 * Get the entity type key for configuration lookup.
 */
function getEntityTypeKey(node) {
    const nodeType = node["@type"] || "";
    return ENTITY_TYPE_CONFIG[nodeType] ? nodeType : "schema:Person";
}

/**
 * Extract edges from cross-reference fields.
 */
function extractEdges(graphNodes, idIndex) {
    const edges = [];
    const edgeSet = new Set();
    const directedPairs = new Set();

    graphNodes.forEach(node => {
        const sourceId = node["@id"] || "";
        CROSS_REF_FIELDS.forEach(field => {
            let values = node[field];
            if (values === undefined || values === null) return;
            if (!Array.isArray(values)) values = [values];

            values.forEach(targetRef => {
                if (targetRef === null || targetRef === undefined) return;
                const targetNode = idIndex[targetRef];
                if (!targetNode) return;

                const targetId = targetNode["@id"] || "";
                const edgeKey = `${sourceId}|${targetId}|${field}`;
                if (edgeSet.has(edgeKey)) return;
                edgeSet.add(edgeKey);
                directedPairs.add(`${sourceId}|${targetId}`);

                const edgeConfig = EDGE_TYPE_CONFIG[field] || {
                    label: field,
                    color: "#94a3b8",
                };

                edges.push({
                    source: sourceId,
                    target: targetId,
                    label: edgeConfig.label,
                    color: edgeConfig.color,
                    type: field,
                });
            });
        });
    });

    edges.forEach(edge => {
        const reverseKey = `${edge.target}|${edge.source}`;
        edge.curvature = directedPairs.has(reverseKey) ? 0.3 : 0;
    });
    return edges;
}

/**
 * Calculate radial positions for nodes.
 */
function calculateRadialPositions(nodesByTypeKey) {
    const positions = {};
    const ringRadius = { 0: 0, 1: 150, 2: 300, 3: 450 };
    const nodesByRing = {};

    Object.entries(nodesByTypeKey).forEach(([entityType, nodes]) => {
        const config = ENTITY_TYPE_CONFIG[entityType] || ENTITY_TYPE_CONFIG["schema:Person"];
        const ring = config.ring;
        if (!nodesByRing[ring]) nodesByRing[ring] = [];
        nodes.forEach(node => nodesByRing[ring].push(node));
    });

    Object.entries(nodesByRing).forEach(([ringKey, ringNodes]) => {
        const ring = Number(ringKey);
        const radius = ringRadius[ring] ?? 450;
        const count = ringNodes.length;
        if (count === 0) return;

        if (ring === 0 && count === 1) {
            positions[ringNodes[0]["@id"]] = { x: 0, y: 0 };
            return;
        }

        ringNodes.forEach((node, idx) => {
            const angle = (2 * Math.PI * idx / count) - (Math.PI / 2);
            positions[node["@id"]] = {
                x: radius * Math.cos(angle),
                y: radius * Math.sin(angle),
            };
        });
    });
    return positions;
}

/**
 * Match a graph node ID to its validation result.
 */
function matchValidation(nodeId, validationLookup) {
    if (validationLookup[nodeId]) return validationLookup[nodeId];
    if (nodeId.includes("/")) {
        const shortId = nodeId.split("/").slice(-1)[0];
        if (validationLookup[shortId]) return validationLookup[shortId];
    }
    return null;
}

/**
 * Build the full graph data structure from parsed JSON-LD.
 */
function buildGraphDataFromJsonld(jsonld, validationLookup) {
    const graphNodes = jsonld["@graph"];
    if (!Array.isArray(graphNodes)) {
        throw new Error('JSON-LD must include an "@graph" array.');
    }

    const idIndex = buildIdIndex(graphNodes);
    const nodesByTypeKey = {};
    graphNodes.forEach(node => {
        const nodeType = node["@type"];
        if (ENTITY_TYPE_CONFIG[nodeType]) {
            if (!nodesByTypeKey[nodeType]) nodesByTypeKey[nodeType] = [];
            nodesByTypeKey[nodeType].push(node);
        }
    });

    const positions = calculateRadialPositions(nodesByTypeKey);
    const edges = extractEdges(graphNodes, idIndex);
    const connectionCounts = {};
    edges.forEach(edge => {
        connectionCounts[edge.source] = (connectionCounts[edge.source] || 0) + 1;
        connectionCounts[edge.target] = (connectionCounts[edge.target] || 0) + 1;
    });

    let validCount = 0;
    let invalidCount = 0;
    let noValidationCount = 0;
    const nodes = [];

    graphNodes.forEach(node => {
        const nodeId = node["@id"] || "";
        const nodeType = node["@type"] || "";
        if (!ENTITY_TYPE_CONFIG[nodeType]) return;

        const config = ENTITY_TYPE_CONFIG[nodeType];
        const pos = positions[nodeId] || { x: 0, y: 0 };
        const connCount = connectionCounts[nodeId] || 0;
        const size = config.size_base + Math.min(connCount * 2, 10);

        const properties = {};
        Object.entries(node).forEach(([key, value]) => {
            if ((key === "@id" || key === "@type") || value === null || value === undefined) {
                return;
            }
            const displayKey = key.includes(":") ? key.split(":").slice(-1)[0] : key;
            properties[displayKey] = value;
        });

        const val = matchValidation(nodeId, validationLookup);
        let validation = null;
        if (val) {
            validation = {
                strict: Boolean(val.strict),
                agent: Boolean(val.agent),
                strict_errors: val.strict_errors || [],
                agent_errors: val.agent_errors || [],
                shape: val.shape || "",
            };
            if (validation.strict && validation.agent) {
                validCount += 1;
            } else {
                invalidCount += 1;
            }
        } else {
            noValidationCount += 1;
        }

        nodes.push({
            id: nodeId,
            label: extractNodeLabel(node),
            x: pos.x,
            y: pos.y,
            size,
            color: config.color,
            nodeType: config.label,
            entityType: nodeType,
            properties,
            validation,
        });
    });

    return {
        nodes,
        edges,
        metadata: {
            generated: new Date().toISOString(),
            nodeCount: nodes.length,
            edgeCount: edges.length,
            entityTypes: Object.keys(ENTITY_TYPE_CONFIG),
            validation: {
                valid: validCount,
                invalid: invalidCount,
                noData: noValidationCount,
                total: validCount + invalidCount + noValidationCount,
            },
        },
    };
}

/**
 * Populate a graphology Graph instance from graph data.
 */
function addGraphDataToGraph(graph, data) {
    graph.clear();
    data.nodes.forEach(node => {
        graph.addNode(node.id, {
            label: node.label,
            x: node.x,
            y: node.y,
            size: node.size,
            color: node.color,
            nodeType: node.nodeType,
            entityType: node.entityType,
            properties: node.properties,
            validation: node.validation,
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
                edgeType: edge.type,
                originalColor: edge.color,
                curvature: edge.curvature,
            });
        }
    });
}

/**
 * Build a validation lookup from graph data nodes.
 */
function buildValidationLookupFromGraphData(data) {
    const lookup = {};
    (data.nodes || []).forEach(node => {
        if (node.validation !== undefined && node.validation !== null) {
            lookup[node.id] = node.validation;
            if (node.id.includes("/")) {
                lookup[node.id.split("/").slice(-1)[0]] = node.validation;
            }
        }
    });
    return lookup;
}
