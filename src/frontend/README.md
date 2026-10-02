# Frontend

The frontend uses native JavaScript modules and CSS. FastAPI serves this directory directly; no bundler or build step is required.

## File Map

- `index.html`: page shell, forms, reader controls, and dialogs.
- `app.js`: initializes PDF rendering, registers feature events once, then loads application data.
- `js/core/`: shared state, DOM references, API requests, state refresh, and main-page navigation.
- `js/library/`: book import, library rendering and ordering, and Trash.
- `js/reader/`: document loading, page rendering, PDF support, navigation, sidebars, search, highlights, dictionary lookup, and AI chat.
- `js/anki/`: card preview and export.
- `js/integrations/`: Anki connection and vocabulary sync, dictionaries, AI models, image settings, and Supabase sync.
- `js/shared/`: formatting, notifications, dialogs, tooltips, and browser speech helpers.
- `js/shared/motion.js`: optional GSAP entrance fades with bounded work, reduced-motion support, and cleanup on navigation/hiding.
- `js/shared/tooltips.js`: delegated, keyboard-accessible tooltips for labelled controls and help text, kept inside the viewport.
- `js/library/loading.js`: initial library placeholders and failed-load retry; normal state refreshes retain the existing grid.
- `styles.css`: ordered imports for the files in `styles/`.
- `styles/refinements.css`: tooltip sizing, static loading placeholders, and shared dialog spacing.
- `vendor/pdfjs/`: third-party browser PDF renderer and its license.
- `vendor/gsap/`: pinned local GSAP browser build; regenerate with `npm run vendor:gsap` after installing dependencies.
- `vendor/lucide/`: local copy/send SVG icons and licenses, with no runtime dependency.

## Editing Guidelines

Keep feature functions and their event handlers together. Export the functions other modules need, and register listeners through the feature's `bind...Events()` function in `app.js`.

`core/state.js` owns the single shared application state object. Request IDs, timers, and temporary interaction state stay in their feature modules. Use exported actions when another feature needs to reset private state.

Some reader modules call one another through imported functions. Keep these calls inside functions and initialize features from `app.js`; avoid reading another feature's state or registering listeners while a module is being imported.

The order of imports in `styles.css` preserves the existing cascade. Keep responsive overrides last, and check both desktop and narrow layouts when changing that order.

## Tests

Tests live outside the served frontend directory:

- `python run.py test`: backend/API behavior and retired UI checks, including Word Bank and local TTS removal.
- `node scripts/smoke-test.js`: end-to-end API checks against a disposable local database, including dictionary imports, reader rendering, and persistence.
- `node scripts/highlight-layout-test.js`: lightweight reader highlight geometry checks, including ruby gaps; no browser needed.
- `node scripts/integrations-layout-test.js`: real browser checks for file-picker focus and scrolling at mobile/desktop widths; serves only frontend fixtures and never accesses user data. Requires Playwright and an installed browser. Set `PLAYWRIGHT_MODULE` to an existing Playwright package path if needed, and `PLAYWRIGHT_CHANNEL` to `msedge` or `chrome` to use that installed browser.

Keep layout regressions separate from API checks: successful imports alone cannot detect focus/scrolling bugs. Before deleting a CSS selector, check HTML, JavaScript-generated markup, and backend-generated reader HTML, not just the static page shell.

## Visual Motion

Short opacity fades are applied after elements become visible. They never delay
API calls, focus, dialog dismissal, or reader navigation. Content stays visible
if GSAP fails to load. `finishMotion(root)` restores original inline styles before
elements are hidden/replaced; call it when adding another animated surface.
Motion stops when the tab is hidden or reduced motion changes.

Library covers animate only for newly seen document IDs, up to twelve visible
covers, with a maximum 90 ms stagger delay. Filtering, reorder responses, and
progress refreshes do not replay the entrance. Drag start finishes cover fades.
Hover/focus treatments use fixed geometry so hit testing and drop calculations
remain stable. Reader text, scrolling, and page dimensions are not animated.

`styles/motion.css` owns hover/focus treatment and the active navigation underline.
Keep these enhancements scoped; avoid ongoing animation loops or adding React
for standalone visual effects. Fade timing is inspired by content-reveal patterns
such as React Bits, implemented directly with GSAP in the existing vanilla modules.

The assistant uses plain escaped text, distinct user bubbles, and unboxed replies.
Its input grows to a bounded height; streaming only follows the bottom while the
reader is already near it. Response copying uses the browser clipboard API and
reports failures without changing the reply. No AI prompts or backend API shapes
are changed by this presentation layer.
