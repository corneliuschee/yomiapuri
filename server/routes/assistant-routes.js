export function registerAssistantRoutes(app, ctx) {
  const handlers = createAssistantHandlers(ctx);
  app.post("/api/reader/assistant", handlers.postReaderAssistant);
  app.post("/api/reader/assistant/stream", handlers.postReaderAssistantStream);
}

function createAssistantHandlers(ctx) {
  const { services, helpers } = ctx;
  const { aiService, mlService } = services;
  const {
    compactReaderContext,
    inferAssistantIntent,
    normalizeAssistantHistory,
    translationPromptText,
    analyzeText,
    assistantTermNotes,
    assistantRetrievalQuery,
    assistantWantsExplicitCitations,
    assistantWantsLocalRetrieval,
    assistantWantsExamples,
    assistantNameReadingNotes,
    buildAssistantMessages,
    assistantMaxTokens,
    assistantResponseText,
    logLearningEvent
  } = helpers;

  return {
    async postReaderAssistant(req, res, next) {
      try {
        const state = ctx.getState();
        const document = state.documents.find((item) => item.id === req.body.documentId);
        const question = compactReaderContext(req.body.question, 2500);
        if (!question) return res.status(400).json({ error: "Type a message before sending." });
        const task = inferAssistantIntent(question);
        const history = normalizeAssistantHistory(req.body.history);
        const contextText = task === "translate" ? compactReaderContext(translationPromptText(question), 2500) : question;
        const analysis = await analyzeText(contextText);
        const termNotes = assistantTermNotes(analysis.tokens);
        const query = assistantRetrievalQuery(question, contextText, history);
        const exposeCitations = task !== "translate" && assistantWantsExplicitCitations(question);
        const useRagContext = task === "recap" || (task !== "translate" && assistantWantsLocalRetrieval(query));
        const exampleSearch = task !== "translate" && assistantWantsExamples(query);
        const currentPage = Number(req.body.page) || 0;
        const searchResult = !useRagContext
          ? { results: [], status: { ready: false, skipped: true } }
          : await mlService.search(query, {
              limit: 6,
              readSafe: true,
              documentId: document?.id || "",
              currentPage
            });
        const citations = searchResult.results ?? [];
        const nameNotes = assistantNameReadingNotes({ document, question, contextText, citations });
        let chat;
        try {
          chat = await aiService.chat({
            intent: task,
            modelId: req.body.modelId,
            messages: buildAssistantMessages({
              intent: task,
              question: task === "translate" ? contextText : question,
              contextText,
              history,
              termNotes,
              nameNotes,
              citations,
              document,
              page: currentPage,
              includeRetrievedContext: useRagContext,
              includeCitations: exposeCitations,
              exampleSearch
            }),
            maxTokens: assistantMaxTokens(task, contextText, { useRagContext, exampleSearch }),
            temperature: task === "translate" ? 0.1 : 0.25
          });
        } catch (error) {
          chat = { available: false, text: "", reason: error.message, model: null };
        }
        const fallback = assistantResponseText(task, {
          contextText,
          question,
          termNotes,
          citations,
          document,
          translation: task === "translate" ? {
            available: chat.available,
            translatedText: chat.text,
            reason: chat.reason
          } : null
        });
        const answer = chat.available && chat.text ? chat.text : fallback;
        const result = {
          task,
          intent: task,
          question,
          answer,
          terms: termNotes,
          citations: exposeCitations ? citations : [],
          includeCitations: exposeCitations,
          translation: task === "translate" ? {
            available: chat.available,
            translatedText: chat.text,
            reason: chat.reason,
            model: chat.model
          } : null,
          ai: {
            available: chat.available,
            reason: chat.reason,
            model: chat.model
          },
          status: searchResult.status,
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
          citations: citations.length,
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
        const state = ctx.getState();
        const document = state.documents.find((item) => item.id === req.body.documentId);
        const question = compactReaderContext(req.body.question, 2500);
        if (!question) {
          writeAssistantStream(res, "error", { error: "Type a message before sending." });
          res.end();
          return;
        }
        const task = inferAssistantIntent(question);
        const history = normalizeAssistantHistory(req.body.history);
        const contextText = task === "translate" ? compactReaderContext(translationPromptText(question), 2500) : question;
        const analysis = await analyzeText(contextText);
        const termNotes = assistantTermNotes(analysis.tokens);
        const query = assistantRetrievalQuery(question, contextText, history);
        const exposeCitations = task !== "translate" && assistantWantsExplicitCitations(question);
        const useRagContext = task === "recap" || (task !== "translate" && assistantWantsLocalRetrieval(query));
        const exampleSearch = task !== "translate" && assistantWantsExamples(query);
        const currentPage = Number(req.body.page) || 0;
        const searchResult = !useRagContext
          ? { results: [], status: { ready: false, skipped: true } }
          : await mlService.search(query, {
              limit: 6,
              readSafe: true,
              documentId: document?.id || "",
              currentPage
            });
        const citations = searchResult.results ?? [];
        const nameNotes = assistantNameReadingNotes({ document, question, contextText, citations });

        writeAssistantStream(res, "meta", {
          task,
          intent: task,
          includeCitations: exposeCitations,
          terms: termNotes,
          citations: exposeCitations ? citations : [],
          status: searchResult.status,
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
            messages: buildAssistantMessages({
              intent: task,
              question: task === "translate" ? contextText : question,
              contextText,
              history,
              termNotes,
              nameNotes,
              citations,
              document,
              page: currentPage,
              includeRetrievedContext: useRagContext,
              includeCitations: exposeCitations,
              exampleSearch
            }),
            maxTokens: assistantMaxTokens(task, contextText, { useRagContext, exampleSearch }),
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
          citations,
          document,
          translation: task === "translate" ? {
            available: chat.available,
            translatedText: chat.text,
            reason: chat.reason
          } : null
        });
        const answer = chat.available && chat.text ? chat.text : fallback;
        if (!chat.available || !chat.text) writeAssistantStream(res, "delta", { delta: answer });
        const result = {
          task,
          intent: task,
          question,
          answer,
          terms: termNotes,
          citations: exposeCitations ? citations : [],
          includeCitations: exposeCitations,
          ai: {
            available: chat.available,
            reason: chat.reason,
            model: chat.model
          },
          status: searchResult.status,
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
          citations: citations.length,
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
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
