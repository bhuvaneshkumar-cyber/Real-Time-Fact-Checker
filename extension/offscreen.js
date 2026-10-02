import { pipeline, env } from './lib/transformers.min.js';

env.allowLocalModels = false;
env.allowRemoteModels = true; 

env.backends.onnx.wasm.numThreads = 1;

let audioContext = null;

// Create a Promise that resolves when the model is fully loaded
console.log("Fact Checker: Initializing Whisper Model download/load...");
const transcriberPromise = pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');

chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'processTabStream') {
        startAudioProcessing(message.streamId);
    } else if (message.action === 'stopTabStream') {
        stopAudioProcessing();
    }
});
let currentMediaStream = null; // Track the active stream

function stopAudioProcessing() {
    if (currentMediaStream) {
        currentMediaStream.getTracks().forEach(track => track.stop());
        currentMediaStream = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    console.log("Fact Checker: Stopped audio capture.");
}

async function startAudioProcessing(streamId) {
    console.log("Fact Checker: Tab stream received. Waiting for model to be ready...");
    
    // This will pause execution here until the model is 100% downloaded and ready
    const transcriber = await transcriberPromise;
    console.log("Fact Checker: Model is ready! Starting audio capture...");

    try {
        // Clean up previous audio streams if the user clicked "Start" on a new tab
        if (currentMediaStream) {
            currentMediaStream.getTracks().forEach(track => track.stop());
        }
        if (audioContext) {
            await audioContext.close();
        }

        currentMediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: streamId
                }
            }
        });

        audioContext = new AudioContext({ sampleRate: 16000 });
        const source = audioContext.createMediaStreamSource(currentMediaStream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);

        source.connect(processor);
        processor.connect(audioContext.destination);

        let audioBuffer = [];
        let isProcessing = false;

        processor.onaudioprocess = async (e) => {
            const inputData = e.inputBuffer.getChannelData(0);
            audioBuffer.push(...inputData);

            // FIX 1: Increase chunk size to 8 seconds (16000 * 8 = 128000 samples)
            // This gives Whisper enough context to stop panicking
            if (audioBuffer.length >= 128000 && !isProcessing) {
                isProcessing = true;
                
                const chunkToProcess = new Float32Array(audioBuffer);
                
                // Keep the last 2 seconds (32000 samples) in the buffer for the next chunk
                const overlapSamples = 32000;
                audioBuffer = audioBuffer.slice(audioBuffer.length - overlapSamples);

                // Silence Detection
                let sum = 0;
                for (let i = 0; i < chunkToProcess.length; i++) {
                    sum += Math.abs(chunkToProcess[i]);
                }
                const averageVolume = sum / chunkToProcess.length;

                if (averageVolume < 0.005) {
                    isProcessing = false;
                    return;
                }

                try {
                    const output = await transcriber(chunkToProcess);
                    const rawText = Array.isArray(output) ? output[0].text : output.text;

                    if (!rawText) {
                        isProcessing = false;
                        return;
                    }

                    const text = rawText.trim();
                    const isJustPunctuation = /^[.,?!\[\]\s]+$/.test(text);

                    // FIX 2: The "Word Entropy" Hallucination Filter
                    const isAudioTag = text.includes('[') || text.includes(']') || text.includes('(') || text.includes(')');
                    // We calculate the ratio of unique words to total words
                    const cleanText = text.toLowerCase().replace(/[.,?!\[\]]/g, '');
                    const words = cleanText.split(/\s+/);
                    const uniqueWords = new Set(words);
                    const wordVarietyRatio = uniqueWords.size / words.length;

                    // Rule 1: The overall entropy ratio (Catches pure loops)
                    const isLowEntropy = words.length >= 6 && wordVarietyRatio < 0.45;

                    // Rule 2: Single word repeated 4 or more times in a row (e.g., "talking talking talking talking")
                    const hasWordLoop = /(\b\w+\b)(?:\s+\1){3,}/.test(cleanText);

                    // Rule 3: Phrase (2 to 5 words) repeated 3 or more times in a row (e.g., "what I was on what I was on what I was on")
                    const hasPhraseLoop = /(\b(?:\w+\s+){1,4}\w+\b)(?:\s+\1){2,}/.test(cleanText);

                    // If ANY of these rules trigger, it's a hallucination
                    const isHallucinationLoop = isLowEntropy || hasWordLoop || hasPhraseLoop;
                    
                    // Require at least 3 words and 15 characters to be considered a potential "claim"
                    const isLongEnough = text.length > 15 && words.length >= 3;

                    if (isLongEnough && !isJustPunctuation && !isAudioTag && !isHallucinationLoop) {
                        console.log("✅ Transcribed Clean Sentence:", text);
                        
                        // Send valid text to the background script -> Python Backend!
                        chrome.runtime.sendMessage({
                            action: 'transcriptionReady',
                            text: text
                        });
                    } else if (isHallucinationLoop) {
                        console.warn("🗑️ Dropped Hallucination Loop:", text.substring(0, 80) + "...");
                    }
                } catch (error) {
                    console.error("Fact Checker Inference Error:", error);
                } finally {
                    isProcessing = false;
                }
            }
        };
    } catch (error) {
        console.error("Fact Checker: Failed to grab audio stream. Please refresh the YouTube tab.", error);
    }
}