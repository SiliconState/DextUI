// Runs inside the opaque report iframe, before authored scripts. This is a
// presentation channel only: no credentials, network or filesystem capabilities.
export const ARTIFACT_BRIDGE = `(() => {
  addEventListener("keydown", e => {
    if (e.key === "Escape") parent.postMessage({ dextArtifact: "close" }, "*");
  }, true);
  addEventListener("message", e => {
    if (e.source !== parent || e.data?.dextArtifact !== "theme") return;
    const theme = e.data.theme;
    if (theme !== "light" && theme !== "dark" && theme !== "dim") return;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme === "light" ? "light" : "dark";
  });
  addEventListener("DOMContentLoaded", () => {
    parent.postMessage({ dextArtifact: "ready" }, "*");
  }, { once: true });
})();`;
