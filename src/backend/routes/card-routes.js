import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function registerCardRoutes(app, ctx) {
  const handlers = createCardHandlers(ctx);
  app.post("/api/cards", handlers.postCards);
  app.post("/api/anki/export-card", handlers.postAnkiExportCard);
  app.get("/api/cards/export", handlers.getCardsExport);
}

function createCardHandlers(ctx) {
  const { services, persistence, cache, paths, helpers } = ctx;
  const { ankiService } = services;
  const { saveCardsAndKnownTermsState, saveAnkiExportState } = persistence;
  const { invalidateReadabilityContext } = cache;
  const {
    normalizeJapaneseTerm,
    imageSvg,
    mapCardFields,
    logLearningEvent
  } = helpers;
  const { mediaDir } = paths;

  return {
    async postCards(req, res) {
      const state = ctx.getState();
      const document = state.documents.find((item) => item.id === req.body.documentId);
      if (!document) return res.status(404).json({ error: "Document not found." });

      const template = state.templates.find((item) => item.id === req.body.templateId) ?? state.templates[0];
      const expression = normalizeJapaneseTerm(req.body.expression);
      if (!expression) return res.status(400).json({ error: "Expression is required." });

      const imageName = `${crypto.randomUUID()}.svg`;
      await fs.writeFile(path.join(mediaDir, imageName), imageSvg(expression, req.body.reading ?? ""));

      const card = {
        id: crypto.randomUUID(),
        documentId: document.id,
        templateId: template.id,
        expression,
        dictionaryForm: normalizeJapaneseTerm(req.body.dictionaryForm || expression),
        reading: req.body.reading ?? "",
        sentence: req.body.sentence ?? "",
        meaning: req.body.meaning ?? "",
        source: document.title,
        audioPrompt: `Generate natural Japanese audio for: ${req.body.sentence || expression}`,
        imagePrompt: `Simple visual mnemonic for the Japanese vocabulary "${expression}" (${req.body.reading ?? ""}).`,
        imagePath: `/media/${imageName}`,
        createdAt: new Date().toISOString()
      };

      card.fields = mapCardFields(template, card);
      state.cards.unshift(card);
      await saveCardsAndKnownTermsState();
      res.status(201).json(card);
    },

    async postAnkiExportCard(req, res, next) {
      try {
        const exported = await ankiService.exportCard(req.body);
        logLearningEvent("anki.exported", {
          documentId: exported.documentId,
          expression: exported.expression,
          dictionaryForm: exported.dictionaryForm,
          noteId: exported.ankiNoteId,
          deckName: exported.deckName,
          modelName: exported.modelName
        });
        invalidateReadabilityContext();
        await saveAnkiExportState();
        res.status(201).json(exported);
      } catch (error) {
        next(error);
      }
    },

    getCardsExport(req, res) {
      const state = ctx.getState();
      const rows = state.cards.map((card) => card.fields);
      const fieldNames = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      const csv = [
        fieldNames.join(","),
        ...rows.map((row) => fieldNames.map((field) => JSON.stringify(row[field] ?? "")).join(","))
      ].join("\n");

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=\"anki-cards.csv\"");
      res.send(csv);
    }
  };
}
