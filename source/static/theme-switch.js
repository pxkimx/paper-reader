/* Light | Dark switch (same file in Paper Reader and BioCanvas).
 * Load it synchronously in <head>: it sets data-theme="light"/"dark" on <html> before first paint, so there is no flash.
 * The choice lives in localStorage "theme"; until the user picks, the tool's own look is used
 * (<html data-default-theme="light|dark">). Put <span data-theme-switch></span> wherever the switch should appear.
 * Pages are told about changes with a "themechange" event on window (detail: "light" | "dark").
 */
(function () {
  var KEY = "theme", root = document.documentElement;
  function saved() { try { var v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : null; } catch (e) { return null; } }
  var first = true;
  function apply(t) {
    if (root.dataset.theme === t) return;
    if (!first) {   // switch instantly, without every transition fading at once
      root.classList.add("ts-instant");
      setTimeout(function () { root.classList.remove("ts-instant"); }, 60);
    }
    first = false;
    root.dataset.theme = t;
    var bs = document.querySelectorAll(".theme-switch .ts-btn");
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute("aria-pressed", String(bs[i].dataset.t === t));
    try { window.dispatchEvent(new CustomEvent("themechange", { detail: t })); } catch (e) {}
  }
  apply(saved() || root.dataset.defaultTheme || "light");

  var SUN = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.1" fill="currentColor"/><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1"/></g></svg>';
  var MOON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.6 10.2A6 6 0 0 1 5.8 2.4a6 6 0 1 0 7.8 7.8z" fill="currentColor"/></svg>';
  var CSS = ".ts-instant,.ts-instant *,.ts-instant *::before,.ts-instant *::after{transition:none!important}" +
    ".theme-switch{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:999px;flex:none;vertical-align:middle;" +
    "background:rgba(120,120,128,.16)!important;border:1px solid rgba(120,120,128,.24)!important;line-height:1}" +
    ".theme-switch .ts-btn{-webkit-appearance:none;appearance:none;display:inline-flex!important;align-items:center;gap:5px;margin:0!important;" +
    "padding:3px 10px 3px 8px!important;border:0!important;border-radius:999px!important;background:transparent!important;box-shadow:none!important;" +
    "font:500 12px/16px -apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif!important;letter-spacing:0!important;" +
    "text-transform:none!important;color:inherit!important;opacity:.72;cursor:pointer;transform:none!important;min-width:0!important;height:auto!important}" +
    ".theme-switch .ts-btn svg{width:13px;height:13px;flex:none}" +
    ".theme-switch .ts-btn:hover{opacity:1}" +
    ".theme-switch .ts-btn[aria-pressed=true]{opacity:1;background:#ffffff!important;color:#1d1d1f!important;box-shadow:0 1px 3px rgba(0,0,0,.2)!important}" +
    ":root[data-theme=dark] .theme-switch .ts-btn[aria-pressed=true]{background:#48484a!important;color:#f5f5f7!important}" +
    ".theme-switch .ts-btn:focus-visible{outline:2px solid #0a84ff!important;outline-offset:1px}" +
    "@media (max-width:640px){.theme-switch .ts-label{display:none}.theme-switch .ts-btn{padding:4px 7px!important}}";

  function mount(el) {
    if (el.querySelector(".theme-switch")) return;
    var t = root.dataset.theme, w = document.createElement("span");
    w.className = "theme-switch"; w.setAttribute("role", "group"); w.setAttribute("aria-label", "Colour theme");
    w.innerHTML = '<button type="button" class="ts-btn" data-t="light" title="Light theme">' + SUN + '<span class="ts-label">Light</span></button>' +
      '<button type="button" class="ts-btn" data-t="dark" title="Dark theme">' + MOON + '<span class="ts-label">Dark</span></button>';
    var bs = w.querySelectorAll(".ts-btn");
    for (var i = 0; i < bs.length; i++) {
      bs[i].setAttribute("aria-pressed", String(bs[i].dataset.t === t));
      bs[i].addEventListener("click", function (e) { e.stopPropagation(); ThemeSwitch.set(this.dataset.t); });
    }
    el.appendChild(w);
  }
  window.ThemeSwitch = {
    get: function () { return root.dataset.theme; },
    set: function (t) { if (t !== "light" && t !== "dark") return; try { localStorage.setItem(KEY, t); } catch (e) {} apply(t); },
    mount: mount,
  };
  // another window of the same tool (a browser tab and the Toolbox Launcher frame) follows the change
  window.addEventListener("storage", function (e) { if (e.key === KEY && (e.newValue === "light" || e.newValue === "dark")) apply(e.newValue); });
  document.addEventListener("DOMContentLoaded", function () {
    var s = document.createElement("style"); s.textContent = CSS; document.head.appendChild(s);
    var els = document.querySelectorAll("[data-theme-switch]");
    for (var i = 0; i < els.length; i++) mount(els[i]);
  });
})();
