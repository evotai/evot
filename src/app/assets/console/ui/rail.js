/* Shared left rail, loaded as a classic script in <head> on every console page.
 *
 * `<evot-rail>` is defined before the body is parsed, so the browser renders
 * the rail while it parses the page, before first paint. The console is
 * settings only: conversations live in the TUI and in /remote.
 */
(() => {
  const PAGES = [
    { href: "/models", name: "Models" },
    { href: "/feishu", name: "Feishu" },
  ];

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
  const here = () => window.location.pathname.replace(/\/+$/, "") || "/";
  const links = (items) => items.map((item) => {
    const on = here() === item.href;
    return '<a href="' + item.href + '"' + (on ? ' class="active" aria-current="page"' : "") + ">" +
      esc(item.name) + "</a>";
  }).join("");

  function themeButton() {
    const target = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    return '<button class="theme-toggle" type="button" aria-label="Switch to ' + target +
      ' mode" title="Switch to ' + target + ' mode" aria-pressed="' + String(target === "dark") + '">' +
      target[0].toUpperCase() + target.slice(1) + " mode</button>";
  }

  function html() {
    return '<div class="rail-brand"><a class="brand" href="/"><span class="mark">' +
      '<svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true">' +
      '<rect x="1" y="1" width="16" height="16" stroke="currentColor" stroke-width="1.6"/>' +
      '<rect x="5.5" y="5.5" width="7" height="7" fill="currentColor"/></svg>' +
      "</span>evot <span>console</span></a></div>" +
      '<section class="rail-settings" aria-label="Settings"><div class="rail-label">Settings</div>' +
      '<nav class="rail-nav" aria-label="Settings pages">' + links(PAGES) + "</nav>" +
      '<div class="rail-row"><span>Appearance</span>' + themeButton() + "</div></section>";
  }

  class EvotRail extends HTMLElement {
    connectedCallback() {
      if (this.dataset.ready) return;
      this.dataset.ready = "true";
      this.innerHTML = html();
    }
  }

  window.evotRail = { html };
  if (!customElements.get("evot-rail")) customElements.define("evot-rail", EvotRail);
})();
