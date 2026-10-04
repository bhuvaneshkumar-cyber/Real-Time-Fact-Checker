"""
Pick the best local model: runs the real fact-check pipeline on labelled snippets and reports
accuracy + warm latency for each installed Ollama model (or the ones given as arguments).

Run from backend/:  python benchmark_models.py [model ...]
"""
import asyncio
import statistics
import sys
import time

from app import checker

# (transcript snippet, acceptable verdicts; empty = nothing checkable)
CASES = [
    ("so the eiffel tower was finished in 1889 for the world's fair in paris", {"TRUE"}),
    ("and you know the great wall of china is actually visible from the moon with the naked eye", {"FALSE", "MISLEADING"}),
    ("water boils at 50 degrees celsius at sea level which is why pasta cooks so fast", {"FALSE"}),
    ("an adult human body has 206 bones", {"TRUE"}),
    ("the first man to walk on the moon was buzz aldrin back in 1969", {"FALSE"}),
    ("the pacific is the smallest ocean on earth", {"FALSE"}),
    ("light from the sun takes about eight minutes to reach the earth", {"TRUE"}),
    ("einstein got his nobel prize for the theory of relativity", {"FALSE", "MISLEADING"}),
    ("mount everest is the tallest mountain above sea level at about 8849 meters", {"TRUE"}),
    ("we only use about ten percent of our brains, that's a scientific fact", {"FALSE", "MISLEADING"}),
    ("the capital of australia is sydney, everyone knows that", {"FALSE"}),
    ("the titanic sank in 1912 after it hit an iceberg", {"TRUE"}),
    ("light travels at roughly three hundred thousand kilometers per second", {"TRUE"}),
    ("the moon is about 384,000 km away and the soviets were the first to land people on it in 1975", {"FALSE"}),
    ("the great wall is over twenty thousand kilometers long when you count all of its branches", {"TRUE"}),
    ("honestly I think this is the best pizza I've ever had, you guys should totally try it", set()),
    ("okay so let's get into today's video, but first smash that like button and subscribe", set()),
]


async def bench(model: str) -> tuple[int, list[float]]:
    checker.MODEL = model
    await checker.check("warm up")  # load the model; not timed
    correct, times = 0, []
    for text, expected in CASES:
        start = time.perf_counter()
        results = await checker.check(text)
        times.append(time.perf_counter() - start)
        verdicts = {r["verdict"] for r in results}
        ok = (not results) if not expected else bool(verdicts & expected)
        correct += ok
        print(f"  {'PASS' if ok else 'FAIL'} {times[-1]:5.1f}s  {sorted(verdicts) or '-'}  {text[:55]}")
    return correct, times


async def main():
    models = sys.argv[1:] or sorted(m.id for m in (await checker.client.models.list()).data
                                    if not m.id.endswith("cloud"))
    scores = {}
    for model in models:
        print(f"\n{model}")
        try:
            scores[model] = await bench(model)
        except Exception as e:
            print(f"  ERROR: {e}")
    print(f"\n{'model':<22} {'accuracy':>8} {'median':>8} {'max':>7}")
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1][0], statistics.median(kv[1][1])))
    for model, (correct, times) in ranked:
        print(f"{model:<22} {correct:>4}/{len(CASES):<3} {statistics.median(times):>7.1f}s {max(times):>6.1f}s")


if __name__ == "__main__":
    asyncio.run(main())
