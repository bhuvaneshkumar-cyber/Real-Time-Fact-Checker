const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
let tab;

async function refreshHealth() {
  $('health').textContent = '…';
  const { data: h, error } = await send({ action: 'health' });
  let state = 'ok', label = 'Ready', hint = '';
  if (error) {
    [state, label, hint] = ['bad', 'Offline', 'Start the backend:<code>cd backend &amp;&amp; uvicorn app.main:app --port 8001</code>'];
  } else if (h.llm === 'down') {
    [state, label, hint] = ['warn', 'LLM down', h.provider === 'ollama'
      ? 'Ollama isn\'t running. Open the Ollama app, or run:<code>ollama serve</code>'
      : 'Can\'t reach NVIDIA NIM. Check NIM_API_KEY and your connection.'];
  } else if (h.llm === 'model-missing') {
    [state, label, hint] = ['warn', 'No model', `The model isn't downloaded yet:<code>ollama pull ${fcEsc(h.model)}</code>`];
  }
  $('health').className = 'pill ' + state;
  $('health').textContent = label;
  $('model').textContent = h ? `${h.model} · ${h.provider}${h.search ? ' · web search' : ''}` : 'Backend not reachable';
  $('hint').innerHTML = hint;
  $('hint').hidden = !hint;
}

async function renderCapture() {
  const { capture, captureError } = await chrome.storage.session.get(['capture', 'captureError']);
  const here = capture?.tabId === tab.id;
  const btn = $('listen');
  btn.disabled = false;
  btn.textContent = here ? 'Stop listening' : capture ? 'Listen to this tab instead' : 'Listen to this tab';
  btn.classList.toggle('danger', here);
  $('captureStatus').textContent = here ? capture.detail
    : capture ? 'Already listening to another tab.'
    : captureError || 'Transcribes this tab\'s audio on your machine with Whisper. Works on any site.';
  $('captureStatus').classList.toggle('error', !capture && !!captureError);
}

$('listen').addEventListener('click', async () => {
  const { capture } = await chrome.storage.session.get('capture');
  $('listen').disabled = true;
  await send(capture?.tabId === tab.id ? { action: 'stopCapture' } : { action: 'startCapture', tabId: tab.id });
  renderCapture(); // errors are stored in session storage by the background
});

$('captions').addEventListener('change', (e) => chrome.storage.local.set({ captions: e.target.checked }));

async function checkText() {
  const text = $('text').value.trim();
  if (!text) return $('text').focus();
  $('check').disabled = true;
  $('results').innerHTML = '<article class="card"><div class="row"><span class="spinner"></span>Checking…</div></article>';
  const { data, error } = await send({ action: 'factCheck', text: text.slice(0, 5000) });
  $('check').disabled = false;
  if (error) $('results').innerHTML = `<article class="card error"><p>${fcEsc(error)}</p></article>`;
  else if (!data.results.length) $('results').innerHTML = '<article class="card empty"><p class="muted">No checkable factual claim found.</p></article>';
  else $('results').replaceChildren(...data.results.map((r) => fcResultCard(r, `${(data.processingTimeMs / 1000).toFixed(1)}s`)));
}

$('check').addEventListener('click', checkText);
$('text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) checkText(); });
$('health').addEventListener('click', refreshHealth);
chrome.storage.session.onChanged.addListener(renderCapture);

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { captions } = await chrome.storage.local.get({ captions: true });
  $('captions').checked = captions;
  renderCapture();
  refreshHealth();
})();
