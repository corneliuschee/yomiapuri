import { execFile } from "node:child_process";
import path from "node:path";

export const EMBEDDING_MODELS = [
  {
    id: "multilingual-e5-small",
    label: "Multilingual E5 Small",
    model: "intfloat/multilingual-e5-small",
    dimensions: 384,
    runtime: "sentence-transformers",
    recommended: true
  },
  {
    id: "local-hash-ngram-v1",
    label: "Local hash n-gram fallback",
    model: "",
    dimensions: 128,
    runtime: "builtin"
  }
];

export function defaultMlSettings() {
  return {
    indexStale: false,
    indexStaleReason: "",
    embeddingProviderId: "multilingual-e5-small",
    embeddingPythonPath: "python",
    embeddingBatchSize: 64
  };
}

export function normalizeMlSettings(settings = {}) {
  const defaults = defaultMlSettings();
  const providerId = EMBEDDING_MODELS.some((model) => model.id === settings.embeddingProviderId)
    ? settings.embeddingProviderId
    : defaults.embeddingProviderId;
  return {
    ...defaults,
    ...(settings ?? {}),
    indexStale: Boolean(settings?.indexStale),
    indexStaleReason: String(settings?.indexStaleReason ?? ""),
    embeddingProviderId: providerId,
    embeddingPythonPath: String(settings?.embeddingPythonPath || defaults.embeddingPythonPath).trim() || defaults.embeddingPythonPath,
    embeddingBatchSize: Math.max(1, Math.min(256, Number(settings?.embeddingBatchSize) || defaults.embeddingBatchSize))
  };
}

export function publicMlSettings(settings = {}) {
  const normalized = normalizeMlSettings(settings);
  return {
    indexStale: normalized.indexStale,
    indexStaleReason: normalized.indexStaleReason,
    embeddingProviderId: normalized.embeddingProviderId,
    embeddingPythonPath: normalized.embeddingPythonPath,
    embeddingBatchSize: normalized.embeddingBatchSize
  };
}

export function createRuntimeEmbeddingProvider({ getState, rootDir, dataDir, hashProvider }) {
  const scriptPath = path.join(rootDir, "scripts", "embed_text.py");
  const cacheDir = path.join(dataDir, "embedding-models");
  let lastInfo = null;

  function configuredModel(providerId = "") {
    const ml = normalizeMlSettings(getState()?.ml ?? {});
    const id = providerId || ml.embeddingProviderId;
    return EMBEDDING_MODELS.find((model) => model.id === id) ?? EMBEDDING_MODELS[0];
  }

  function hashInfo(reason = "") {
    return {
      id: hashProvider.id,
      label: hashProvider.label,
      dimensions: hashProvider.dimensions,
      runtime: "builtin",
      fallback: true,
      error: reason
    };
  }

  function currentInfo() {
    return lastInfo ?? configuredModel();
  }

  function configuredInfo() {
    return configuredModel();
  }

  async function embedMany(texts = [], options = {}) {
    const model = configuredModel(options.providerId);
    if (model.runtime === "builtin") {
      lastInfo = { ...model, fallback: false };
      return hashProvider.embedMany(texts);
    }

    try {
      const ml = normalizeMlSettings(getState()?.ml ?? {});
      const result = await runSentenceTransformer({
        pythonPath: ml.embeddingPythonPath,
        scriptPath,
        modelName: model.model,
        cacheDir,
        texts,
        batchSize: ml.embeddingBatchSize
      });
      const embeddings = Array.isArray(result) ? result : result.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length) throw new Error("Embedding runtime returned an invalid batch.");
      lastInfo = { ...model, fallback: false, device: Array.isArray(result) ? "" : result.device || "" };
      return embeddings;
    } catch (error) {
      lastInfo = hashInfo(error.message);
      return hashProvider.embedMany(texts);
    }
  }

  return {
    get id() {
      return currentInfo().id;
    },
    get label() {
      return currentInfo().label;
    },
    get dimensions() {
      return currentInfo().dimensions;
    },
    info() {
      return currentInfo();
    },
    configuredInfo,
    async embed(text = "", options = {}) {
      const [embedding] = await embedMany([text], options);
      return embedding;
    },
    embedMany
  };
}

function runSentenceTransformer({ pythonPath, scriptPath, modelName, cacheDir, texts, batchSize }) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      pythonPath,
      [scriptPath],
      {
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
        timeout: 30 * 60 * 1000
      },
      (error, stdout, stderr) => {
        if (error) {
          try {
            const parsed = JSON.parse(stdout);
            if (Array.isArray(parsed.embeddings)) {
              resolve({ embeddings: parsed.embeddings, device: parsed.device || "" });
              return;
            }
          } catch {
            // Fall through to the clearer error message below.
          }
          if (error.killed || error.signal) {
            reject(new Error(`Embedding runtime timed out while loading or encoding ${modelName}. Try a smaller embedding model or rebuild again after the model cache finishes downloading.`));
            return;
          }
          reject(new Error(cleanEmbeddingRuntimeError(error, stderr, modelName)));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.error) throw new Error(parsed.error);
          resolve({ embeddings: parsed.embeddings, device: parsed.device || "" });
        } catch (parseError) {
          reject(new Error(parseError.message));
        }
      }
    );
    child.stdin.end(JSON.stringify({ model: modelName, cacheDir, texts, batchSize }));
  });
}

function cleanEmbeddingRuntimeError(error, stderr = "", modelName = "the selected model") {
  const cleanedStderr = String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isIgnorableEmbeddingLog(line))
    .join("\n")
    .trim();
  if (cleanedStderr) return cleanedStderr;
  const message = String(error?.message ?? "").trim();
  if (message.includes("cache_dir") && message.includes("deprecated")) return "";
  if (/Loading weights/i.test(message) && !/Traceback|Error|Exception/i.test(message)) {
    return `Embedding runtime exited before returning vectors for ${modelName}. Try rebuilding again, reducing the batch size, or selecting Multilingual E5 Small/MiniLM instead of a larger model.`;
  }
  return message || `Embedding runtime failed for ${modelName}.`;
}

function isIgnorableEmbeddingLog(line = "") {
  return /cache_dir.*deprecated/i.test(line)
    || /Loading weights:/i.test(line)
    || /HF_TOKEN/i.test(line)
    || /symlinks by default/i.test(line)
    || /enable-your-device-for-development/i.test(line)
    || /warnings\.warn\(message\)/i.test(line);
}
