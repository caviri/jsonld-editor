/* ==============================================
   JSON-LD Graph Visualization — Theme Manager
   ============================================== */

window.themeManager = (function () {
    const STORAGE_KEY = "jsonld-theme";
    const DARK = "dark";
    const LIGHT = "light";

    function get() {
        return document.documentElement.getAttribute("data-theme") || LIGHT;
    }

    function set(theme) {
        document.documentElement.setAttribute("data-theme", theme);
        localStorage.setItem(STORAGE_KEY, theme);
        window.dispatchEvent(new CustomEvent("theme-changed", { detail: { theme } }));
    }

    function toggle() {
        set(get() === DARK ? LIGHT : DARK);
        updateToggleButton();
    }

    function updateToggleButton() {
        const btn = document.getElementById("theme-toggle");
        if (!btn) return;
        const isDark = get() === DARK;
        btn.textContent = isDark ? "☀️" : "🌙";
        btn.classList.toggle("active", isDark);
    }

    // Restore persisted theme on load
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === DARK) {
        document.documentElement.setAttribute("data-theme", DARK);
    }

    // Expose
    return { get, set, toggle, updateToggleButton, DARK, LIGHT };
})();
