export function registerAssistantRoutes(app, ctx) {
  const handlers = createAssistantHandlers(ctx);
  app.post("/api/reader/assistant", handlers.postReaderAssistant);
  app.post("/api/reader/assistant/stream", handlers.postReaderAssistantStream);
}

function createAssistantHandlers(ctx) {
  const { services, helpers } = ctx;
  const { aiService } = services;
  const {
    compactReaderContext,
    inferAssistantIntent,
    normalizeAssistantHistory,
    translationPromptText,
    analyzeText,
    assistantTermNotes,
    assistantNameReadingNotes,
    buildAssistantMessages,
    assistantMaxTokens,
    assistantResponseText,
    logLearningEvent
  } = helpers;

  const localContextStatus = {
    source: "current-message",
    retrieval: "disabled",
    citations: false
  };

  function assistantInputs(req) {
    const state = ctx.getState();
    const document = (state.documents ?? []).find((item) => item.id === req.body.documentId);
    const question = compactReaderContext(req.body.question, 2500);
    const task = inferAssistantIntent(question);
    const history = normalizeAssistantHistory(req.body.history);
    const contextText = task === "translate"
      ? compactReaderContext(translationPromptText(question), 2500)
      : question;
    const currentPage = Number(req.body.page) || 0;
    return { state, document, question, task, history, contextText, currentPage };
  }

  function buildChatPayload({ task, question, contextText, history, termNotes, nameNotes, document, currentPage }) {
    return {
      intent: task,
      question: task === "translate" ? contextText : question,
      contextText,
      history,
      termNotes,
      nameNotes,
      citations: [],
      document,
      page: currentPage,
      includeRetrievedContext: false,
      includeCitations: false,
      exampleSearch: false
    };
  }

  return {
    async postReaderAssistant(req, res, next) {
      try {
        const { document, question, task, history, contextText, currentPage } = assistantInputs(req);
        if (!question) return res.status(400).json({ error: "Type a message before sending." });

        const analysis = await analyzeText(contextText);
        const termNotes = assistantTermNotes(analysis.tokens);
        const nameNotes = assistantNameReadingNotes({
          document,
          question,
          contextText,
          citations: []
        });

        let chat;
        try {
          chat = await aiService.chat({
            intent: task,
            modelId: req.body.modelId,
            messages: buildAssistantMessages(buildChatPayload({
              task,
              question,
              contextText,
              history,
              termNotes,
              nameNotes,
              document,
              currentPage
            })),
            maxTokens: assistantMaxTokens(task, contextText),
            temperature: task === "translate" ? 0.1 : 0.25
          });
        } catch (error) {
          chat = { available: false, text: "", reason: error.message, model: null };
        }

        const fallback = assistantResponseText(task, {
          contextText,
          question,
          termNotes,
          citations: [],
          document,
          translation: task === "translate"
            ? {
                available: chat.available,
                translatedText: chat.text,
                reason: chat.reason
              }
            : null
        });
        const answer = chat.available && chat.text ? chat.text : fallback;
        const result = {
          task,
          intent: task,
          question,
          answer,
          terms: termNotes,
          citations: [],
          includeCitations: false,
          translation: task === "translate"
            ? {
                available: chat.available,
                translatedText: chat.text,
                reason: chat.reason,
                model: chat.model
              }
            : null,
          ai: {
            available: chat.available,
            reason: chat.reason,
            model: chat.model
          },
          status: localContextStatus,
          context: {
            documentId: document?.id || "",
            title: document?.title || "",
            page: currentPage,
            source: "message"
          }
        };
        logLearningEvent("reader.assistant", {
          documentId: document?.id,
          task,
          page: result.context.page,
          terms: termNotes.length,
          citations: 0,
          source: result.context.source
        });
        res.json(result);
      } catch (error) {
        next(error);
      }
    },

    async postReaderAssistantStream(req, res) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });

      try {
        const { document, question, task, history, contextText, currentPage } = assistantInputs(req);
        if (!question) {
          writeAssistantStream(res, "error", { error: "Type a message before sending." });
          res.end();
          return;
        }

        const analysis = await analyzeText(contextText);
        const termNotes = assistantTermNotes(analysis.tokens);
        const nameNotes = assistantNameReadingNotes({
          document,
          question,
          contextText,
          citations: []
        });

        writeAssistantStream(res, "meta", {
          task,
          intent: task,
          includeCitations: false,
          terms: termNotes,
          citations: [],
          status: localContextStatus,
          context: {
            documentId: document?.id || "",
            title: document?.title || "",
            page: currentPage,
            source: "message"
          }
        });

        let chat;
        try {
          chat = await aiService.chatStream({
            intent: task,
            modelId: req.body.modelId,
            messages: buildAssistantMessages(buildChatPayload({
              task,
              question,
              contextText,
              history,
              termNotes,
              nameNotes,
              document,
              currentPage
            })),
            maxTokens: assistantMaxTokens(task, contextText),
            temperature: task === "translate" ? 0.1 : 0.25,
            onToken: (delta) => writeAssistantStream(res, "delta", { delta })
          });
        } catch (error) {
          chat = { available: false, text: "", reason: error.message, model: null };
        }

        const fallback = assistantResponseText(task, {
          contextText,
          question,
          termNotes,
          citations: [],
          document,
          translation: task === "translate"
            ? {
                available: chat.available,
                translatedText: chat.text,
                reason: chat.reason
              }
            : null
        });
        const answer = chat.available && chat.text ? chat.text : fallback;
        if (!chat.available || !chat.text) writeAssistantStream(res, "delta", { delta: answer });

        const result = {
          task,
          intent: task,
          question,
          answer,
          terms: termNotes,
          citations: [],
          includeCitations: false,
          ai: {
            available: chat.available,
            reason: chat.reason,
            model: chat.model
          },
          status: localContextStatus,
          context: {
            documentId: document?.id || "",
            title: document?.title || "",
            page: currentPage,
            source: "message"
          }
        };
        logLearningEvent("reader.assistant", {
          documentId: document?.id,
          task,
          page: result.context.page,
          terms: termNotes.length,
          citations: 0,
          source: result.context.source
        });
        writeAssistantStream(res, "done", result);
        res.end();
      } catch (error) {
        writeAssistantStream(res, "error", { error: error.message });
        res.end();
      }
    }
  };
}

function writeAssistantStream(res, event, data) {
  res.write("event: " + event + "\n");
  res.write("data: " + JSON.stringify(data) + "\n\n");
}
