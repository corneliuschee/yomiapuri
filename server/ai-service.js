import { spawn } from "node:child_process";

const DEFAULT_TRANSLATION_MODEL = {
  id: "liquidai-lfm2-350m-enjp-mt",
  name: "LiquidAI LFM2-350M ENJP MT",
  url: "https://huggingface.co/LiquidAI/LFM2-350M-ENJP-MT",
  provider: "huggingface",
  task: "translation",
  language: "ja-en",
  status: "imported",
  note: "Registered for local translation. Configure LOCAL_TRANSLATION_COMMAND to run inference."
};

export function defaultAiSettings() {
  return {
    translation: {
      enabled: false,
      provider: "local-huggingface",
      modelId: DEFAULT_TRANSLATION_MODEL.id,
      sourceLanguage: "auto",
      targetLanguage: "en"
    },
    assistant: {
      provider: "local-evidence"
    },
    models: [DEFAULT_TRANSLATION_MODEL]
  };
}

export function normalizeAiSettings(settings = {}) {
  const defaults = defaultAiSettings();
  const models = [...(Array.isArray(settings.models) ? settings.models : []), DEFAULT_TRANSLATION_MODEL]
    .map(normalizeAiModel)
    .filter(Boolean);
  const uniqueModels = [...new Map(models.map((model) => [model.id, model])).values()];
  const selectedModelId = String(settings.translation?.modelId ?? defaults.translation.modelId).trim();
  return {
    translation: {
      ...defaults.translation,
      ...(settings.translation ?? {}),
      enabled: Boolean(settings.translation?.enabled),
      modelId: uniqueModels.some((model) => model.id === selectedModelId) ? selectedModelId : defaults.translation.modelId,
      sourceLanguage: String(settings.translation?.sourceLanguage ?? defaults.translation.sourceLanguage),
      targetLanguage: String(settings.translation?.targetLanguage ?? defaults.translation.targetLanguage)
    },
    assistant: {
      ...defaults.assistant,
      ...(settings.assistant ?? {}),
      provider: "local-evidence"
    },
    models: uniqueModels
  };
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
      return { translatedText: "", status, model: selectedModel, available: false, reason: "Local translation is disabled in Integrations." };
    }
    if (!runtimeCommand) {
      return { translatedText: "", status, model: selectedModel, available: false, reason: "No local translation runtime command is configured." };
    }
    const payload = {
      text: cleanText,
      sourceLanguage: sourceLanguage || settings.translation.sourceLanguage,
      targetLanguage: targetLanguage || settings.translation.targetLanguage,
      model: selectedModel
    };
    const translatedText = await runTranslationCommand(runtimeCommand, payload);
    return { translatedText, status: providerStatus(settings, runtimeCommand), model: selectedModel, available: true, reason: "" };
  }

  return { providers, updateSettings, importModel, translate };
}

function providerStatus(settings = normalizeAiSettings(), runtimeCommand = "") {
  const command = String(runtimeCommand ?? "").trim();
  const selectedModel = settings.models.find((model) => model.id === settings.translation.modelId);
  return {
    translation: {
      enabled: Boolean(settings.translation.enabled),
      configured: Boolean(settings.translation.enabled && command),
      runtime: command ? "local-command" : "not-configured",
      modelName: selectedModel?.name ?? "",
      label: settings.translation.enabled
        ? command
          ? `Local translation ready: ${selectedModel?.name ?? "model"}`
          : `Local translation selected: ${selectedModel?.name ?? "model"} (runtime not configured)`
        : "Local translation disabled"
    },
    assistant: {
      configured: true,
      label: "Reader assistant uses local evidence and citations"
    }
  };
}

function runTranslationCommand(command, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Local translation runtime timed out."));
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
        reject(new Error(stderr.trim() || `Local translation runtime exited with code ${code}.`));
        return;
      }
      const parsed = parseTranslationOutput(stdout);
      if (!parsed) {
        reject(new Error("Local translation runtime did not return translation text."));
        return;
      }
      resolve(parsed);
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
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
  if (/enjp|ja|jp|japanese/.test(lower)) return "ja-en";
  return "unknown";
}
