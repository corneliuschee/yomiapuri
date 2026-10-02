// Brief, optional entrance fades. Layout, focus, and application actions stay synchronous.
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const active = new Map();

function finishMotion(root = document) {
  if (!root) return;
  for (const [element, tween] of active) {
    if (element === root || root.contains(element)) {
      tween.revert();
      active.delete(element);
    }
  }
}

function reveal(targets, { stagger = 0 } = {}) {
  const elements = targets instanceof Element ? [targets] : Array.from(targets ?? []);
  for (const element of elements) finishMotion(element);
  if (!window.gsap || reducedMotion.matches || document.hidden) return;

  // Bound work for large libraries; content is visible even before GSAP runs.
  const visible = elements.filter((element) => element.isConnected && element.getClientRects().length).slice(0, 12);
  visible.forEach((element, index) => {
    const tween = window.gsap.fromTo(element, { opacity: 0.5 }, {
      opacity: 1,
      duration: 0.18,
      delay: Math.min(index * stagger, 0.09),
      ease: "power1.out",
      onComplete: () => {
        tween.revert();
        active.delete(element);
      }
    });
    active.set(element, tween);
  });
}

reducedMotion.addEventListener("change", () => finishMotion());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) finishMotion();
});
window.addEventListener("pagehide", () => finishMotion());

export { finishMotion, reveal };
