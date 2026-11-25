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

    /** Node ids grouped by display type, biggest groups first (ring order respected). */
    function groupsByType() {
        const groups = new Map();
        graph.forEachNode((nodeId, attrs) => {
            const type = attrs.nodeType || "Untyped";
            if (!groups.has(type)) groups.set(type, { ids: [], external: Boolean(attrs.external) });
            groups.get(type).ids.push(nodeId);
        });
        return [...groups.entries()].sort((a, b) =>
            (a[1].external - b[1].external) || b[1].ids.length - a[1].ids.length || a[0].localeCompare(b[0]));
    }

    const layouts = {
        force(opts = {}) {
            stopForceAnimation();
            forceIterations = 0;
            const count = graph.order;
            const maxIterations = opts.warm ? 80 : (count > 1500 ? 120 : count > 400 ? 200 : 300);
            stopLayoutBtn.style.display = "flex";
            layoutRunning = true;

            const nodes = [];
            const nodeIndex = {};
            graph.forEachNode((nodeId, attrs) => {
                nodeIndex[nodeId] = nodes.length;
                nodes.push({
                    id: nodeId,
                    x: Number.isFinite(attrs.x) && attrs.x !== 0 ? attrs.x : Math.random() * 500 - 250,
                    y: Number.isFinite(attrs.y) && attrs.y !== 0 ? attrs.y : Math.random() * 500 - 250,
                    vx: 0,
                    vy: 0,
                });
            });
            const edges = [];
            graph.forEachEdge((edgeId, attrs, source, target) => {
                if (source !== target) edges.push({ source: nodeIndex[source], target: nodeIndex[target] });
            });

            const repulsion = 5000;
            const attraction = 0.01;
            const gravity = 0.1;
            const damping = 0.9;
            const exact = nodes.length <= 400;
            const cellSize = 220;

            function repulse(a, b) {
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const dist2 = dx * dx + dy * dy || 1;
                const dist = Math.sqrt(dist2);
                const force = repulsion / dist2;
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                a.vx -= fx; a.vy -= fy;
                b.vx += fx; b.vy += fy;
            }

            function simulateStep() {
                nodes.forEach(node => { node.vx *= damping; node.vy *= damping; });
                if (exact) {
                    for (let i = 0; i < nodes.length; i++) {
                        for (let j = i + 1; j < nodes.length; j++) repulse(nodes[i], nodes[j]);
                    }
                } else {
                    // Grid buckets: repulsion only between nearby nodes (O(n) per step).
                    const grid = new Map();
                    nodes.forEach(node => {
                        const key = `${Math.floor(node.x / cellSize)}|${Math.floor(node.y / cellSize)}`;
                        if (!grid.has(key)) grid.set(key, []);
                        grid.get(key).push(node);
                    });
                    grid.forEach((cell, key) => {
                        const [cx, cy] = key.split("|").map(Number);
                        for (let ox = 0; ox <= 1; ox++) {
                            for (let oy = -1; oy <= 1; oy++) {
                                if (ox === 0 && oy < 0) continue;
                                const other = ox === 0 && oy === 0 ? cell : grid.get(`${cx + ox}|${cy + oy}`);
                                if (!other) continue;
                                for (let i = 0; i < cell.length; i++) {
                                    for (let j = other === cell ? i + 1 : 0; j < other.length; j++) repulse(cell[i], other[j]);
                                }
                            }
                        }
                    });
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
                    source.vx += fx; source.vy += fy;
                    target.vx -= fx; target.vy -= fy;
                });
                nodes.forEach(node => {
                    node.vx -= node.x * gravity * 0.01;
                    node.vy -= node.y * gravity * 0.01;
                    // Clamp to keep the simulation stable on dense graphs.
                    const speed = Math.hypot(node.vx, node.vy);
                    if (speed > 60) { node.vx *= 60 / speed; node.vy *= 60 / speed; }
                    node.x += node.vx;
                    node.y += node.vy;
                });
            }

            function animateForce() {
                const iterationsPerFrame = nodes.length > 1500 ? 1 : 3;
                for (let k = 0; k < iterationsPerFrame && forceIterations < maxIterations; k++) {
                    simulateStep();
                    forceIterations++;
                }
                nodes.forEach(node => {
                    if (!graph.hasNode(node.id)) return;
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
            const groups = groupsByType();
            const totalNodes = graph.order || 1;
            const radius = Math.max(200, totalNodes * 15);
            const anglePerNode = (2 * Math.PI) / totalNodes;
            let currentAngle = 0;
            groups.forEach(([, group]) => {
                group.ids.forEach(nodeId => {
                    graph.setNodeAttribute(nodeId, "x", radius * Math.cos(currentAngle));
                    graph.setNodeAttribute(nodeId, "y", radius * Math.sin(currentAngle));
                    currentAngle += anglePerNode;
                });
            });
        },

        radial() {
            stopForceAnimation();
            const groups = groupsByType();
            // The type with the most connections per node goes in the middle.
            const degreeOf = ids => ids.reduce((sum, id) => sum + graph.degree(id), 0) / Math.max(1, ids.length);
            const ordered = groups.filter(([, g]) => !g.external).sort((a, b) => degreeOf(b[1].ids) - degreeOf(a[1].ids))
                .concat(groups.filter(([, g]) => g.external));
            ordered.forEach(([, group], ring) => {
                const count = group.ids.length;
                const radius = ring === 0 ? (count > 1 ? 60 + count * 4 : 0) : 120 + ring * 140 + count * 2;
                group.ids.forEach((nodeId, i) => {
                    const angle = (2 * Math.PI * i) / count - Math.PI / 2 + ring * 0.3;
                    const jitter = ring === 0 ? 0 : (Math.random() - 0.5) * 30;
                    graph.setNodeAttribute(nodeId, "x", (radius + jitter) * Math.cos(angle));
                    graph.setNodeAttribute(nodeId, "y", (radius + jitter) * Math.sin(angle));
                });
            });
        },

        grid() {
            stopForceAnimation();
            const nodes = [];
            graph.forEachNode(nodeId => nodes.push(nodeId));
            nodes.sort((a, b) => {
                const typeA = String(graph.getNodeAttribute(a, "nodeType") || "");
                const typeB = String(graph.getNodeAttribute(b, "nodeType") || "");
                if (typeA !== typeB) return typeA.localeCompare(typeB);
                return String(graph.getNodeAttribute(a, "label") || "").localeCompare(String(graph.getNodeAttribute(b, "label") || ""));
            });
            const cols = Math.ceil(Math.sqrt(nodes.length)) || 1;
            const spacing = 150;
            nodes.forEach((nodeId, i) => {
                const col = i % cols;
                const row = Math.floor(i / cols);
                graph.setNodeAttribute(nodeId, "x", col * spacing - (cols * spacing) / 2);
                graph.setNodeAttribute(nodeId, "y", row * spacing - (Math.ceil(nodes.length / cols) * spacing) / 2);
            });
        },
    };

    function applyLayout(layoutName, opts = {}) {
        currentLayout = layoutName;
        if (layouts[layoutName]) {
            layouts[layoutName](opts);
            sigmaInstance.refresh();
        }
        document.querySelectorAll(".layout-menu-item").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.layout === layoutName);
        });
    }

    function getCurrentLayout() {
        return currentLayout;
    }

    stopLayoutBtn.addEventListener("click", () => stopForceAnimation());

    return {
        applyLayout,
        stopForceAnimation,
        getCurrentLayout,
    };
}
