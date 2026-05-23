#!/usr/bin/env python3
"""
Hestia Wake Word — YouTube Scraper (multi-word)

Downloads YouTube videos, extracts word-level timestamps from transcripts,
and clips tight, noise-free samples of the target wake word.

Supports: athena, artemis, hestia

Usage:
  python scrape_wakeword.py --word athena urls_athena.txt
  python scrape_wakeword.py --word artemis urls_artemis.txt
  python scrape_wakeword.py --word hestia urls_hestia.txt
  python scrape_wakeword.py --word artemis urls_artemis.txt --dry-run
  python scrape_wakeword.py --word athena urls.txt --output training_data

Output:
  training_data_{word}/
    positive/       <- tight wake word clips
    negative/       <- non-speech or unrelated speech clips
    hard_negative/  <- similar-sounding words
    manifest.json   <- metadata and stats
"""

import os
import sys
import json
import struct
import subprocess
import shutil
import re
import math
import time
from pathlib import Path

# ── Per-word configuration ───────────────────────────────────────────────────

WORD_CONFIGS = {
    'athena': {
        'positive': {'athena', 'athene', 'pallas athena'},
        'hard_negative': {
            'athens', 'athenian', 'athenians', 'antenna',
            'arena', 'alina', 'ariana', 'elena', 'serena',
            'selena', 'katrina', 'marina', 'helena', 'sabrina',
            'hyena', 'christina', 'ballerina',
        },
    },
    'artemis': {
        'positive': {'artemis'},
        'hard_negative': {
            'artist', 'artisan', 'armistice', 'artem',
            'army', 'archive', 'artemisia',
            'ardent', 'argus', 'harvest',
        },
    },
    'hestia': {
        'positive': {'hestia'},
        'hard_negative': {
            'bestia', 'hysteria', 'historia',
            'vestige', 'festival', 'celestia',
            'hester', 'nestor', 'gesture',
        },
    },
    'apollo': {
        'positive': {'apollo'},
        'hard_negative': {
            'polo', 'appalling', 'apologize', 'apology',
            'apparel', 'apostle', 'follow', 'hollow',
            'swallow', 'bravado',
        },
    },
    'andromeda': {
        'positive': {'andromeda'},
        'hard_negative': {
            'android', 'andrea', 'andrew', 'anderson',
            'andromache', 'andro', 'andro',
            'remedy', 'comedy',
        },
    },
    'achilles': {
        'positive': {'achilles'},
        'hard_negative': {
            'agility', 'ability', 'achille',
            'vanilla', 'gorilla', 'guerrilla',
            'papilla', 'distillery',
        },
    },
    'hermes': {
        'positive': {'hermes'},
        'hard_negative': {
            'hermit', 'hermitage', 'herman', 'mercy',
            'hurdles', 'furnace', 'terminus',
            'purchase', 'surface', 'nervous',
        },
    },
    'odin': {
        'positive': {'odin'},
        'hard_negative': {
            'coding', 'loading', 'golden', 'holding',
            'molding', 'folding', 'woden', 'oden',
            'sewing', 'showing', 'going',
        },
    },
    'osiris': {
        'positive': {'osiris'},
        'hard_negative': {
            'iris', 'cyrus', 'virus', 'papyrus',
            'desirous', 'aspire', 'siren',
            'series', 'cerise', 'cirrus',
        },
    },
    'anubis': {
        'positive': {'anubis'},
        'hard_negative': {
            'cannabis', 'annuity', 'annual',
            'amulet', 'ambush', 'anguish',
            'cherub', 'hubris', 'rubis',
        },
    },
}

# ── Shared config ────────────────────────────────────────────────────────────

SAMPLE_RATE = 16000
CLIP_DURATION = 2.0
PRE_WORD_PAD = 0.5
MIN_PEAK = 0.02
MIN_SPEECH_MS = 150
SILENCE_THRESH = 0.015
NEG_CLIP_DURATION = 1.5
NEG_EXCLUSION_PAD = 2.0
MAX_NEG_PER_VIDEO = 50
MIN_GAP = 2.0


# ── Audio utilities ──────────────────────────────────────────────────────────

def read_wav_samples(path):
    with open(path, 'rb') as f:
        riff = f.read(4)
        if riff != b'RIFF':
            raise ValueError('Not a WAV file')
        f.read(4)
        if f.read(4) != b'WAVE':
            raise ValueError('Not a WAV file')
        while True:
            chunk_id = f.read(4)
            if len(chunk_id) < 4:
                break
            chunk_size = struct.unpack('<I', f.read(4))[0]
            if chunk_id == b'fmt ':
                f.read(chunk_size)
            elif chunk_id == b'data':
                raw = f.read(chunk_size)
                return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            else:
                f.read(chunk_size)
    raise ValueError('No data chunk found')


def compute_rms_frames(samples, frame_ms=20, sr=SAMPLE_RATE):
    frame_size = int(sr * frame_ms / 1000)
    n_frames = len(samples) // frame_size
    rms = []
    for i in range(n_frames):
        frame = samples[i * frame_size:(i + 1) * frame_size]
        rms.append(math.sqrt(float(np.mean(frame ** 2))))
    return rms, frame_size


def find_speech_bounds(samples, sr=SAMPLE_RATE):
    rms_frames, frame_size = compute_rms_frames(samples, frame_ms=10, sr=sr)
    if not rms_frames:
        return 0, len(samples)

    speech_frames = [r > SILENCE_THRESH for r in rms_frames]

    first = None
    last = None
    for i, is_speech in enumerate(speech_frames):
        if is_speech:
            if first is None:
                first = i
            last = i

    if first is None:
        return 0, len(samples)

    start_sample = max(0, first * frame_size - int(sr * 0.05))
    end_sample = min(len(samples), (last + 1) * frame_size + int(sr * 0.05))
    return start_sample, end_sample


def validate_clip(samples, sr=SAMPLE_RATE):
    peak = float(np.max(np.abs(samples)))
    if peak < MIN_PEAK:
        return False, f'too quiet (peak={peak:.3f})'

    start, end = find_speech_bounds(samples, sr)
    speech_ms = (end - start) / sr * 1000

    if speech_ms < MIN_SPEECH_MS:
        return False, f'speech too short ({speech_ms:.0f}ms)'

    return True, 'ok'


def energy_center_clip(samples, target_duration_samples, sr=SAMPLE_RATE):
    start, end = find_speech_bounds(samples, sr)
    speech_center = (start + end) // 2
    half_target = target_duration_samples // 2

    new_start = speech_center - half_target
    new_end = speech_center + half_target

    if new_start < 0:
        pad_left = np.zeros(-new_start, dtype=np.float32)
        segment = samples[0:new_end]
        return np.concatenate([pad_left, segment])
    elif new_end > len(samples):
        segment = samples[new_start:]
        pad_right = np.zeros(new_end - len(samples), dtype=np.float32)
        return np.concatenate([segment, pad_right])
    else:
        return samples[new_start:new_end]


# ── Transcript parsing ───────────────────────────────────────────────────────

def parse_json3_word_level(path):
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    words = []
    for event in data.get('events', []):
        event_start_ms = event.get('tStartMs', 0)
        segs = event.get('segs', [])

        for seg in segs:
            text = seg.get('utf8', '').strip()
            if not text or text == '\n':
                continue
            offset_ms = seg.get('tOffsetMs', 0)
            seg_time = (event_start_ms + offset_ms) / 1000.0

            seg_words = text.split()
            if len(seg_words) <= 1:
                words.append((seg_time, text))
            else:
                for j, w in enumerate(seg_words):
                    words.append((seg_time + j * 0.3, w))

    return words


def parse_vtt_segments(path):
    segments = []
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    pattern = r'(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*\n(.*?)(?=\n\n|\Z)'
    matches = re.findall(pattern, content, re.DOTALL)

    for m in matches:
        start = int(m[0]) * 3600 + int(m[1]) * 60 + int(m[2]) + int(m[3]) / 1000
        text = re.sub(r'<[^>]+>', '', m[8])
        text = re.sub(r'\n', ' ', text).strip()
        if text:
            for word in text.split():
                segments.append((start, word))
                start += 0.3

    return segments


def find_word_timestamps(words, target_word, word_config):
    positive_words = word_config['positive']
    hard_neg_words = word_config['hard_negative']
    mentions = []
    last_times = {}

    for i, (time_val, text) in enumerate(words):
        text_lower = text.lower().strip('.,!?;:()[]"\'''""')
        text_lower = re.sub(r"['']s$", '', text_lower)

        # Check bigrams for multi-word matches
        if i + 1 < len(words):
            next_lower = words[i + 1][1].lower().strip('.,!?;:()[]"\'''""')
            next_lower = re.sub(r"['']s$", '', next_lower)
            bigram = text_lower + ' ' + next_lower
            if bigram in positive_words:
                key = target_word
                if key not in last_times or (time_val - last_times[key]) >= MIN_GAP:
                    mentions.append((time_val, target_word, bigram))
                    last_times[key] = time_val
                continue

        if text_lower in positive_words or text_lower.rstrip('s') in positive_words:
            key = target_word
            if key not in last_times or (time_val - last_times[key]) >= MIN_GAP:
                mentions.append((time_val, target_word, text_lower))
                last_times[key] = time_val
            continue

        if text_lower in hard_neg_words:
            if text_lower not in last_times or (time_val - last_times[text_lower]) >= MIN_GAP:
                mentions.append((time_val, text_lower, text_lower))
                last_times[text_lower] = time_val

    return mentions


# ── YouTube interaction ──────────────────────────────────────────────────────

def check_tools():
    ok = True
    if not shutil.which('yt-dlp'):
        print('ERROR: yt-dlp not found. Install: pip install yt-dlp')
        ok = False
    if not shutil.which('ffmpeg'):
        print('ERROR: ffmpeg not found. Install: winget install ffmpeg')
        ok = False
    return ok


def get_video_info(url, retries=3):
    for attempt in range(retries):
        cmd = ['yt-dlp', '--no-playlist', '--print', '%(title)s\n%(duration)s', url]
        result = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')
        if result.returncode == 0 and result.stdout:
            lines = result.stdout.strip().split('\n')
            title = lines[0] if lines else 'Unknown'
            duration = float(lines[1]) if len(lines) > 1 else 0
            if title != 'Unknown' or duration > 0:
                return title, duration
        if attempt < retries - 1:
            wait = 15 * (attempt + 1)
            print(f'  ⏳ Rate limited — waiting {wait}s (attempt {attempt + 1}/{retries})')
            time.sleep(wait)
    return 'Unknown', 0


def download_transcript(url, temp_dir, retries=3):
    for attempt in range(retries):
        out_template = str(temp_dir / 'subs')

        cmd = [
            'yt-dlp', '--no-playlist',
            '--write-auto-sub', '--write-sub',
            '--sub-lang', 'en',
            '--sub-format', 'json3',
            '--skip-download',
            '-o', out_template,
            url
        ]
        subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')

        json3_files = list(temp_dir.glob('*.json3'))
        if json3_files:
            words = parse_json3_word_level(json3_files[0])
            if words:
                return words, 'json3'

        for f in temp_dir.iterdir():
            f.unlink()

        cmd_vtt = [
            'yt-dlp', '--no-playlist',
            '--write-auto-sub', '--write-sub',
            '--sub-lang', 'en',
            '--sub-format', 'vtt',
            '--skip-download',
            '-o', out_template,
            url
        ]
        subprocess.run(cmd_vtt, capture_output=True, text=True, encoding='utf-8', errors='replace')

        vtt_files = list(temp_dir.glob('*.vtt'))
        if vtt_files:
            words = parse_vtt_segments(vtt_files[0])
            if words:
                return words, 'vtt'

        for f in temp_dir.iterdir():
            f.unlink()

        if attempt < retries - 1:
            wait = 20 * (attempt + 1)
            print(f'  ⏳ Transcript fetch failed — retrying in {wait}s (attempt {attempt + 1}/{retries})')
            time.sleep(wait)

    return None, None


def download_audio(url, output_path):
    cmd = [
        'yt-dlp', '--no-playlist',
        '-x', '--audio-format', 'wav',
        '--audio-quality', '0',
        '--postprocessor-args', f'-ar {SAMPLE_RATE} -ac 1',
        '-o', str(output_path),
        url
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if result.returncode != 0:
        return False

    if not output_path.exists():
        alt = Path(str(output_path) + '.wav')
        if alt.exists():
            alt.rename(output_path)
        else:
            return False
    return True


def clip_audio(input_path, start_sec, duration_sec):
    cmd = [
        'ffmpeg', '-y',
        '-i', str(input_path),
        '-ss', str(max(0, start_sec)),
        '-t', str(duration_sec),
        '-ar', str(SAMPLE_RATE),
        '-ac', '1',
        '-f', 's16le',
        '-acodec', 'pcm_s16le',
        'pipe:1'
    ]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0 or not result.stdout:
        return None

    samples = np.frombuffer(result.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    return samples


def save_wav(path, samples, sr=SAMPLE_RATE):
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


# ── Main pipeline ────────────────────────────────────────────────────────────

def process_video(url, video_idx, target_word, word_config, output_dir, dry_run=False):
    print(f'\n{"─" * 60}')
    print(f'[{video_idx + 1}] {url}')

    title, duration = get_video_info(url)
    print(f'  Title:    {title}')
    print(f'  Duration: {duration:.0f}s ({duration/60:.1f} min)')

    temp_dir = Path(f'_temp_scrape_{video_idx}')
    temp_dir.mkdir(exist_ok=True)

    words, fmt = download_transcript(url, temp_dir)
    shutil.rmtree(temp_dir, ignore_errors=True)

    if not words:
        print('  ✗ No transcript available — skipping')
        return {'positive': 0, 'negative': 0, 'hard_negative': 0, 'rejected': 0}

    print(f'  Transcript: {len(words)} words ({fmt} format)')

    mentions = find_word_timestamps(words, target_word, word_config)
    pos_count = sum(1 for _, label, _ in mentions if label == target_word)
    hard_count = sum(1 for _, label, _ in mentions if label != target_word)
    print(f'  Matches:  {pos_count} positive, {hard_count} hard negative')

    if not mentions and not dry_run:
        print(f'  ✗ No "{target_word}" mentions found — skipping')
        return {'positive': 0, 'negative': 0, 'hard_negative': 0, 'rejected': 0}

    if dry_run:
        for time_val, label, text in mentions[:10]:
            m, s = divmod(int(time_val), 60)
            print(f'    {m}:{s:02d}  {label} ("{text}")')
        if len(mentions) > 10:
            print(f'    ... and {len(mentions) - 10} more')
        return {'positive': pos_count, 'negative': 0, 'hard_negative': hard_count, 'rejected': 0}

    temp_dir = Path(f'_temp_scrape_{video_idx}')
    temp_dir.mkdir(exist_ok=True)
    audio_path = temp_dir / 'audio.wav'

    print('  Downloading audio...')
    if not download_audio(url, audio_path):
        print('  ✗ Download failed — skipping')
        shutil.rmtree(temp_dir, ignore_errors=True)
        return {'positive': 0, 'negative': 0, 'hard_negative': 0, 'rejected': 0}

    counts = {'positive': 0, 'negative': 0, 'hard_negative': 0, 'rejected': 0}
    target_samples = int(CLIP_DURATION * SAMPLE_RATE)
    marked_zones = []

    for time_sec, label, matched_text in mentions:
        category = 'positive' if label == target_word else 'hard_negative'
        cat_dir = output_dir / category
        cat_dir.mkdir(parents=True, exist_ok=True)

        clip_start = max(0, time_sec - PRE_WORD_PAD)
        marked_zones.append((clip_start - NEG_EXCLUSION_PAD, clip_start + CLIP_DURATION + NEG_EXCLUSION_PAD))

        samples = clip_audio(audio_path, clip_start, CLIP_DURATION + 0.5)
        if samples is None or len(samples) < SAMPLE_RATE * 0.5:
            counts['rejected'] += 1
            continue

        samples = energy_center_clip(samples, target_samples)

        if len(samples) > target_samples:
            samples = samples[:target_samples]
        elif len(samples) < target_samples:
            pad = np.zeros(target_samples - len(samples), dtype=np.float32)
            samples = np.concatenate([samples, pad])

        ok, reason = validate_clip(samples)
        if not ok:
            counts['rejected'] += 1
            continue

        existing = len(list(cat_dir.glob('*.wav')))
        out_name = f'v{video_idx}_{target_word}_{existing:04d}.wav'
        save_wav(cat_dir / out_name, samples)
        counts[category] += 1

    neg_dir = output_dir / 'negative'
    neg_dir.mkdir(parents=True, exist_ok=True)

    neg_extracted = 0
    scan_pos = 0.0
    while scan_pos + NEG_CLIP_DURATION <= duration and neg_extracted < MAX_NEG_PER_VIDEO:
        scan_end = scan_pos + NEG_CLIP_DURATION

        overlaps = any(scan_pos < zone_end and scan_end > zone_start
                       for zone_start, zone_end in marked_zones)

        if not overlaps:
            samples = clip_audio(audio_path, scan_pos, NEG_CLIP_DURATION)
            if samples is not None and len(samples) >= SAMPLE_RATE * 0.5:
                peak = float(np.max(np.abs(samples)))
                if peak > MIN_PEAK:
                    if len(samples) > target_samples:
                        samples = samples[:target_samples]
                    elif len(samples) < target_samples:
                        pad = np.zeros(target_samples - len(samples), dtype=np.float32)
                        samples = np.concatenate([samples, pad])

                    existing = len(list(neg_dir.glob('*.wav')))
                    out_name = f'v{video_idx}_neg_{existing:04d}.wav'
                    save_wav(neg_dir / out_name, samples)
                    neg_extracted += 1

            scan_pos += NEG_CLIP_DURATION
        else:
            scan_pos += NEG_CLIP_DURATION + NEG_EXCLUSION_PAD

    counts['negative'] = neg_extracted

    shutil.rmtree(temp_dir, ignore_errors=True)

    print(f'  ✓ {counts["positive"]} positive, {counts["hard_negative"]} hard neg, '
          f'{counts["negative"]} negative ({counts["rejected"]} rejected)')
    return counts


def write_manifest(totals, urls, target_word, output_dir):
    manifest = {
        'target_word': target_word,
        'sample_rate': SAMPLE_RATE,
        'clip_duration': CLIP_DURATION,
        'format': 'PCM 16-bit signed little-endian mono',
        'sources': len(urls),
        'totals': totals,
        'categories': {}
    }

    for category in ['positive', 'negative', 'hard_negative']:
        cat_dir = output_dir / category
        if cat_dir.exists():
            files = sorted([f.name for f in cat_dir.glob('*.wav')])
            manifest['categories'][category] = {'count': len(files)}
        else:
            manifest['categories'][category] = {'count': 0}

    manifest_path = output_dir / 'manifest.json'
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    return manifest


def main():
    if len(sys.argv) < 2 or '--word' not in sys.argv:
        print('Hestia Wake Word — YouTube Scraper (multi-word)')
        print('=' * 60)
        print()
        print('Usage: python scrape_wakeword.py --word <name> <urls_file> [options]')
        print()
        print('Words:    athena, artemis, hestia')
        print()
        print('Options:')
        print('  --output DIR    Output directory (default: training_data_{word})')
        print('  --dry-run       Scan transcripts only, don\'t download audio')
        print()
        print('Examples:')
        print('  python scrape_wakeword.py --word athena urls_athena.txt')
        print('  python scrape_wakeword.py --word artemis urls_artemis.txt --dry-run')
        print('  python scrape_wakeword.py --word hestia urls_hestia.txt')
        sys.exit(1)

    if not check_tools():
        sys.exit(1)

    # Parse --word
    word_idx = sys.argv.index('--word')
    if word_idx + 1 >= len(sys.argv):
        print('ERROR: --word requires a value (athena, artemis, hestia)')
        sys.exit(1)
    target_word = sys.argv[word_idx + 1].lower()

    if target_word not in WORD_CONFIGS:
        print(f'ERROR: unknown word "{target_word}". Supported: {", ".join(WORD_CONFIGS.keys())}')
        sys.exit(1)

    word_config = WORD_CONFIGS[target_word]

    # Find urls file (first positional arg that isn't a flag or flag value)
    skip_next = False
    urls_file = None
    for arg in sys.argv[1:]:
        if skip_next:
            skip_next = False
            continue
        if arg in ('--word', '--output'):
            skip_next = True
            continue
        if arg.startswith('--'):
            continue
        urls_file = arg
        break

    if not urls_file or not os.path.exists(urls_file):
        print(f'ERROR: urls file not found: {urls_file}')
        sys.exit(1)

    dry_run = '--dry-run' in sys.argv

    output_dir = Path(f'training_data_{target_word}')
    if '--output' in sys.argv:
        idx = sys.argv.index('--output')
        if idx + 1 < len(sys.argv):
            output_dir = Path(sys.argv[idx + 1])

    # Read URLs
    urls = []
    with open(urls_file, 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                urls.append(line)

    if not urls:
        print('No URLs found in file.')
        sys.exit(1)

    print(f'Hestia Wake Word Scraper — "{target_word}"')
    print('=' * 60)
    print(f'Target:  {target_word}')
    print(f'Videos:  {len(urls)}')
    print(f'Output:  {output_dir}/')
    print(f'Clip:    {CLIP_DURATION}s (centered on word)')
    print(f'Positives: {word_config["positive"]}')
    print(f'Hard neg:  {len(word_config["hard_negative"])} confusable words')
    if dry_run:
        print('Mode:    DRY RUN (transcript scan only)')
    print()

    output_dir.mkdir(exist_ok=True)

    totals = {'positive': 0, 'negative': 0, 'hard_negative': 0, 'rejected': 0}

    for i, url in enumerate(urls):
        counts = process_video(url, i, target_word, word_config, output_dir, dry_run=dry_run)
        for k in totals:
            totals[k] += counts.get(k, 0)
        if i < len(urls) - 1:
            time.sleep(8)

    print(f'\n{"=" * 60}')
    print('SUMMARY')
    print(f'{"=" * 60}')
    print(f'  Positive ({target_word}): {totals["positive"]}')
    print(f'  Hard negative:       {totals["hard_negative"]}')
    print(f'  Negative (ambient):  {totals["negative"]}')
    print(f'  Rejected (quality):  {totals["rejected"]}')

    if not dry_run:
        manifest = write_manifest(totals, urls, target_word, output_dir)
        print(f'\n  Manifest: {output_dir}/manifest.json')

        pos = manifest['categories']['positive']['count']
        neg = manifest['categories']['negative']['count']
        hard = manifest['categories']['hard_negative']['count']

        print(f'\n  Training data totals:')
        print(f'    positive/:      {pos} clips')
        print(f'    negative/:      {neg} clips')
        print(f'    hard_negative/: {hard} clips')

        if pos < 200:
            print(f'\n  ⚠ {pos} positive samples — aim for 200+ for robust detection.')
            print(f'    Add more URLs with "{target_word}" mentions to your urls file.')
        if neg < pos * 2:
            print(f'  ⚠ Negatives ({neg}) should be ~2-3x positives ({pos}).')

        print(f'\nNext steps:')
        print(f'  1. python cleanup_audio.py     (normalize + trim)')
        print(f'  2. Upload to Colab for OWW training')
    else:
        print(f'\nDry run complete. Remove --dry-run to download and clip.')


if __name__ == '__main__':
    try:
        import numpy as np
    except ImportError:
        print('ERROR: numpy not found. Install: pip install numpy')
        sys.exit(1)
    main()
