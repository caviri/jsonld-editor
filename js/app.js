/* ==============================================
   JSON-LD Graph Visualization — App Entry Point
   ============================================== */

(async function main() {
    // ── Load JSON-LD data ────────────────────
    let jsonldData;
    let jsonldText;

    try {
        const response = await fetch("data/sample.jsonld.json");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        jsonldText = await response.text();
        jsonldData = JSON.parse(jsonldText);
    } catch (err) {
        document.getElementById("sigma-container").innerHTML =
            `<p style="padding: 20px; color: #ef4444; font-size: 14px;">
                Failed to load JSON-LD data: ${err.message}<br>
                Make sure <code>data/sample.jsonld.json</code> exists and the page is served via HTTP (not file://).
            </p>`;
        return;
    }

    // ── Load validation results (optional) ────
    let validationRaw = null;
    try {
        const valResponse = await fetch("data/validation_results.json");
        if (valResponse.ok) {
            validationRaw = await valResponse.json();
            console.log("Validation results loaded");
        }
    } catch (_) {
        // Validation file is optional — continue without it
    }

    // Build per-instance validation lookup (mirrors Python load_validation)
    function buildValidationLookup(data) {
        if (!data) return {};
        const lookup = {};
        for (const mode of ["strict", "agent"]) {
            const modeData = data[mode] || {};
            for (const [shapeName, shapeResult] of Object.entries(modeData)) {
                for (const instance of (shapeResult.instances || [])) {
                    const instId = instance.id || "";
                    if (!lookup[instId]) {
                        lookup[instId] = {
                            strict: true,
                            agent: true,
                            strict_errors: [],
                            agent_errors: [],
                            shape: shapeName,
                        };
                    }
                    lookup[instId][mode] = instance.valid !== false;
                    lookup[instId][mode + "_errors"] = instance.errors || [];
                }
            }
        }
        return lookup;
    }

    const validationLookup = buildValidationLookup(validationRaw);

    // ── Build graph data ─────────────────────
    const graphData = buildGraphDataFromJsonld(jsonldData, validationLookup);
    const validationLookupById = buildValidationLookupFromGraphData(graphData);

    // ── Check dependencies ───────────────────
    const container = document.getElementById("sigma-container");

    if (typeof graphology === "undefined") {
        container.innerHTML = '<p style="padding: 20px; color: red;">Error: graphology library failed to load</p>';
        throw new Error("graphology not loaded");
    }
    if (typeof Sigma === "undefined") {
        container.innerHTML = '<p style="padding: 20px; color: red;">Error: Sigma.js library failed to load</p>';
        throw new Error("Sigma not loaded");
    }

    // ── Initialize graphology ────────────────
    const graph = new graphology.Graph({ multi: true });
    addGraphDataToGraph(graph, graphData);

    console.log("Graph nodes:", graph.order, "edges:", graph.size);

    // ── Custom label renderer ────────────────

    function drawLabel(context, data, settings) {
        if (!data.label) return;

        const fontSize = settings.labelSize || 12;
        const fontWeight = settings.labelWeight || "normal";
        const styles = getComputedStyle(document.documentElement);
        const fontColor = styles.getPropertyValue("--text-primary").trim() || "#1e293b";
        const nodeType = data.nodeType || "Unknown";
        const typeColor = data.color || "#64748b";
        const x = data.x;
        const y = data.y;
        const size = data.size;

        // Type badge above node
        const badgeFontSize = Math.max(8, fontSize - 3);
        context.font = `bold ${badgeFontSize}px ${settings.labelFont || "sans-serif"}`;
        const badgeWidth = context.measureText(nodeType).width + 8;
        const badgeHeight = badgeFontSize + 4;
        const badgeY = y - size - badgeHeight - 4;

        context.fillStyle = typeColor + "30";
        context.strokeStyle = typeColor;
        context.lineWidth = 1;
        context.beginPath();
        const badgeRadius = 3;
        const badgeX = x - badgeWidth / 2;
        context.moveTo(badgeX + badgeRadius, badgeY);
        context.lineTo(badgeX + badgeWidth - badgeRadius, badgeY);
        context.quadraticCurveTo(badgeX + badgeWidth, badgeY, badgeX + badgeWidth, badgeY + badgeRadius);
        context.lineTo(badgeX + badgeWidth, badgeY + badgeHeight - badgeRadius);
        context.quadraticCurveTo(badgeX + badgeWidth, badgeY + badgeHeight, badgeX + badgeWidth - badgeRadius, badgeY + badgeHeight);
        context.lineTo(badgeX + badgeRadius, badgeY + badgeHeight);
        context.quadraticCurveTo(badgeX, badgeY + badgeHeight, badgeX, badgeY + badgeHeight - badgeRadius);
        context.lineTo(badgeX, badgeY + badgeRadius);
        context.quadraticCurveTo(badgeX, badgeY, badgeX + badgeRadius, badgeY);
        context.closePath();
        context.fill();
        context.stroke();

        context.fillStyle = typeColor;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(nodeType, x, badgeY + badgeHeight / 2);

        // Main label below node
        context.font = `${fontWeight} ${fontSize}px ${settings.labelFont || "sans-serif"}`;
        context.fillStyle = fontColor;
        context.textAlign = "center";
        context.textBaseline = "top";

        let displayLabel = data.label;
        const maxWidth = 120;
        if (context.measureText(displayLabel).width > maxWidth) {
            while (context.measureText(displayLabel + "...").width > maxWidth && displayLabel.length > 0) {
                displayLabel = displayLabel.slice(0, -1);
            }
            displayLabel += "...";
        }

        const labelWidth = context.measureText(displayLabel).width;
        const labelBg = styles.getPropertyValue("--label-bg").trim() || "rgba(255,255,255,0.85)";
        context.fillStyle = labelBg;
        context.fillRect(x - labelWidth / 2 - 3, y + size + 3, labelWidth + 6, fontSize + 4);
        context.fillStyle = fontColor;
        context.fillText(displayLabel, x, y + size + 5);

        // Validation badge
        const validation = data.validation;
        if (validation !== undefined) {
            const badgeR = Math.max(4, size * 0.3);
            const bx = x + size * 0.7;
            const by = y - size * 0.7;
            context.beginPath();
            context.arc(bx, by, badgeR, 0, 2 * Math.PI);
            if (validation === null) context.fillStyle = "#94a3b8";
            else if (validation.strict && validation.agent) context.fillStyle = "#22c55e";
            else context.fillStyle = "#ef4444";
            context.fill();
            context.strokeStyle = styles.getPropertyValue("--badge-stroke").trim() || "white";
            context.lineWidth = 1.5;
            context.stroke();

            context.fillStyle = "white";
            context.font = `bold ${Math.max(6, badgeR)}px sans-serif`;
            context.textAlign = "center";
            context.textBaseline = "middle";
            if (validation === null) context.fillText("?", bx, by);
            else if (validation.strict && validation.agent) context.fillText("✓", bx, by);
            else context.fillText("✗", bx, by);
        }
    }

    // ── Custom hover renderer (theme-aware bg) ──
    function drawHover(context, data, settings) {
        const styles = getComputedStyle(document.documentElement);
        const hoverBg = styles.getPropertyValue("--label-bg").trim() || "rgba(255,255,255,0.85)";
        const fontColor = styles.getPropertyValue("--text-primary").trim() || "#1e293b";
        const borderColor = data.color || "#64748b";

        const fontSize = settings.labelSize + 2 || 14;
        const label = data.label || "";
        const nodeType = data.nodeType || "";
        const x = data.x;
        const y = data.y;
        const size = data.size;

        context.font = `bold ${fontSize}px ${settings.labelFont || "sans-serif"}`;
        const labelWidth = context.measureText(label).width;
        const typeWidth = context.measureText(nodeType).width;
        const boxWidth = Math.max(labelWidth, typeWidth) + 20;
        const boxHeight = fontSize * 2.8;
        const boxX = x + size + 4;
        const boxY = y - boxHeight / 2;
        const r = 6;

        // Rounded rect background
        context.beginPath();
        context.moveTo(boxX + r, boxY);
        context.lineTo(boxX + boxWidth - r, boxY);
        context.quadraticCurveTo(boxX + boxWidth, boxY, boxX + boxWidth, boxY + r);
        context.lineTo(boxX + boxWidth, boxY + boxHeight - r);
        context.quadraticCurveTo(boxX + boxWidth, boxY + boxHeight, boxX + boxWidth - r, boxY + boxHeight);
        context.lineTo(boxX + r, boxY + boxHeight);
        context.quadraticCurveTo(boxX, boxY + boxHeight, boxX, boxY + boxHeight - r);
        context.lineTo(boxX, boxY + r);
        context.quadraticCurveTo(boxX, boxY, boxX + r, boxY);
        context.closePath();
        context.fillStyle = hoverBg;
        context.fill();
        context.strokeStyle = borderColor;
        context.lineWidth = 1.5;
        context.stroke();

        // Node type (smaller, muted)
        context.font = `bold ${fontSize - 2}px ${settings.labelFont || "sans-serif"}`;
        context.fillStyle = borderColor;
        context.textAlign = "left";
        context.textBaseline = "top";
        context.fillText(nodeType, boxX + 10, boxY + 6);

        // Label text
        context.font = `${fontSize}px ${settings.labelFont || "sans-serif"}`;
        context.fillStyle = fontColor;
        context.textBaseline = "bottom";
        context.fillText(label, boxX + 10, boxY + boxHeight - 6);
    }

    // ── Initialize Sigma ─────────────────────
    const sigmaSettings = {
        renderEdgeLabels: false,
        enableEdgeEvents: true,
        labelRenderedSizeThreshold: 0,
        labelDensity: 1,
        labelGridCellSize: 50,
        zIndex: true,
        minCameraRatio: 0.1,
        maxCameraRatio: 10,
        zoomingRatio: 1.2,
        labelRenderer: drawLabel,
        hoverRenderer: drawHover,
        labelFont: "sans-serif",
        labelSize: 11,
        labelWeight: "normal",
        labelColor: { color: "#1e293b" },
    };

    const sigmaInstance = new Sigma(graph, container, sigmaSettings);
    console.log("Sigma initialized");

    // ── Create modules ───────────────────────
    const layoutManager = createLayouts(graph, sigmaInstance);
    const editorModule = createEditor();
    const ui = createUI(graph, sigmaInstance, layoutManager, editorModule);

    // ── Initialize ───────────────────────────
    ui.init(graphData, validationLookupById);
    editorModule.initJsonldEditor(jsonldText, () => ui.getSelectedNode());

    // ── Theme toggle wiring ──────────────────
    const themeToggleBtn = document.getElementById("theme-toggle");
    themeToggleBtn.addEventListener("click", () => {
        window.themeManager.toggle();
    });
    window.themeManager.updateToggleButton();

    // Re-render on theme change
    window.addEventListener("theme-changed", () => {
        const styles = getComputedStyle(document.documentElement);
        sigmaInstance.setSetting("labelColor", { color: styles.getPropertyValue("--text-primary").trim() });
        sigmaInstance.refresh();
    });

    // Run initial layout
    setTimeout(() => layoutManager.applyLayout("force"), 100);
})();
