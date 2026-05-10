#!/usr/bin/env python3
"""
Hestia Wake Word — Audio Cleanup (multi-word)

Normalizes volume and trims silence from training samples.
Run BEFORE uploading to Colab for OWW training.

Usage:
  python cleanup_audio.py --word apollo
  python cleanup_audio.py --word apollo achilles odin
  python cleanup_audio.py --all
"""

import sys
import struct
import numpy as np
from pathlib import Path

SAMPLE_RATE = 16000

SILENCE_THRESH = 0.015
FRAME_MS = 20
MIN_SPEECH_MS = 200
PAD_MS = 150
TARGET_PEAK = 0.7

ALL_WORDS = [
    'athena', 'artemis', 'hestia', 'apollo', 'achilles',
    'andromeda', 'hermes', 'odin', 'osiris', 'anubis',
]


def read_wav(path):
    with open(path, 'rb') as f:
        riff = f.read(4)
        if riff != b'RIFF':
            raise ValueError('Not WAV')
        f.read(4)
        if f.read(4) != b'WAVE':
            raise ValueError('Not WAV')
        channels, sample_width = 1, 2
        while True:
            cid = f.read(4)
            if len(cid) < 4:
                break
            csz = struct.unpack('<I', f.read(4))[0]
            if cid == b'fmt ':
                fmt = f.read(csz)
                channels = struct.unpack('<H', fmt[2:4])[0]
                sample_width = struct.unpack('<H', fmt[14:16])[0] // 8
            elif cid == b'data':
                raw = f.read(csz)
                if sample_width == 2:
                    s = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                else:
                    s = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
                if channels == 2:
                    s = s.reshape(-1, 2).mean(axis=1)
                return s
            else:
                f.read(csz)
    raise ValueError('No data')


def write_wav(path, samples, sr=16000):
    samples = np.clip(samples, -1.0, 1.0)
    pcm = (samples * 32767).astype(np.int16)
    data = pcm.tobytes()
    with open(path, 'wb') as f:
        f.write(b'RIFF')
        f.write(struct.pack('<I', 36 + len(data)))
        f.write(b'WAVE')
        f.write(b'fmt ')
        f.write(struct.pack('<I', 16))
        f.write(struct.pack('<HHIIHH', 1, 1, sr, sr * 2, 2, 16))
        f.write(b'data')
        f.write(struct.pack('<I', len(data)))
        f.write(data)


def normalize(samples, target_peak=TARGET_PEAK):
    peak = np.max(np.abs(samples))
    if peak < 0.001:
        return samples
    return samples * (target_peak / peak)


def trim_silence(samples, sr=SAMPLE_RATE, thresh=SILENCE_THRESH,
                 frame_ms=FRAME_MS, min_speech_ms=MIN_SPEECH_MS, pad_ms=PAD_MS):
    frame_size = int(sr * frame_ms / 1000)
    n_frames = len(samples) // frame_size

    if n_frames < 1:
        return samples

    speech_frames = []
    for i in range(n_frames):
        frame = samples[i * frame_size:(i + 1) * frame_size]
        rms = np.sqrt(np.mean(frame ** 2))
        speech_frames.append(rms > thresh)

    first_speech = None
    last_speech = None
    for i, is_speech in enumerate(speech_frames):
        if is_speech:
            if first_speech is None:
                first_speech = i
            last_speech = i

    if first_speech is None:
        return samples

    speech_duration_ms = (last_speech - first_speech + 1) * frame_ms
    if speech_duration_ms < min_speech_ms:
        return samples

    pad_frames = int(pad_ms / frame_ms)
    start_frame = max(0, first_speech - pad_frames)
    end_frame = min(n_frames, last_speech + pad_frames + 1)

    start_sample = start_frame * frame_size
    end_sample = min(len(samples), end_frame * frame_size)

    return samples[start_sample:end_sample]


def process_directory(training_dir, dirname):
    d = training_dir / dirname
    if not d.exists():
        return 0, 0, 0

    files = sorted(d.glob('*.wav'))
    total = len(files)
    trimmed = 0
    normalized = 0
    skipped = 0

    for f in files:
        try:
            audio = read_wav(f)
            original_len = len(audio)
            original_peak = np.max(np.abs(audio))

            audio = normalize(audio)
            if np.max(np.abs(audio)) > original_peak * 1.1:
                normalized += 1

            if dirname in ('positive', 'hard_negative'):
                audio = trim_silence(audio)
                if len(audio) < original_len * 0.9:
                    trimmed += 1

            min_samples = SAMPLE_RATE
            if len(audio) < min_samples:
                padding = np.zeros(min_samples - len(audio), dtype=np.float32)
                audio = np.concatenate([audio, padding])

            write_wav(f, audio)

        except Exception:
            skipped += 1

    return total, trimmed, normalized


def cleanup_word(word):
    script_dir = Path(__file__).parent
    training_dir = script_dir / f'training_data_{word}'

    if not training_dir.exists():
        print(f'\n  Skipping {word} — training_data_{word}/ not found')
        return

    print(f'\n{"=" * 60}')
    print(f'  CLEANUP: {word.upper()}')
    print(f'{"=" * 60}')

    print('\n  Before:')
    for dirname in ['positive', 'negative', 'hard_negative']:
        d = training_dir / dirname
        if not d.exists():
            continue
        files = sorted(d.glob('*.wav'))[:20]
        if not files:
            continue
        peaks = []
        silent_pcts = []
        for f in files:
            try:
                s = read_wav(f)
                peaks.append(np.max(np.abs(s)))
                silent_pcts.append(np.sum(np.abs(s) < 0.01) / len(s) * 100)
            except Exception:
                pass
        if peaks:
            print(f'    {dirname}: avg peak={np.mean(peaks):.3f}, avg silence={np.mean(silent_pcts):.0f}%')

    print('\n  Processing...')
    for dirname in ['positive', 'negative', 'hard_negative']:
        total, trimmed, normalized = process_directory(training_dir, dirname)
        if total > 0:
            print(f'    {dirname}: {total} files — {normalized} normalized, {trimmed} trimmed')

    print('\n  After:')
    for dirname in ['positive', 'negative', 'hard_negative']:
        d = training_dir / dirname
        if not d.exists():
            continue
        files = sorted(d.glob('*.wav'))[:20]
        if not files:
            continue
        peaks = []
        silent_pcts = []
        durations = []
        for f in files:
            try:
                s = read_wav(f)
                peaks.append(np.max(np.abs(s)))
                silent_pcts.append(np.sum(np.abs(s) < 0.01) / len(s) * 100)
                durations.append(len(s) / SAMPLE_RATE)
            except Exception:
                pass
        if peaks:
            print(f'    {dirname}: avg peak={np.mean(peaks):.3f}, avg silence={np.mean(silent_pcts):.0f}%, avg duration={np.mean(durations):.1f}s')


def main():
    if len(sys.argv) < 2:
        print('Hestia Wake Word — Audio Cleanup')
        print('=' * 50)
        print()
        print('Usage:')
        print('  python cleanup_audio.py --word apollo')
        print('  python cleanup_audio.py --word apollo achilles odin')
        print('  python cleanup_audio.py --all')
        sys.exit(1)

    if '--all' in sys.argv:
        words = ALL_WORDS
    elif '--word' in sys.argv:
        idx = sys.argv.index('--word')
        words = [w.lower() for w in sys.argv[idx + 1:] if not w.startswith('--')]
    else:
        print('ERROR: specify --word <names> or --all')
        sys.exit(1)

    if not words:
        print('ERROR: no words specified')
        sys.exit(1)

    print('Hestia Wake Word — Audio Cleanup')
    print(f'Words: {", ".join(words)}')

    for word in words:
        cleanup_word(word)

    print(f'\n{"=" * 60}')
    print('ALL DONE')
    print(f'{"=" * 60}')


if __name__ == '__main__':
    main()
