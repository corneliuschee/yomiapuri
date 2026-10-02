// Regression checks for ruby gaps without requiring a browser installation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/frontend/js/reader/highlights.js", import.meta.url), "utf8");
const implementation = source.slice(source.indexOf("function paintHighlightBands("), source.indexOf("function normalizeHighlights("));
const reader = {
  style: {}, scrollLeft: 0, scrollTop: 0,
  getBoundingClientRect: () => ({ left: 0, top: 0 }),
  querySelectorAll: () => []
};
const context = vm.createContext({ elements: { reader } });
vm.runInContext(implementation, context);
const rect = (left, right, run = 1, top = 20, bottom = 44) => ({ left, right, run, top, bottom, color: "gold" });
const paint = (rects) => context.paintHighlightBands(rects);

// Real reader ruby padding and margins exceed the old two-pixel join limit.
paint([rect(0, 20), rect(23, 43, 1, 18, 45), rect(46, 90)]);
assert.equal(reader.style.backgroundSize, "90px 24px");
assert.equal(reader.style.backgroundPosition, "0px 20px");

// Never bridge unselected text or connect separate wrapped lines.
paint([rect(0, 20), rect(23, 43, 2), rect(0, 30, 1, 70, 94)]);
assert.equal(reader.style.backgroundSize.split(",").length, 3);

// Keep the band below the reading even when font boxes overlap slightly.
reader.querySelectorAll = () => [{ getBoundingClientRect: () => ({ left: 0, right: 20, bottom: 22 }) }];
paint([rect(0, 20)]);
assert.equal(reader.style.backgroundPosition, "0px 22px");
assert.equal(reader.style.backgroundSize, "20px 22px");
paint([]);
assert.equal(reader.style.backgroundImage, "none");
console.log("Highlight layout regression checks passed.");
