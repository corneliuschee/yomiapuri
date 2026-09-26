import assert from "node:assert/strict";
import { createAiService, defaultAiSettings, normalizeAiSettings } from "../src/backend/ai-service.js";

let settings = normalizeAiSettings(defaultAiSettings());
const sample = "勉強します。";
const service = createAiService({
  getSettings: () => settings,
  saveSettings: async (next) => {
    settings = normalizeAiSettings(next);
  }
});

const providers = await service.providers();
assert.equal(providers.settings.translation.modelId, "sugoi-14b-ultra-q4-k-m");
assert.equal(providers.models.some((model) => model.id === "sugoi-14b-ultra-q3-k-m"), true);
assert.equal(providers.models.some((model) => model.id === "liquidai-lfm2-350m-enjp-mt"), false);
assert.equal(providers.models.some((model) => model.id === "sugoitoolkit-sugoi-14b-ultra-hf"), false);
assert.match(providers.models.find((model) => model.id === "sugoi-14b-ultra-q4-k-m").systemPrompt, /literary localizer/);
assert.equal(providers.status.translation.configured, false);

const missingTranslationRuntime = await service.translate({ text: sample });
assert.equal(missingTranslationRuntime.available, false);
assert.match(missingTranslationRuntime.reason, /runtime command/i);

const missingChatRuntime = await service.chat({ messages: [{ role: "user", content: "Explain this." }] });
assert.equal(missingChatRuntime.available, false);
assert.match(missingChatRuntime.reason, /runtime command/i);

const imported = await service.importModel({ url: "https://huggingface.co/example/custom-ja-en-model" });
assert.equal(imported.model.id, "example-custom-ja-en-model");
assert.equal(settings.translation.modelId, "example-custom-ja-en-model");

await service.updateSettings({ translation: { enabled: true } });
const missingRuntime = await service.translate({ text: sample });
assert.equal(missingRuntime.available, false);
assert.match(missingRuntime.reason, /runtime command/i);

const runtimeService = createAiService({
  getSettings: () => settings,
  saveSettings: async (next) => {
    settings = normalizeAiSettings(next);
  },
  runtimeCommand: "node -e \"let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const p=JSON.parse(s);const last=(p.messages||[]).at(-1)?.content||'';console.log(JSON.stringify({translation:'translated:'+p.text,text:'answered:'+last}))})\""
});
const translated = await runtimeService.translate({ text: sample });
assert.equal(translated.available, true);
assert.equal(translated.translatedText, `translated:${sample}`);

const chat = await runtimeService.chat({ intent: "explain", messages: [{ role: "user", content: "Follow up?" }] });
assert.equal(chat.available, true);
assert.equal(chat.text, "answered:Follow up?");

const streamRuntimeService = createAiService({
  getSettings: () => settings,
  saveSettings: async (next) => {
    settings = normalizeAiSettings(next);
  },
  runtimeCommand: "node -e \"let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{console.log(JSON.stringify({delta:'stream '}));console.log(JSON.stringify({delta:'answer'}));console.log(JSON.stringify({done:true}))})\""
});
const streamTokens = [];
const streamed = await streamRuntimeService.chatStream({
  intent: "ask",
  messages: [{ role: "user", content: "Stream?" }],
  onToken: (token) => streamTokens.push(token)
});
assert.equal(streamed.available, true);
assert.equal(streamed.text, "stream answer");
assert.deepEqual(streamTokens, ["stream ", "answer"]);

console.log("AI service test passed.");
