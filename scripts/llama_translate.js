import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_SYSTEM_PROMPT = "You are a professional localizer whose primary goal is to translate Japanese to English. You should use colloquial or slang or nsfw vocabulary if it makes the translation more accurate. Always respond in English.";
const DEFAULT_LLAMA_SERVER_PATH = "D:\\YomiApuriModels\\llama-tools\\b9785-cuda-13.3\\llama-server.exe";
const DEFAULT_ENDPOINT = "http://127.0.0.1:8094/v1/chat/completions";

const payload = JSON.parse(await readStdin() || "{}");
const text = String(payload.text ?? "").trim();
const messages = normalizeMessages(payload.messages);
if (!text && messages.length === 0) {
  process.stdout.write(`${JSON.stringify({ translation: "", text: "" })}\n`);
  process.exit(0);
}

const model = payload.model ?? {};
const modelPath = String(model.localPath ?? process.env.SUGOI_Q4_MODEL_PATH ?? "").trim();
if (!modelPath) throw new Error("No GGUF model path configured. Set SUGOI_Q4_MODEL_PATH or SUGOI_Q3_MODEL_PATH.");
if (!fs.existsSync(modelPath)) throw new Error(`Configured GGUF model was not found: ${modelPath}`);

const endpoint = String(model.localEndpoint ?? process.env.LOCAL_TRANSLATION_LLAMA_ENDPOINT ?? DEFAULT_ENDPOINT).trim();
const serverPath = String(process.env.LLAMA_SERVER_PATH ?? DEFAULT_LLAMA_SERVER_PATH).trim();
const serverPort = new URL(endpoint).port || "8094";
const defaultGpuLayers = process.platform === "win32" ? 24 : process.platform === "darwin" ? 16 : 16;
const gpuLayers = Math.max(0, Number(process.env.LLAMA_GPU_LAYERS ?? defaultGpuLayers) || 0);
const noWarmup = parseBoolean(process.env.LLAMA_NO_WARMUP);
const idleTimeoutSeconds = Math.max(0, Number(process.env.LLAMA_IDLE_TIMEOUT_SECONDS ?? 600) || 0);

const serverRuntime = await ensureServer({ endpoint, serverPath, modelPath, port: serverPort, gpuLayers, noWarmup });
const systemPrompt = String(payload.systemPrompt ?? model.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);
try {
  if (messages.length) {
    if (payload.stream) {
      await streamChatViaServer({
        endpoint,
        messages,
        systemPrompt,
        maxTokens: Number(payload.maxTokens) || 768,
        temperature: Number.isFinite(Number(payload.temperature)) ? Number(payload.temperature) : 0.2
      });
      process.exitCode = 0;
    } else {
      const answer = await chatViaServer({
        endpoint,
        messages,
        systemPrompt,
        maxTokens: Number(payload.maxTokens) || 768,
        temperature: Number.isFinite(Number(payload.temperature)) ? Number(payload.temperature) : 0.2
      });
      process.stdout.write(`${JSON.stringify({ text: answer })}\n`);
    }
  } else {
    const translation = await translateViaServer({ endpoint, text, systemPrompt });
    process.stdout.write(`${JSON.stringify({ translation })}\n`);
  }
} finally {
  await markServerActivity(serverRuntime);
  scheduleIdleShutdown(serverRuntime, idleTimeoutSeconds);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(data));
  });
}

async function ensureServer({ endpoint, serverPath, modelPath, port, gpuLayers = 0, noWarmup = false }) {
  const logDir = path.resolve("data", "llama");
  await mkdir(logDir, { recursive: true });
  const runtime = {
    port: String(port),
    pidPath: path.join(logDir, `llama-server-${port}.pid`),
    activityPath: path.join(logDir, `llama-server-${port}.activity`),
    killerPath: path.resolve("scripts", "llama_idle_killer.js")
  };
  if (await isReady(endpoint)) {
    await markServerActivity(runtime);
    return runtime;
  }
  if (!fs.existsSync(serverPath)) throw new Error(`llama-server was not found: ${serverPath}`);

  const logPath = path.join(logDir, `llama-server-${port}.log`);
  const out = fs.openSync(logPath, "a");
  const err = fs.openSync(logPath, "a");
  const serverArgs = [
    "--model", modelPath,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--ctx-size", String(process.env.LOCAL_TRANSLATION_CONTEXT_SIZE ?? 1536),
    "--parallel", "1",
    "--no-webui",
    "--flash-attn", "on"
  ];
  if (gpuLayers > 0) serverArgs.push("--n-gpu-layers", String(gpuLayers));
  if (noWarmup) serverArgs.push("--no-warmup");

  const child = spawn(serverPath, serverArgs, {
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true
  });
  child.unref();
  await writeFile(runtime.pidPath, String(child.pid));
  await markServerActivity(runtime);

  const deadline = Date.now() + Number(process.env.LOCAL_TRANSLATION_SERVER_STARTUP_MS ?? 180000);
  while (Date.now() < deadline) {
    if (await isReady(endpoint)) return runtime;
    await sleep(1500);
  }
  throw new Error(`llama-server did not become ready in time. See ${logPath}`);
}

async function markServerActivity(runtime) {
  if (!runtime?.activityPath) return;
  await writeFile(runtime.activityPath, new Date().toISOString());
}

function scheduleIdleShutdown(runtime, timeoutSeconds) {
  if (!runtime?.pidPath || !runtime?.activityPath || !runtime?.killerPath || timeoutSeconds <= 0) return;
  const child = spawn(process.execPath, [
    runtime.killerPath,
    "--pid-file", runtime.pidPath,
    "--activity-file", runtime.activityPath,
    "--timeout-seconds", String(timeoutSeconds)
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

async function isReady(endpoint) {
  try {
    const url = new URL(endpoint);
    url.pathname = "/health";
    url.search = "";
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "local", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
        signal: AbortSignal.timeout(1500)
      });
      return response.ok || response.status === 400;
    } catch {
      return false;
    }
  }
}

async function translateViaServer({ endpoint, text, systemPrompt }) {
  const maxTokens = Math.max(96, Math.min(768, Math.ceil(text.length * 1.8) + 64));
  return chatViaServer({
    endpoint,
    systemPrompt,
    messages: [{ role: "user", content: text }],
    temperature: 0.1,
    maxTokens
  });
}

async function chatViaServer({ endpoint, messages, systemPrompt, maxTokens = 768, temperature = 0.2 }) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "local",
      messages: [
        { role: "system", content: systemPrompt },
        ...messages
      ],
      temperature,
      top_p: 0.95,
      top_k: 40,
      repeat_penalty: 1.1,
      max_tokens: Math.max(96, Math.min(1024, Number(maxTokens) || 768))
    }),
    signal: AbortSignal.timeout(Number(process.env.LOCAL_TRANSLATION_REQUEST_MS ?? 180000))
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`llama-server request failed with ${response.status}: ${body.slice(0, 600)}`);
  const parsed = JSON.parse(body);
  return cleanupTranslation(String(parsed.choices?.[0]?.message?.content ?? parsed.content ?? ""));
}

async function streamChatViaServer({ endpoint, messages, systemPrompt, maxTokens = 768, temperature = 0.2 }) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "local",
      messages: [
        { role: "system", content: systemPrompt },
        ...messages
      ],
      temperature,
      top_p: 0.95,
      top_k: 40,
      repeat_penalty: 1.1,
      max_tokens: Math.max(96, Math.min(1024, Number(maxTokens) || 768)),
      stream: true
    }),
    signal: AbortSignal.timeout(Number(process.env.LOCAL_TRANSLATION_REQUEST_MS ?? 180000))
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`llama-server stream failed with ${response.status}: ${body.slice(0, 600)}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("llama-server did not provide a stream.");
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) emitStreamLine(line);
  }
  if (buffer.trim()) emitStreamLine(buffer);
  process.stdout.write(`${JSON.stringify({ done: true })}\n`);
}

function emitStreamLine(line = "") {
  const trimmed = String(line ?? "").trim();
  if (!trimmed || !trimmed.startsWith("data:")) return;
  const data = trimmed.replace(/^data:\s*/, "");
  if (data === "[DONE]") return;
  try {
    const parsed = JSON.parse(data);
    const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? parsed.content ?? "";
    if (delta && !["<|im_end|>", "<|endoftext|>", "<|eot_id|>"].includes(delta)) {
      process.stdout.write(`${JSON.stringify({ delta })}\n`);
    }
  } catch {
    // Ignore keepalive or malformed stream lines from the local server.
  }
}

function normalizeMessages(value = []) {
  return (Array.isArray(value) ? value : [])
    .map((message) => ({
      role: message?.role === "assistant" ? "assistant" : "user",
      content: String(message?.content ?? "").trim()
    }))
    .filter((message) => message.content)
    .slice(-12);
}

function cleanupTranslation(value) {
  let cleaned = value.trim();
  for (const marker of ["<|im_end|>", "<|endoftext|>", "<|eot_id|>"]) {
    if (cleaned.includes(marker)) cleaned = cleaned.split(marker, 1)[0].trim();
  }
  return cleaned;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBoolean(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}
