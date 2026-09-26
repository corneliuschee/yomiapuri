import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const DEFAULT_MEDIA_SETTINGS = {
  audio: {
    enabled: false,
    provider: "local-system-tts",
    voiceName: "",
    voiceModelId: "",
    rate: 0
  },
  image: {
    enabled: false,
    provider: "local-mnemonic"
  },
  voiceModels: []
};
const LIQUIDAI_TTS_PORT = 38941;
const liquidAiServers = new Map();

export function defaultMediaSettings() {
  return structuredClone(DEFAULT_MEDIA_SETTINGS);
}

export function normalizeMediaSettings(settings = {}) {
  return {
    audio: {
      ...DEFAULT_MEDIA_SETTINGS.audio,
      ...(settings.audio ?? {}),
      enabled: Boolean(settings.audio?.enabled),
      rate: clampNumber(settings.audio?.rate, -10, 10, 0)
    },
    image: {
      ...DEFAULT_MEDIA_SETTINGS.image,
      ...(settings.image ?? {}),
      enabled: Boolean(settings.image?.enabled)
    },
    voiceModels: Array.isArray(settings.voiceModels) ? settings.voiceModels.map(normalizeVoiceModel).filter(Boolean) : []
  };
}

export function createDefaultMediaProvider() {
  return {
    status() {
      return {
        audio: { configured: false, label: "Audio provider not configured" },
        image: { configured: false, label: "Image provider not configured" }
      };
    },
    async providers() {
      return { voices: [], settings: defaultMediaSettings(), status: this.status() };
    },
    async createAudio() {
      return "";
    },
    async createImage() {
      return "";
    },
    async storeMediaFiles() {
      return [];
    }
  };
}

export function createLocalMediaProvider({ getSettings, mediaDir, pythonPath = "", liquidAiScriptPath = "", hfHome = "" }) {
  const ankiMediaDir = path.join(mediaDir, "anki-media");
  let voicesCache = null;

  const currentSettings = () => normalizeMediaSettings(getSettings() ?? {});

  async function voices() {
    if (voicesCache) return voicesCache;
    voicesCache = process.platform === "win32" ? await windowsVoices() : [];
    return voicesCache;
  }

  async function selectedVoiceName(settings) {
    if (settings.audio.voiceName) return settings.audio.voiceName;
    const available = await voices();
    return available.find((voice) => voice.culture?.toLowerCase().startsWith("ja"))?.name ?? "";
  }

  return {
    async providers() {
      const settings = currentSettings();
      const availableVoices = await voices();
      const modelRuntimeReady = Boolean(pythonPath && liquidAiScriptPath && existsSync(pythonPath) && existsSync(liquidAiScriptPath));
      const voiceModels = withRuntimeStatus(settings.voiceModels ?? [], modelRuntimeReady);
      return {
        voices: availableVoices,
        voiceModels,
        settings,
        status: await this.status()
      };
    },
    async status() {
      const settings = currentSettings();
      const availableVoices = await voices();
      const selectedVoice = await selectedVoiceName(settings);
      const runtimeInstalled = Boolean(pythonPath && liquidAiScriptPath && existsSync(pythonPath) && existsSync(liquidAiScriptPath));
      const voiceModels = withRuntimeStatus(settings.voiceModels ?? [], runtimeInstalled);
      const selectedModel = voiceModels.find((model) => model.id === settings.audio.voiceModelId);
      const modelReady = Boolean(selectedModel && runtimeInstalled);
      return {
        audio: {
          configured: Boolean(settings.audio.enabled && (selectedVoice || modelReady)),
          enabled: Boolean(settings.audio.enabled),
          label: settings.audio.enabled
            ? modelReady
              ? `LiquidAI audio: ${selectedModel.name}`
              : selectedVoice
              ? `Local audio: ${selectedVoice}`
              : selectedModel
                ? `Imported voice model: ${selectedModel.name} (runtime not installed)`
                : "Local audio enabled, but no Japanese voice is available"
            : "Audio provider not configured"
        },
        image: {
          configured: Boolean(settings.image.enabled),
          enabled: Boolean(settings.image.enabled),
          label: settings.image.enabled ? "Local mnemonic image enabled" : "Image provider not configured"
        },
        voices: availableVoices,
        voiceModels
      };
    },
    async createAudio({ expression = "", sentence = "" } = {}, { generate = true } = {}) {
      const settings = currentSettings();
      if (!settings.audio.enabled || process.platform !== "win32") return "";
      const text = String(sentence || expression || "").trim();
      if (!text) return "";
      const selectedModel = (settings.voiceModels ?? []).find((model) => model.id === settings.audio.voiceModelId);
      if (selectedModel && pythonPath && liquidAiScriptPath && existsSync(pythonPath) && existsSync(liquidAiScriptPath)) {
        await fs.mkdir(ankiMediaDir, { recursive: true });
        const maxNewTokens = liquidAiTokenLimit(text);
        const rate = Number(settings.audio.rate) || 0;
        const filename = `kanji-reader-audio-${hashKey([text, selectedModel.url, "liquidai", maxNewTokens, rate])}.wav`;
        const filePath = path.join(ankiMediaDir, filename);
        if (!existsSync(filePath) && !generate) return "";
        if (!existsSync(filePath)) {
          await synthesizeLiquidAiSpeech({
            text,
            filePath,
            model: modelIdFromHuggingFaceUrl(selectedModel.url),
            pythonPath,
            scriptPath: liquidAiScriptPath,
            hfHome,
            maxNewTokens,
            rate
          });
        }
        return `[sound:${filename}]`;
      }
      const voiceName = await selectedVoiceName(settings);
      if (!voiceName) return "";
      await fs.mkdir(ankiMediaDir, { recursive: true });
      const filename = `kanji-reader-audio-${hashKey([text, voiceName, settings.audio.rate])}.wav`;
      const filePath = path.join(ankiMediaDir, filename);
      if (!existsSync(filePath) && !generate) return "";
      if (!existsSync(filePath)) await synthesizeWindowsSpeech({ text, filePath, voiceName, rate: settings.audio.rate });
      return `[sound:${filename}]`;
    },
    async createImage({ expression = "", reading = "", meaning = "", source = "" } = {}) {
      const settings = currentSettings();
      if (!settings.image.enabled) return "";
      const term = String(expression || "").trim();
      if (!term) return "";
      await fs.mkdir(ankiMediaDir, { recursive: true });
      const filename = `kanji-reader-image-${hashKey([term, reading, meaning, source])}.svg`;
      const filePath = path.join(ankiMediaDir, filename);
      if (!existsSync(filePath)) {
        await fs.writeFile(filePath, mnemonicSvg({ expression: term, reading, meaning, source }), "utf8");
      }
      return `<img src="${filename}">`;
    },
    async storeMediaFiles(connect, fields = {}) {
      const filenames = mediaFilenamesFromFields(fields);
      const stored = [];
      for (const filename of filenames) {
        const filePath = path.join(ankiMediaDir, path.basename(filename));
        if (!existsSync(filePath)) continue;
        const data = await fs.readFile(filePath);
        await connect("storeMediaFile", {
          filename: path.basename(filename),
          data: data.toString("base64")
        });
        stored.push(path.basename(filename));
      }
      return stored;
    }
  };
}

export function mediaFilenamesFromFields(fields = {}) {
  const filenames = new Set();
  for (const value of Object.values(fields)) {
    const text = String(value ?? "");
    for (const match of text.matchAll(/\[sound:([^\]]+)\]/gi)) filenames.add(path.basename(match[1]));
    for (const match of text.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) filenames.add(path.basename(match[1]));
  }
  return [...filenames].filter((filename) => /^kanji-reader-(audio|image)-[a-f0-9]+\.(wav|svg)$/i.test(filename));
}

async function windowsVoices() {
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$synth.GetInstalledVoices() | ForEach-Object {",
    "  [PSCustomObject]@{ Name = $_.VoiceInfo.Name; Culture = $_.VoiceInfo.Culture.Name }",
    "} | ConvertTo-Json -Compress",
    "$synth.Dispose()"
  ].join("\n");
  const output = await runPowerShell(script).catch(() => "");
  if (!output.trim()) return [];
  try {
    const parsed = JSON.parse(output);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .map((voice) => ({ name: String(voice.Name ?? ""), culture: String(voice.Culture ?? "") }))
      .filter((voice) => voice.name);
  } catch {
    return [];
  }
}

async function synthesizeWindowsSpeech({ text, filePath, voiceName, rate }) {
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `$synth.SelectVoice(${psString(voiceName)})`,
    `$synth.Rate = ${Number(rate) || 0}`,
    `$synth.SetOutputToWaveFile(${psString(filePath)})`,
    `$synth.Speak(${psString(text)})`,
    "$synth.Dispose()"
  ].join("\n");
  await runPowerShell(script);
}

async function synthesizeLiquidAiSpeech({ text, filePath, model, pythonPath, scriptPath, hfHome, maxNewTokens, rate }) {
  const env = {
    ...process.env,
    PYTHONUTF8: "1",
    HF_HOME: hfHome || process.env.HF_HOME || "",
    HUGGINGFACE_HUB_CACHE: hfHome ? path.join(hfHome, "hub") : process.env.HUGGINGFACE_HUB_CACHE || ""
  };

  // Automatically swap the script filename so you don't have to change your .env
  const oneShotScriptPath = scriptPath.replace("liquidai_tts_server.py", "liquidai_tts.py");

  // Build the command line arguments
  const args = [
    oneShotScriptPath,
    "--model", model,
    "--text", text,
    "--out", filePath,
    "--max-new-tokens", String(maxNewTokens)
  ];

  // Execute the one-shot Python script directly
  // This uses the runProcess function already at the bottom of your file
  await runProcess(pythonPath, args, env);
}


function runPowerShell(script) {
  return runProcess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
}

function runProcess(command, args = [], env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else {
        const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
        reject(new Error(details || `${command} exited with ${code}`));
      }
    });
  });
}

function modelIdFromHuggingFaceUrl(url = "") {
  const parts = String(url).replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : "LiquidAI/LFM2.5-Audio-1.5B-JP";
}

function liquidAiTokenLimit(text = "") {
  const length = [...String(text)].filter((char) => !/\s/u.test(char)).length;
  return Math.max(160, Math.min(384, length * 18));
}

function mnemonicSvg({ expression = "", reading = "", meaning = "", source = "" } = {}) {
  const hue = parseInt(hashKey([expression]).slice(0, 2), 16);
  const accent = `hsl(${hue}, 68%, 54%)`;
  const meaningLines = wrapText(stripHtml(meaning || "No definition"), 30, 3);
  const sourceLine = stripHtml(source).slice(0, 42);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480" viewBox="0 0 720 480">
  <rect width="720" height="480" fill="#111216"/>
  <rect x="28" y="28" width="664" height="424" rx="18" fill="#18191f" stroke="#2a2c33"/>
  <rect x="28" y="28" width="8" height="424" fill="${accent}"/>
  <text x="64" y="132" fill="#f4f1eb" font-family="Yu Gothic, Meiryo, sans-serif" font-size="88" font-weight="700">${escapeXml(expression)}</text>
  <text x="68" y="176" fill="#f97316" font-family="Yu Gothic, Meiryo, sans-serif" font-size="30">${escapeXml(reading)}</text>
  ${meaningLines.map((line, index) => `<text x="68" y="${258 + index * 42}" fill="#d8d2c8" font-family="Yu Gothic, Meiryo, sans-serif" font-size="30">${escapeXml(line)}</text>`).join("\n  ")}
  <text x="68" y="414" fill="#777b84" font-family="Yu Gothic, Meiryo, sans-serif" font-size="20">${escapeXml(sourceLine)}</text>
</svg>`;
}

function hashKey(values = []) {
  return createHash("sha256").update(values.map((value) => String(value ?? "")).join("\u0001")).digest("hex").slice(0, 20);
}

function psString(value = "") {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripHtml(value = "") {
  return String(value).replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim();
}

function wrapText(value = "", max = 30, lines = 3) {
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return [];
  const output = [];
  let remaining = text;
  while (remaining && output.length < lines) {
    if (remaining.length <= max) {
      output.push(remaining);
      break;
    }
    const slice = remaining.slice(0, max + 1);
    const breakAt = Math.max(slice.lastIndexOf(" "), Math.floor(max * 0.7));
    output.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }
  if (remaining && output.length === lines) output[output.length - 1] = `${output[output.length - 1].replace(/\.*$/, "")}...`;
  return output;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeVoiceModel(model = {}) {
  const id = String(model.id ?? "").trim();
  const url = String(model.url ?? "").trim();
  const name = String(model.name ?? "").trim() || url.split("/").filter(Boolean).slice(-2).join("/");
  if (!id || !url || !name) return null;
  return {
    id,
    name,
    url,
    provider: String(model.provider ?? "huggingface"),
    status: String(model.status ?? "imported"),
    note: String(model.note ?? "")
  };
}

function withRuntimeStatus(models = [], runtimeInstalled = false) {
  return models.map((model) => ({
    ...model,
    status: runtimeInstalled ? "ready" : model.status,
    note: runtimeInstalled ? "LiquidAI runtime installed locally." : model.note
  }));
}
