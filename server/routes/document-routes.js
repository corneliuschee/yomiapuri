export function registerDocumentRoutes(app, ctx) {
  const { handlers, upload } = ctx;
  app.post("/api/documents", upload.single("book"), handlers.postDocuments);
  app.post("/api/documents/reorder", handlers.postDocumentsReorder);
  app.get("/api/documents/:id/ingest-stream", handlers.getDocumentsByIdIngestStream);
  app.get("/api/documents/:id/pages", handlers.getDocumentsByIdPages);
  app.get("/api/documents/:id", handlers.getDocumentsById);
  app.patch("/api/documents/:id", handlers.patchDocumentsById);
  app.delete("/api/documents/:id", handlers.deleteDocumentsById);
  app.post("/api/trash/documents/:id/restore", handlers.postTrashDocumentsByIdRestore);
  app.delete("/api/trash/documents/:id", handlers.deleteTrashDocumentsById);
  app.delete("/api/trash/documents", handlers.deleteTrashDocuments);
  app.post("/api/documents/:id/progress", handlers.postDocumentsByIdProgress);
}
