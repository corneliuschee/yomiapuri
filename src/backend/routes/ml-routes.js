export function registerMlRoutes(app, ctx) {
  const handlers = createMlHandlers(ctx);
  app.get("/api/ml/analytics", handlers.getMlAnalytics);
  app.get("/api/ml/index/status", handlers.getMlIndexStatus);
  app.post("/api/search/index/refresh", handlers.postSearchIndexRefresh);
  app.post("/api/search/fts", handlers.postSearchFts);
}

function createMlHandlers(ctx) {
  const { services, persistence, cache, helpers } = ctx;
  const { mlService, ftsSearchService } = services;
  const { saveSettingsState } = persistence;
  const { markMlIndexFresh } = cache;
  const { logLearningEvent } = helpers;

  return {
    async getMlAnalytics(req, res, next) {
      try {
        res.json(await mlService.analytics());
      } catch (error) {
        next(error);
      }
    },

    async getMlIndexStatus(req, res, next) {
      try {
        res.json(await mlService.status());
      } catch (error) {
        next(error);
      }
    },

    async postSearchIndexRefresh(req, res, next) {
      try {
        const state = ctx.getState();
        const shouldSaveFreshState = Boolean(state.ml?.indexStale || state.ml?.indexStaleReason);
        const result = await mlService.refreshTextIndex();
        markMlIndexFresh();
        if (shouldSaveFreshState) await saveSettingsState(["ml"]);
        logLearningEvent("search.index-refreshed", {
          chunks: result.textSearch?.chunks ?? result.chunks ?? 0,
          inserted: result.textSearch?.inserted ?? result.inserted ?? 0,
          updated: result.textSearch?.updated ?? result.updated ?? 0,
          deleted: result.textSearch?.deleted ?? result.deleted ?? 0
        });
        res.json(await mlService.status());
      } catch (error) {
        if (error.code === "INDEX_BUSY") return res.status(409).json({ error: error.message });
        next(error);
      }
    },

    async postSearchFts(req, res, next) {
      try {
        const result = await ftsSearchService.search(req.body.query, {
          limit: req.body.limit,
          documentId: req.body.documentId ? String(req.body.documentId) : ""
        });
        logLearningEvent("search.fts", {
          query: req.body.query,
          results: result.results.length
        });
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  };
}
