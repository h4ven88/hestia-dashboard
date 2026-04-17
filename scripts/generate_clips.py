#!/usr/bin/env python3
"""
Generate synthetic TTS clips for wake word training.
Usage: python generate_clips.py <word> <count> <output_dir> [neg_dir]

If neg_dir is provided, also generates negative samples using random words.
Primary: Microsoft Edge TTS  |  Fallback: espeak-ng (local)
"""
import asyncio, os, subprocess, sys, random

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

# Common words unlikely to be confused with wake words
NEGATIVE_WORDS = [
    "hello", "okay", "yes", "no", "stop", "go", "help", "time",
    "light", "music", "weather", "news", "call", "text", "home",
    "open", "close", "play", "pause", "next", "back", "up", "down",
    "left", "right", "start", "end", "good", "bad", "hot", "cold",
    "morning", "evening", "today", "tomorrow", "please", "thank you",
    "kitchen", "bedroom", "living room", "bathroom", "garage",
    "one", "two", "three", "four", "five", "six", "seven", "eight",
]

ESPEAK_VOICES = [
    "en", "en-us", "en-gb", "en-au", "en-in",
    "en-us+m1", "en-us+m2", "en-us+m3",
    "en-us+f1", "en-us+f2", "en-us+f3",
    "en-gb+m1", "en-gb+f1",
]
ESPEAK_SPEEDS = [120, 140, 160, 180, 200, 130, 150, 170]


async def test_edge_tts(word):
    try:
        import edge_tts
        c = edge_tts.Communicate(word, "en-US-AriaNeural")
        p = "/tmp/_edge_test.mp3"
        await c.save(p)
        ok = os.path.exists(p) and os.path.getsize(p) > 100
        if os.path.exists(p): os.remove(p)
        return ok
    except Exception as e:
        print(f"  Edge TTS unavailable: {e}")
        return False


async def gen_edge(word, voice, speed, path):
    try:
        import edge_tts
        c = edge_tts.Communicate(word, voice, rate=speed)
        await c.save(path)
        return os.path.exists(path) and os.path.getsize(path) > 100
    except:
        return False


def gen_espeak(word, voice, speed, path):
    try:
        r = subprocess.run(
            ["espeak-ng", "-v", voice, "-s", str(speed), "-w", path, word],
            capture_output=True, timeout=10)
        return r.returncode == 0 and os.path.exists(path) and os.path.getsize(path) > 100
    except:
        return False


async def generate(words_list, out_dir, count, use_edge):
    """Generate `count` clips for words in words_list into out_dir."""
    os.makedirs(out_dir, exist_ok=True)
    combos = []
    if use_edge:
        for s in SPEEDS:
            for v in VOICES:
                combos.append(("edge", v, s))
    else:
        for s in ESPEAK_SPEEDS:
            for v in ESPEAK_VOICES:
                combos.append(("espeak", v, s))

    random.seed(42)
    random.shuffle(combos)
    while len(combos) < count:
        combos += combos
    combos = combos[:count]

    ok = 0
    for i in range(0, len(combos), 20):
        batch = combos[i:i+20]
        word  = random.choice(words_list)
        tasks = []
        for j, (engine, v, s) in enumerate(batch):
            path = os.path.join(out_dir, f"clip_{i+j:04d}.mp3"
                                if engine == "edge" else f"clip_{i+j:04d}.wav")
            if engine == "edge":
                tasks.append(gen_edge(word, v, s, path))
            else:
                tasks.append(asyncio.get_event_loop().run_in_executor(
                    None, gen_espeak, word, v, s, path))

        results = await asyncio.gather(*tasks)
        ok += sum(results)
        done = min(i + 20, len(combos))
        if done % 100 == 0 or done >= len(combos):
            print(f"  {done}/{len(combos)} clips ({ok} ok)", flush=True)
        await asyncio.sleep(0.3)

    return ok


async def main():
    if len(sys.argv) < 4:
        print("Usage: generate_clips.py <word> <count> <pos_dir> [neg_dir]")
        sys.exit(1)

    word    = sys.argv[1]
    count   = int(sys.argv[2])
    pos_dir = sys.argv[3]
    neg_dir = sys.argv[4] if len(sys.argv) > 4 else None

    print(f"Testing edge-tts...")
    use_edge = await test_edge_tts(word)
    engine   = "edge-tts" if use_edge else "espeak-ng (local)"
    print(f"  Using {engine}")

    print(f"\nGenerating {count} POSITIVE clips for '{word}'...")
    pos_ok = await generate([word], pos_dir, count, use_edge)
    print(f"  {pos_ok}/{count} positive clips ready")

    if neg_dir:
        print(f"\nGenerating {count} NEGATIVE clips (random words)...")
        neg_ok = await generate(NEGATIVE_WORDS, neg_dir, count, use_edge)
        print(f"  {neg_ok}/{count} negative clips ready")

    if pos_ok < 50:
        print(f"ERROR: only {pos_ok} positive clips (need ≥50)", file=sys.stderr)
        sys.exit(1)

asyncio.run(main())
