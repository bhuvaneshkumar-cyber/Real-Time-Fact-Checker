# Real-Time Fact Checker

This repository contains a Chrome Extension and a Python backend that extracts audio and captions from videos (like YouTube) and verifies factual claims in real-time using Large Language Models (LLMs).

## Directory Layout
- `/backend`: Python FastAPI application handling LLM inference and web search.
- `/extension`: Chrome extension utilizing the Offscreen API, MutationObservers for captions, and Transformer.js for local Whisper audio transcription.

## Commands

### Backend
- **Install:** `cd backend && pip install -r requirements.txt`
- **Run:** `cd backend && uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload`
- **Test/Lint/Type-check:** Not currently configured.

### Frontend
- **Install:** Navigate to `chrome://extensions`, enable "Developer mode", and select "Load unpacked" on the `/extension` directory.
- **Run:** Click the extension icon and select "Start Listening to Tab".

## Conventions & Gotchas
- **Configuration:** Handled via Pydantic `BaseSettings` in `backend/app/config.py`. Uses `.env` for secrets.
- **Environment Variables:** Requires `LLM_PROVIDER` (either `ollama` or `nim`). If using NIM, `NIM_API_KEY` is required. If using Ollama, ensure it is running locally on port 11434.
- **Port:** The backend and frontend are hard-wired to communicate over port `8001` by default.
- **Message Passing:** The extension relies heavily on `chrome.runtime.sendMessage`. The content script sends proxy requests to `background.js`, which then queries the FastAPI backend.
- **Where things live:**
  - Backend endpoints: `backend/app/routers/`
  - Frontend popup UI: `extension/popup.html` & `extension/popup.js`
  - Audio transcription logic: `extension/offscreen.js`
