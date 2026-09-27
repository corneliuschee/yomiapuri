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
- `styles.css`: ordered imports for the files in `styles/`.
- `vendor/pdfjs/`: third-party browser PDF renderer and its license.

## Editing Guidelines

Keep feature functions and their event handlers together. Export the functions other modules need, and register listeners through the feature's `bind...Events()` function in `app.js`.

`core/state.js` owns the single shared application state object. Request IDs, timers, and temporary interaction state stay in their feature modules. Use exported actions when another feature needs to reset private state.

Some reader modules call one another through imported functions. Keep these calls inside functions and initialize features from `app.js`; avoid reading another feature's state or registering listeners while a module is being imported.

The order of imports in `styles.css` preserves the existing cascade. Keep responsive overrides last, and check both desktop and narrow layouts when changing that order.
