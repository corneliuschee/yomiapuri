export function registerWordBankRoutes(app, ctx) {
  const { handlers, upload } = ctx;
  app.get("/api/known-terms", handlers.getKnownTerms);
  app.post("/api/known-terms", upload.single("terms"), handlers.postKnownTerms);
  app.delete("/api/known-terms", handlers.deleteKnownTerms);
  app.post("/api/known-terms/sync-anki", handlers.postKnownTermsSyncAnki);
  app.post("/api/trash/known-terms/restore", handlers.postTrashKnownTermsRestore);
  app.delete("/api/trash/known-terms", handlers.deleteTrashKnownTerms);
}
