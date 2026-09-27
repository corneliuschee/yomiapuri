// PDF document caching, canvas rendering, text layers, covers, and links.
import { elements } from "../core/dom.js";
import { jumpToPage } from "./navigation.js";

const pdfDocuments = new Map();

async function getPdfDocument(src) {
  if (!window.PDFJS || !src) return null;
  if (!pdfDocuments.has(src)) {
    const task = window.PDFJS.getDocument(src);
    pdfDocuments.set(src, task.promise ?? task);
  }
  return pdfDocuments.get(src);
}

async function renderPdfPages(container) {
  const pages = [...container.querySelectorAll(".pdf-page-render:not([data-rendered='true'])")];
  for (const node of pages) {
    if (node.dataset.rendering === "true") continue;
    node.dataset.rendering = "true";
    try {
      const src = node.dataset.pdfSrc;
      const pageNumber = Number(node.dataset.pdfPage) || 1;
      const pdf = await getPdfDocument(src);
      if (!pdf) throw new Error("PDF renderer unavailable.");

      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport(1);
      const width = Math.max(320, Math.min(1100, elements.reader.clientWidth - 48));
      const displayScale = Math.max(1, width / baseViewport.width);
      const renderScale = displayScale * Math.min(window.devicePixelRatio || 1, 2);
      const displayViewport = page.getViewport(displayScale);
      const renderViewport = page.getViewport(renderScale);
      const canvas = node.querySelector(".pdf-canvas");
      const context = canvas.getContext("2d", { alpha: false });
      canvas.width = Math.floor(renderViewport.width);
      canvas.height = Math.floor(renderViewport.height);
      canvas.style.aspectRatio = `${displayViewport.width} / ${displayViewport.height}`;
      node.querySelector(".pdf-canvas-wrap").style.aspectRatio = `${displayViewport.width} / ${displayViewport.height}`;
      await page.render({ canvasContext: context, viewport: renderViewport }).promise;
      await renderPdfLinks(pdf, page, displayViewport, node);
      await renderPdfTextLayer(page, displayViewport, node);
      node.dataset.rendered = "true";
    } catch (error) {
      node.classList.add("pdf-render-error");
      node.insertAdjacentHTML("beforeend", `<p class="empty">Could not render this PDF page.</p>`);
      console.error(error);
    } finally {
      node.dataset.rendering = "false";
    }
  }
}

async function renderPdfTextLayer(page, viewport, node) {
  const layer = node.querySelector(".pdf-text-layer");
  if (!layer || layer.dataset.textRendered === "true") return;
  const textContent = await page.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false
  });
  const baseViewport = page.getViewport(1);
  layer.innerHTML = "";
  for (const item of textContent.items ?? []) {
    if (!item.str?.trim()) continue;
    const transform = window.PDFJS.Util.transform(viewport.transform, item.transform);
    const span = document.createElement("span");
    span.textContent = item.str;
    span.style.left = `${(transform[4] / viewport.width) * 100}%`;
    span.style.top = `${(transform[5] / viewport.height) * 100}%`;
    span.style.fontSize = `${Math.max(1, Math.hypot(transform[2], transform[3]))}px`;
    span.style.transform = "translateY(-100%)";
    span.style.width = `${Math.max(8, (((item.width || item.str.length * 5) / baseViewport.width) * 100))}%`;
    layer.append(span);
  }
  layer.dataset.textRendered = "true";
}

async function renderPdfCovers(container) {
  const covers = [...container.querySelectorAll(".pdf-cover-render:not([data-rendered='true'])")];
  for (const cover of covers) {
    try {
      const pdf = await getPdfDocument(cover.dataset.pdfSrc);
      if (!pdf) return;
      const page = await pdf.getPage(1);
      const canvas = cover.querySelector("canvas");
      const baseViewport = page.getViewport(1);
      const scale = Math.max(0.6, cover.clientWidth / baseViewport.width) * Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport(scale);
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport }).promise;
      cover.dataset.rendered = "true";
    } catch (error) {
      cover.classList.add("pdf-cover-error");
      console.error(error);
    }
  }
}

async function renderPdfLinks(pdf, page, viewport, node) {
  const layer = node.querySelector(".pdf-link-layer");
  if (!layer) return;
  layer.innerHTML = "";
  const annotations = await page.getAnnotations();
  for (const annotation of annotations.filter((item) => item.subtype === "Link" && item.rect)) {
    const rect = viewport.convertToViewportRectangle(annotation.rect);
    const left = Math.min(rect[0], rect[2]);
    const top = Math.min(rect[1], rect[3]);
    const width = Math.abs(rect[0] - rect[2]);
    const height = Math.abs(rect[1] - rect[3]);
    const link = document.createElement("a");
    link.className = "pdf-link";
    link.href = annotation.url || "#";
    link.title = annotation.url || "Jump";
    link.style.left = `${(left / viewport.width) * 100}%`;
    link.style.top = `${(top / viewport.height) * 100}%`;
    link.style.width = `${(width / viewport.width) * 100}%`;
    link.style.height = `${(height / viewport.height) * 100}%`;
    if (annotation.url) {
      link.target = "_blank";
      link.rel = "noreferrer";
    } else if (annotation.dest) {
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        const pageIndex = await resolvePdfDestinationPage(pdf, annotation.dest);
        if (Number.isInteger(pageIndex)) jumpToPage(pageIndex + 1);
      });
    }
    layer.append(link);
  }
}

async function resolvePdfDestinationPage(pdf, destination) {
  const explicitDestination = Array.isArray(destination) ? destination : await pdf.getDestination(destination);
  const pageRef = explicitDestination?.[0];
  if (!pageRef) return null;
  return pdf.getPageIndex(pageRef);
}

function initPdfRenderer() {
  if (window.PDFJS) {
    window.PDFJS.workerSrc = "/vendor/pdfjs/pdf.worker.js";
  }
}

export { initPdfRenderer, renderPdfCovers, renderPdfPages };
