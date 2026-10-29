/* Paper Reader: quit completely when the window is closed (server side: lifecycle.py).
 * Loaded by the app page and the style gallery. A page inside a frame (the gallery's 11 previews) takes no part:
 * it can't outlive the page around it, and frames that check in but never say goodbye would keep the app looking
 * open after the window is closed (found in the 2026-09-30 test sweep).
 * The top-level page checks in every 5 s, holds a live connection (/api/window) that drops the moment the window goes,
 * and sends a beacon on pagehide as a second signal. A reload checks in again at once, so it doesn't quit.
 */
(() => {
  if (window.PR_PREVIEW) return;           // a style-gallery preview (frame.js), not a window
  const page = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let token = null;
  const beat = () => fetch("/api/alive", { method: "POST", keepalive: true,
    headers: { "Content-Type": "application/json", "X-Paper-Reader": "1" }, body: JSON.stringify({ page }) }).catch(() => {});
  fetch("/api/health").then((r) => r.json()).then((h) => {
    token = h.life;
    if ("EventSource" in window) new EventSource(`/api/window?page=${page}&token=${token}`);
  }).catch(() => {});
  beat();
  setInterval(beat, 5000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") beat(); });
  addEventListener("pageshow", (e) => { if (e.persisted) beat(); });
  addEventListener("pagehide", (e) => {
    if (e.persisted || !token) return;       // kept in the back/forward cache: not really closed
    navigator.sendBeacon("/api/closing", new Blob([JSON.stringify({ page, token })], { type: "text/plain" }));
  });
})();
