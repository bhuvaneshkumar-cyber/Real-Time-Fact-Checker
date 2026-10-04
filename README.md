# Real-Time Fact Checker

A Chrome extension plus a small local backend that fact-checks what is being said while you watch,
using an LLM that runs on your own machine through [Ollama](https://ollama.com). Nothing leaves your computer
unless you turn on web search.

Three ways in:

- **YouTube captions**: on any `youtube.com/watch` page with CC on, captions are read, buffered and checked automatically.
- **Any tab's audio**: *Listen to this tab* in the popup captures the tab's sound, transcribes it locally with
  Whisper-tiny (transformers.js), and checks the transcript. You keep hearing the tab while it listens.
- **Selected text**: select text on any page, right-click, then *Fact-check "…"*. Or paste a statement into the popup.

Verdicts appear in a floating panel on the page: **True / False / Misleading / Unverifiable**, a one-line
explanation, a confidence level, and a timestamp you can click to jump back to that moment in the video.

## Setup

**1. Ollama and the model**

```bash
ollama pull llama3.2:3b
```

**2. Backend** (Python 3.12+)

```bash
cd backend
python -m venv venv
venv\Scripts\activate          # macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
copy .env.example .env         # macOS/Linux: cp .env.example .env
uvicorn app.main:app --port 8001
```

The model is loaded into memory at startup, so the first check is as fast as the rest.

**3. Extension**

Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `extension/` folder.
Pin the icon. The popup shows **Ready** when the backend and the model are both up. If something is missing,
it shows the exact command that fixes it.

## Using it

| Where | What you get |
|---|---|
| Popup | Backend and model status, **Listen to this tab** / **Stop**, the *Auto-check YouTube captions* switch, a box to check any statement (Ctrl+Enter) |
| Page panel | Live status (reading captions / listening / downloading speech model), verdict counts, cards newest first. Buttons: filter to *false & misleading only*, clear, minimize. Follows the video into fullscreen. |
| Right-click | *Fact-check "selection"* on any page |

The first time you click *Listen to this tab*, the Whisper model (~40 MB) downloads once, with progress shown.
After that it loads from the browser cache.

## Picking the model

`backend/benchmark_models.py` runs the real pipeline over 17 labelled transcript snippets (true facts, popular
myths, a mixed true+false sentence, pure filler) and reports accuracy and warm latency per model:

```bash
cd backend
python benchmark_models.py                  # every installed Ollama model
python benchmark_models.py llama3.2:3b      # or specific ones
```

Results on an i5-13420H laptop, 16 GB RAM, CPU only (no GPU):

| Model | Accuracy | Median latency per chunk |
|---|---|---|
| **llama3.2:3b** (default) | **17/17** | **4.0 s** |
| qwen2.5:3b | 15/16 (first 16 cases) | 4.1 s |
| gemma2:2b | 14/16 (first 16 cases) | 5.5 s |
| granite4:tiny-h | 8/10 (first 10 cases) | 5.5 s |
| granite3-moe:3b (old default) | 7/10 (first 10 cases) | 2.3 s |
| granite3.1-moe:3b, qwen2.5:1.5b, gemma3:1b | 4–5/10 (first 10 cases) | 2–4 s |

The smaller and MoE models are faster but call obvious myths true (for example "water boils at 50 °C"),
so they aren't usable as fact checkers. On a machine with a GPU, re-run the benchmark: bigger models become affordable.

Known limit of a 3B model: when one chunk holds several claims, a true *numeric* claim that follows a false
claim can be mis-judged, while the explanation still gives the right figure. Read the explanation, not just the
badge. `USE_SEARCH=true` or a larger model reduces this.

## How it works

```
YouTube captions ─┐
tab audio ─ Whisper (offscreen doc) ─┤→ content script: word-level de-dup, ~3–15 s chunks
selected text ────┘            │
                               ▼
              background.js ── POST /api/v1/fact-check ──▶ FastAPI ──▶ Ollama
                                                            one LLM call per chunk:
                                                            extract ≤3 claims + judge each,
                                                            JSON-schema constrained
```

- **One LLM call per chunk.** Claim extraction and judgement happen together, and Ollama's JSON-schema
  mode makes the output always parseable. The earlier design made 1 + N calls and took 5–90 s per chunk.
- **Captions de-dup.** YouTube captions roll, and Whisper windows overlap by 2 s. The content script skips
  the longest run of words that repeats what it already took, so nothing is checked twice.
- **Optional web search.** `USE_SEARCH=true` re-judges each claim against DuckDuckGo results, adds a
  source link, and costs one search plus one extra LLM call.

## Configuration (`backend/.env`)

| Variable | Default | Notes |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | `ollama` or `nim` |
| `OLLAMA_MODEL` | `llama3.2:3b` | any pulled model; see the benchmark above |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | |
| `OLLAMA_KEEP_ALIVE` | `30m` | how long the model stays in RAM after the last request |
| `NIM_API_KEY` / `NIM_MODEL` / `NIM_BASE_URL` | — / `meta/llama-3.1-8b-instruct` / NVIDIA API | hosted alternative |
| `USE_SEARCH` | `false` | ground verdicts in web results |
| `SEARCH_MAX_RESULTS` | `3` | results per claim |
| `REQUEST_TIMEOUT` | `60` | seconds per LLM call |
| `LLM_MAX_TOKENS` | `400` | output cap per call |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Popup says **Offline** | Start the backend: `uvicorn app.main:app --port 8001` from `backend/` |
| Popup says **LLM down** / **No model** | Start Ollama, or `ollama pull <model>` as shown |
| Panel says *Captions are off* | Click **Turn on** in the panel, or use *Listen to this tab* for videos without captions |
| *Listen* fails on a page | Chrome pages (`chrome://`, the Web Store) can't be captured |
| Results stop after a page reload | Click *Listen to this tab* again; capture is tied to the page you started it on |

## Layout

```
backend/
  app/main.py          API: /health, /api/v1/fact-check
  app/checker.py       prompt, LLM call, JSON parsing, optional search
  app/config.py        settings from .env
  benchmark_models.py  model accuracy/latency benchmark
extension/
  manifest.json
  background.js        backend proxy, tab-capture lifecycle, context menu
  content_script.js    caption reader, text buffering, in-page panel
  offscreen.js         tab audio → Whisper → transcripts
  popup.html/.js       popup UI
  ui.js, styles.css    shared card rendering and styles
  lib/transformers.min.js
```
