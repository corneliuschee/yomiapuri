export function registerMlRoutes(app, ctx) {
  const { handlers, upload } = ctx;
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
