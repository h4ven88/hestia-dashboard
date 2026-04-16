#!/usr/bin/env python3
"""Generate synthetic TTS clips for wake word training."""
import asyncio, os, sys, random
import edge_tts

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

async def gen(word, voice, speed, path):
    try:
        c = edge_tts.Communicate(word, voice, rate=speed)
        await c.save(path)
        return True
    except:
        return False

async def main():
    word  = sys.argv[1]
    clips = int(sys.argv[2]) if len(sys.argv) > 2 else 500
    out   = sys.argv[3] if len(sys.argv) > 3 else "clips"
    os.makedirs(out, exist_ok=True)

    combos = [(v, s) for v in VOICES for s in SPEEDS]
    random.seed(42)
    random.shuffle(combos)
    while len(combos) < clips:
        combos += combos
    combos = combos[:clips]

    ok = 0
    for i in range(0, len(combos), 20):
        batch = combos[i:i+20]
        tasks = [gen(word, v, s, f"{out}/pos_{i+j:04d}.mp3")
                 for j, (v, s) in enumerate(batch)]
        results = await asyncio.gather(*tasks)
        ok += sum(results)
        done = min(i + 20, len(combos))
        if done % 100 == 0 or done >= len(combos):
            print(f"  {done}/{len(combos)} clips ({ok} ok)", flush=True)
        await asyncio.sleep(0.3)

    print(f"Generated: {ok}/{len(combos)} clips saved to {out}")
    if ok < 50:
        print("ERROR: Too few clips generated", file=sys.stderr)
        sys.exit(1)

asyncio.run(main())
