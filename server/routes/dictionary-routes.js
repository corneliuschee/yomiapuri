export function registerDictionaryRoutes(app, ctx) {
  const { upload } = ctx;
  const handlers = createDictionaryHandlers(ctx);
  app.post("/api/dictionaries", upload.array("dictionary", 20), handlers.postDictionaries);
  app.get("/api/dictionaries", handlers.getDictionaries);
  app.patch("/api/dictionaries/:id/settings", handlers.patchDictionariesByIdSettings);
  app.delete("/api/dictionaries/:id", handlers.deleteDictionariesById);
  app.patch("/api/dictionaries/settings", handlers.patchDictionariesSettings);
  app.get("/api/dictionary/lookup", handlers.getDictionaryLookup);
  app.get("/api/dictionary", handlers.getDictionary);
}

function createDictionaryHandlers(ctx) {
  const { services, persistence, cache, helpers } = ctx;
  const { dictionaryService, ankiService } = services;
  const { saveDictionariesState } = persistence;
  const {
    clearDocumentCache,
    invalidateWordBankMeaningCache,
    invalidateReadabilityContext,
    markMlIndexStale
  } = cache;
  const {
    lookupDictionaryForms,
    readabilityForLookupTerm,
    normalizeJapaneseTerm,
    logLearningEvent
  } = helpers;

  async function firstExistingAnkiNoteId(noteIds = []) {
    for (const noteId of noteIds.map(Number).filter(Number.isFinite)) {
      if (await ankiService.hasNote(noteId)) return noteId;
    }
    return null;
  }

  return {
    async postDictionaries(req, res, next) {
      try {
        const files = req.files ?? [];
        if (files.length === 0) return res.status(400).json({ error: "No dictionary uploaded." });

        clearDocumentCache();
        invalidateWordBankMeaningCache();
        invalidateReadabilityContext();
        const displayName = files.length === 1 ? req.body.name ?? "" : "";
        const imports = [];
        for (const file of files) {
          imports.push(await dictionaryService.importDictionary(file, displayName));
        }
        markMlIndexStale("Dictionary imports changed lookup metadata.");
        await saveDictionariesState();
        res.status(201).json({
          dictionary: imports[0]?.dictionary ?? null,
          dictionaries: imports.map((item) => item.dictionary),
          validations: imports.map((item) => item.validation)
        });
      } catch (error) {
        next(error);
      }
    },

    getDictionaries(req, res) {
      const state = ctx.getState();
      res.json({ dictionaries: dictionaryService.listMetadata(), settings: state.dictionarySettings });
    },

    async patchDictionariesByIdSettings(req, res, next) {
      try {
        const state = ctx.getState();
        const patch = req.body ?? {};
        const dictionary = await dictionaryService.updateSettings(req.params.id, req.body ?? {});
        const selectedOnly = Object.keys(patch).every((key) => key === "selectedForWordBank");
        if (!selectedOnly) {
          markMlIndexStale("Dictionary settings changed lookup metadata.");
          invalidateReadabilityContext();
          clearDocumentCache();
        }
        await saveDictionariesState();
        res.json({ dictionary, dictionaries: dictionaryService.listMetadata(), settings: state.dictionarySettings });
      } catch (error) {
        next(error);
      }
    },

    async deleteDictionariesById(req, res, next) {
      try {
        const state = ctx.getState();
        const dictionary = await dictionaryService.deleteDictionary(req.params.id);
        invalidateWordBankMeaningCache(req.params.id);
        markMlIndexStale("Dictionary was deleted.");
        invalidateReadabilityContext();
        await saveDictionariesState();
        clearDocumentCache();
        res.json({ dictionary, dictionaries: dictionaryService.listMetadata(), settings: state.dictionarySettings });
      } catch (error) {
        next(error);
      }
    },

    async patchDictionariesSettings(req, res, next) {
      try {
        const settings = await dictionaryService.updateLookupSettings(req.body ?? {});
        markMlIndexStale("Dictionary lookup settings changed.");
        invalidateReadabilityContext();
        await saveDictionariesState();
        res.json({ settings });
      } catch (error) {
        next(error);
      }
    },

    async getDictionaryLookup(req, res, next) {
      try {
        const term = String(req.query.term ?? "");
        const result = await lookupDictionaryForms(term, { prefix: req.query.prefix === "true" });
        result.readability = await readabilityForLookupTerm(term, result);
        if (req.query.checkAnki === "true" && result.knownTerm?.ankiNoteIds?.length) {
          try {
            const liveNoteId = await firstExistingAnkiNoteId(result.knownTerm.ankiNoteIds);
            result.knownTerm.hasAnkiNote = Boolean(liveNoteId);
            if (liveNoteId) result.knownTerm.ankiNoteIds = [liveNoteId, ...result.knownTerm.ankiNoteIds.filter((id) => Number(id) !== liveNoteId)];
          } catch {
            result.knownTerm.hasAnkiNote = true;
          }
        }
        logLearningEvent("lookup.performed", {
          term: normalizeJapaneseTerm(term),
          matched: (result.entries?.length ?? 0) > 0,
          entries: result.entries?.length ?? 0,
          frequencies: result.frequencies?.length ?? 0
        });
        invalidateReadabilityContext();
        res.json(result);
      } catch (error) {
        next(error);
      }
    },

    async getDictionary(req, res, next) {
      try {
        const result = await lookupDictionaryForms(String(req.query.term ?? ""));
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  };
}
