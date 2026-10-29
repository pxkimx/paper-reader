// Is this page one of Paper Reader's own style-gallery previews? Only when the page around it is Paper Reader's
// (same origin). Shown inside another app, e.g. Toolbox Launcher (http://localhost:8773), it is a real window:
// it checks in, holds its live connection, sends the closing beacon, runs auto-analysis and records "opened".
// Reading a cross-origin parent's location throws, which is exactly that case.
window.PR_PREVIEW = (() => {
  if (window === window.top) return false;
  try { return window.parent.location.origin === location.origin; } catch (e) { return false; }
})();
