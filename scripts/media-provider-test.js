import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalMediaProvider, mediaFilenamesFromFields, normalizeMediaSettings } from "../src/backend/media-providers.js";

const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "media-provider-test-"));

let settings = normalizeMediaSettings({
  image: { enabled: true },
  audio: { enabled: false }
});

const provider = createLocalMediaProvider({
  getSettings: () => settings,
  mediaDir
});

const firstImage = await provider.createImage({
  expression: "図書館",
  reading: "としょかん",
  meaning: "library",
  source: "Test Book"
});
const secondImage = await provider.createImage({
  expression: "図書館",
  reading: "としょかん",
  meaning: "library",
  source: "Test Book"
});
assert.equal(firstImage, secondImage);
assert.match(firstImage, /<img src="kanji-reader-image-[a-f0-9]+\.svg">/);

const imageFilename = mediaFilenamesFromFields({ Image: firstImage })[0];
const imagePath = path.join(mediaDir, "anki-media", imageFilename);
const svg = await fs.readFile(imagePath, "utf8");
assert(svg.includes("図書館"));
assert(svg.includes("library"));

settings = normalizeMediaSettings({ image: { enabled: false }, audio: { enabled: false } });
assert.equal(await provider.createImage({ expression: "図書館" }), "");
assert.equal(await provider.createAudio({ expression: "図書館" }), "");

const importedModelSettings = normalizeMediaSettings({
  audio: { enabled: true, voiceModelId: "lfm-jp" },
  voiceModels: [{
    id: "lfm-jp",
    name: "LiquidAI/LFM2.5-Audio-1.5B-JP",
    url: "https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B-JP"
  }]
});
assert.equal(importedModelSettings.voiceModels[0].provider, "huggingface");
assert.equal(importedModelSettings.audio.voiceModelId, "lfm-jp");

console.log("Media provider test passed.");
