import crypto, { createHash } from "node:crypto";
import path from "node:path";

export function registerIntegrationRoutes(app, ctx) {
  const { upload } = ctx;
  const handlers = createIntegrationHandlers(ctx);
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

function createIntegrationHandlers(ctx) {
  const { services, persistence, helpers } = ctx;
  const { stateStore, mediaProvider, aiService, ankiService } = services;
  const { saveTemplatesState, saveSettingsState } = persistence;
  const {
    normalizeMediaSettings,
    aiRuntimeStatus,
    stopAiRuntime,
    logLearningEvent,
    normalizeJapaneseTerm,
    dictionaryLookupTerms,
    knownTermLookupMatch
  } = helpers;

  return {
    async postTemplates(req, res) {
      const state = ctx.getState();
      if (!req.file) return res.status(400).json({ error: "No file uploaded." });

      const raw = req.file.buffer.toString("utf8");
      let fields;
      try {
        const parsed = JSON.parse(raw);
        fields = parsed.fields ?? parsed.flds?.map((field) => field.name);
      } catch {
        fields = raw.split(/[\r\n,\t]/).map((field) => field.trim()).filter(Boolean);
      }

      if (!Array.isArray(fields) || fields.length === 0) {
        return res.status(422).json({ error: "Template must contain at least one field name." });
      }

      const template = {
        id: crypto.randomUUID(),
        name: req.body.name?.trim() || path.parse(req.file.originalname).name,
        fields
      };
      state.templates.unshift(template);
      await saveTemplatesState();
      res.status(201).json(template);
    },

    async postAnkiSettings(req, res) {
      const state = ctx.getState();
      const hasAutoLaunch = Object.prototype.hasOwnProperty.call(req.body, "autoLaunchAnki");
      const hasExecutablePath = Object.prototype.hasOwnProperty.call(req.body, "ankiExecutablePath");
      const nextExecutablePath = hasExecutablePath
        ? String(req.body.ankiExecutablePath ?? "").trim()
        : state.anki.ankiExecutablePath;
      const patch = {
        connectUrl: req.body.connectUrl?.trim() || state.anki.connectUrl,
        deckName: req.body.deckName?.trim() ?? state.anki.deckName,
        modelName: req.body.modelName?.trim() ?? state.anki.modelName,
        fieldMap: req.body.fieldMap ?? {},
        autoLaunchAnki: hasAutoLaunch ? Boolean(req.body.autoLaunchAnki) : state.anki.autoLaunchAnki,
        ankiExecutablePath: nextExecutablePath
      };
      if (hasExecutablePath && nextExecutablePath !== state.anki.ankiExecutablePath) {
        patch.ankiExecutablePathDetected = false;
      }
      if (Object.prototype.hasOwnProperty.call(req.body, "instantExport")) {
        patch.instantExport = Boolean(req.body.instantExport);
      }
      const nextSettings = await stateStore.anki.updateSettings({ ...patch }, { save: false });
      await saveSettingsState(["anki"]);
      res.json(nextSettings);
    },

    async getMediaProviders(req, res, next) {
      try {
        res.json(await mediaProvider.providers());
      } catch (error) {
        next(error);
      }
    },

    async postMediaSettings(req, res, next) {
      try {
        const settings = await stateStore.media.updateSettings(req.body ?? {}, normalizeMediaSettings, { save: false });
        await saveSettingsState(["media"]);
        res.json({ settings, providers: await mediaProvider.providers() });
      } catch (error) {
        next(error);
      }
    },

    async postMediaVoiceModels(req, res, next) {
      try {
        const state = ctx.getState();
        const url = String(req.body.url ?? "").trim();
        const name = String(req.body.name ?? "").trim() || voiceModelNameFromUrl(url);
        if (!/^https:\/\/huggingface\.co\/[^/\s]+\/[^/\s]+\/?$/i.test(url)) {
          return res.status(400).json({ error: "Enter a Hugging Face model URL, for example https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B-JP" });
        }
        const model = {
          id: createHash("sha256").update(url).digest("hex").slice(0, 16),
          name,
          url,
          provider: "huggingface",
          status: "imported",
          note: "Imported model metadata. Local liquid-audio runtime support is required before this model can generate card audio."
        };
        const current = normalizeMediaSettings(state.media);
        const existing = current.voiceModels.filter((item) => item.id !== model.id);
        const settings = await stateStore.media.updateSettings({
          ...current,
          audio: { ...current.audio, voiceModelId: model.id },
          voiceModels: [...existing, model]
        }, normalizeMediaSettings, { save: false });
        await saveSettingsState(["media"]);
        res.status(201).json({ model, settings, providers: await mediaProvider.providers() });
      } catch (error) {
        next(error);
      }
    },

    async getAiProviders(req, res, next) {
      try {
        res.json(await aiService.providers());
      } catch (error) {
        next(error);
      }
    },

    async getAiRuntime(req, res, next) {
      try {
        res.json(await aiRuntimeStatus());
      } catch (error) {
        next(error);
      }
    },

    async postAiRuntimeStop(req, res, next) {
      try {
        const stopped = await stopAiRuntime();
        res.json({ stopped, ...(await aiRuntimeStatus()) });
      } catch (error) {
        next(error);
      }
    },

    async postAiSettings(req, res, next) {
      try {
        res.json(await aiService.updateSettings(req.body ?? {}));
      } catch (error) {
        next(error);
      }
    },

    async postAiModels(req, res, next) {
      try {
        res.status(201).json(await aiService.importModel(req.body ?? {}));
      } catch (error) {
        next(error);
      }
    },

    async postAiTestTranslation(req, res, next) {
      try {
        res.json(await aiService.translate({
          text: req.body.text,
          sourceLanguage: req.body.sourceLanguage,
          targetLanguage: req.body.targetLanguage
        }));
      } catch (error) {
        next(error);
      }
    },

    async postMediaTestAudio(req, res, next) {
      try {
        const value = await mediaProvider.createAudio({
          expression: req.body.expression || "å›³æ›¸é¤¨",
          sentence: req.body.sentence || "å›³æ›¸é¤¨ã¸è¡Œãã¾ã™ã€‚"
        });
        res.json({ value, status: await mediaProvider.status() });
      } catch (error) {
        next(error);
      }
    },

    async postMediaTestImage(req, res, next) {
      try {
        const value = await mediaProvider.createImage({
          expression: req.body.expression || "å›³æ›¸é¤¨",
          reading: req.body.reading || "ã¨ã—ã‚‡ã‹ã‚“",
          meaning: req.body.meaning || "library",
          source: "Media test"
        });
        res.json({ value, status: await mediaProvider.status() });
      } catch (error) {
        next(error);
      }
    },

    async getAnkiConnect(req, res, next) {
      try {
        const result = await ankiService.listDecksAndModels();
        res.json({ ok: true, ...result });
      } catch (error) {
        next(error);
      }
    },

    async getAnkiModelFields(req, res, next) {
      try {
        res.json(await ankiService.modelFields(String(req.query.modelName ?? "")));
      } catch (error) {
        next(error);
      }
    },

    async postAnkiImport(req, res, next) {
      try {
        const result = await ankiService.importReviewedTerms({
          preset: req.body.preset,
          deckName: req.body.deckName?.trim(),
          query: req.body.query
        });
        logLearningEvent("anki.vocabulary-imported", { preset: req.body.preset, deckName: req.body.deckName, imported: result.imported });
        res.json(result);
      } catch (error) {
        next(error);
      }
    },

    async postAnkiCardPreview(req, res, next) {
      try {
        const preview = await ankiService.previewCard(req.body);
        logLearningEvent("sentence.previewed", {
          documentId: req.body.documentId,
          expression: preview.canonical?.Expression,
          dictionaryForm: preview.canonical?.DictionaryForm
        });
        res.json(preview);
      } catch (error) {
        next(error);
      }
    },

    async postAnkiOpenKnownTerm(req, res, next) {
      try {
        const requestedTerm = normalizeJapaneseTerm(req.body.term ?? "");
        const queryTerms = await dictionaryLookupTerms(requestedTerm);
        const match = knownTermLookupMatch(requestedTerm, queryTerms, []);
        if (!match.exists) throw Object.assign(new Error("This vocabulary is not in the Word Bank."), { status: 404 });
        res.json(await ankiService.openTerm(match.term));
      } catch (error) {
        next(error);
      }
    }
  };
}

function voiceModelNameFromUrl(url = "") {
  return url.split("/").filter(Boolean).slice(-2).join("/") || "Imported voice model";
}
