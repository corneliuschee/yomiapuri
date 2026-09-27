// Text escaping, formatting, select options, and book cover markup.


function normalizeTermForUi(value = "") {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, "").trim();
}

function formatDateTime(value = "") {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function transparentColor(hex) {
  const value = String(hex || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return "rgba(246, 196, 83, 0.36)";
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, 0.36)`;
}

function populateSelect(select, values, selectedValue, fallback) {
  select.innerHTML = `<option value="">${fallback}</option>`;
  for (const value of values ?? []) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = value === selectedValue;
    select.append(option);
  }
}

function escapeHtml(value = "") {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function coverMarkup(item, className) {
  if (item.type === "pdf" && item.sourcePath) {
    return `<span class="${className} pdf-cover-render" data-pdf-src="${escapeHtml(item.sourcePath)}"><canvas aria-label=""></canvas></span>`;
  }
  if (item.coverPath) {
    return `<span class="${className}"><img src="${escapeHtml(item.coverPath)}" alt="" loading="lazy" draggable="false" /></span>`;
  }
  const initials = (item.title || item.filename || "?").trim().slice(0, 2).toUpperCase();
  return `<span class="${className} cover-fallback">${escapeHtml(initials)}</span>`;
}

function escapeCssIdent(value = "") {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function cssEscape(value = "") {
  return window.CSS?.escape ? window.CSS.escape(String(value)) : escapeCssIdent(value);
}

export {
  coverMarkup,
  cssEscape,
  escapeHtml,
  formatDateTime,
  normalizeTermForUi,
  populateSelect,
  transparentColor,
};
