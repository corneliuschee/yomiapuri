export function registerDictionaryRoutes(app, ctx) {
  const { handlers, upload } = ctx;
  app.post("/api/dictionaries", upload.array("dictionary", 20), handlers.postDictionaries);
  app.get("/api/dictionaries", handlers.getDictionaries);
  app.patch("/api/dictionaries/:id/settings", handlers.patchDictionariesByIdSettings);
  app.delete("/api/dictionaries/:id", handlers.deleteDictionariesById);
  app.patch("/api/dictionaries/settings", handlers.patchDictionariesSettings);
  app.get("/api/dictionary/lookup", handlers.getDictionaryLookup);
  app.get("/api/dictionary", handlers.getDictionary);
}
