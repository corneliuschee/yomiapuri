// One viewport-aware tooltip shared by static and dynamically rendered controls.
export function bindTooltipEvents() {
  const tooltip = document.createElement("div");
  tooltip.className = "floating-tooltip";
  tooltip.id = "control-tooltip";
  tooltip.role = "tooltip";
  tooltip.hidden = true;
  document.body.append(tooltip);
  let active;
  let timer;
  let hideTimer;
  const selector = "[data-tooltip], button[title], button[aria-label]";

  function hide() {
    clearTimeout(timer);
    clearTimeout(hideTimer);
    if (active) {
      const ids = (active.getAttribute("aria-describedby") || "").split(/\s+/).filter(id => id && id !== tooltip.id);
      if (ids.length) active.setAttribute("aria-describedby", ids.join(" "));
      else active.removeAttribute("aria-describedby");
    }
    active = null;
    tooltip.hidden = true;
  }

  function show(target, delay) {
    if (target === active) { clearTimeout(hideTimer); return; }
    hide();
    if (target.disabled) return;
    const message = target.title || target.dataset.tooltip || target.getAttribute("aria-label");
    if (!message) return;
    if (target.title) {
      target.dataset.tooltip = target.title;
      if (!target.textContent.trim() && !target.hasAttribute("aria-label")) target.setAttribute("aria-label", target.title);
      target.removeAttribute("title");
    }
    active = target;
    timer = setTimeout(() => {
      if (!target.isConnected || !target.getClientRects().length) return hide();
      tooltip.textContent = message;
      tooltip.hidden = false;
      const box = target.getBoundingClientRect();
      const size = tooltip.getBoundingClientRect();
      const gap = 8;
      tooltip.style.left = `${Math.max(gap, Math.min(box.left + (box.width - size.width) / 2, innerWidth - size.width - gap))}px`;
      const top = box.bottom + gap + size.height <= innerHeight - gap ? box.bottom + gap : box.top - size.height - gap;
      tooltip.style.top = `${Math.max(gap, top)}px`;
      const ids = new Set((target.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
      ids.add(tooltip.id);
      target.setAttribute("aria-describedby", [...ids].join(" "));
    }, delay);
  }

  document.addEventListener("pointerover", event => {
    if (event.pointerType === "touch") return;
    if (tooltip.contains(event.target)) { clearTimeout(hideTimer); return; }
    const target = event.target.closest?.(selector);
    if (target) show(target, 300);
  });
  document.addEventListener("pointerout", event => {
    if (active?.contains(event.relatedTarget) || tooltip.contains(event.relatedTarget)) return;
    if (active?.contains(event.target) || tooltip.contains(event.target)) hideTimer = setTimeout(hide, 100);
  });
  document.addEventListener("focusin", event => {
    const target = event.target.closest?.(selector);
    if (target) show(target, 0);
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("pointerdown", hide);
  document.addEventListener("keydown", event => { if (event.key === "Escape") hide(); });
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
  window.addEventListener("blur", hide);
}
