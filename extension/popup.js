document.addEventListener('DOMContentLoaded', () => {
    const statusEl = document.getElementById('status');
    const checkBtn = document.getElementById('checkBackend');

    const startCaptureBtn = document.getElementById('startCapture');
    const stopCaptureBtn = document.getElementById('stopCapture');

    // Restore state
    chrome.storage.local.get(['isListening'], (res) => {
        if (res.isListening) {
            setListeningState(true);
        }
    });

    function setListeningState(isListening) {
        if (isListening) {
            statusEl.textContent = 'Listening to tab...';
            statusEl.className = 'status online';
            startCaptureBtn.style.display = 'none';
            stopCaptureBtn.style.display = 'block';
        } else {
            // Re-check backend to reset status text
            checkBackend();
            startCaptureBtn.style.display = 'block';
            stopCaptureBtn.style.display = 'none';
        }
    }

    // --- Tab Capture Logic ---
    startCaptureBtn.addEventListener('click', async () => {
        // Find the currently active tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (tab) {
            // Tell the background script to start capturing this tab
            chrome.runtime.sendMessage({ 
                action: 'startTabCapture', 
                tabId: tab.id 
            });
            
            
            // Update UI to show we are listening
            chrome.storage.local.set({ isListening: true });
            setListeningState(true);
        }
    });

    stopCaptureBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'stopTabCapture' });
        chrome.storage.local.set({ isListening: false });
        setListeningState(false);
    });

    // --- Backend Check Logic ---
    async function checkBackend() {
        statusEl.textContent = 'Checking connection...';
        statusEl.className = 'status'; 

        try {
            const response = await fetch('http://localhost:8001/health', { 
                signal: AbortSignal.timeout(3000) 
            });
            
            if (response.ok) {
                statusEl.textContent = 'Backend: Online';
                statusEl.className = 'status online';
            } else {
                throw new Error('Bad response');
            }
        } catch (e) {
            statusEl.textContent = 'Backend: Offline';
            statusEl.className = 'status offline';
            console.error('Backend check failed:', e);
        }
    }

    checkBtn.addEventListener('click', checkBackend);
    


    // Initial check on load
    checkBackend();
});