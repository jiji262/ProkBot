(() => {
  let preference = "system";
  try { preference = localStorage.getItem("grokbot-host-theme") || "system"; } catch {}
  if (!["system", "light", "dark"].includes(preference)) preference = "system";
  const media = matchMedia("(prefers-color-scheme: dark)");
  function apply() {
    document.documentElement.dataset.theme = preference === "system" ? (media.matches ? "dark" : "light") : preference;
    document.querySelectorAll("[data-theme-picker]").forEach((picker) => { picker.value = preference; });
  }
  apply();
  media.addEventListener("change", apply);
  document.addEventListener("DOMContentLoaded", apply);
  document.addEventListener("change", (event) => {
    if (!event.target.matches?.("[data-theme-picker]")) return;
    preference = event.target.value;
    try { localStorage.setItem("grokbot-host-theme", preference); } catch {}
    apply();
  });
})();
