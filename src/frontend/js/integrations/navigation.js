// Keep section navigation inside the settings scroller, not the app shell.
export function bindIntegrationNavigation() {
  const page = document.querySelector("#integrations-page");
  const nav = page?.querySelector(".integration-nav");
  nav?.addEventListener("click", (event) => {
    const link = event.target.closest("a[href^='#integration-']");
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const section = page.querySelector(link.getAttribute("href"));
    if (!section) return;
    event.preventDefault();
    page.scrollTo({
      top: page.scrollTop + section.getBoundingClientRect().top
        - page.getBoundingClientRect().top - nav.offsetHeight - 16,
      behavior: "instant"
    });
    section.setAttribute("tabindex", "-1");
    section.focus({ preventScroll: true });
  });
}
