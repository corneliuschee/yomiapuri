export function registerStateRoutes(app, ctx) {
  const { handlers, upload } = ctx;
  app.get("/api/state", handlers.getState);
  app.get("/api/cache/wordbank-meanings/status", handlers.getCacheWordbankMeaningsStatus);
  app.post("/api/cache/wordbank-meanings/rebuild", handlers.postCacheWordbankMeaningsRebuild);
  app.patch("/api/reader/settings", handlers.updateReaderSettings);
  app.post("/api/reader/settings", handlers.updateReaderSettings);
  app.post("/api/reader/readable-suggestion/dismiss", handlers.postReaderReadableSuggestionDismiss);
}
