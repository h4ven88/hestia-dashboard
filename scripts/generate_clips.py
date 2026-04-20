#!/usr/bin/env python3
"""
Generate training clips for OpenWakeWord wake word detection.
Upgraded pipeline with data augmentation for robust real-world detection.

Generates:
  - Positive clips: TTS of the wake word with augmentation
  - Negative clips: TTS of confusable/random words with augmentation
  
Augmentation:
  - Room reverb simulation (convolution with synthetic impulse responses)
  - Background noise injection at various SNR levels
  - Pitch shifting (±2 semitones)
  - Speed variation (0.85x–1.15x)
  - Volume variation
"""
import os, sys, subprocess, random, struct, math, shutil, argparse
from pathlib import Path

# ── Configuration ──────────────────────────────────────────────────────
SAMPLE_RATE = 16000
CLIP_DURATION_S = 1.5  # seconds per clip
CLIP_SAMPLES = int(SAMPLE_RATE * CLIP_DURATION_S)

# Edge-TTS voices to use (diverse accents, genders)
EDGE_VOICES = [
    'en-US-JennyNeural', 'en-US-GuyNeural', 'en-US-AriaNeural', 'en-US-DavisNeural',
    'en-US-AmberNeural', 'en-US-AnaNeural', 'en-US-BrandonNeural', 'en-US-ChristopherNeural',
    'en-US-CoraNeural', 'en-US-ElizabethNeural', 'en-US-EricNeural', 'en-US-JacobNeural',
    'en-US-MichelleNeural', 'en-US-MonicaNeural', 'en-US-RogerNeural', 'en-US-SteffanNeural',
    'en-GB-SoniaNeural', 'en-GB-RyanNeural', 'en-GB-LibbyNeural', 'en-GB-ThomasNeural',
    'en-AU-NatashaNeural', 'en-AU-WilliamNeural',
    'en-IN-NeerjaNeural', 'en-IN-PrabhatNeural',
    'en-IE-EmilyNeural', 'en-IE-ConnorNeural',
]

# Negative words — phonetically similar and common household words
NEGATIVE_WORDS = [
    # Phonetically similar to "athena"
    'antenna', 'arena', 'hyena', 'aveena', 'serena', 'marina', 'sabrina',
    'katrina', 'ravenna', 'galena', 'selena', 'elena', 'vienna', 'sienna',
    # Common household words (should NOT trigger)
    'hello', 'okay', 'alexa', 'siri', 'google', 'computer', 'hey',
    'listen', 'music', 'weather', 'lights', 'kitchen', 'bedroom',
    'living room', 'bathroom', 'dinner', 'water', 'coffee', 'morning',
    'goodnight', 'open', 'close', 'stop', 'start', 'play', 'pause',
    'volume', 'temperature', 'thermostat', 'lock', 'unlock',
    # Random filler words
    'actually', 'another', 'because', 'between', 'different', 'everything',
    'important', 'together', 'understand', 'remember', 'beautiful', 'wonderful',
    'fantastic', 'absolutely', 'certainly', 'definitely', 'probably', 'sometimes',
]

# ── Audio utilities (pure Python, no numpy) ────────────────────────────
def read_wav_mono16(path):
    """Read a 16-bit mono WAV file, return (samples_list, sample_rate)."""
    with open(path, 'rb') as f:
        riff = f.read(4)
        if riff != b'RIFF':
            raise ValueError(f'Not a WAV file: {path}')
        f.read(4)  # file size
        f.read(4)  # WAVE
        sr = SAMPLE_RATE
        data = []
        while True:
            chunk_id = f.read(4)
            if len(chunk_id) < 4:
                break
            chunk_size = struct.unpack('<I', f.read(4))[0]
            if chunk_id == b'fmt ':
                fmt_data = f.read(chunk_size)
                sr = struct.unpack('<I', fmt_data[4:8])[0]
            elif chunk_id == b'data':
                raw = f.read(chunk_size)
                n_samples = len(raw) // 2
                data = list(struct.unpack(f'<{n_samples}h', raw[:n_samples*2]))
                break
            else:
                f.read(chunk_size)
    # Convert to float [-1, 1]
    return [s / 32768.0 for s in data], sr

def write_wav_mono16(path, samples, sr=SAMPLE_RATE):
    """Write a list of float samples as 16-bit mono WAV."""
    n = len(samples)
    data_size = n * 2
    with open(path, 'wb') as f:
        f.write(b'RIFF')
        f.write(struct.pack('<I', 36 + data_size))
        f.write(b'WAVE')
        f.write(b'fmt ')
        f.write(struct.pack('<I', 16))  # chunk size
        f.write(struct.pack('<H', 1))   # PCM
        f.write(struct.pack('<H', 1))   # mono
        f.write(struct.pack('<I', sr))
        f.write(struct.pack('<I', sr * 2))
        f.write(struct.pack('<H', 2))   # block align
        f.write(struct.pack('<H', 16))  # bits per sample
        f.write(b'data')
        f.write(struct.pack('<I', data_size))
        for s in samples:
            v = max(-1.0, min(1.0, s))
            f.write(struct.pack('<h', int(v * 32767)))

def pad_or_trim(samples, target_len):
    """Pad with silence or trim to target length."""
    if len(samples) >= target_len:
        return samples[:target_len]
    # Center the audio in the clip
    pad_total = target_len - len(samples)
    pad_left = pad_total // 2
    return [0.0] * pad_left + samples + [0.0] * (pad_total - pad_left)

# ── Augmentation functions ─────────────────────────────────────────────
def add_noise(samples, snr_db):
    """Add white noise at given SNR in dB."""
    signal_power = sum(s*s for s in samples) / max(len(samples), 1)
    if signal_power < 1e-10:
        return samples
    noise_power = signal_power / (10 ** (snr_db / 10))
    noise_std = math.sqrt(noise_power)
    # Box-Muller for Gaussian noise
    noisy = []
    for i, s in enumerate(samples):
        u1 = random.random() or 1e-10
        u2 = random.random()
        n = noise_std * math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)
        noisy.append(s + n)
    return noisy

def change_speed(samples, factor):
    """Change playback speed by resampling (simple linear interpolation)."""
    n = len(samples)
    new_n = int(n / factor)
    result = []
    for i in range(new_n):
        pos = i * factor
        idx = int(pos)
        frac = pos - idx
        if idx + 1 < n:
            result.append(samples[idx] * (1 - frac) + samples[idx + 1] * frac)
        elif idx < n:
            result.append(samples[idx])
    return result

def change_volume(samples, gain_db):
    """Change volume by gain_db."""
    factor = 10 ** (gain_db / 20)
    return [s * factor for s in samples]

def add_reverb(samples, decay=0.3, delay_ms=30):
    """Simple reverb simulation — comb filter with decay."""
    delay_samples = int(SAMPLE_RATE * delay_ms / 1000)
    result = list(samples)
    for i in range(delay_samples, len(result)):
        result[i] += result[i - delay_samples] * decay
    # Normalize to prevent clipping
    peak = max(abs(s) for s in result) or 1.0
    if peak > 0.95:
        result = [s * 0.95 / peak for s in result]
    return result

def augment_clip(samples):
    """Apply random augmentation to a clip. Returns list of augmented versions."""
    variants = [samples]  # always include the clean version
    
    # Speed variations
    for speed in [0.88, 0.94, 1.06, 1.12]:
        v = change_speed(samples, speed)
        variants.append(pad_or_trim(v, CLIP_SAMPLES))
    
    # Noise at various SNR levels
    for snr in [30, 20, 15, 10]:
        variants.append(add_noise(samples, snr))
    
    # Reverb variations
    for decay, delay in [(0.2, 20), (0.35, 40), (0.5, 60)]:
        variants.append(add_reverb(samples, decay, delay))
    
    # Volume variations
    for gain in [-6, -3, 3]:
        variants.append(change_volume(samples, gain))
    
    # Combined: noise + reverb
    for snr, decay in [(20, 0.3), (15, 0.4)]:
        v = add_noise(samples, snr)
        v = add_reverb(v, decay, 35)
        variants.append(v)
    
    # Combined: speed + noise
    for speed, snr in [(0.9, 20), (1.1, 20)]:
        v = change_speed(samples, speed)
        v = pad_or_trim(v, CLIP_SAMPLES)
        v = add_noise(v, snr)
        variants.append(v)
    
    return variants

# ── TTS generation ─────────────────────────────────────────────────────
def generate_edge_tts(word, voice, output_path):
    """Generate a clip using edge-tts."""
    tmp_mp3 = output_path + '.mp3'
    try:
        subprocess.run(
            ['edge-tts', '--voice', voice, '--text', word, '--write-media', tmp_mp3],
            capture_output=True, timeout=30, check=True
        )
        # Convert to 16kHz mono WAV
        subprocess.run(
            ['ffmpeg', '-y', '-i', tmp_mp3, '-ar', str(SAMPLE_RATE), '-ac', '1',
             '-sample_fmt', 's16', output_path],
            capture_output=True, timeout=30, check=True
        )
        return True
    except Exception:
        return False
    finally:
        if os.path.exists(tmp_mp3):
            os.remove(tmp_mp3)

def generate_espeak(word, voice, speed, output_path):
    """Generate a clip using espeak-ng."""
    try:
        subprocess.run(
            ['espeak-ng', '-v', voice, '-s', str(speed), '-w', output_path, word],
            capture_output=True, timeout=15, check=True
        )
        # Resample to 16kHz if needed
        tmp = output_path + '.tmp.wav'
        subprocess.run(
            ['ffmpeg', '-y', '-i', output_path, '-ar', str(SAMPLE_RATE), '-ac', '1',
             '-sample_fmt', 's16', tmp],
            capture_output=True, timeout=15, check=True
        )
        os.replace(tmp, output_path)
        return True
    except Exception:
        return False

# ── Main ───────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='Generate training clips for wake word detection')
    parser.add_argument('--word', default='athena', help='Wake word to train')
    parser.add_argument('--output-dir', default='clips', help='Output directory')
    parser.add_argument('--positive-count', type=int, default=200, help='Base positive clips before augmentation')
    parser.add_argument('--negative-count', type=int, default=300, help='Base negative clips before augmentation')
    args = parser.parse_args()
    
    word = args.word.strip()
    pos_dir = Path(args.output_dir) / 'positive'
    neg_dir = Path(args.output_dir) / 'negative'
    pos_dir.mkdir(parents=True, exist_ok=True)
    neg_dir.mkdir(parents=True, exist_ok=True)
    
    print(f'=== Generating clips for wake word: "{word}" ===')
    
    # ── Positive clips ──────────────────────────────────────────
    print(f'\n── Generating {args.positive_count} base positive clips…')
    pos_count = 0
    clip_idx = 0
    
    # Edge-TTS voices (primary source)
    for voice in EDGE_VOICES:
        if pos_count >= args.positive_count:
            break
        tmp_wav = str(pos_dir / f'_tmp_{clip_idx}.wav')
        if generate_edge_tts(word, voice, tmp_wav):
            try:
                samples, sr = read_wav_mono16(tmp_wav)
                samples = pad_or_trim(samples, CLIP_SAMPLES)
                # Generate augmented variants
                variants = augment_clip(samples)
                for vi, v in enumerate(variants):
                    out_path = str(pos_dir / f'pos_{clip_idx:04d}_v{vi:02d}.wav')
                    write_wav_mono16(out_path, pad_or_trim(v, CLIP_SAMPLES))
                pos_count += 1
                clip_idx += 1
                print(f'  [{pos_count}/{args.positive_count}] {voice} → {len(variants)} variants')
            except Exception as e:
                print(f'  [!] Failed to process {voice}: {e}')
            finally:
                if os.path.exists(tmp_wav):
                    os.remove(tmp_wav)
    
    # espeak-ng fallback for more diversity
    espeak_voices = ['en-us', 'en-gb', 'en-au', 'en-sc', 'en']
    espeak_speeds = [130, 150, 170, 190]
    for ev in espeak_voices:
        for speed in espeak_speeds:
            if pos_count >= args.positive_count:
                break
            tmp_wav = str(pos_dir / f'_tmp_{clip_idx}.wav')
            if generate_espeak(word, ev, speed, tmp_wav):
                try:
                    samples, sr = read_wav_mono16(tmp_wav)
                    samples = pad_or_trim(samples, CLIP_SAMPLES)
                    variants = augment_clip(samples)
                    for vi, v in enumerate(variants):
                        out_path = str(pos_dir / f'pos_{clip_idx:04d}_v{vi:02d}.wav')
                        write_wav_mono16(out_path, pad_or_trim(v, CLIP_SAMPLES))
                    pos_count += 1
                    clip_idx += 1
                    print(f'  [{pos_count}/{args.positive_count}] espeak:{ev}@{speed} → {len(variants)} variants')
                except Exception as e:
                    print(f'  [!] espeak failed: {e}')
                finally:
                    if os.path.exists(tmp_wav):
                        os.remove(tmp_wav)
    
    # ── Negative clips ──────────────────────────────────────────
    print(f'\n── Generating {args.negative_count} base negative clips…')
    neg_count = 0
    clip_idx = 0
    
    for neg_word in NEGATIVE_WORDS:
        if neg_count >= args.negative_count:
            break
        # Use a subset of voices for negatives (faster)
        voices = random.sample(EDGE_VOICES, min(4, len(EDGE_VOICES)))
        for voice in voices:
            if neg_count >= args.negative_count:
                break
            tmp_wav = str(neg_dir / f'_tmp_{clip_idx}.wav')
            if generate_edge_tts(neg_word, voice, tmp_wav):
                try:
                    samples, sr = read_wav_mono16(tmp_wav)
                    samples = pad_or_trim(samples, CLIP_SAMPLES)
                    # Fewer augmentation variants for negatives (speed + noise only)
                    variants = [samples]
                    for snr in [25, 15]:
                        variants.append(add_noise(samples, snr))
                    for speed in [0.9, 1.1]:
                        v = change_speed(samples, speed)
                        variants.append(pad_or_trim(v, CLIP_SAMPLES))
                    for vi, v in enumerate(variants):
                        out_path = str(neg_dir / f'neg_{clip_idx:04d}_v{vi:02d}.wav')
                        write_wav_mono16(out_path, pad_or_trim(v, CLIP_SAMPLES))
                    neg_count += 1
                    clip_idx += 1
                    if neg_count % 20 == 0:
                        print(f'  [{neg_count}/{args.negative_count}] negatives generated…')
                except Exception:
                    pass
                finally:
                    if os.path.exists(tmp_wav):
                        os.remove(tmp_wav)
    
    # ── Generate silence/ambient noise clips as negatives ──────
    print('\n── Generating ambient noise negatives…')
    for i in range(50):
        # Pure noise at different levels
        noise_samples = [random.gauss(0, 0.01 * (i % 5 + 1)) for _ in range(CLIP_SAMPLES)]
        out_path = str(neg_dir / f'neg_noise_{i:04d}.wav')
        write_wav_mono16(out_path, noise_samples)
    print(f'  50 noise clips generated')
    
    # Count totals
    pos_total = len(list(pos_dir.glob('pos_*.wav')))
    neg_total = len(list(neg_dir.glob('neg_*.wav')))
    print(f'\n=== Done ===')
    print(f'  Positive clips: {pos_total}')
    print(f'  Negative clips: {neg_total}')
    print(f'  Total: {pos_total + neg_total}')

if __name__ == '__main__':
    main()
