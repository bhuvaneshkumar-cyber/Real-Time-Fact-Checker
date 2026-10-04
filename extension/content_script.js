// In-page panel: reads YouTube captions, receives tab-audio transcripts and selection checks from
// background.js, and shows the verdicts. Injected statically on YouTube, on demand elsewhere.
(() => {
  'use strict';

  const POLL_MS = 500;         // caption sampling interval
  const PAUSE_MS = 3000;       // speaker pause: send what we have
  const MAX_CHUNK_MS = 15000;  // continuous speech: send at least this often
  const MIN_CHARS = 60;        // shorter text rarely holds a whole claim: keep accumulating
  const MAX_CARDS = 30;

  const svg = (d) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  const ICONS = {
    filter: svg('M3 5h18l-7 8v6l-4-2v-4z'),
    clear: svg('M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'),
    min: svg('M6 9l6 6 6-6'),
  };

  document.getElementById('fact-checker-root')?.remove(); // replace a stale copy (extension was reloaded)

  let root, panel, cards, dot, statusEl, countsEl, filterBtn, lastStatus;
  let words = [], tail = [], chunkStart = 0, chunkTime = null;
  let pauseTimer, pollTimer, pending = 0;
  let audio = 'off', audioDetail = '';
  let settings = { captions: true, onlyIssues: false };

  // ── Panel ──

  function ui() {
    if (root) return;
    root = document.createElement('fact-checker-root'); // custom tag + closed shadow: page CSS can't reach in
    root.id = 'fact-checker-root';
    const shadow = root.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <link rel="stylesheet" href="${chrome.runtime.getURL('styles.css')}">
      <section class="panel" aria-label="Fact checker">
        <header>
          <span class="dot"></span>
          <div class="title"><strong>Fact Checker</strong><span class="status"></span></div>
          <span class="counts"></span>
          <button class="icon" data-act="filter" title="Only false &amp; misleading" aria-label="Only false and misleading">${ICONS.filter}</button>
          <button class="icon" data-act="clear" title="Clear" aria-label="Clear results">${ICONS.clear}</button>
          <button class="icon" data-act="min" title="Minimize" aria-label="Minimize">${ICONS.min}</button>
        </header>
        <div class="cards" aria-live="polite"></div>
      </section>`;
    panel = shadow.querySelector('.panel');
    cards = shadow.querySelector('.cards');
    dot = shadow.querySelector('.dot');
    statusEl = shadow.querySelector('.status');
    countsEl = shadow.querySelector('.counts');
    filterBtn = shadow.querySelector('[data-act="filter"]');
    lastStatus = null;
    shadow.addEventListener('click', onClick);
    mount();
  }

  function onClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'filter') chrome.storage.local.set({ onlyIssues: !settings.onlyIssues });
    if (act === 'clear') cards.replaceChildren();
    if (act === 'min') panel.classList.toggle('min');
    if (act === 'cc') document.querySelector('.ytp-subtitles-button')?.click();
    if (btn.dataset.seek) {
      const media = document.querySelector('video, audio');
      if (media) media.currentTime = Number(btn.dataset.seek);
    }
    refresh();
  }

  // Fullscreen hides everything outside the fullscreen element, so move the panel into it.
  function mount() {
    if (!root) return;
    const fs = document.fullscreenElement;
    const host = fs && !/^(VIDEO|IFRAME)$/.test(fs.tagName) ? fs : document.body;
    if (root.parentNode !== host) host.appendChild(root);
    root.classList.toggle('fs', host !== document.body);
  }
  document.addEventListener('fullscreenchange', mount);

  function refresh() {
    if (!root) return;
    if (!cards.children.length && !pollTimer && audio === 'off') { // nothing to show: get out of the way
      root.remove();
      root = null;
      return;
    }
    let state = 'idle', html = 'Idle';
    if (audio === 'loading') [state, html] = ['busy', fcEsc(audioDetail || 'Loading speech model…')];
    else if (audio === 'listening') [state, html] = ['live', 'Listening to tab audio'];
    else if (pollTimer) {
      const ccOn = document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') === 'true';
      [state, html] = ccOn ? ['live', 'Reading captions'] : ['busy', 'Captions are off · <button data-act="cc">Turn on</button>'];
    }
    if (pending) html += ` · checking ${pending}…`;
    const counts = Object.entries({ TRUE: '✓', FALSE: '✗', MISLEADING: '!', UNVERIFIABLE: '?' }).map(([v, sym]) => {
      const n = cards.querySelectorAll(`.card[data-verdict="${v}"]`).length;
      return n ? `<span class="count" data-verdict="${v}" title="${FC_LABELS[v]}">${sym} ${n}</span>` : '';
    }).join('');
    const next = state + html + counts + settings.onlyIssues;
    if (next === lastStatus) return; // runs every poll: skip identical repaints
    lastStatus = next;
    dot.className = 'dot ' + state;
    statusEl.innerHTML = html;
    countsEl.innerHTML = counts;
    panel.classList.toggle('issues', settings.onlyIssues);
    filterBtn.setAttribute('aria-pressed', settings.onlyIssues);
  }

  function addCard(cls, html) {
    ui();
    const card = document.createElement('article');
    card.className = 'card ' + cls;
    card.innerHTML = html;
    cards.prepend(card);
    trim();
    return card;
  }

  function trim() {
    while (cards.children.length > MAX_CARDS) cards.lastElementChild.remove();
  }

  function fadeOut(card, ms) {
    setTimeout(() => {
      card.classList.add('gone');
      setTimeout(() => { card.remove(); refresh(); }, 300);
    }, ms);
  }

  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  const clock = (t) => {
    const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  };
  const timeChip = (t) => (t == null ? '' : `<button class="time" data-seek="${t}" title="Jump to this moment">${clock(t)}</button>`);

  // ── Checking ──

  async function check(text, time = null, label = 'Heard') {
    pending++;
    const card = addCard('pending', `
      <div class="row"><span class="spinner"></span>Checking…<span class="meta">${timeChip(time)}</span></div>
      <p class="heard">${label}: “${fcEsc(clip(text, 160))}”</p>`);
    refresh();

    const res = await send({ action: 'factCheck', text, videoTitle: pageTitle() });
    pending--;
    if (!res) return;
    if (res.error) {
      card.className = 'card error';
      card.innerHTML = `<p>${fcEsc(res.error)}</p>`;
      fadeOut(card, 12000);
    } else if (!res.data.results.length) {
      card.className = 'card empty';
      card.innerHTML = `<p class="heard">No checkable claims in “${fcEsc(clip(text, 90))}”</p>`;
      fadeOut(card, 4000);
    } else {
      const meta = timeChip(time) + `<span>${(res.data.processingTimeMs / 1000).toFixed(1)}s</span>`;
      card.replaceWith(...res.data.results.map((r) => fcResultCard(r, meta)));
      if (root) trim();
    }
    refresh();
  }

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (!chrome.runtime?.id) { teardown(); return null; } // extension reloaded: this copy is orphaned
      return { error: e.message };
    }
  }

  function pageTitle() {
    return document.title.replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, '').trim().slice(0, 300) || null;
  }

  function videoTime(lag) {
    const media = document.querySelector('video, audio');
    return media?.duration ? Math.max(0, Math.floor(media.currentTime - lag)) : null;
  }

  // ── Text accumulation (captions and tab audio) ──

  function addText(text, isAudio = false) {
    const incoming = text.split(/\s+/).filter(Boolean);
    const key = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    // Captions roll and audio windows overlap: skip the longest prefix that repeats the last words taken.
    // `tail` outlives flushes, so text still on screen after a send isn't sent twice.
    let k = Math.min(incoming.length, tail.length);
    while (k > 0 && !incoming.slice(0, k).every((w, i) => key(w) === key(tail[tail.length - k + i]))) k--;
    const fresh = incoming.slice(k);
    if (!fresh.length) return;

    tail = tail.concat(fresh).slice(-40);
    if (!words.length) {
      chunkStart = Date.now();
      chunkTime = videoTime(isAudio ? 10 : 2); // audio arrives ~8 s window + inference after it was spoken
    }
    words.push(...fresh);
    clearTimeout(pauseTimer);
    if (isAudio || Date.now() - chunkStart >= MAX_CHUNK_MS) flush();
    else pauseTimer = setTimeout(flush, PAUSE_MS);
  }

  function flush() {
    clearTimeout(pauseTimer);
    const text = words.join(' ');
    if (text.length < MIN_CHARS) return;
    words = [];
    check(text, chunkTime);
  }

  function poll() {
    if (!chrome.runtime?.id) return teardown();
    const text = [...document.querySelectorAll('.ytp-caption-segment')].map((s) => s.textContent).join(' ').trim();
    if (text) addText(text);
    refresh();
  }

  function syncCaptions() {
    const want = settings.captions && audio === 'off'
      && location.hostname.endsWith('youtube.com') && location.pathname === '/watch';
    if (want && !pollTimer) { ui(); pollTimer = setInterval(poll, POLL_MS); }
    if (!want && pollTimer) { clearInterval(pollTimer); pollTimer = null; flush(); }
    refresh();
  }

  function teardown() {
    clearInterval(pollTimer);
    clearTimeout(pauseTimer);
    root?.remove();
  }

  // ── Wiring ──

  document.addEventListener('yt-navigate-finish', () => { // YouTube navigates without reloading
    flush();
    words = []; tail = [];
    syncCaptions();
  });

  chrome.storage.local.get(settings).then((s) => { settings = s; syncCaptions(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue;
    syncCaptions();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.action === 'transcript') addText(msg.text, true);
    else if (msg.action === 'checkText') { ui(); check(msg.text.slice(0, 5000), null, 'Selected'); }
    else if (msg.action === 'audioStatus') {
      audio = msg.state;
      audioDetail = msg.detail || '';
      if (audio === 'off') {
        flush();
        if (audioDetail) fadeOut(addCard('error', `<p>${fcEsc(audioDetail)}</p>`), 12000);
      } else ui();
      syncCaptions();
    } else if (msg.action !== 'ping') return;
    reply(true); // background treats a missing reply as "no content script here"
  });
})();
