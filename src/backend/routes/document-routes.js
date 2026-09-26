import crypto from "node:crypto";
import path from "node:path";

export function registerDocumentRoutes(app, ctx) {
  const { upload } = ctx;
  const handlers = createDocumentHandlers(ctx);
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

function createDocumentHandlers(ctx) {
  const { persistence, cache, helpers, stores } = ctx;
  const {
    saveDocumentsState,
    saveProgressState,
    saveSettingsState
  } = persistence;
  const {
    clearDocumentCache,
    markMlIndexStale,
    markMlIndexFresh,
    deleteDocumentSearchIndex
  } = cache;
  const { documentResponseCache } = stores;
  const {
    extractDocument,
    repairMojibake,
    decodeUploadName,
    ensureDocumentIngestionCacheSingleFlight,
    documentTokenCacheDir,
    documentPageDescriptors,
    readerPageWindowStart,
    renderDocumentPageWindow,
    documentCacheKey,
    analyzeDocument,
    fallbackChapters,
    renderRubyLines,
    renderRubyLinePages,
    stripChapterTitleFromBlocks,
    blocksToText,
    renderInitialStructuredPages,
    renderStructuredPages,
    authorRubyProtectedTermsFromText,
    isImageOnlyPageHtml,
    wrapReaderPage,
    chapterHeadingHtml,
    yieldToEventLoop,
    renderRuby,
    renderRubyPages,
    frontImagePaths,
    renderImageFigure,
    logLearningEvent
  } = helpers;

  return {
    async postDocuments(req, res, next) {
      try {
        const state = ctx.getState();
        if (!req.file) return res.status(400).json({ error: "No file uploaded." });
        const id = crypto.randomUUID();
        const imported = await extractDocument(req.file, id);
        if (!imported.text) return res.status(422).json({ error: "Could not extract text from this file." });
        const filename = repairMojibake(decodeUploadName(req.file.originalname));
        const type = path.extname(filename).replace(".", "").toLowerCase() || "text";
        const duplicate = state.documents.find((item) =>
          item.filename === filename &&
          item.type === type &&
          item.text?.length === imported.text.length
        );
        if (duplicate) return res.status(409).json({ error: "Duplicate copy", document: { id: duplicate.id, title: duplicate.title } });

        const document = {
          id,
          title: repairMojibake(req.body.title?.trim() || imported.title || path.parse(filename).name),
          author: repairMojibake(imported.author || ""),
          filename,
          type,
          createdAt: new Date().toISOString(),
          coverPath: imported.coverPath ?? "",
          sourcePath: imported.sourcePath ?? "",
          text: imported.text,
          chapters: imported.chapters
        };

        state.documents.unshift(document);
        state.progress[document.id] = { percentage: 0, updatedAt: new Date().toISOString() };
        clearDocumentCache();
        markMlIndexStale("Imported book added new source text.");
        await saveDocumentsState();
        logLearningEvent("document.imported", { documentId: document.id, title: document.title, type: document.type });
        res.status(201).json({ document: { ...document, text: undefined } });
      } catch (error) {
        next(error);
      }
    },

    async postDocumentsReorder(req, res) {
      const state = ctx.getState();
      const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
      if (ids.length === 0) return res.status(400).json({ error: "Document order is required." });
      const order = new Map(ids.map((id, index) => [id, index]));
      state.documents.sort((a, b) => {
        const aOrder = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
        const bOrder = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
        return aOrder - bOrder;
      });
      markMlIndexStale("Book order changed.");
      await saveDocumentsState();
      const documents = state.documents.map(({ text, chapters, ...document }) => document);
      res.json({ documents });
    },

    async getDocumentsByIdIngestStream(req, res) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      try {
        const state = ctx.getState();
        const document = state.documents.find((item) => item.id === req.params.id);
        if (!document) {
          writeSse(res, "error", { error: "Document not found." });
          res.end();
          return;
        }
        const result = await ensureDocumentIngestionCacheSingleFlight(document, {
          force: req.query.force === "1",
          deferFullStale: req.query.force !== "1",
          onProgress: (progress) => writeSse(res, "progress", progress)
        });
        if (result.state === "dictionary-stale" && result.rebuilt) {
          markMlIndexFresh();
          await saveSettingsState(["ml"]);
        }
        writeSse(res, "done", {
          state: result.state,
          rebuilt: result.rebuilt,
          deferred: Boolean(result.deferred),
          reason: result.reason,
          indexStale: Boolean(state.ml?.indexStale)
        });
        res.end();
      } catch (error) {
        writeSse(res, "error", { error: error.message });
        res.end();
      }
    },

    async getDocumentsById(req, res, next) {
      try {
        const state = ctx.getState();
        const initialOnly = req.query.initial === "1";
        const debugTiming = req.query.debug === "1";
        const routeStartedAt = Date.now();
        const logTiming = (label) => {
          if (debugTiming) {
            console.log(`[document-load] ${label}: ${Date.now() - routeStartedAt}ms`);
          }
        };
        const document = state.documents.find((item) => item.id === req.params.id);
        if (!document) return res.status(404).json({ error: "Document not found." });
        const initialPageLimit = 8;
        logTiming("document found");
        if (initialOnly) {
          const { chapters, descriptors } = documentPageDescriptors(document);
          const progress = state.progress[document.id] ?? { percentage: 0 };
          const requestedPage = Number.isFinite(Number(req.query.page)) ? Number(req.query.page) : Number(progress.page);
          const windowStart = readerPageWindowStart(descriptors.length, requestedPage, initialPageLimit);
          const pageWindow = await renderDocumentPageWindow(document, windowStart, initialPageLimit);
          const renderedByIndex = new Map(pageWindow.pages.map((page) => [page.index, page]));
          const pages = descriptors.map((descriptor, index) => {
            const rendered = renderedByIndex.get(index);
            if (rendered) return rendered;
            return {
              chapterId: descriptor.chapterId,
              html: "",
              unloaded: true
            };
          });
          res.json({
            id: document.id,
            filename: document.filename,
            createdAt: document.createdAt,
            coverPath: document.coverPath ?? "",
            author: document.author ?? "",
            sourcePath: document.sourcePath ?? "",
            html: "",
            pages,
            chapters,
            textLength: document.text.length,
            candidates: [],
            readabilitySuggestions: [],
            title: document.title,
            progress
          });
          logTiming(`initial response sent pages=${pageWindow.pages.length}/${pages.length}`);
          return;
        }
        const ingestion = initialOnly
          ? { state: "initial-skip", rebuilt: false, deferred: true, cacheDir: documentTokenCacheDir(document.id) }
          : await ensureDocumentIngestionCacheSingleFlight(document);
        logTiming("ingestion ready");
        const tokenCacheDir = ingestion.cacheDir;
        const useDictionaryAwareRender = !(ingestion.state === "dictionary-stale" && ingestion.deferred);

        const cacheKey = documentCacheKey(document);
        let cached = initialOnly ? null : documentResponseCache.get(cacheKey);

        if (!cached) {
          let analysis;
          const getAnalysis = async () => {
            analysis ??= await analyzeDocument(document);
            return analysis;
          };
          const chapters = fallbackChapters(document);
          logTiming(`chapters ready ${chapters.length}`);
          const hasImageBlocks = chapters.some((chapter) => chapter.blocks?.some((block) => block.type === "image"));
          const hasPageBlocks = chapters.some((chapter) => chapter.blocks?.some((block) => block.type === "page"));
          logTiming(`chapter flags images=${hasImageBlocks} pages=${hasPageBlocks}`);
          let responseChapters;

          if (!hasImageBlocks && !hasPageBlocks && chapters.length <= 1 && document.text.length <= 20000) {
            analysis = await getAnalysis();
            responseChapters = [{ id: chapters[0]?.id ?? "chapter-1", title: chapters[0]?.title ?? "Document", html: renderRubyLines(analysis.tokens), pages: renderRubyLinePages(analysis.tokens) }];
          } else {
            const renderedChapters = [];
            let renderedPageCount = 0;
            for (const [index, chapter] of chapters.entries()) {
              const chapterTitle = chapter.title || `Chapter ${index + 1}`;
              logTiming(`chapter ${index + 1} start`);
              const renderBlocks = stripChapterTitleFromBlocks(chapter.blocks ?? [], chapterTitle);
              logTiming(`chapter ${index + 1} stripped blocks=${renderBlocks.length}`);
              const chapterText = blocksToText(renderBlocks);
              const rawPages = initialOnly
                ? renderInitialStructuredPages(renderBlocks, 850, Math.max(1, initialPageLimit - renderedPageCount))
                : await renderStructuredPages(renderBlocks, 850, {
                    cacheDir: tokenCacheDir,
                    authorRubyProtectedTerms: authorRubyProtectedTermsFromText(chapterText),
                    dictionaryAware: useDictionaryAwareRender
                  });
              logTiming(`chapter ${index + 1} raw pages=${rawPages.length}`);
              let headingPlaced = false;
              const pages = rawPages.map((pageHtml) => {
                const includeHeading = !headingPlaced && !isImageOnlyPageHtml(pageHtml);
                if (includeHeading) headingPlaced = true;
                return wrapReaderPage(pageHtml, chapterTitle, includeHeading);
              });
              const rawHtml = rawPages.join("");
              const html = `${chapterHeadingHtml(chapterTitle)}${rawHtml}`;
              renderedChapters.push({
                id: chapter.id || `chapter-${index + 1}`,
                title: chapterTitle,
                href: chapter.href ?? "",
                html,
                pages
              });
              renderedPageCount += pages.length;
              await yieldToEventLoop();
              if (initialOnly && renderedPageCount >= initialPageLimit) break;
            }
            logTiming(`rendered chapters ${renderedChapters.length}`);
            const visibleChapters = renderedChapters.filter((chapter) => chapter.html.trim());
            const fallbackHtml = visibleChapters.length > 0 ? "" : renderRuby((await getAnalysis()).tokens);
            responseChapters = visibleChapters.length > 0 ? visibleChapters : [{ id: "chapter-1", title: "Document", html: fallbackHtml, pages: renderRubyPages(analysis.tokens) }];
          }
          logTiming("response chapters ready");
          const missingFrontImages = initialOnly ? [] : (await frontImagePaths(document)).filter((imagePath) =>
            !responseChapters.some((chapter) =>
              String(chapter.html ?? "").includes(imagePath) ||
              (chapter.pages ?? []).some((pageHtml) => String(pageHtml ?? "").includes(imagePath))
            )
          );
          const frontImageHtml = missingFrontImages.map((imagePath) => renderImageFigure(imagePath, document.title)).join("");
          const pages = [
            ...missingFrontImages.map((imagePath) => ({
              chapterId: responseChapters[0]?.id ?? "chapter-1",
              html: wrapReaderPage(renderImageFigure(imagePath, document.title), responseChapters[0]?.title ?? document.title)
            })),
            ...responseChapters.flatMap((chapter) => chapter.pages.map((html, pageIndex) => ({
              chapterId: chapter.id,
              html: wrapReaderPage(html, chapter.title, pageIndex === 0)
            })))
          ];
          cached = {
            id: document.id,
            filename: document.filename,
            createdAt: document.createdAt,
            coverPath: document.coverPath ?? "",
            author: document.author ?? "",
            sourcePath: document.sourcePath ?? "",
            html: frontImageHtml,
            pages,
            chapters: initialOnly
              ? chapters.map((chapter, index) => ({
                  id: chapter.id || `chapter-${index + 1}`,
                  title: chapter.title || `Chapter ${index + 1}`,
                  href: chapter.href ?? ""
                }))
              : responseChapters.map(({ id, title, href }) => ({ id, title, href: href ?? "" })),
            textLength: document.text.length
          };
          if (!initialOnly) documentResponseCache.set(cacheKey, cached);
        }
        logTiming("cached payload ready");

        res.json({
          ...cached,
          candidates: [],
          readabilitySuggestions: [],
          title: document.title,
          progress: state.progress[document.id] ?? { percentage: 0 }
        });
        logTiming("response sent");
      } catch (error) {
        next(error);
      }
    },

    async getDocumentsByIdPages(req, res, next) {
      try {
        const state = ctx.getState();
        const document = state.documents.find((item) => item.id === req.params.id);
        if (!document) return res.status(404).json({ error: "Document not found." });
        const start = Number(req.query.start);
        const limit = Number(req.query.limit);
        const pageWindow = await renderDocumentPageWindow(document, start, limit);
        res.json(pageWindow);
      } catch (error) {
        next(error);
      }
    },

    async patchDocumentsById(req, res) {
      const state = ctx.getState();
      const document = state.documents.find((item) => item.id === req.params.id);
      if (!document) return res.status(404).json({ error: "Document not found." });

      const title = req.body.title?.trim();
      if (!title) return res.status(400).json({ error: "Title is required." });

      document.title = title;
      document.updatedAt = new Date().toISOString();
      clearDocumentCache();
      markMlIndexStale("Book metadata changed.");
      await saveDocumentsState();
      const { text, chapters, ...publicDocument } = document;
      res.json(publicDocument);
    },

    async deleteDocumentsById(req, res) {
      const state = ctx.getState();
      const index = state.documents.findIndex((item) => item.id === req.params.id);
      if (index === -1) return res.status(404).json({ error: "Document not found." });

      const [deleted] = state.documents.splice(index, 1);
      const trashIndex = state.trash.documents.findIndex((item) => item.id === deleted.id);
      const trashedDocument = { ...deleted, deletedAt: new Date().toISOString() };
      if (trashIndex >= 0) state.trash.documents.splice(trashIndex, 1, trashedDocument);
      else state.trash.documents.unshift(trashedDocument);
      clearDocumentCache();
      await saveDocumentsState();
      res.json({ ok: true });
    },

    async postTrashDocumentsByIdRestore(req, res) {
      const state = ctx.getState();
      const index = state.trash.documents.findIndex((item) => item.id === req.params.id);
      if (index === -1) return res.status(404).json({ error: "Deleted book not found." });

      const [restored] = state.trash.documents.splice(index, 1);
      const { deletedAt, ...document } = restored;
      if (!state.documents.some((item) => item.id === document.id)) {
        state.documents.push(document);
      }
      clearDocumentCache();
      markMlIndexStale("Deleted book was restored.");
      await saveDocumentsState();
      const { text, chapters, ...publicDocument } = document;
      res.json({ document: publicDocument });
    },

    async deleteTrashDocumentsById(req, res) {
      const state = ctx.getState();
      const index = state.trash.documents.findIndex((item) => item.id === req.params.id);
      if (index === -1) return res.status(404).json({ error: "Deleted book not found." });
      const [deleted] = state.trash.documents.splice(index, 1);
      clearDocumentCache();
      await deleteDocumentSearchIndex(deleted.id);
      markMlIndexStale("Deleted book was permanently removed.");
      await saveDocumentsState();
      res.json({ deleted: 1, documentId: deleted.id, total: state.trash.documents.length });
    },

    async deleteTrashDocuments(req, res) {
      const state = ctx.getState();
      const deletedIds = state.trash.documents.map((document) => document.id).filter(Boolean);
      const deleted = state.trash.documents.length;
      state.trash.documents = [];
      clearDocumentCache();
      for (const id of deletedIds) await deleteDocumentSearchIndex(id);
      if (deleted > 0) markMlIndexStale("Deleted books were permanently removed.");
      await saveDocumentsState();
      res.json({ deleted, total: 0 });
    },

    async postDocumentsByIdProgress(req, res) {
      const state = ctx.getState();
      const document = state.documents.find((item) => item.id === req.params.id);
      if (!document) return res.status(404).json({ error: "Document not found." });

      const percentage = Math.max(0, Math.min(100, Number(req.body.percentage) || 0));
      state.progress[document.id] = {
        percentage,
        page: Math.max(0, Number(req.body.page) || 0),
        mode: req.body.mode === "paged" ? "paged" : "scroll",
        chapterId: req.body.chapterId ? String(req.body.chapterId) : "",
        scrollTop: Math.max(0, Number(req.body.scrollTop) || 0),
        zoom: Math.max(75, Math.min(175, Number(req.body.zoom) || state.progress[document.id]?.zoom || 100)),
        highlights: req.body.highlights && typeof req.body.highlights === "object" ? req.body.highlights : state.progress[document.id]?.highlights ?? { pages: {}, scrollHtml: "" },
        bookmarks: Array.isArray(req.body.bookmarks) ? req.body.bookmarks.slice(0, 100) : state.progress[document.id]?.bookmarks ?? [],
        updatedAt: new Date().toISOString()
      };
      await saveProgressState(document.id, state.progress[document.id]);
      logLearningEvent("reading.progress", {
        documentId: document.id,
        title: document.title,
        page: state.progress[document.id].page,
        chapterId: state.progress[document.id].chapterId,
        percentage
      });
      res.json(state.progress[document.id]);
    }
  };
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
