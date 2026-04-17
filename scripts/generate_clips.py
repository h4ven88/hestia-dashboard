#!/usr/bin/env python3
"""
Generate synthetic TTS clips for wake word training.
Usage: python generate_clips.py <word> <count> <output_dir>

Primary: Microsoft Edge TTS (edge-tts) — high quality, 18 voices
Fallback: espeak-ng — local, no network required, lower quality but works everywhere
"""
import asyncio
import os
import subprocess
import sys
import random

VOICES = [
    "en-US-AriaNeural",     "en-US-GuyNeural",
    "en-US-JennyNeural",    "en-US-EricNeural",
    "en-US-MichelleNeural", "en-US-ChristopherNeural",
    "en-US-MonicaNeural",   "en-US-BrandonNeural",
    "en-GB-SoniaNeural",    "en-GB-RyanNeural",
    "en-GB-LibbyNeural",    "en-GB-ThomasNeural",
    "en-AU-NatashaNeural",  "en-AU-WilliamNeural",
    "en-IN-NeerjaNeural",   "en-IN-PrabhatNeural",
    "en-CA-ClaraNeural",    "en-CA-LiamNeural",
]
SPEEDS = ["-25%", "-15%", "-5%", "+0%", "+10%", "+20%", "+30%"]

ESPEAK_VOICES = [
    "en", "en-us", "en-gb", "en-au", "en-in",
    "en-us+m1", "en-us+m2", "en-us+m3",
    "en-us+f1", "en-us+f2", "en-us+f3",
    "en-gb+m1", "en-gb+f1",
]
ESPEAK_SPEEDS = [120, 140, 160, 180, 200, 130, 150, 170]


async def test_edge_tts(word):
    """Quick connectivity test for edge-tts."""
    try:
        import edge_tts
        communicate = edge_tts.Communicate(word, "en-US-AriaNeural")
        test_path = "/tmp/edge_tts_test.mp3"
        await communicate.save(test_path)
        ok = os.path.exists(test_path) and os.path.getsize(test_path) > 100
        if os.path.exists(test_path):
            os.remove(test_path)
        return ok
    except Exception as e:
        print(f"  Edge TTS test failed: {type(e).__name__}: {e}")
        return False


async def generate_edge_clip(word, voice, speed, path):
    try:
        import edge_tts
        communicate = edge_tts.Communicate(word, voice, rate=speed)
        await communicate.save(path)
        return os.path.exists(path) and os.path.getsize(path) > 100
    except Exception:
        return False


def generate_espeak_clips(word, out_dir, count):
    print("  Using espeak-ng (local TTS — no network required)")
    ok = 0
    combos = [(v, s) for v in ESPEAK_VOICES for s in ESPEAK_SPEEDS]
    random.seed(42)
    random.shuffle(combos)
    while len(combos) < count:
        combos += combos
    combos = combos[:count]

    for i, (voice, speed) in enumerate(combos):
        path = os.path.join(out_dir, f"pos_{i:04d}.wav")
        try:
            result = subprocess.run(
                ["espeak-ng", "-v", voice, "-s", str(speed), "-w", path, word],
                capture_output=True, timeout=10
            )
            if result.returncode == 0 and os.path.exists(path) and os.path.getsize(path) > 100:
                ok += 1
        except Exception:
            pass
        if (i + 1) % 100 == 0 or (i + 1) >= len(combos):
            print(f"  {i+1}/{len(combos)} clips ({ok} ok)", flush=True)
    return ok


async def generate_edge_clips(word, out_dir, count):
    combos = [(v, s) for v in VOICES for s in SPEEDS]
    random.seed(42)
    random.shuffle(combos)
    while len(combos) < count:
        combos += combos
    combos = combos[:count]

    ok = 0
    for i in range(0, len(combos), 20):
        batch = combos[i:i+20]
        tasks = [
            generate_edge_clip(word, v, s, os.path.join(out_dir, f"pos_{i+j:04d}.mp3"))
            for j, (v, s) in enumerate(batch)
        ]
        results = await asyncio.gather(*tasks)
        ok += sum(results)
        done = min(i + 20, len(combos))
        if done % 100 == 0 or done >= len(combos):
            print(f"  {done}/{len(combos)} clips ({ok} ok)", flush=True)
        await asyncio.sleep(0.5)
    return ok


async def main():
    if len(sys.argv) < 4:
        print("Usage: python generate_clips.py <word> <count> <output_dir>")
        sys.exit(1)

    word    = sys.argv[1]
    count   = int(sys.argv[2])
    out_dir = sys.argv[3]
    os.makedirs(out_dir, exist_ok=True)

    print(f"Generating {count} clips of '{word}'...")
    print("Testing edge-tts connectivity...")
    edge_ok = await test_edge_tts(word)

    if edge_ok:
        print(f"  Edge TTS available — generating {count} clips across {len(VOICES)} voices")
        ok = await generate_edge_clips(word, out_dir, count)
    else:
        print("  Edge TTS unavailable — falling back to espeak-ng (local)")
        ok = generate_espeak_clips(word, out_dir, count)

    total = len([f for f in os.listdir(out_dir) if f.startswith("pos_")])
    print(f"Generated: {ok} clips saved to {out_dir} ({total} total files)")

    if ok < 50:
        print(f"ERROR: Only {ok} clips generated (minimum 50 required)", file=sys.stderr)
        sys.exit(1)

    print(f"Success: {ok} clips ready for training")


if __name__ == "__main__":
    asyncio.run(main())
