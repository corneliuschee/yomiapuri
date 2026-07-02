import { EMBEDDING_MODELS, normalizeMlSettings, publicMlSettings } from "../embedding-providers.js";

export function registerMlRoutes(app, ctx) {
  const handlers = createMlHandlers(ctx);
  app.get("/api/ml/analytics", handlers.getMlAnalytics);
  app.get("/api/ml/index/status", handlers.getMlIndexStatus);
  app.get("/api/ml/providers", handlers.getMlProviders);
  app.patch("/api/ml/settings", handlers.updateMlSettings);
  app.post("/api/ml/settings", handlers.updateMlSettings);
  app.post("/api/search/index/refresh", handlers.postSearchIndexRefresh);
  app.post("/api/ml/vectors/update/stream", handlers.postMlVectorsUpdateStream);
  app.post("/api/ml/index/rebuild", handlers.postMlIndexRebuild);
  app.post("/api/search/semantic", handlers.postSearchSemantic);
  app.post("/api/search/fts", handlers.postSearchFts);
  app.post("/api/rag/ask", handlers.postRagAsk);
}

function createMlHandlers(ctx) {
  const { services, persistence, cache, helpers } = ctx;
  const { mlService, ftsSearchService } = services;
  const { saveSettingsState } = persistence;
  const { markMlIndexFresh, markMlIndexStale } = cache;
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

    async getMlProviders(req, res, next) {
      try {
        const state = ctx.getState();
        res.json({
          models: EMBEDDING_MODELS,
          settings: publicMlSettings(state.ml ?? {})
        });
      } catch (error) {
        next(error);
      }
    },

    async updateMlSettings(req, res, next) {
      try {
        const state = ctx.getState();
        const previousMl = normalizeMlSettings(state.ml);
        state.ml = normalizeMlSettings({
          ...state.ml,
          embeddingProviderId: req.body?.embeddingProviderId ?? state.ml?.embeddingProviderId,
          embeddingPythonPath: req.body?.embeddingPythonPath ?? state.ml?.embeddingPythonPath,
          embeddingBatchSize: req.body?.embeddingBatchSize ?? state.ml?.embeddingBatchSize
        });
        if (previousMl.embeddingProviderId !== state.ml.embeddingProviderId) {
          markMlIndexStale("Embedding model changed. Rebuild the local semantic index.");
        } else if (previousMl.embeddingPythonPath !== state.ml.embeddingPythonPath) {
          markMlIndexStale("Embedding Python runtime changed. Rebuild the local semantic index.");
        } else if (previousMl.embeddingBatchSize !== state.ml.embeddingBatchSize) {
          markMlIndexStale("Embedding batch size changed. Rebuild the local semantic index.");
        }
        await saveSettingsState(["ml"]);
        res.json({
          settings: publicMlSettings(state.ml),
          status: await mlService.status()
        });
      } catch (error) {
        next(error);
      }
    },

    async postMlIndexRebuild(req, res, next) {
      try {
        const state = ctx.getState();
        const skipVectors = req.body?.skipVectors === true;
        const shouldSaveFreshState = Boolean(state.ml?.indexStale || state.ml?.indexStaleReason);
        await mlService.rebuildIndex({ skipVectors });
        if (!skipVectors) {
          markMlIndexFresh();
          if (shouldSaveFreshState) await saveSettingsState(["ml"]);
        }
        const result = await mlService.status();
        logLearningEvent("ml.index-rebuilt", { chunks: result.chunks, provider: result.provider, embeddingProvider: result.embeddingProvider });
        res.json(result);
      } catch (error) {
        if (error.code === "INDEX_BUSY") return res.status(409).json({ error: error.message });
        next(error);
      }
    },

    async postSearchIndexRefresh(req, res, next) {
      try {
        const result = await mlService.refreshTextIndex();
        logLearningEvent("search.index-refreshed", { chunks: result.textSearch?.chunks ?? result.fts?.chunks ?? result.chunks });
        res.json(await mlService.status());
      } catch (error) {
        if (error.code === "INDEX_BUSY") return res.status(409).json({ error: error.message });
        next(error);
      }
    },

    async postMlVectorsUpdateStream(req, res) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      try {
        const state = ctx.getState();
        writeSse(res, "progress", { phase: "start", message: "Starting semantic vector update...", current: 0, total: 1 });
        const shouldSaveFreshState = Boolean(state.ml?.indexStale || state.ml?.indexStaleReason);
        await mlService.updateSemanticVectors({
          onProgress: (progress) => writeSse(res, "progress", progress)
        });
        markMlIndexFresh();
        if (shouldSaveFreshState) await saveSettingsState(["ml"]);
        const status = await mlService.status();
        logLearningEvent("ml.vectors-updated", { chunks: status.chunks, provider: status.provider, embeddingProvider: status.embeddingProvider });
        writeSse(res, "done", status);
      } catch (error) {
        writeSse(res, "error", { error: error.message, code: error.code || "" });
      } finally {
        res.end();
      }
    },

    async postSearchSemantic(req, res, next) {
      try {
        const result = await mlService.search(req.body.query, {
          limit: req.body.limit,
          readSafe: req.body.readSafe === true,
          documentId: req.body.documentId ? String(req.body.documentId) : "",
          currentPage: Number.isFinite(Number(req.body.currentPage)) ? Number(req.body.currentPage) : null,
          scope: req.body.scope === "document" ? "document" : "library"
        });
        logLearningEvent("search.semantic", { query: req.body.query, results: result.results.length });
        res.json(result);
      } catch (error) {
        next(error);
      }
    },

    async postSearchFts(req, res, next) {
      try {
        const result = await ftsSearchService.search(req.body.query, {
          limit: req.body.limit,
          documentId: req.body.documentId ? String(req.body.documentId) : ""
        });
        logLearningEvent("search.fts", { query: req.body.query, results: result.results.length });
        res.json(result);
      } catch (error) {
        next(error);
      }
    },

    async postRagAsk(req, res, next) {
      try {
        const result = await mlService.ragAnswer(req.body.question, {
          readSafe: req.body.readSafe !== false,
          documentId: req.body.documentId ? String(req.body.documentId) : "",
          currentPage: Number.isFinite(Number(req.body.currentPage)) ? Number(req.body.currentPage) : null
        });
        logLearningEvent("rag.asked", { question: req.body.question, citations: result.citations.length });
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  };
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
