import { spawn } from "node:child_process";

const SUGOI_TRANSLATION_PROMPT = "You are an expert Japanese-to-English literary localizer. Translate only the provided Japanese text into fluent, natural English.\n\nRules:\n- Preserve speaker tone, emotion, genre style, and relationship dynamics.\n- Prefer contextual, natural English over literal phrasing.\n- Use slang, subculture terms, profanity, or explicit wording when needed for accuracy.\n- Output only the final English translation. No notes, preambles, explanations, or markdown.";
const DEFAULT_ASSISTANT_PROMPTS = {
  translate: SUGOI_TRANSLATION_PROMPT,
  explain: "You are an expert Japanese language tutor and morphological analyst. Explain the target Japanese text clearly in English.\n\nRules:\n- If the user says previous, above, first sentence, second sentence, or similar, resolve that reference against the immediate previous user message before using older chat or page context.\n- Do not switch to unrelated reader/page text unless the user explicitly asks for current page context.\n- Keep the response concise.\n\nUse this structure:\n1. Brief Overview: why the sentence or grammar point matters.\n2. Key Grammar / Vocabulary:\n   - Japanese item\n   - Core meaning\n   - Syntax / formation\n   - Nuance in context\n3. Natural interpretation: what the sentence is doing overall.\n\nFocus only on important grammar, vocabulary, particles, conjugations, idioms, or ambiguity.",
  recap: "You are a spoiler-safe narrative recap assistant. Summarize only the provided already-read context.\n\nRules:\n- Do not speculate or mention unread events.\n- Focus on character actions, relationship changes, and immediate plot movement.\n- Use concise bullet points.\n- If no reading history is provided, respond exactly:\nNo historical reading context available for this document yet.",
  ask: "You are a Japanese reading assistant and cultural consultant. Answer the user's question clearly in English using the current text, chat history, and provided context.\n\nRules:\n- Be concise, direct, and educational.\n- For follow-up questions, use recent conversation history.\n- Ground answers in the provided text.\n- Use markdown only when it improves clarity.\n- If context is insufficient, say what is missing."
};
const LEGACY_ASSISTANT_PROMPTS = {
  translate: "You are a professional localizer whose primary goal is to translate Japanese to English. You should use colloquial or slang or nsfw vocabulary if it makes the translation more accurate. Always respond in English.",
  explain: "You are a Japanese reading tutor. Explain the user's sentence or question using clear English. Focus on grammar, vocabulary, conjugation, nuance, and how the meaning works in context. Keep the answer concise unless the user asks for detail.",
  recap: "You are a spoiler-safe reading recap assistant. Summarize only the already-read context provided by the app. Do not invent later events. Mention uncertainty when the provided context is insufficient.",
  ask: "You are a reader assistant for Japanese novels. Answer naturally in English using the user's message and the provided local context. If the context is insufficient, say what is missing instead of inventing details."
};

const DEFAULT_TRANSLATION_MODEL = {
  id: "sugoi-14b-ultra-q4-k-m",
  name: "Sugoi 14B Ultra Q4_K_M",
  url: "https://huggingface.co/sugoitoolkit/Sugoi-14B-Ultra-HF",
  provider: "llama.cpp",
  task: "translation",
  language: "ja-en",
  status: "imported",
  systemPrompt: SUGOI_TRANSLATION_PROMPT,
  quantization: "Q4_K_M",
  memoryTarget: "16gb",
  note: "Default local Japanese-to-English translation model. Uses a quantized GGUF build intended for 16 GB Macs."
};

const LOW_MEMORY_TRANSLATION_MODEL = {
  id: "sugoi-14b-ultra-q3-k-m",
  name: "Sugoi 14B Ultra Q3_K_M",
  url: "https://huggingface.co/sugoitoolkit/Sugoi-14B-Ultra-HF",
  provider: "llama.cpp",
  task: "translation",
  language: "ja-en",
  status: "imported",
  systemPrompt: SUGOI_TRANSLATION_PROMPT,
  quantization: "Q3_K_M",
  memoryTarget: "16gb-low",
  note: "Lower-memory Sugoi option for 16 GB Macs. Quality is lower than Q4_K_M."
};

const BUILT_IN_TRANSLATION_MODELS = [DEFAULT_TRANSLATION_MODEL, LOW_MEMORY_TRANSLATION_MODEL];
const DEPRECATED_TRANSLATION_MODEL_IDS = new Set([
  "liquidai-lfm2-350m-enjp-mt",
  "sugoitoolkit-sugoi-14b-ultra-hf"
]);

export function defaultAiSettings() {
  return {
    translation: {
      enabled: true,
      provider: "local-huggingface",
      modelId: DEFAULT_TRANSLATION_MODEL.id,
      sourceLanguage: "auto",
      targetLanguage: "en"
    },
    assistant: {
      provider: "local-evidence",
      prompts: { ...DEFAULT_ASSISTANT_PROMPTS }
    },
    models: BUILT_IN_TRANSLATION_MODELS
  };
}

export function normalizeAiSettings(settings = {}) {
  const defaults = defaultAiSettings();
  const storedModels = Array.isArray(settings.models) ? settings.models : [];
  const models = [...storedModels, ...BUILT_IN_TRANSLATION_MODELS]
    .map(normalizeAiModel)
    .filter((model) => model && !DEPRECATED_TRANSLATION_MODEL_IDS.has(model.id));
  const uniqueModels = [...new Map(models.map((model) => [model.id, model])).values()];
  const selectedModelId = String(settings.translation?.modelId ?? defaults.translation.modelId).trim();
  return {
    translation: {
      ...defaults.translation,
      ...(settings.translation ?? {}),
      enabled: true,
      modelId: uniqueModels.some((model) => model.id === selectedModelId) ? selectedModelId : defaults.translation.modelId,
      sourceLanguage: String(settings.translation?.sourceLanguage ?? defaults.translation.sourceLanguage),
      targetLanguage: String(settings.translation?.targetLanguage ?? defaults.translation.targetLanguage)
    },
    assistant: {
      ...defaults.assistant,
      ...(settings.assistant ?? {}),
      provider: "local-evidence",
      prompts: normalizeAssistantPrompts(settings.assistant?.prompts)
    },
    models: uniqueModels
  };
}

function normalizeAssistantPrompts(prompts = {}) {
  const normalized = { ...DEFAULT_ASSISTANT_PROMPTS };
  for (const key of Object.keys(DEFAULT_ASSISTANT_PROMPTS)) {
    const value = String(prompts?.[key] ?? "").trim();
    if (!value || value === LEGACY_ASSISTANT_PROMPTS[key]) continue;
    normalized[key] = value;
  }
  return normalized;
}

export function createAiService({ getSettings, saveSettings, runtimeCommand = "" }) {
  async function providers() {
    const settings = normalizeAiSettings(getSettings());
    return {
      settings,
      status: providerStatus(settings, runtimeCommand),
      models: settings.models
    };
  }

  async function updateSettings(patch = {}) {
    const current = normalizeAiSettings(getSettings());
    const next = normalizeAiSettings({
      ...current,
      ...patch,
      translation: { ...current.translation, ...(patch.translation ?? {}) },
      assistant: { ...current.assistant, ...(patch.assistant ?? {}) },
      models: patch.models ?? current.models
    });
    await saveSettings(next);
    return providers();
  }

  async function importModel({ url = "", name = "", task = "translation" } = {}) {
    const cleanUrl = String(url ?? "").trim();
    if (!/^https:\/\/huggingface\.co\/[^/\s]+\/[^/\s]+/i.test(cleanUrl)) {
      throw new Error("Enter a Hugging Face model URL, for example https://huggingface.co/LiquidAI/LFM2-350M-ENJP-MT");
    }
    const current = normalizeAiSettings(getSettings());
    const model = normalizeAiModel({
      id: modelIdFromUrl(cleanUrl),
      name: String(name ?? "").trim() || modelNameFromUrl(cleanUrl),
      url: cleanUrl,
      provider: "huggingface",
      task,
      language: languageHintFromUrl(cleanUrl),
      status: "imported",
      note: "Registered model metadata. Local runtime support is required before this model can generate translations."
    });
    const models = [...current.models.filter((item) => item.id !== model.id), model];
    await saveSettings(normalizeAiSettings({
      ...current,
      translation: { ...current.translation, modelId: model.id },
      models
    }));
    return { model, ...(await providers()) };
  }

  async function translate({ text = "", sourceLanguage = "", targetLanguage = "" } = {}) {
    const settings = normalizeAiSettings(getSettings());
    const cleanText = String(text ?? "").trim();
    const status = providerStatus(settings, runtimeCommand);
    const selectedModel = settings.models.find((model) => model.id === settings.translation.modelId);
    if (!cleanText) return { translatedText: "", status, model: selectedModel, available: false, reason: "No text supplied." };
    if (!settings.translation.enabled) {
      return { translatedText: "", status, model: selectedModel, available: false, reason: "Local AI is disabled in Integrations." };
    }
    if (!runtimeCommand) {
      return { translatedText: "", status, model: selectedModel, available: false, reason: "No local translation runtime command is configured." };
    }
    const payload = {
      text: cleanText,
      sourceLanguage: sourceLanguage || settings.translation.sourceLanguage,
      targetLanguage: targetLanguage || settings.translation.targetLanguage,
      model: withRuntimeModelPath(selectedModel),
      systemPrompt: selectedModel?.systemPrompt || settings.translation.systemPrompt || ""
    };
    const translatedText = await runTranslationCommand(runtimeCommand, payload);
    return { translatedText, status: providerStatus(settings, runtimeCommand), model: selectedModel, available: true, reason: "" };
  }

  async function chat({ messages = [], intent = "ask", modelId = "", maxTokens = 768, temperature = 0.2 } = {}) {
    const settings = normalizeAiSettings(getSettings());
    const status = providerStatus(settings, runtimeCommand);
    const cleanMessages = normalizeChatMessages(messages);
    const selectedModel = selectModel(settings, modelId);
    if (cleanMessages.length === 0) {
      return { text: "", status, model: selectedModel, available: false, reason: "No message supplied." };
    }
    if (!settings.translation.enabled) {
      return { text: "", status, model: selectedModel, available: false, reason: "Local AI is disabled in Integrations." };
    }
    if (!runtimeCommand) {
      return { text: "", status, model: selectedModel, available: false, reason: "No local AI runtime command is configured." };
    }
    const promptKey = DEFAULT_ASSISTANT_PROMPTS[intent] ? intent : "ask";
    const payload = {
      messages: cleanMessages,
      intent: promptKey,
      model: withRuntimeModelPath(selectedModel),
      systemPrompt: settings.assistant?.prompts?.[promptKey] || DEFAULT_ASSISTANT_PROMPTS[promptKey],
      maxTokens,
      temperature
    };
    const text = await runChatCommand(runtimeCommand, payload);
    return { text, status: providerStatus(settings, runtimeCommand), model: selectedModel, available: true, reason: "" };
  }

  async function chatStream({ messages = [], intent = "ask", modelId = "", maxTokens = 768, temperature = 0.2, onToken = () => {} } = {}) {
    const settings = normalizeAiSettings(getSettings());
    const status = providerStatus(settings, runtimeCommand);
    const cleanMessages = normalizeChatMessages(messages);
    const selectedModel = selectModel(settings, modelId);
    if (cleanMessages.length === 0) {
      return { text: "", status, model: selectedModel, available: false, reason: "No message supplied." };
    }
    if (!settings.translation.enabled) {
      return { text: "", status, model: selectedModel, available: false, reason: "Local AI is disabled in Integrations." };
    }
    if (!runtimeCommand) {
      return { text: "", status, model: selectedModel, available: false, reason: "No local AI runtime command is configured." };
    }
    const promptKey = DEFAULT_ASSISTANT_PROMPTS[intent] ? intent : "ask";
    const payload = {
      messages: cleanMessages,
      intent: promptKey,
      model: withRuntimeModelPath(selectedModel),
      systemPrompt: settings.assistant?.prompts?.[promptKey] || DEFAULT_ASSISTANT_PROMPTS[promptKey],
      maxTokens,
      temperature,
      stream: true
    };
    const text = await runChatStreamCommand(runtimeCommand, payload, onToken);
    return { text, status: providerStatus(settings, runtimeCommand), model: selectedModel, available: true, reason: "" };
  }

  return { providers, updateSettings, importModel, translate, chat, chatStream };
}

function selectModel(settings, modelId = "") {
  const cleanId = String(modelId ?? "").trim();
  return settings.models.find((model) => model.id === cleanId)
    ?? settings.models.find((model) => model.id === settings.translation.modelId)
    ?? settings.models[0]
    ?? null;
}

function normalizeChatMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      role: message?.role === "assistant" ? "assistant" : message?.role === "system" ? "system" : "user",
      content: String(message?.content ?? "").trim()
    }))
    .filter((message) => message.content)
    .slice(-12);
}

function providerStatus(settings = normalizeAiSettings(), runtimeCommand = "") {
  const command = String(runtimeCommand ?? "").trim();
  const selectedModel = withRuntimeModelPath(settings.models.find((model) => model.id === settings.translation.modelId));
  const hasLocalPath = Boolean(selectedModel?.localPath);
  return {
    translation: {
      enabled: Boolean(settings.translation.enabled),
      configured: Boolean(settings.translation.enabled && command),
      runtime: command ? hasLocalPath ? "local-command-local-model" : "local-command" : "not-configured",
      modelName: selectedModel?.name ?? "",
      label: settings.translation.enabled
        ? command
          ? `Local assistant ready: ${selectedModel?.name ?? "model"}${hasLocalPath ? " (local files)" : ""}`
          : `Local assistant selected: ${selectedModel?.name ?? "model"} (runtime not configured)`
        : "Local assistant disabled"
    },
    assistant: {
      configured: true,
      label: "Reader assistant uses local evidence and citations"
    }
  };
}

function withRuntimeModelPath(model = null) {
  if (!model) return model;
  const runtimePaths = {
    [DEFAULT_TRANSLATION_MODEL.id]: process.env.SUGOI_Q4_MODEL_PATH,
    [LOW_MEMORY_TRANSLATION_MODEL.id]: process.env.SUGOI_Q3_MODEL_PATH
  };
  const runtimeEndpoints = {
    [DEFAULT_TRANSLATION_MODEL.id]: process.env.SUGOI_Q4_ENDPOINT,
    [LOW_MEMORY_TRANSLATION_MODEL.id]: process.env.SUGOI_Q3_ENDPOINT
  };
  const localPath = String(runtimePaths[model.id] ?? model.localPath ?? "").trim();
  const localEndpoint = String(runtimeEndpoints[model.id] ?? model.localEndpoint ?? "").trim();
  return { ...model, ...(localPath ? { localPath } : {}), ...(localEndpoint ? { localEndpoint } : {}) };
}

function runTranslationCommand(command, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Local AI runtime timed out."));
    }, Number(process.env.LOCAL_TRANSLATION_TIMEOUT_MS) || 60000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(cleanRuntimeError(stderr) || `Local AI runtime exited with code ${code}.`));
        return;
      }
      const parsed = parseTranslationOutput(stdout);
      if (!parsed) {
        reject(new Error("Local AI runtime did not return response text."));
        return;
      }
      resolve(parsed);
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

function runChatCommand(command, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Local AI runtime timed out."));
    }, Number(process.env.LOCAL_TRANSLATION_TIMEOUT_MS) || 60000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(cleanRuntimeError(stderr) || `Local AI runtime exited with code ${code}.`));
        return;
      }
      const parsed = parseChatOutput(stdout);
      if (!parsed) {
        reject(new Error("Local AI runtime did not return response text."));
        return;
      }
      resolve(parsed);
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    child.stdin.end();
  });
}

function runChatStreamCommand(command, payload, onToken = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdoutBuffer = "";
    let stderr = "";
    let fullText = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Local AI runtime timed out."));
    }, Number(process.env.LOCAL_TRANSLATION_TIMEOUT_MS) || 60000);

    const processLine = (line = "") => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed.delta === "string") {
          fullText += parsed.delta;
          onToken(parsed.delta);
        }
      } catch {
        // Ignore non-JSON progress lines from local runtimes.
      }
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      if (code !== 0) {
        reject(new Error(cleanRuntimeError(stderr) || `Local AI runtime exited with code ${code}.`));
        return;
      }
      resolve(fullText.trim());
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    child.stdin.end();
  });
}

function cleanRuntimeError(stderr = "") {
  const lines = String(stderr ?? "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/Loading checkpoint shards|Fetching \d+ files|^\d+%\|/.test(line));
  const relevant = lines.slice(-12).join("\n");
  return relevant.length > 2000 ? relevant.slice(-2000) : relevant;
}

function parseTranslationOutput(stdout = "") {
  const text = String(stdout ?? "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    return String(parsed.translation ?? parsed.translatedText ?? parsed.text ?? "").trim();
  } catch {
    return text;
  }
}

function parseChatOutput(stdout = "") {
  const text = String(stdout ?? "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    return String(parsed.text ?? parsed.answer ?? parsed.translation ?? parsed.translatedText ?? "").trim();
  } catch {
    return text;
  }
}

function normalizeAiModel(model = {}) {
  const url = String(model.url ?? "").trim();
  const id = String(model.id ?? "").trim() || modelIdFromUrl(url);
  if (!id) return null;
  return {
    id,
    name: String(model.name ?? "").trim() || modelNameFromUrl(url) || id,
    url,
    provider: String(model.provider ?? "huggingface"),
    task: String(model.task ?? "translation"),
    language: String(model.language ?? ""),
    status: String(model.status ?? "imported"),
    systemPrompt: String(model.systemPrompt ?? ""),
    localPath: String(model.localPath ?? ""),
    localEndpoint: String(model.localEndpoint ?? ""),
    quantization: String(model.quantization ?? ""),
    memoryTarget: String(model.memoryTarget ?? ""),
    note: String(model.note ?? "")
  };
}

function modelIdFromUrl(url = "") {
  return String(url).replace(/^https:\/\/huggingface\.co\//i, "").replace(/[^\w./-]+/g, "-").replace(/\//g, "-").toLowerCase();
}

function modelNameFromUrl(url = "") {
  return String(url).split("/").filter(Boolean).slice(-2).join("/") || "Imported AI model";
}

function languageHintFromUrl(url = "") {
  const lower = String(url).toLowerCase();
  if (/enjp|ja|jp|japanese|sugoi/.test(lower)) return "ja-en";
  return "unknown";
}
