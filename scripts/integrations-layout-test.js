// Browser regression for file-picker focus escaping the Integrations scroller.
// Set PLAYWRIGHT_MODULE to a local Playwright installation if not on Node's path.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../src/frontend/", import.meta.url));
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const filename = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!filename.startsWith(root)) { response.writeHead(403).end(); return; }
  try {
    let content = await readFile(filename);
    if (filename.endsWith("index.html")) {
      // Use real markup/styles without starting services or touching user data.
      content = content.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
    }
    const type = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" }[path.extname(filename)];
    response.writeHead(200, { "Content-Type": type || "application/octet-stream" }).end(content);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    document.querySelectorAll(".page").forEach(el => el.classList.toggle("active", el.id === "integrations-page"));
    const { bindIntegrationNavigation } = await import("/js/integrations/navigation.js");
    bindIntegrationNavigation();
  });
  assert.equal(await page.locator('#dictionary-form input[name="name"]').count(), 0);
  const geometry = () => page.evaluate(() => ({
    shellTop: document.querySelector(".shell").getBoundingClientRect().top,
    pageTop: document.querySelector("#integrations-page").getBoundingClientRect().top,
    navTop: document.querySelector(".integration-nav").getBoundingClientRect().top,
    outerScroll: document.scrollingElement.scrollTop
  }));
  for (const width of [320, 390, 1365, 2091]) {
    await page.setViewportSize({ width, height: 773 });
    await page.locator('.integration-nav a[href="#integration-dictionary"]').click();
    const before = await geometry();
    const input = page.locator("#dictionary-file");
    await input.focus();
    assert.deepEqual(await geometry(), before, `Picker focus moved the shell at ${width}px`);
    assert.equal(before.outerScroll, 0);
    assert(before.navTop >= 0);
    const bounds = await input.evaluate(el => {
      const input = el.getBoundingClientRect(), button = el.parentElement.getBoundingClientRect();
      return input.top >= button.top && input.bottom <= button.bottom && input.left >= button.left && input.right <= button.right;
    });
    assert(bounds, "Invisible input must stay inside the visible upload button");
    for (const keyboard of [false, true]) {
      const chooserPromise = page.waitForEvent("filechooser");
      if (keyboard) await input.press("Enter");
      else await page.locator("#dictionary-form .file-button").click();
      const chooser = await chooserPromise;
      await chooser.setFiles({ name: "sample.json", mimeType: "application/json", buffer: Buffer.from("[]") });
      assert.deepEqual(await geometry(), before, `Picker return moved the shell at ${width}px`);
      await input.setInputFiles([]);
    }
  }
  console.log("Integration picker focus/layout checks passed (320-2091px).");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
