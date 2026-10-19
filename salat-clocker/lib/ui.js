/* Shared UI helpers: user background color with automatic light/dark text. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SalatUi = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // Perceived brightness check for auto light/dark text.
  function isDark(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return false;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return 0.299 * r + 0.587 * g + 0.114 * b < 128;
  }

  // Apply the user's background choice; dark choices get light text.
  function applyTheme(settings) {
    const bg = settings.bgColor || "#FAFAFA";
    document.body.style.backgroundColor = bg;
    document.body.classList.toggle("dark", isDark(bg));
  }

  return { isDark, applyTheme };
});
