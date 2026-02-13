/* ==============================================
   JSON-LD Graph Visualization — Layouts
   ============================================== */

/**
 * Create layout functions.
 * @param {object} graph - graphology Graph instance
 * @param {object} sigmaInstance - Sigma renderer instance
 * @returns {object} Layout functions and helpers
 */
function createLayouts(graph, sigmaInstance) {
    let forceAnimationId = null;
    let forceIterations = 0;
    let layoutRunning = false;
    let currentLayout = "force";
    const stopLayoutBtn = document.getElementById("stop-layout");

    function stopForceAnimation() {
        if (forceAnimationId) {
            cancelAnimationFrame(forceAnimationId);
            forceAnimationId = null;
        }
        stopLayoutBtn.style.display = "none";
        layoutRunning = false;
    }

    const layouts = {
        force() {
            stopForceAnimation();
            forceIterations = 0;
            const maxIterations = 300;

            stopLayoutBtn.style.display = "flex";
            layoutRunning = true;

            const nodes = [];
            const nodeIndex = {};
            let i = 0;
            graph.forEachNode((nodeId, attrs) => {
                nodeIndex[nodeId] = i;
                nodes.push({
                    id: nodeId,
                    x: attrs.x || Math.random() * 500 - 250,
                    y: attrs.y || Math.random() * 500 - 250,
                    vx: 0,
                    vy: 0,
                    size: attrs.size || 10,
                });
                i++;
            });

            const edges = [];
            graph.forEachEdge((edgeId, attrs, source, target) => {
                edges.push({
                    source: nodeIndex[source],
                    target: nodeIndex[target],
                });
            });

            const repulsion = 5000;
            const attraction = 0.01;
            const gravity = 0.1;
            const damping = 0.9;

            function simulateStep() {
                nodes.forEach(node => {
                    node.vx *= damping;
                    node.vy *= damping;
                });

                for (let i = 0; i < nodes.length; i++) {
                    for (let j = i + 1; j < nodes.length; j++) {
                        const dx = nodes[j].x - nodes[i].x;
                        const dy = nodes[j].y - nodes[i].y;
                        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                        const force = repulsion / (dist * dist);
                        const fx = (dx / dist) * force;
                        const fy = (dy / dist) * force;
                        nodes[i].vx -= fx;
                        nodes[i].vy -= fy;
                        nodes[j].vx += fx;
                        nodes[j].vy += fy;
                    }
                }

                edges.forEach(edge => {
                    const source = nodes[edge.source];
                    const target = nodes[edge.target];
                    const dx = target.x - source.x;
                    const dy = target.y - source.y;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    const force = dist * attraction;
                    const fx = (dx / dist) * force;
                    const fy = (dy / dist) * force;
                    source.vx += fx;
                    source.vy += fy;
                    target.vx -= fx;
                    target.vy -= fy;
                });

                nodes.forEach(node => {
                    node.vx -= node.x * gravity * 0.01;
                    node.vy -= node.y * gravity * 0.01;
                });

                nodes.forEach(node => {
                    node.x += node.vx;
                    node.y += node.vy;
                });
            }

            function animateForce() {
                const iterationsPerFrame = 3;
                for (let k = 0; k < iterationsPerFrame && forceIterations < maxIterations; k++) {
                    simulateStep();
                    forceIterations++;
                }

                nodes.forEach(node => {
                    graph.setNodeAttribute(node.id, "x", node.x);
                    graph.setNodeAttribute(node.id, "y", node.y);
                });

                sigmaInstance.refresh();

                if (forceIterations < maxIterations && layoutRunning) {
                    forceAnimationId = requestAnimationFrame(animateForce);
                } else {
                    stopLayoutBtn.style.display = "none";
                    layoutRunning = false;
                }
            }

            forceAnimationId = requestAnimationFrame(animateForce);
        },

        circular() {
            stopForceAnimation();
            const nodesByType = {};
            graph.forEachNode((nodeId, attrs) => {
                const type = attrs.nodeType;
                if (!nodesByType[type]) nodesByType[type] = [];
                nodesByType[type].push(nodeId);
            });

            const typeOrder = ["Organization", "Person", "Repository", "Article", "Membership", "Contribution"];
            const sortedTypes = Object.keys(nodesByType).sort((a, b) => {
                const aIdx = typeOrder.indexOf(a);
                const bIdx = typeOrder.indexOf(b);
                return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
            });

            let currentAngle = 0;
            const totalNodes = graph.order;
            const radius = Math.max(200, totalNodes * 15);

            sortedTypes.forEach(type => {
                const nodes = nodesByType[type];
                const anglePerNode = (2 * Math.PI) / totalNodes;
                nodes.forEach(nodeId => {
                    const x = radius * Math.cos(currentAngle);
                    const y = radius * Math.sin(currentAngle);
                    graph.setNodeAttribute(nodeId, "x", x);
                    graph.setNodeAttribute(nodeId, "y", y);
                    currentAngle += anglePerNode;
                });
            });
        },

        radial() {
            stopForceAnimation();
            const nodesByType = {};
            graph.forEachNode((nodeId, attrs) => {
                const type = attrs.nodeType;
                if (!nodesByType[type]) nodesByType[type] = [];
                nodesByType[type].push(nodeId);
            });

            const ringConfig = {
                Organization: { ring: 0, radius: 0 },
                Person: { ring: 1, radius: 200 },
                Repository: { ring: 2, radius: 350 },
                Article: { ring: 2, radius: 400 },
                Membership: { ring: 3, radius: 500 },
                Contribution: { ring: 3, radius: 550 },
            };

            Object.entries(nodesByType).forEach(([type, nodes]) => {
                const config = ringConfig[type] || { ring: 3, radius: 450 };
                const count = nodes.length;

                if (config.radius === 0 && count > 0) {
                    const clusterRadius = count > 1 ? 50 : 0;
                    nodes.forEach((nodeId, i) => {
                        const angle = (2 * Math.PI * i) / count;
                        graph.setNodeAttribute(nodeId, "x", clusterRadius * Math.cos(angle));
                        graph.setNodeAttribute(nodeId, "y", clusterRadius * Math.sin(angle));
                    });
                } else {
                    nodes.forEach((nodeId, i) => {
                        const angle = (2 * Math.PI * i) / count - Math.PI / 2;
                        const jitter = (Math.random() - 0.5) * 30;
                        graph.setNodeAttribute(nodeId, "x", (config.radius + jitter) * Math.cos(angle));
                        graph.setNodeAttribute(nodeId, "y", (config.radius + jitter) * Math.sin(angle));
                    });
                }
            });
        },

        grid() {
            stopForceAnimation();
            const nodes = [];
            graph.forEachNode(nodeId => nodes.push(nodeId));

            nodes.sort((a, b) => {
                const typeA = graph.getNodeAttribute(a, "nodeType");
                const typeB = graph.getNodeAttribute(b, "nodeType");
                if (typeA !== typeB) return typeA.localeCompare(typeB);
                return graph.getNodeAttribute(a, "label").localeCompare(graph.getNodeAttribute(b, "label"));
            });

            const cols = Math.ceil(Math.sqrt(nodes.length));
            const spacing = 150;

            nodes.forEach((nodeId, i) => {
                const col = i % cols;
                const row = Math.floor(i / cols);
                graph.setNodeAttribute(nodeId, "x", col * spacing - (cols * spacing) / 2);
                graph.setNodeAttribute(nodeId, "y", row * spacing - (Math.ceil(nodes.length / cols) * spacing) / 2);
            });
        },
    };

    function applyLayout(layoutName) {
        currentLayout = layoutName;
        if (layouts[layoutName]) {
            layouts[layoutName]();
            sigmaInstance.refresh();
        }

        document.querySelectorAll(".layout-menu-item").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.layout === layoutName);
        });
    }

    function getCurrentLayout() {
        return currentLayout;
    }

    stopLayoutBtn.addEventListener("click", () => {
        stopForceAnimation();
    });

    return {
        applyLayout,
        stopForceAnimation,
        getCurrentLayout,
    };
}
