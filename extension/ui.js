// Card rendering shared by the in-page panel (content_script.js) and the popup.
// Top-level `var`/`function` only: this file can be injected twice into the same page.

var FC_LABELS = { TRUE: 'True', FALSE: 'False', MISLEADING: 'Misleading', UNVERIFIABLE: 'Unverifiable' };

function fcEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fcSourceLink(src) {
  try {
    const url = new URL(src);
    // http(s) only: never render a javascript: link that came out of model output
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `<a class="source" href="${fcEsc(url.href)}" target="_blank" rel="noopener noreferrer">${fcEsc(url.hostname)} ↗</a>`;
    }
  } catch {}
  return '';
}

/** One result card. `meta` is trusted HTML for the top-right corner (timestamp, latency). */
function fcResultCard(r, meta = '') {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.verdict = r.verdict;
  card.innerHTML = `
    <div class="row">
      <span class="verdict">${fcEsc(FC_LABELS[r.verdict] || r.verdict)}</span>
      <span>${fcEsc((r.confidence || '').toLowerCase())} confidence</span>
      <span class="meta">${meta}</span>
    </div>
    <p class="claim">${fcEsc(r.claim)}</p>
    <p class="why">${fcEsc(r.explanation)}</p>
    ${fcSourceLink(r.source)}`;
  return card;
}
