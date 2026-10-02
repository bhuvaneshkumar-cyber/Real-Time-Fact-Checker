// Background service worker for the Real-Time Fact Checker extension

// Default backend URL (can be overridden by storage)
let BACKEND_URL = "http://localhost:8001";

// Load the backend URL from storage when the extension starts
chrome.storage.local.get(["backendUrl"], (result) => {
  if (chrome.runtime.lastError) {
    console.error("Fact Checker: Error reading backendUrl from storage:", chrome.runtime.lastError);
  } else if (result && result.backendUrl) {
    BACKEND_URL = result.backendUrl;
    console.log(`Fact Checker: Loaded backend URL from storage: ${BACKEND_URL}`);
  } else {
    console.log(`Fact Checker: Using default backend URL: ${BACKEND_URL}`);
  }
});

// Listen for changes to the backend URL in storage
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "local" && changes.backendUrl) {
    BACKEND_URL = changes.backendUrl.newValue;
    console.log(`Fact Checker: Backend URL updated to: ${BACKEND_URL}`);
  }
});

/**
 * Proxy function to forward a fact-check request to the backend.
 * @param {string} text - The text chunk to fact-check.
 * @param {string} videoId - Optional YouTube video ID.
 * @returns {Promise<Object>} - The fact-check response from the backend.
 */
async function factCheckProxy(text, videoId = null, videoTitle = null, context = null) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/fact-check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, videoId, videoTitle, context }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error("Fact Checker: Error in fact-check proxy:", error);
    throw error;
  }
}

/**
 * Listen for messages from the content script, popup, and offscreen document.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ─── ROUTE 1: YouTube Caption fact-check (content_script.js) ───
  // The content script sends text and expects a response via sendResponse callback.
  if (message.action === 'factCheck') {
    factCheckProxy(message.text, message.videoId, message.videoTitle, message.context)
      .then((result) => {
        sendResponse({ success: true, data: result });
      })
      .catch((error) => {
        console.error("Fact Checker: Backend API Error (factCheck):", error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep the message channel open for the async sendResponse
  }

  // ─── ROUTE 2: Whisper transcription result (offscreen.js) ───
  // The offscreen document transcribed audio and sent us the text.
  // We show a "processing" card immediately, then call the backend.
  if (message.action === 'transcriptionReady') {
    const factCheckId = 'fc-' + Date.now();

    // 1. Immediately tell the Content Script to show a "Processing..." UI card
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'transcriptionProcessing',
          id: factCheckId,
          text: message.text
        });
      }
    });

    // 2. Call the Python backend
    factCheckProxy(message.text, null)
      .then((result) => {
        // 3. Send the final verdict back to update the specific UI card
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              action: 'displayFactCheckResults',
              id: factCheckId,
              data: result
            });
          }
        });
      })
      .catch((error) => {
        console.error("Fact Checker: Backend API Error:", error);
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              action: 'factCheckError',
              id: factCheckId
            });
          }
        });
      });

    return true;
  }

  // ─── ROUTE 3: Start Tab Capture (popup.js) ───
  // The user clicked "Start Listening to Tab" in the popup.
  if (message.action === 'startTabCapture') {
    if (message.tabId) {
      startCapturingTab(message.tabId);
    }
    return false;
  }
  
  // ─── ROUTE 4: Stop Tab Capture (popup.js) ───
  if (message.action === 'stopTabCapture') {
    chrome.runtime.sendMessage({ action: 'stopTabStream' });
    return false;
  }
});

/**
 * Starts capturing audio from a specific browser tab.
 * Creates an offscreen document (if needed) and passes the stream ID to it.
 */
async function startCapturingTab(tabId) {
  try {
    // 1. Get the stream ID, catching Chrome's locked-state errors
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve(id);
      });
    });

    // 2. Ensure an offscreen document exists
    const hasDocument = await chrome.offscreen.hasDocument();
    if (!hasDocument) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Recording tab audio for real-time fact-checking'
      });
    }

    // 3. Send the valid stream ID to the offscreen document for Whisper processing
    chrome.runtime.sendMessage({
      action: 'processTabStream',
      streamId: streamId
    });

  } catch (error) {
    console.warn("Fact Checker: Ignored capture request -", error.message);
  }
}

console.log("Fact Checker: Background service worker started.");
