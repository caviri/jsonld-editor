/* ==============================================
   JSON-LD Graph Visualization — Resizable panels
   ============================================== */

/**
 * Make a side panel resizable by dragging a handle on one of its edges.
 *
 *   wrapper     the panel element whose width is driven by a CSS variable
 *   handle      the drag strip
 *   cssVar      e.g. "--editor-width" (read by the panel's CSS)
 *   edge        "right" (panel grows to the right) or "left"
 *   min         minimum width in px
 *   maxFn       () => maximum width in px
 *   storageKey  remembers the width in this browser (optional)
 *   onResize    called after a resize ends
 *
 * Returns { setWidth(px, persist), getWidth(), toggleHalf() }.
 */
function makePanelResizable({ wrapper, handle, cssVar, edge = "right", min = 280, maxFn, storageKey, defaultWidth, onResize }) {
    let previousWidth = null;

    function clamp(px) {
        const max = Math.max(min, maxFn ? maxFn() : window.innerWidth - 200);
        return Math.round(Math.max(min, Math.min(max, px)));
    }

    function getWidth() {
        const value = parseFloat(getComputedStyle(wrapper).getPropertyValue(cssVar));
        return Number.isFinite(value) ? value : (defaultWidth || wrapper.getBoundingClientRect().width);
    }

    function setWidth(px, persist = true) {
        const w = clamp(px);
        wrapper.style.setProperty(cssVar, `${w}px`);
        if (persist && storageKey) {
            try { localStorage.setItem(storageKey, String(w)); } catch (_) { /* storage blocked */ }
        }
        return w;
    }

    /** Toggle between half of the available width and the previous width. */
    function toggleHalf() {
        const container = wrapper.parentElement;
        const half = clamp(container.clientWidth * 0.5);
        const current = getWidth();
        if (Math.abs(current - half) < 12) {
            setWidth(previousWidth && Math.abs(previousWidth - half) >= 12 ? previousWidth : (defaultWidth || min));
        } else {
            previousWidth = current;
            setWidth(half);
        }
        if (onResize) setTimeout(onResize, 320);
        return getWidth() >= half - 12;
    }

    // Restore a remembered width.
    if (storageKey) {
        try {
            const saved = parseFloat(localStorage.getItem(storageKey));
            if (Number.isFinite(saved)) wrapper.style.setProperty(cssVar, `${Math.round(saved)}px`);
        } catch (_) { /* storage blocked */ }
    }

    // Pointer events: mouse, touch and pen drag the handle the same way.
    handle.style.touchAction = "none";
    handle.addEventListener("pointerdown", e => {
        if (wrapper.classList.contains("collapsed") || (e.pointerType === "mouse" && e.button !== 0)) return;
        e.preventDefault();
        const startX = e.clientX;
        const startW = wrapper.getBoundingClientRect().width;
        try { handle.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        document.body.classList.add("resizing-x");
        wrapper.classList.add("resizing");
        const move = ev => {
            const dx = ev.clientX - startX;
            setWidth(edge === "right" ? startW + dx : startW - dx, false);
        };
        const up = () => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            handle.removeEventListener("pointercancel", up);
            document.body.classList.remove("resizing-x");
            wrapper.classList.remove("resizing");
            setWidth(getWidth(), true);
            if (onResize) onResize();
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
    });
    handle.addEventListener("dblclick", () => toggleHalf());

    // Keep the panel within bounds when the window shrinks.
    window.addEventListener("resize", () => {
        if (!wrapper.classList.contains("collapsed")) setWidth(getWidth(), false);
    });

    return { setWidth, getWidth, toggleHalf };
}
