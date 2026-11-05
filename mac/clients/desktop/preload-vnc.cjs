// Only the lifecycle protocol required by the original renderer is installed.
// Input, rendering and transport are handled by the unmodified local noVNC page.
const { ipcRenderer } = require("electron");
let connected = false;
let connectedBefore = false;
function reportConnection() {
  const next = document.documentElement.classList.contains("noVNC_connected");
  if (next === connected) return;
  connected = next;
  const phase = next
    ? connectedBefore
      ? "reconnect"
      : "rfb_connect"
    : "rfb_disconnect";
  if (next) connectedBefore = true;
  ipcRenderer.sendToHost(
    "sand:vnc-session",
    JSON.stringify({ phase, clean: true }),
  );
}
window.addEventListener("DOMContentLoaded", () => {
  const style = document.createElement("style");
  style.textContent =
    "#noVNC_control_bar_anchor,#noVNC_hint_anchor,#noVNC_status{display:none!important}";
  document.head.appendChild(style);
  new MutationObserver(reportConnection).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  reportConnection();
});
