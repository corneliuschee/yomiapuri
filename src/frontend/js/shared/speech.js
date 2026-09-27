// Browser speech playback for dictionary entries.
import { state } from "../core/state.js";

function loadVoices() {
  state.voices = window.speechSynthesis.getVoices();
}

function bestJapaneseVoice(preferredName = "") {
  const voices = state.voices.length > 0 ? state.voices : window.speechSynthesis.getVoices();
  return voices.find((voice) => preferredName && voice.name === preferredName)
    || voices.find((voice) => voice.lang === "ja-JP" && /natural|nanami|haruka|google|microsoft/i.test(voice.name))
    || voices.find((voice) => voice.lang?.startsWith("ja"));
}

function playJapanese(text, options = {}) {
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ja-JP";
  utterance.rate = options.rate ?? 0.86;
  utterance.pitch = 0.98;
  const voice = bestJapaneseVoice(options.voiceName);
  if (voice) utterance.voice = voice;
  window.speechSynthesis.speak(utterance);
}

export { loadVoices };
