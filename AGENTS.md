# Real-Time Fact Checker

A Chrome extension plus a Python backend that fact-checks YouTube captions, any tab's audio (transcribed locally with Whisper), or selected text, using a local LLM through Ollama.

## Directory Layout
- `/backend`: FastAPI app. `app/main.py` (routes + request/response models), `app/checker.py` (prompt, LLM call, parsing, optional DuckDuckGo search), `app/config.py` (settings).
- `/extension`: Manifest V3 extension. The service worker proxies the backend and owns tab capture, an offscreen document runs Whisper (transformers.js), and the content script reads captions and renders the in-page panel inside a closed shadow root.

## Commands

### Backend
- **Install:** `cd backend && pip install -r requirements.txt`
- **Run:** `cd backend && uvicorn app.main:app --port 8001 --reload`
- **Parser self-check:** `cd backend && python -m app.checker`
- **Model benchmark (needs Ollama):** `cd backend && python benchmark_models.py [model ...]`
- Lint/type-check: not configured.

### Extension
- **Install:** `chrome://extensions` → Developer mode → Load unpacked → `/extension`. After editing, click reload on the extension card.
- **Use:** the popup has Listen to this tab, the captions switch, and a manual check box. Right-click a selection for *Fact-check*.

## Conventions & Gotchas
- **Config:** Pydantic `BaseSettings` in `backend/app/config.py`, read from `backend/.env`. `LLM_PROVIDER` is `ollama` (default) or `nim` (needs `NIM_API_KEY`).
- **Model:** default `llama3.2:3b`, picked with `benchmark_models.py` on a CPU-only machine. Smaller and MoE models called myths true. Re-benchmark before changing it.
- **One LLM call per chunk:** extraction and verdicts come back together. For Ollama the output is constrained by the JSON schema in `checker.py`. Verdicts: `TRUE | FALSE | MISLEADING | UNVERIFIABLE`.
- **Prompt wording is fragile at 3B:** a one-phrase change to `SYSTEM` moved the benchmark from 17/17 to 13/17. Re-run `benchmark_models.py` after any prompt edit.
- **No earlier transcript in the prompt:** `CONTEXT` carries only the video title. Sending previous chunks made the model re-check old claims (+5–10 s, wrong verdicts). `check()` also drops claims that share no meaningful word with the transcript.
- **Ollama via its OpenAI-compatible API:** `keep_alive` works; `options` such as `num_ctx` are ignored there.
- **No CORS on purpose:** the extension reaches the API through `host_permissions`. Adding CORS would let any web page call the local backend.
- **Port 8001** is hard-wired in `extension/background.js` (`API`) and `manifest.json` (`host_permissions`).
- **Message passing:** the content script and popup talk only to `background.js` (`factCheck`, `health`, `startCapture`, `stopCapture`). The offscreen document sends `audioStatus` / `transcript`, which the background forwards to the captured tab. Content-script handlers must `reply(true)`: the background treats no reply as "no content script, inject one".
- **Capture state** lives in `chrome.storage.session` (`capture`, `captureError`) so it survives service-worker restarts. The popup re-renders from it.
- **Content script:** declared for YouTube only. Other pages get it injected on demand via `activeTab`. `ui.js` is shared with the popup and must stay re-injectable (top-level `var`/`function` only).
- **Where things live:**
  - Backend endpoints: `backend/app/main.py`
  - Prompt and verdict logic: `backend/app/checker.py`
  - Popup UI: `extension/popup.html` and `extension/popup.js`
  - In-page panel and caption buffering: `extension/content_script.js`, styles in `extension/styles.css`
  - Audio transcription: `extension/offscreen.js`
