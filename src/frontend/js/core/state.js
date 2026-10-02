// Shared application state and lookup-cache invalidation.


const state = {
  documents: [],
  dictionaries: [],
  dictionarySettings: { prefixWildcardSearch: false },
  reader: { hideInferredReadableFurigana: false },
  media: { image: { enabled: false, provider: "local-mnemonic" } },
  mediaProviders: { status: null },
  ai: { translation: { enabled: true, modelId: "sugoi-14b-ultra-q4-k-m" }, models: [] },
  aiProviders: { status: null, models: [] },
  sync: { enabled: false, configured: false, signedIn: false, status: "disabled" },
  cards: [],
  progress: {},
  trash: { documents: [], knownTerms: [] },
  anki: null,
  ankiModelFields: [],
  activeCardPreview: null,
  activeCardCandidate: null,
  activeCandidateNode: null,
  knownTermsCount: 0,
  activeDocumentId: null,
  activeDocumentTitle: "",
  activeHtml: "",
  activePages: [""],
  activeChapters: [],
  activeChapterId: "",
  highlightColor: "#f6c453",
  highlightMode: "select",
  highlights: { pages: {}, scrollHtml: "" },
  bookmarks: [],
  highlightUndo: [],
  highlightRedo: [],
  readerMode: "scroll",
  readerSideTab: "chapters",
  readerSearchQuery: "",
  readerSearchResults: [],
  readerZoom: 100,
  libraryZoom: 140,
  libraryQuery: "",
  dictionaryLookupCache: new Map(),
  selectedTrashDocuments: new Set(),
  currentPage: 0,
  voices: [],
};

function clearLookupRelatedCaches() {
  state.dictionaryLookupCache.clear();
}

export { clearLookupRelatedCaches, state };
