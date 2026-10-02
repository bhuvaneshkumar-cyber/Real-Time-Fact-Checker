// Content script for the Real-Time Fact Checker extension
// Handles YouTube caption scraping, text accumulation, and UI display.
// Also receives results from background script (Tab Capture / Whisper route).

(() => {
  'use strict';

  // ══════════════════════════════════════════════
  //  CONFIGURATION
  // ══════════════════════════════════════════════

  const CONFIG = {
    // YouTube caption selectors — ordered by specificity.
    // These ONLY match actual captions rendered by the YouTube player.
    YOUTUBE_CAPTION_SELECTORS: [
      '.ytp-caption-segment',
      '.caption-visual-line',
      '.captions-text span',
    ],

    // Caption accumulation timing
    CAPTION_PAUSE_FLUSH_MS: 4000,   // Flush buffer after 4s of no new captions (speaker paused)
    CAPTION_MAX_FLUSH_MS: 40000,    // Force-flush every 40s during continuous speech (prevents fragmentation)
    CAPTION_POLL_MS: 1500,          // Backup: poll for captions every 1.5s
    MIN_BUFFER_LENGTH: 80,          // Minimum characters before sending to backend

    // UI
    RESULT_DISPLAY_MS: 15000,       // Show result cards for 15 seconds
    MAX_VISIBLE_CARDS: 5,           // Maximum cards visible at once

    // CSS class names (must match styles.css)
    UI: {
      CONTAINER:    'fact-checker-container',
      ITEM:         'fact-checker-item',
      VERDICT_TRUE: 'fact-checker-verdict-true',
      VERDICT_FALSE:'fact-checker-verdict-false',
      VERDICT_LACKS:'fact-checker-verdict-lacks',
      CLAIM:        'fact-checker-claim',
      EXPLANATION:  'fact-checker-explanation',
      SOURCE:       'fact-checker-source',
      CLOSE_BUTTON: 'fact-checker-close',
    },
  };

  // ══════════════════════════════════════════════
  //  STATE
  // ══════════════════════════════════════════════

  const state = {
    container: null,
    statusEl: null,
    // Caption monitoring
    captionObserver: null,
    captionPollTimer: null,
    // Caption accumulation
    captionBuffer: '',
    lastCaptionFragment: '',
    pauseFlushTimer: null,
    maxFlushTimer: null,
    // Conversation context (rolling history of flushed captions)
    conversationContext: [],
    MAX_CONTEXT_ITEMS: 5,
    // Tracking
    activeRequests: 0,
    isMonitoring: false,
  };

  // ══════════════════════════════════════════════
  //  INITIALIZATION
  // ══════════════════════════════════════════════

  function initialize() {
    console.log('[FactChecker] Content script loaded on:', window.location.href);
    injectStyles();
    createUIContainer();
    setupMessageListener();
    checkAndSetupForCurrentPage();

    // Handle YouTube SPA navigation (page changes without full reload)
    if (window.location.hostname.includes('youtube.com')) {
      document.addEventListener('yt-navigate-finish', () => {
        console.log('[FactChecker] YouTube SPA navigation detected:', window.location.href);
        checkAndSetupForCurrentPage();
      });
    }
  }

  function checkAndSetupForCurrentPage() {
    const isYouTubeWatch =
      window.location.hostname.includes('youtube.com') &&
      window.location.pathname === '/watch';

    if (isYouTubeWatch && !state.isMonitoring) {
      console.log('[FactChecker] YouTube /watch page — starting caption monitor.');
      showStatus('🔍 Listening for captions... (enable CC if needed)');
      startCaptionMonitoring();
    } else if (!isYouTubeWatch && state.isMonitoring) {
      console.log('[FactChecker] Navigated away from /watch — stopping caption monitor.');
      stopCaptionMonitoring();
      hideContainerIfEmpty();
    } else if (!isYouTubeWatch && !state.isMonitoring) {
      // Non-watch page (or non-YouTube) — show brief hint, then hide
      showStatus('🎧 Click extension icon → "Start Listening" for audio capture');
      setTimeout(() => {
        hideStatus();
        hideContainerIfEmpty();
      }, 4000);
    }
  }

  // ══════════════════════════════════════════════
  //  STYLES & UI CONTAINER
  // ══════════════════════════════════════════════

  function injectStyles() {
    if (document.getElementById('fact-checker-styles')) return;
    const link = document.createElement('link');
    link.id = 'fact-checker-styles';
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = chrome.runtime.getURL('styles.css');
    document.head.appendChild(link);
  }

  function createUIContainer() {
    const existing = document.getElementById('fact-checker-container');
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.id = 'fact-checker-container';
    container.className = CONFIG.UI.CONTAINER;
    container.style.display = 'none'; // Hidden until we have content
    document.body.appendChild(container);
    state.container = container;
  }

  // ── Status indicator ──

  function showStatus(message) {
    if (!state.statusEl) {
      state.statusEl = document.createElement('div');
      state.statusEl.id = 'fact-checker-status';
      state.statusEl.className = 'fact-checker-status';
    }
    state.statusEl.textContent = message;

    // Ensure it's the first child of the container
    if (!state.statusEl.parentNode) {
      state.container.insertBefore(state.statusEl, state.container.firstChild);
    }
    state.container.style.display = ''; // Make container visible
  }

  function hideStatus() {
    if (state.statusEl && state.statusEl.parentNode) {
      state.statusEl.remove();
    }
  }

  function hideContainerIfEmpty() {
    if (state.container && state.container.children.length === 0) {
      state.container.style.display = 'none';
    }
  }

  // ══════════════════════════════════════════════
  //  YOUTUBE CAPTION MONITORING
  // ══════════════════════════════════════════════

  function startCaptionMonitoring() {
    if (state.isMonitoring) return;
    state.isMonitoring = true;

    // Method 1: MutationObserver — catches live caption DOM changes
    state.captionObserver = new MutationObserver(onDomMutation);
    state.captionObserver.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    // Method 2: Polling — backup in case MutationObserver misses updates
    state.captionPollTimer = setInterval(pollForCaptions, CONFIG.CAPTION_POLL_MS);

    // Periodic force-flush for continuous speech
    resetMaxFlushTimer();
  }

  function stopCaptionMonitoring() {
    state.isMonitoring = false;

    if (state.captionObserver) {
      state.captionObserver.disconnect();
      state.captionObserver = null;
    }
    if (state.captionPollTimer) {
      clearInterval(state.captionPollTimer);
      state.captionPollTimer = null;
    }
    clearTimeout(state.pauseFlushTimer);
    clearInterval(state.maxFlushTimer);

    // Flush any remaining buffer before stopping
    if (state.captionBuffer.trim().length >= CONFIG.MIN_BUFFER_LENGTH) {
      flushCaptionBuffer();
    }
    state.captionBuffer = '';
    state.lastCaptionFragment = '';
    state.conversationContext = []; // Clear context on stop
  }

  function onDomMutation() {
    const text = getCaptionText();
    if (text) accumulateCaption(text);
  }

  function pollForCaptions() {
    const text = getCaptionText();
    if (text) accumulateCaption(text);
  }

  /**
   * Extracts the currently visible YouTube caption text from the DOM.
   * Returns an empty string if no caption elements are found (e.g., CC is off).
   */
  function getCaptionText() {
    for (const selector of CONFIG.YOUTUBE_CAPTION_SELECTORS) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        const text = Array.from(elements)
          .map(el => el.textContent.trim())
          .filter(t => t.length > 0)
          .join(' ')
          .trim();
        if (text.length > 0) return text;
      }
    }
    return '';
  }

  // ══════════════════════════════════════════════
  //  CAPTION TEXT ACCUMULATION
  //
  //  Instead of sending each small caption fragment (often too short
  //  for the LLM to extract claims), we buffer text and flush it when:
  //    a) Captions pause for 3+ seconds (speaker pause), OR
  //    b) 12 seconds of continuous speech have elapsed (force-flush).
  // ══════════════════════════════════════════════

  function accumulateCaption(text) {
    // Skip if this is the exact same fragment we already captured
    if (text === state.lastCaptionFragment) return;
    state.lastCaptionFragment = text;

    // Append to buffer. Simple deduplication: only add if text isn't already
    // at the end of the buffer (handles YouTube's overlapping caption frames).
    if (state.captionBuffer.length === 0) {
      state.captionBuffer = text;
    } else {
      // Find the longest overlap between the end of the buffer and the start of the new text
      let overlap = 0;
      const minLen = Math.min(state.captionBuffer.length, text.length);
      for (let i = minLen; i > 0; i--) {
        if (state.captionBuffer.endsWith(text.substring(0, i))) {
          overlap = i;
          break;
        }
      }

      if (overlap > 0) {
        const newPart = text.substring(overlap).trim();
        if (newPart) {
          state.captionBuffer += (state.captionBuffer.endsWith(' ') ? '' : ' ') + newPart;
        }
      } else {
        state.captionBuffer += (state.captionBuffer.endsWith(' ') ? '' : ' ') + text;
      }
    }

    console.log(`[FactChecker] Buffer: ${state.captionBuffer.length} chars`);
    showStatus('🔍 Capturing captions...');

    // Reset the pause-flush timer (fires after 3s of silence)
    clearTimeout(state.pauseFlushTimer);
    state.pauseFlushTimer = setTimeout(flushCaptionBuffer, CONFIG.CAPTION_PAUSE_FLUSH_MS);
  }

  function resetMaxFlushTimer() {
    clearInterval(state.maxFlushTimer);
    state.maxFlushTimer = setInterval(() => {
      if (state.captionBuffer.trim().length >= CONFIG.MIN_BUFFER_LENGTH) {
        console.log('[FactChecker] Max-flush timer triggered (40s of speech).');
        flushCaptionBuffer();
      }
    }, CONFIG.CAPTION_MAX_FLUSH_MS);
  }

  function flushCaptionBuffer() {
    const text = state.captionBuffer.trim();
    state.captionBuffer = '';

    if (text.length < CONFIG.MIN_BUFFER_LENGTH) {
      console.log(`[FactChecker] Buffer too short (${text.length} chars), skipping.`);
      return;
    }

    console.log(`[FactChecker] Flushing ${text.length} chars: "${text.substring(0, 100)}..."`);

    // Show a "Processing..." card immediately so the user sees activity
    const cardId = 'fc-' + Date.now();
    const preview = text.length > 120 ? text.substring(0, 120) + '…' : text;
    displayProcessingCard(cardId, preview);
    showStatus('⏳ Analyzing claims with AI...');

    // Send accumulated text to the backend
    sendToBackend(text, cardId);

    // Add to context history
    state.conversationContext.push(text);
    if (state.conversationContext.length > state.MAX_CONTEXT_ITEMS) {
      state.conversationContext.shift();
    }
  }

  // ══════════════════════════════════════════════
  //  BACKEND COMMUNICATION
  // ══════════════════════════════════════════════

  function sendToBackend(text, cardId) {
    state.activeRequests++;
    const videoId = getYouTubeVideoId();
    
    // Attempt to get the video title (YouTube specific)
    let videoTitle = document.title.replace(/^\(\d+\)\s+/, '').replace(' - YouTube', '').trim();
    if (!videoTitle && document.querySelector('h1.ytd-watch-metadata')) {
        videoTitle = document.querySelector('h1.ytd-watch-metadata').textContent.trim();
    }

    const contextStr = state.conversationContext.join(' ');

    chrome.runtime.sendMessage(
      { 
        action: 'factCheck', 
        text, 
        videoId,
        videoTitle: videoTitle || null,
        context: contextStr || null
      },
      (response) => {
        state.activeRequests--;

        if (chrome.runtime.lastError) {
          console.error('[FactChecker] Runtime error:', chrome.runtime.lastError.message);
          updateCardWithError(cardId);
          restoreListeningStatus();
          return;
        }

        if (response && response.success) {
          console.log('[FactChecker] Backend response received.');
          updateCardWithResults(cardId, response.data);
        } else {
          console.warn('[FactChecker] Backend error:', response?.error);
          updateCardWithError(cardId);
        }

        restoreListeningStatus();
      }
    );
  }

  function restoreListeningStatus() {
    if (state.activeRequests === 0 && state.isMonitoring) {
      showStatus('🔍 Listening for captions...');
    }
  }

  // ══════════════════════════════════════════════
  //  MESSAGE LISTENER (Tab Capture / Whisper route)
  // ══════════════════════════════════════════════

  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'transcriptionProcessing') {
        displayProcessingCard(message.id, message.text);
      } else if (message.action === 'displayFactCheckResults') {
        updateCardWithResults(message.id, message.data);
      } else if (message.action === 'factCheckError') {
        updateCardWithError(message.id);
      }
    });
  }

  // ══════════════════════════════════════════════
  //  UI CARD RENDERING
  // ══════════════════════════════════════════════

  /** Shows an immediate "Processing..." card while waiting for the backend. */
  function displayProcessingCard(id, previewText) {
    state.container.style.display = ''; // Ensure container is visible

    const item = document.createElement('div');
    item.className = `${CONFIG.UI.ITEM} fact-checker-result`;
    item.id = id;
    item.innerHTML = `
      <div class="${CONFIG.UI.CLAIM}"><strong>Heard:</strong> ${escapeHtml(previewText)}</div>
      <div class="${CONFIG.UI.VERDICT_LACKS}">⏳ Analyzing...</div>
      <div class="${CONFIG.UI.EXPLANATION}">Sending to AI for fact-checking...</div>
      <button class="${CONFIG.UI.CLOSE_BUTTON}" aria-label="Close">×</button>
    `;
    bindCloseButton(item);
    state.container.appendChild(item);
    trimCards();
  }

  /** Updates a processing card with the final fact-check results. */
  function updateCardWithResults(id, factCheckResponse) {
    const processingCard = document.getElementById(id);

    // No verifiable claims found
    if (!factCheckResponse?.results?.length) {
      if (processingCard) {
        processingCard.innerHTML = `
          <div class="${CONFIG.UI.EXPLANATION}"><em>No verifiable claims found in that text.</em></div>
          <button class="${CONFIG.UI.CLOSE_BUTTON}" aria-label="Close">×</button>
        `;
        bindCloseButton(processingCard);
        setTimeout(() => removeCard(processingCard), 5000);
      }
      return;
    }

    // Replace processing card with the first result
    if (processingCard) {
      renderResultInCard(processingCard, factCheckResponse.results[0]);
      setTimeout(() => removeCard(processingCard), CONFIG.RESULT_DISPLAY_MS);
    }

    // Create additional cards for any remaining results
    for (let i = 1; i < factCheckResponse.results.length; i++) {
      const card = document.createElement('div');
      card.className = `${CONFIG.UI.ITEM} fact-checker-result`;
      state.container.appendChild(card);
      renderResultInCard(card, factCheckResponse.results[i]);
      setTimeout(() => removeCard(card), CONFIG.RESULT_DISPLAY_MS);
    }

    trimCards();
  }

  /** Renders a single fact-check result inside a card element. */
  function renderResultInCard(card, result) {
    let verdictClass = CONFIG.UI.VERDICT_LACKS;
    if (result.verdict === 'TRUE') verdictClass = CONFIG.UI.VERDICT_TRUE;
    else if (result.verdict === 'FALSE') verdictClass = CONFIG.UI.VERDICT_FALSE;

    card.innerHTML = `
      <div class="${CONFIG.UI.CLAIM}"><strong>Claim:</strong> ${escapeHtml(result.claim)}</div>
      <div class="${verdictClass}"><strong>Verdict:</strong> ${result.verdict}</div>
      <div class="${CONFIG.UI.EXPLANATION}"><strong>Explanation:</strong> ${escapeHtml(result.explanation)}</div>
      ${result.source ? `<div class="${CONFIG.UI.SOURCE}"><strong>Source:</strong> <a href="${escapeHtml(result.source)}" target="_blank" rel="noopener">View Source</a></div>` : ''}
      <button class="${CONFIG.UI.CLOSE_BUTTON}" aria-label="Close">×</button>
    `;
    bindCloseButton(card);
  }

  /** Shows a backend error in a card. */
  function updateCardWithError(id) {
    const item = document.getElementById(id);
    if (!item) return;

    item.innerHTML = `
      <div class="${CONFIG.UI.CLAIM}" style="color:#ffb3ba;">
        <strong>Error:</strong> Could not reach the AI backend. Is uvicorn running on port 8001?
      </div>
      <button class="${CONFIG.UI.CLOSE_BUTTON}" aria-label="Close">×</button>
    `;
    bindCloseButton(item);
    setTimeout(() => removeCard(item), 8000);
  }

  // ══════════════════════════════════════════════
  //  UI UTILITIES
  // ══════════════════════════════════════════════

  function trimCards() {
    let cards = state.container.querySelectorAll('.fact-checker-result');
    while (cards.length > CONFIG.MAX_VISIBLE_CARDS) {
      cards[0].remove();
      cards = state.container.querySelectorAll('.fact-checker-result');
    }
  }

  function bindCloseButton(item) {
    const btn = item.querySelector(`.${CONFIG.UI.CLOSE_BUTTON}`);
    if (btn) btn.addEventListener('click', () => removeCard(item));
  }

  function removeCard(item) {
    if (!item || !item.parentNode) return;
    item.style.opacity = '0';
    item.style.transition = 'opacity 0.3s ease';
    setTimeout(() => {
      if (item.parentNode) item.parentNode.removeChild(item);
      hideContainerIfEmpty();
    }, 300);
  }

  function getYouTubeVideoId() {
    try {
      return new URL(window.location.href).searchParams.get('v');
    } catch {
      return null;
    }
  }

  function escapeHtml(text) {
    if (!text) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, m => map[m]);
  }

  // ══════════════════════════════════════════════
  //  CLEANUP
  // ══════════════════════════════════════════════

  function cleanup() {
    stopCaptionMonitoring();
    if (state.container && state.container.parentNode) {
      state.container.remove();
    }
  }

  // ── Start ──
  initialize();
  window.factCheckerCleanup = cleanup;

})();