export function registerIntegrationRoutes(app, ctx) {
  const { handlers, upload } = ctx;
  app.post("/api/templates", upload.single("template"), handlers.postTemplates);
  app.post("/api/anki/settings", handlers.postAnkiSettings);
  app.get("/api/media/providers", handlers.getMediaProviders);
  app.post("/api/media/settings", handlers.postMediaSettings);
  app.post("/api/media/voice-models", handlers.postMediaVoiceModels);
  app.get("/api/ai/providers", handlers.getAiProviders);
  app.get("/api/ai/runtime", handlers.getAiRuntime);
  app.post("/api/ai/runtime/stop", handlers.postAiRuntimeStop);
  app.post("/api/ai/settings", handlers.postAiSettings);
  app.post("/api/ai/models", handlers.postAiModels);
  app.post("/api/ai/test-translation", handlers.postAiTestTranslation);
  app.post("/api/media/test-audio", handlers.postMediaTestAudio);
  app.post("/api/media/test-image", handlers.postMediaTestImage);
  app.get("/api/anki/connect", handlers.getAnkiConnect);
  app.get("/api/anki/model-fields", handlers.getAnkiModelFields);
  app.post("/api/anki/import", handlers.postAnkiImport);
  app.post("/api/anki/card-preview", handlers.postAnkiCardPreview);
  app.post("/api/anki/open-known-term", handlers.postAnkiOpenKnownTerm);
}
