export function registerSyncRoutes(app, ctx) {
  const { handlers, upload } = ctx;
  app.get("/api/sync/status", handlers.getSyncStatus);
  app.post("/api/sync/settings", handlers.postSyncSettings);
  app.post("/api/sync/sign-in", handlers.postSyncSignIn);
  app.post("/api/sync/sign-out", handlers.postSyncSignOut);
  app.post("/api/sync/push", handlers.postSyncPush);
  app.post("/api/sync/pull", handlers.postSyncPull);
  app.post("/api/sync/run", handlers.postSyncRun);
  app.post("/api/sync/cleanup-deleted", handlers.postSyncCleanupDeleted);
}
