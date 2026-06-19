# Anki Kanji Reader

A local-first full-stack reader for Japanese novels in PDF and EPUB format.

## What it does

- Imports PDF, EPUB, or plain text files.
- Tokenizes Japanese text and adds furigana for vocabulary that has not appeared in your known Anki vocabulary list.
- Tracks reading progress per document.
- Generates draft Anki cards with sentence context, readings, AI-ready audio/image prompts, and flexible field mapping for uploaded note templates.
- Recognizes common conjugated forms by comparing token dictionary forms against known vocabulary.

## Run

```powershell
npm install
npm run dev
```

Open `http://localhost:3000`.

## Known Vocabulary

Export reviewed Anki notes as CSV or text and upload them in the app. The importer accepts one vocabulary term per line or comma/tab-separated rows. The first non-empty Japanese-looking value on each row is treated as the term.

The app treats a word as learned when either the surface form or dictionary form has been imported. For example, if `食べる` is known, `食べました` is handled as learned because Kuromoji resolves it to `食べる`.

## AI media

This MVP creates audio and image prompts for each generated card. The server endpoint is isolated so an OpenAI, Azure, local TTS, or image-generation provider can be added without changing the reader UI.
