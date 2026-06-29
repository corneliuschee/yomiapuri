export function registerAssistantRoutes(app, ctx) {
  const { handlers, upload } = ctx;
  app.post("/api/reader/assistant", handlers.postReaderAssistant);
  app.post("/api/reader/assistant/stream", handlers.postReaderAssistantStream);
}
