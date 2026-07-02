export function registerWordBankRoutes(app, ctx) {
  const { upload } = ctx;
  const handlers = createWordBankHandlers(ctx);
  app.get("/api/known-terms", handlers.getKnownTerms);
  app.post("/api/known-terms", upload.single("terms"), handlers.postKnownTerms);
  app.delete("/api/known-terms", handlers.deleteKnownTerms);
  app.post("/api/known-terms/sync-anki", handlers.postKnownTermsSyncAnki);
  app.post("/api/trash/known-terms/restore", handlers.postTrashKnownTermsRestore);
  app.delete("/api/trash/known-terms", handlers.deleteTrashKnownTerms);
}

function createWordBankHandlers(ctx) {
  const { services, persistence, cache, helpers } = ctx;
  const { ankiService } = services;
  const {
    saveKnownTermsAddedState,
    saveKnownTermsDeletedState,
    saveKnownTermsState
  } = persistence;
  const {
    clearDocumentCache,
    hideKnownTermsInDocumentResponseCache,
    invalidateReadabilityContext,
    invalidateWordBankMeaningCache,
    markMlIndexStale
  } = cache;
  const {
    normalizeJapaneseTerm,
    parseKnownTerms,
    mergeKnownTerms,
    sortKnownTerms,
    lookupCachedWordBankMeanings,
    moveKnownTermsToTrash,
    trashTermValue,
    trashTermMeta,
    logLearningEvent
  } = helpers;

  return {
    getKnownTerms(req, res) {
      const state = ctx.getState();
      const query = normalizeJapaneseTerm(String(req.query.q ?? "")).toLowerCase();
      const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const sort = String(req.query.sort ?? "gojuon");
      const dictionaryId = String(req.query.dictionaryId ?? "");
      const filtered = state.knownTerms.filter((term) => !query || term.toLowerCase().includes(query));
      const pageTerms = sortKnownTerms(filtered, sort)
        .slice(offset, offset + limit)
        .slice(0, limit);
      const entriesByTerm = lookupCachedWordBankMeanings(pageTerms, dictionaryId);
      const terms = pageTerms
        .map((term) => ({ term, dictionaryEntries: entriesByTerm.get(normalizeJapaneseTerm(term)) ?? [] }));

      res.json({ total: filtered.length, allTotal: state.knownTerms.length, offset, limit, sort, terms });
    },

    async postKnownTerms(req, res) {
      const state = ctx.getState();
      const incoming = req.file
        ? parseKnownTerms(req.file.buffer)
        : [
            ...(Array.isArray(req.body.terms) ? req.body.terms : []),
            req.body.term
          ].map(normalizeJapaneseTerm).filter(Boolean);
      if (incoming.length === 0) return res.status(400).json({ error: "No vocabulary provided." });
      const added = mergeKnownTerms(incoming);
      hideKnownTermsInDocumentResponseCache(added);
      invalidateReadabilityContext();
      if (added.length > 0) markMlIndexStale("Word Bank changed known-term coverage.");
      await saveKnownTermsAddedState(added);
      const source = req.file ? "import" : String(req.body?.source ?? "manual");
      for (const term of added) {
        logLearningEvent("wordbank.added", { term, source });
        if (source === "readable-suggestion") {
          logLearningEvent("reader.readable-suggestion-added", {
            term,
            documentId: String(req.body?.documentId ?? "")
          });
        }
      }
      res.json({ imported: incoming.length, added: added.length, total: state.knownTerms.length });
    },

    async deleteKnownTerms(req, res) {
      const state = ctx.getState();
      const body = req.body ?? {};
      const normalizedTerms = state.knownTerms.map(normalizeJapaneseTerm).filter(Boolean);
      const terms = body.all === true
        ? normalizedTerms
        : Array.isArray(body.terms) ? body.terms.map(normalizeJapaneseTerm).filter(Boolean) : [];
      if (terms.length === 0) return res.status(400).json({ error: "No vocabulary selected." });
      const deletedTerms = moveKnownTermsToTrash(terms);
      const deleted = deletedTerms.length;
      clearDocumentCache();
      invalidateReadabilityContext();
      if (deleted > 0) markMlIndexStale("Word Bank changed known-term coverage.");
      await saveKnownTermsDeletedState(deletedTerms);
      for (const term of deletedTerms) logLearningEvent("wordbank.deleted", { term });
      res.json({ deleted, total: state.knownTerms.length });
    },

    async postKnownTermsSyncAnki(req, res, next) {
      try {
        const state = ctx.getState();
        const normalizedTerms = state.knownTerms.map(normalizeJapaneseTerm).filter(Boolean);
        const noteIdsByTerm = new Map();
        const allNoteIds = [];
        for (const term of normalizedTerms) {
          const noteIds = [...new Set((state.knownTermMeta?.[term]?.ankiNoteIds ?? []).map(Number).filter(Number.isFinite))];
          if (noteIds.length === 0) continue;
          noteIdsByTerm.set(term, noteIds);
          allNoteIds.push(...noteIds);
        }

        if (allNoteIds.length === 0) {
          return res.json({ checked: 0, removed: 0, total: state.knownTerms.length });
        }

        const existingNoteIds = new Set(await ankiService.existingNoteIds(allNoteIds));
        const removedTerms = [];
        for (const [term, noteIds] of noteIdsByTerm.entries()) {
          if (noteIds.some((noteId) => existingNoteIds.has(noteId))) continue;
          removedTerms.push(term);
        }

        if (removedTerms.length > 0) {
          moveKnownTermsToTrash(removedTerms, "anki-sync");
          clearDocumentCache();
          invalidateReadabilityContext();
          markMlIndexStale("Anki sync removed Word Bank terms.");
          await saveKnownTermsState();
        }
        logLearningEvent("wordbank.synced-anki", { checked: noteIdsByTerm.size, removed: removedTerms.length });

        res.json({
          checked: noteIdsByTerm.size,
          removed: removedTerms.length,
          terms: removedTerms,
          total: state.knownTerms.length
        });
      } catch (error) {
        next(error);
      }
    },

    async postTrashKnownTermsRestore(req, res) {
      const state = ctx.getState();
      const terms = Array.isArray(req.body.terms) ? req.body.terms.map(normalizeJapaneseTerm).filter(Boolean) : [];
      if (terms.length === 0) return res.status(400).json({ error: "No vocabulary selected." });
      const selected = new Set(terms);
      const activeTerms = new Set(state.knownTerms.map(normalizeJapaneseTerm).filter(Boolean));
      const restoredTerms = [];
      const remainingTrash = [];

      for (const entry of state.trash.knownTerms) {
        const term = trashTermValue(entry);
        if (!term || !selected.has(term)) {
          remainingTrash.push(entry);
          continue;
        }
        if (!activeTerms.has(term)) {
          state.knownTerms.push(term);
          state.knownTermMeta[term] = trashTermMeta(entry);
          activeTerms.add(term);
          restoredTerms.push(term);
        }
      }

      state.trash.knownTerms = remainingTrash;
      if (restoredTerms.length > 0) invalidateWordBankMeaningCache();
      clearDocumentCache();
      invalidateReadabilityContext();
      if (restoredTerms.length > 0) markMlIndexStale("Word Bank changed known-term coverage.");
      await saveKnownTermsState();
      for (const term of restoredTerms) logLearningEvent("wordbank.restored", { term });
      res.json({ restored: restoredTerms.length, total: state.knownTerms.length });
    },

    async deleteTrashKnownTerms(req, res) {
      const state = ctx.getState();
      const body = req.body ?? {};
      const selected = body.all === true
        ? new Set(state.trash.knownTerms.map((entry) => trashTermValue(entry)).filter(Boolean))
        : new Set(Array.isArray(body.terms) ? body.terms.map(normalizeJapaneseTerm).filter(Boolean) : []);
      if (selected.size === 0) return res.status(400).json({ error: "No deleted vocabulary selected." });
      const before = state.trash.knownTerms.length;
      state.trash.knownTerms = state.trash.knownTerms.filter((entry) => {
        const term = trashTermValue(entry);
        return !term || !selected.has(term);
      });
      const deleted = before - state.trash.knownTerms.length;
      if (deleted > 0) markMlIndexStale("Deleted vocabulary was permanently removed.");
      await saveKnownTermsState();
      res.json({ deleted, total: state.trash.knownTerms.length });
    }
  };
}
