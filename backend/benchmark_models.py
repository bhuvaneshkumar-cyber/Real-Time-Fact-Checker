"""
Benchmark script for Ollama models on this device.
Tests speed (tok/s) and quality of fact-checking relevant output.
Run: python benchmark_models.py
"""
import urllib.request
import json
import time

OLLAMA_URL = "http://localhost:11434/api/generate"
MODELS = ["llama3.2:3b", "phi3:mini", "gemma2:2b", "granite3-moe:3b"]

# A real-world prompt similar to what our fact-checker sends
PROMPT = """You are a fact-checking AI. Extract verifiable factual claims from the text below.
Return a JSON array of objects with keys "claim" (string) and "checkable" (boolean).
Only include claims that can be verified with external sources.

Text: "The Eiffel Tower is 330 meters tall and was built in 1889 for the Paris World's Fair.
Thomas Edison invented the lightbulb in 1879. Water boils at 100 degrees Celsius at sea level."

Return ONLY valid JSON, no explanation."""

PASS_THRESHOLD_TOKS = 8  # minimum tokens/sec to be "real-time" viable

def test_model(model_name):
    payload = json.dumps({
        "model": model_name,
        "prompt": PROMPT,
        "stream": False,
        "options": {"num_predict": 200, "temperature": 0}
    }).encode()

    req = urllib.request.Request(
        OLLAMA_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    try:
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode())
        elapsed = time.time() - t0

        eval_count = result.get("eval_count", 0)
        eval_duration_ns = result.get("eval_duration", 1)
        toks_per_sec = eval_count / (eval_duration_ns / 1e9)

        response_text = result.get("response", "").strip()
        # Simple quality check: does it produce JSON?
        try:
            parsed = json.loads(response_text)
            quality = "✅ Valid JSON" if isinstance(parsed, list) else "⚠️  Not a list"
        except Exception:
            # Try to extract JSON block
            start = response_text.find('[')
            end = response_text.rfind(']') + 1
            if start != -1 and end > start:
                try:
                    parsed = json.loads(response_text[start:end])
                    quality = "⚠️  JSON found inside extra text"
                except Exception:
                    quality = "❌ Invalid JSON"
            else:
                quality = "❌ No JSON at all"

        passed = toks_per_sec >= PASS_THRESHOLD_TOKS
        return {
            "model": model_name,
            "toks_per_sec": round(toks_per_sec, 1),
            "elapsed_s": round(elapsed, 1),
            "quality": quality,
            "passed": passed,
            "response_preview": response_text[:200]
        }
    except Exception as e:
        return {
            "model": model_name,
            "error": str(e),
            "passed": False
        }


def main():
    print("\n" + "="*60)
    print("  Ollama Model Benchmark — Real-Time Fact Checker")
    print("="*60)
    print(f"  Threshold: >= {PASS_THRESHOLD_TOKS} tok/s  |  Valid JSON output")
    print("="*60 + "\n")

    results = []
    for model in MODELS:
        print(f"[→] Testing {model}...")
        res = test_model(model)
        results.append(res)
        if "error" in res:
            print(f"    ❌ ERROR: {res['error']}")
        else:
            status = "✅ PASS" if res["passed"] else "❌ FAIL"
            print(f"    Speed   : {res['toks_per_sec']} tok/s  ({res['elapsed_s']}s total)")
            print(f"    Quality : {res['quality']}")
            print(f"    Result  : {status}")
        print()

    # Rank passing models by speed
    passing = [r for r in results if r.get("passed") and "error" not in r]
    passing.sort(key=lambda x: x["toks_per_sec"], reverse=True)

    print("="*60)
    print("  RESULTS SUMMARY")
    print("="*60)
    for r in results:
        if "error" in r:
            print(f"  {r['model']:<25}  ❌ Not available (pull first)")
        else:
            status = "✅ PASS" if r["passed"] else "❌ FAIL (too slow)"
            print(f"  {r['model']:<25}  {r['toks_per_sec']:>6} tok/s  {status}  {r['quality']}")

    print()
    if passing:
        winner = passing[0]
        print(f"  🏆 WINNER: {winner['model']}  ({winner['toks_per_sec']} tok/s)")
        print(f"     → Recommended for OLLAMA_MODEL in .env")
    else:
        print("  ⚠️  No models passed the threshold. Consider pulling a smaller model.")
    print("="*60 + "\n")

    # Write winner to a file for automated pickup
    if passing:
        with open("benchmark_winner.txt", "w") as f:
            f.write(passing[0]["model"])

if __name__ == "__main__":
    main()
