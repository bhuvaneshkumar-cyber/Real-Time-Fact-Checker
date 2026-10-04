// Offscreen document: captures the tab's audio, transcribes it locally with Whisper,
// and posts transcripts to background.js. Closing this document stops everything.
import { pipeline, env } from './lib/transformers.min.js';

env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1; // extension pages aren't cross-origin isolated: no WASM threads

const RATE = 16000;        // Whisper wants 16 kHz mono
const CHUNK = RATE * 8;    // 8 s windows give Whisper enough context not to hallucinate
const OVERLAP = RATE * 2;  // carried into the next window so boundary words aren't cut (content script de-dupes)
const SILENCE = 0.005;     // mean |amplitude| below this: skip the window

const post = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});
const status = (state, detail) => post({ action: 'audioStatus', state, detail });

start().catch((e) => status('error', `Audio capture failed: ${e.message}`));

async function start() {
  // Claim the stream before loading the model: tab-capture stream IDs expire within seconds.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: location.hash.slice(1) } },
  });
  stream.getAudioTracks()[0].addEventListener('ended', () => status('off', ''));

  // Capturing a tab mutes it: play it back so the user still hears it, at full quality.
  const speakers = new AudioContext();
  speakers.createMediaStreamSource(stream).connect(speakers.destination);

  status('loading', 'Loading speech model…');
  const files = {};
  let shown = -1;
  const transcribe = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
    progress_callback: (p) => { // first run only: later runs load from the browser cache
      if (p.status !== 'progress') return;
      files[p.file] = [p.loaded, p.total];
      const [loaded, total] = Object.values(files).reduce((a, f) => [a[0] + f[0], a[1] + f[1]], [0, 0]);
      const pct = Math.floor((loaded / total) * 100);
      if (pct !== shown) status('loading', `Downloading speech model… ${(shown = pct)}%`);
    },
  });
  status('listening', 'Listening to tab audio');

  const ctx = new AudioContext({ sampleRate: RATE });
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  ctx.createMediaStreamSource(stream).connect(processor);
  processor.connect(ctx.destination); // outputs silence, but onaudioprocess only fires while connected

  let parts = [], size = 0, busy = false;
  processor.onaudioprocess = async (e) => {
    const input = e.inputBuffer.getChannelData(0);
    parts.push(new Float32Array(input)); // copy: the input buffer is reused
    size += input.length;
    if (size < CHUNK || busy) return;

    const audio = new Float32Array(size);
    let offset = 0;
    for (const p of parts) { audio.set(p, offset); offset += p.length; }
    parts = [audio.slice(-OVERLAP)];
    size = OVERLAP;
    if (audio.reduce((sum, x) => sum + Math.abs(x), 0) / audio.length < SILENCE) return;

    busy = true;
    try {
      const text = clean((await transcribe(audio)).text);
      if (text) post({ action: 'transcript', text });
    } catch (err) {
      console.error('Fact Checker: transcription failed', err);
    } finally {
      busy = false;
    }
  };
}

// Whisper-tiny hallucinates on music and noise: strip sound tags, drop repetition loops.
function clean(raw) {
  const text = (raw || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪/g, ' ').replace(/\s+/g, ' ').trim();
  const words = text.toLowerCase().replace(/[^\w\s']/g, '').split(' ').filter(Boolean);
  const joined = words.join(' ');
  const looping = (words.length >= 6 && new Set(words).size / words.length < 0.45) // mostly repeats
    || /\b(\w+)(?: \1\b){3,}/.test(joined)                                       // word x4 in a row
    || /\b((?:\w+ ){1,4}\w+)(?: \1\b){2,}/.test(joined);                         // phrase x3 in a row
  return text.length > 15 && words.length >= 3 && !looping ? text : '';
}
