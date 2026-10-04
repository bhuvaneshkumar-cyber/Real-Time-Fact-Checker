// Service worker: proxies the backend, owns tab-audio capture (via an offscreen document),
// and adds the "Fact-check selection" context menu.

const API = 'http://localhost:8001';

async function api(path, body) {
  let res;
  try {
    res = await fetch(API + path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) }
      : { signal: AbortSignal.timeout(5000) });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'The backend timed out.' : 'Backend offline. Start it: uvicorn app.main:app --port 8001');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Backend error ${res.status}`);
  return data;
}

// ── Tab audio capture ──
// State lives in storage.session so it survives service-worker restarts; the popup watches it.

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['ui.js', 'content_script.js'] });
  }
}

async function startCapture(tabId) {
  await stopCapture();
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await ensureContentScript(tabId);
    await chrome.storage.session.set({ capture: { tabId, state: 'loading', detail: 'Starting…' }, captureError: '' });
    // The stream ID rides in the URL, so the document has it the moment it loads (IDs expire in seconds).
    await chrome.offscreen.createDocument({
      url: 'offscreen.html#' + streamId,
      reasons: ['USER_MEDIA'],
      justification: 'Transcribe tab audio for live fact-checking',
    });
    chrome.action.setBadgeText({ text: 'ON' });
  } catch (e) {
    await stopCapture(e.message);
    throw e;
  }
}

async function stopCapture(error = '') {
  const { capture } = await chrome.storage.session.get('capture');
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument(); // releases stream + Whisper
  await chrome.storage.session.set({ capture: null, captureError: error });
  chrome.action.setBadgeText({ text: '' });
  if (capture) chrome.tabs.sendMessage(capture.tabId, { action: 'audioStatus', state: 'off', detail: error }).catch(() => {});
}

async function toCaptureTab(msg) {
  const { capture } = await chrome.storage.session.get('capture');
  if (!capture) return;
  try {
    await chrome.tabs.sendMessage(capture.tabId, msg);
  } catch {
    try { // page reloaded: re-inject once
      await ensureContentScript(capture.tabId);
      await chrome.tabs.sendMessage(capture.tabId, msg);
    } catch {
      await stopCapture('The page changed. Click "Listen to this tab" again.');
    }
  }
}

async function onAudioStatus({ state, detail }) {
  if (state === 'off' || state === 'error') return stopCapture(detail);
  const { capture } = await chrome.storage.session.get('capture');
  if (!capture) return;
  await chrome.storage.session.set({ capture: { ...capture, state, detail } });
  toCaptureTab({ action: 'audioStatus', state, detail });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const handlers = {
    factCheck: () => api('/api/v1/fact-check', { text: msg.text, videoTitle: msg.videoTitle }),
    health: () => api('/health'),
    startCapture: () => startCapture(msg.tabId),
    stopCapture: () => stopCapture(),
  };
  if (handlers[msg.action]) {
    handlers[msg.action]().then((data) => reply({ data }), (e) => reply({ error: e.message }));
    return true; // async reply
  }
  if (msg.action === 'transcript') toCaptureTab(msg);
  if (msg.action === 'audioStatus') onAudioStatus(msg);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { capture } = await chrome.storage.session.get('capture');
  if (capture?.tabId === tabId) stopCapture();
});

// ── Context menu ──

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'fact-check', title: 'Fact-check "%s"', contexts: ['selection'] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { action: 'checkText', text: info.selectionText });
  } catch (e) {
    console.warn('Fact Checker: cannot show results on this page:', e.message);
  }
});

chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
