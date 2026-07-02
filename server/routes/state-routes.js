export function registerStateRoutes(app, ctx) {
  const handlers = createStateHandlers(ctx);
  app.get("/api/state", handlers.getState);
  app.get("/api/cache/wordbank-meanings/status", handlers.getCacheWordbankMeaningsStatus);
  app.post("/api/cache/wordbank-meanings/rebuild", handlers.postCacheWordbankMeaningsRebuild);
  app.patch("/api/reader/settings", handlers.updateReaderSettings);
  app.post("/api/reader/settings", handlers.updateReaderSettings);
  app.post("/api/reader/readable-suggestion/dismiss", handlers.postReaderReadableSuggestionDismiss);
}

function createStateHandlers(ctx) {
  const { services, persistence, cache, helpers } = ctx;
  const { dictionaryService } = services;
  const { saveSettingsState } = persistence;
  const { clearDocumentCache, invalidateReadabilityContext } = cache;
  const {
    initialState,
    publicMlSettings,
    publicSyncSettings,
    syncDiagnostics,
    selectedWordBankDictionaryId,
    wordBankMeaningCacheStatus,
    rebuildWordBankMeaningCache,
    normalizeJapaneseTerm,
    logLearningEvent
  } = helpers;

  return {
    getState(req, res) {
      const state = ctx.getState();
      const sync = publicSyncSettings(state.sync);
      res.json({
        documents: state.documents.map(({ text, chapters, ...document }) => document),
        knownTermsCount: state.knownTerms.length,
        trash: {
          documents: state.trash.documents.map(({ text, chapters, ...document }) => document),
          knownTerms: state.trash.knownTerms
        },
        dictionaries: dictionaryService.listMetadata(),
        dictionarySettings: state.dictionarySettings,
        reader: state.reader,
        progress: state.progress,
        cards: state.cards,
        anki: state.anki,
        media: state.media,
        ai: state.ai,
        ml: publicMlSettings(state.ml),
        sync: { ...sync, diagnostics: syncDiagnostics() },
        templates: state.templates
      });
    },

    getCacheWordbankMeaningsStatus(req, res) {
      const dictionaryId = String(req.query.dictionaryId ?? "") || selectedWordBankDictionaryId();
      res.json(wordBankMeaningCacheStatus(dictionaryId));
    },

    async postCacheWordbankMeaningsRebuild(req, res, next) {
      try {
        const dictionaryId = String(req.body?.dictionaryId ?? "") || selectedWordBankDictionaryId();
        const result = await rebuildWordBankMeaningCache(dictionaryId);
        res.json(result);
      } catch (error) {
        next(error);
      }
    },

    async updateReaderSettings(req, res) {
      const state = ctx.getState();
      state.reader = {
        ...structuredClone(initialState.reader),
        ...(state.reader ?? {}),
        hideInferredReadableFurigana: Boolean(req.body?.hideInferredReadableFurigana)
      };
      clearDocumentCache();
      invalidateReadabilityContext();
      await saveSettingsState(["reader"]);
      res.json({ reader: state.reader });
    },

    postReaderReadableSuggestionDismiss(req, res) {
      const term = normalizeJapaneseTerm(req.body?.term ?? "");
      if (!term) return res.status(400).json({ error: "No vocabulary selected." });
      logLearningEvent("reader.readable-suggestion-dismissed", {
        term,
        documentId: String(req.body?.documentId ?? "")
      });
      res.json({ dismissed: true, term });
    }
  };
}
