export function registerCardRoutes(app, ctx) {
  const { handlers, upload } = ctx;
  app.post("/api/cards", handlers.postCards);
  app.post("/api/anki/export-card", handlers.postAnkiExportCard);
  app.get("/api/cards/export", handlers.getCardsExport);
}
