import assert from "node:assert/strict";
import { createAiService, defaultAiSettings, normalizeAiSettings } from "../server/ai-service.js";

let settings = normalizeAiSettings(defaultAiSettings());
const service = createAiService({
  getSettings: () => settings,
  saveSettings: async (next) => {
    settings = normalizeAiSettings(next);
  }
});

const providers = await service.providers();
assert.equal(providers.settings.translation.modelId, "liquidai-lfm2-350m-enjp-mt");
assert.equal(providers.status.translation.configured, false);

const disabled = await service.translate({ text: "勉強します。" });
assert.equal(disabled.available, false);
assert.match(disabled.reason, /disabled/i);

const imported = await service.importModel({ url: "https://huggingface.co/example/custom-ja-en-model" });
assert.equal(imported.model.id, "example-custom-ja-en-model");
assert.equal(settings.translation.modelId, "example-custom-ja-en-model");

await service.updateSettings({ translation: { enabled: true } });
const missingRuntime = await service.translate({ text: "勉強します。" });
assert.equal(missingRuntime.available, false);
assert.match(missingRuntime.reason, /runtime command/i);

const runtimeService = createAiService({
  getSettings: () => settings,
  saveSettings: async (next) => {
    settings = normalizeAiSettings(next);
  },
  runtimeCommand: "node -e \"let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const p=JSON.parse(s);console.log(JSON.stringify({translation:'translated:'+p.text}))})\""
});
const translated = await runtimeService.translate({ text: "勉強します。" });
assert.equal(translated.available, true);
assert.equal(translated.translatedText, "translated:勉強します。");

console.log("AI service test passed.");
