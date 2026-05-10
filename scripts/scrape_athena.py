#!/usr/bin/env python3
"""
Athena Wake Word — YouTube Scraper v2

Downloads YouTube videos, extracts word-level timestamps from transcripts,
and clips tight, noise-free samples of "Athena" utterances.

Key improvements over v1:
  - Word-level timing from JSON3 subtitles (sub-second precision)
  - Tight 1.5s clip window centered on the word
  - Energy-based centering to trim dead air
  - Quality gate rejects bad clips automatically

Usage:
  python scrape_athena.py urls.txt
  python scrape_athena.py urls.txt --output training_data
  python scrape_athena.py urls.txt --dry-run

urls.txt format (one URL per line, # comments allowed):
  https://www.youtube.com/watch?v=XXXXX
  https://www.youtube.com/watch?v=YYYYY

Output:
  training_data/
    positive/       ← tight "Athena" clips
    negative/       ← non-speech or unrelated speech clips
    hard_negative/  ← similar-sounding words (athens, antenna, etc.)
    manifest.json   ← metadata and stats
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

# ── Config ────────────────────────────────────────────────────────────────────

OUTPUT_DIR = Path('training_data')
SAMPLE_RATE = 16000

# Clip geometry
CLIP_DURATION = 2.0       # total clip length (seconds)
PRE_WORD_PAD = 0.5        # time before word onset to include
# post-word = CLIP_DURATION - PRE_WORD_PAD = 1.5s

# Quality gate
MIN_PEAK = 0.02           # reject clips quieter than this (normalized)
MIN_SPEECH_MS = 150       # speech burst must be at least this long
SILENCE_THRESH = 0.015    # RMS below this = silence (for energy centering)

# Negative extraction
NEG_CLIP_DURATION = 1.5   # same length as positives for balanced training
NEG_EXCLUSION_PAD = 2.0   # seconds around each marked word to avoid
MAX_NEG_PER_VIDEO = 50    # cap negatives per video to avoid imbalance

# Word matching
POSITIVE_WORDS = {'athena', 'athene', 'pallas athena'}
HARD_NEG_WORDS = {'athens', 'athenian', 'athenians', 'antenna',
                  'arena', 'alina', 'ariana', 'elena', 'serena',
                  'selena', 'katrina', 'marina', 'helena', 'sabrina',
                  'hyena', 'christina', 'ballerina'}

# Dedup: minimum seconds between same-word clips
MIN_GAP = 2.0


# ── Audio utilities ───────────────────────────────────────────────────────────

def read_wav_samples(path):
    """Read a 16-bit PCM WAV file, return float32 array normalized to [-1, 1]."""
    with open(path, 'rb') as f:
        riff = f.read(4)
        if riff != b'RIFF':
            raise ValueError('Not a WAV file')
        f.read(4)  # file size
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
    """Compute RMS energy per frame."""
    frame_size = int(sr * frame_ms / 1000)
    n_frames = len(samples) // frame_size
    rms = []
    for i in range(n_frames):
        frame = samples[i * frame_size:(i + 1) * frame_size]
        rms.append(math.sqrt(float(np.mean(frame ** 2))))
    return rms, frame_size


def find_speech_bounds(samples, sr=SAMPLE_RATE):
    """Find the start and end of the speech burst in a clip."""
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
    """Check if a clip meets quality thresholds. Returns (ok, reason)."""
    peak = float(np.max(np.abs(samples)))
    if peak < MIN_PEAK:
        return False, f'too quiet (peak={peak:.3f})'

    start, end = find_speech_bounds(samples, sr)
    speech_ms = (end - start) / sr * 1000

    if speech_ms < MIN_SPEECH_MS:
        return False, f'speech too short ({speech_ms:.0f}ms)'

    return True, 'ok'


def energy_center_clip(samples, target_duration_samples, sr=SAMPLE_RATE):
    """Re-center a clip on its speech burst, padding with silence if needed."""
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


# ── Transcript parsing ────────────────────────────────────────────────────────

def parse_json3_word_level(path):
    """
    Parse YouTube JSON3 subtitles extracting word-level timestamps.
    Splits multi-word segments into individual words with estimated timing.
    Returns: [(time_sec, word_str), ...]
    """
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

            # Split multi-word segments into individual words
            seg_words = text.split()
            if len(seg_words) <= 1:
                words.append((seg_time, text))
            else:
                # Estimate ~0.3s per word within the segment
                for j, w in enumerate(seg_words):
                    words.append((seg_time + j * 0.3, w))

    return words


def parse_vtt_segments(path):
    """Fallback: parse VTT into segment-level timestamps (less precise)."""
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
                start += 0.3  # rough estimate for VTT fallback

    return segments


def find_word_timestamps(words):
    """
    Scan word list for positive and hard negative matches.
    Returns: [(time_sec, label, matched_text), ...]
    """
    mentions = []
    last_times = {}

    for i, (time, text) in enumerate(words):
        # Normalize: lowercase, strip punctuation including curly apostrophes
        text_lower = text.lower().strip('.,!?;:()[]"\'‘’“”')
        # Strip possessive suffixes: "athena's" → "athena"
        text_lower = re.sub(r"['’]s$", '', text_lower)

        # Check bigrams for multi-word matches ("pallas athena")
        if i + 1 < len(words):
            next_lower = words[i + 1][1].lower().strip('.,!?;:()[]"\'‘’“”')
            next_lower = re.sub(r"['’]s$", '', next_lower)
            bigram = text_lower + ' ' + next_lower
            if bigram in POSITIVE_WORDS:
                key = 'athena'
                if key not in last_times or (time - last_times[key]) >= MIN_GAP:
                    mentions.append((time, 'athena', bigram))
                    last_times[key] = time
                continue

        # Single word positive match
        if text_lower in POSITIVE_WORDS or text_lower.rstrip('s') in POSITIVE_WORDS:
            key = 'athena'
            if key not in last_times or (time - last_times[key]) >= MIN_GAP:
                mentions.append((time, 'athena', text_lower))
                last_times[key] = time
            continue

        # Hard negative match
        if text_lower in HARD_NEG_WORDS:
            if text_lower not in last_times or (time - last_times[text_lower]) >= MIN_GAP:
                mentions.append((time, text_lower, text_lower))
                last_times[text_lower] = time

    return mentions


# ── YouTube interaction ───────────────────────────────────────────────────────

def check_tools():
    ok = True
    if not shutil.which('yt-dlp'):
        print('ERROR: yt-dlp not found. Install: pip install yt-dlp')
        ok = False
    if not shutil.which('ffmpeg'):
        print('ERROR: ffmpeg not found. Install: winget install ffmpeg')
        ok = False
    return ok


def get_video_info(url):
    """Get video title and duration."""
    cmd = ['yt-dlp', '--no-playlist', '--print', '%(title)s\n%(duration)s', url]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0:
        lines = result.stdout.strip().split('\n')
        title = lines[0] if lines else 'Unknown'
        duration = float(lines[1]) if len(lines) > 1 else 0
        return title, duration
    return 'Unknown', 0


def download_transcript(url, temp_dir):
    """Download subtitles and parse word-level timestamps."""
    out_template = str(temp_dir / 'subs')

    # Try JSON3 first (has word-level timing)
    cmd = [
        'yt-dlp', '--no-playlist',
        '--write-auto-sub', '--write-sub',
        '--sub-lang', 'en',
        '--sub-format', 'json3',
        '--skip-download',
        '-o', out_template,
        url
    ]
    subprocess.run(cmd, capture_output=True, text=True)

    json3_files = list(temp_dir.glob('*.json3'))
    if json3_files:
        words = parse_json3_word_level(json3_files[0])
        if words:
            return words, 'json3'

    # Fallback to VTT (segment-level only)
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
    subprocess.run(cmd_vtt, capture_output=True, text=True)

    vtt_files = list(temp_dir.glob('*.vtt'))
    if vtt_files:
        words = parse_vtt_segments(vtt_files[0])
        if words:
            return words, 'vtt'

    return None, None


def download_audio(url, output_path):
    """Download audio as 16kHz mono WAV."""
    cmd = [
        'yt-dlp', '--no-playlist',
        '-x', '--audio-format', 'wav',
        '--audio-quality', '0',
        '--postprocessor-args', f'-ar {SAMPLE_RATE} -ac 1',
        '-o', str(output_path),
        url
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
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
    """Extract a clip as raw samples. Returns float32 array or None."""
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
    """Write float32 samples as 16-bit PCM WAV."""
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


# ── Main pipeline ─────────────────────────────────────────────────────────────

def process_video(url, video_idx, dry_run=False):
    """Full pipeline for one video: transcript → download → clip → validate."""
    print(f'\n{"─" * 60}')
    print(f'[{video_idx + 1}] {url}')

    title, duration = get_video_info(url)
    print(f'  Title:    {title}')
    print(f'  Duration: {duration:.0f}s ({duration/60:.1f} min)')

    # Step 1: Get transcript with word-level timestamps
    temp_dir = Path(f'_temp_scrape_{video_idx}')
    temp_dir.mkdir(exist_ok=True)

    words, fmt = download_transcript(url, temp_dir)
    shutil.rmtree(temp_dir, ignore_errors=True)

    if not words:
        print('  ✗ No transcript available — skipping')
        return {'positive': 0, 'negative': 0, 'hard_negative': 0, 'rejected': 0}

    print(f'  Transcript: {len(words)} words ({fmt} format)')

    # Step 2: Find mentions
    mentions = find_word_timestamps(words)
    pos_count = sum(1 for _, label, _ in mentions if label == 'athena')
    hard_count = sum(1 for _, label, _ in mentions if label != 'athena')
    print(f'  Matches:  {pos_count} positive, {hard_count} hard negative')

    if not mentions and not dry_run:
        print('  ✗ No "Athena" mentions found — skipping')
        return {'positive': 0, 'negative': 0, 'hard_negative': 0, 'rejected': 0}

    if dry_run:
        for time, label, text in mentions[:10]:
            m, s = divmod(int(time), 60)
            print(f'    {m}:{s:02d}  {label} ("{text}")')
        if len(mentions) > 10:
            print(f'    ... and {len(mentions) - 10} more')
        return {'positive': pos_count, 'negative': 0, 'hard_negative': hard_count, 'rejected': 0}

    # Step 3: Download full audio
    temp_dir = Path(f'_temp_scrape_{video_idx}')
    temp_dir.mkdir(exist_ok=True)
    audio_path = temp_dir / 'audio.wav'

    print('  Downloading audio...')
    if not download_audio(url, audio_path):
        print('  ✗ Download failed — skipping')
        shutil.rmtree(temp_dir, ignore_errors=True)
        return {'positive': 0, 'negative': 0, 'hard_negative': 0, 'rejected': 0}

    # Step 4: Extract and validate clips
    counts = {'positive': 0, 'negative': 0, 'hard_negative': 0, 'rejected': 0}
    target_samples = int(CLIP_DURATION * SAMPLE_RATE)
    marked_zones = []  # track for negative extraction

    for time_sec, label, matched_text in mentions:
        category = 'positive' if label == 'athena' else 'hard_negative'
        cat_dir = OUTPUT_DIR / category
        cat_dir.mkdir(parents=True, exist_ok=True)

        # Clip: start PRE_WORD_PAD before the word timestamp
        clip_start = max(0, time_sec - PRE_WORD_PAD)
        marked_zones.append((clip_start - NEG_EXCLUSION_PAD, clip_start + CLIP_DURATION + NEG_EXCLUSION_PAD))

        # Extract raw audio
        samples = clip_audio(audio_path, clip_start, CLIP_DURATION + 0.5)  # grab slightly extra
        if samples is None or len(samples) < SAMPLE_RATE * 0.5:
            counts['rejected'] += 1
            continue

        # Energy-center the clip
        samples = energy_center_clip(samples, target_samples)

        # Ensure exact length
        if len(samples) > target_samples:
            samples = samples[:target_samples]
        elif len(samples) < target_samples:
            pad = np.zeros(target_samples - len(samples), dtype=np.float32)
            samples = np.concatenate([samples, pad])

        # Quality gate
        ok, reason = validate_clip(samples)
        if not ok:
            counts['rejected'] += 1
            continue

        # Save
        existing = len(list(cat_dir.glob('*.wav')))
        out_name = f'v{video_idx}_{label}_{existing:04d}.wav'
        save_wav(cat_dir / out_name, samples)
        counts[category] += 1

    # Step 5: Extract negative clips from unmarked regions
    neg_dir = OUTPUT_DIR / 'negative'
    neg_dir.mkdir(parents=True, exist_ok=True)

    neg_extracted = 0
    scan_pos = 0.0
    while scan_pos + NEG_CLIP_DURATION <= duration and neg_extracted < MAX_NEG_PER_VIDEO:
        scan_end = scan_pos + NEG_CLIP_DURATION

        # Check overlap with any marked zone
        overlaps = any(scan_pos < zone_end and scan_end > zone_start
                       for zone_start, zone_end in marked_zones)

        if not overlaps:
            samples = clip_audio(audio_path, scan_pos, NEG_CLIP_DURATION)
            if samples is not None and len(samples) >= SAMPLE_RATE * 0.5:
                # Only keep negatives with some audio content (not dead silence)
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
            # Jump past the exclusion zone
            scan_pos += NEG_CLIP_DURATION + NEG_EXCLUSION_PAD

    counts['negative'] = neg_extracted

    # Cleanup
    shutil.rmtree(temp_dir, ignore_errors=True)

    print(f'  ✓ {counts["positive"]} positive, {counts["hard_negative"]} hard neg, '
          f'{counts["negative"]} negative ({counts["rejected"]} rejected)')
    return counts


def write_manifest(totals, urls):
    """Write a manifest of the training run."""
    manifest = {
        'sample_rate': SAMPLE_RATE,
        'clip_duration': CLIP_DURATION,
        'format': 'PCM 16-bit signed little-endian mono',
        'sources': len(urls),
        'totals': totals,
        'categories': {}
    }

    for category in ['positive', 'negative', 'hard_negative']:
        cat_dir = OUTPUT_DIR / category
        if cat_dir.exists():
            files = sorted([f.name for f in cat_dir.glob('*.wav')])
            manifest['categories'][category] = {'count': len(files)}
        else:
            manifest['categories'][category] = {'count': 0}

    manifest_path = OUTPUT_DIR / 'manifest.json'
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    return manifest


def main():
    if len(sys.argv) < 2:
        print('Athena Wake Word — YouTube Scraper v2')
        print('=' * 60)
        print()
        print('Usage: python scrape_athena.py <urls_file> [options]')
        print()
        print('Options:')
        print('  --output DIR    Output directory (default: training_data)')
        print('  --dry-run       Scan transcripts only, don\'t download audio')
        print()
        print('urls.txt format (one URL per line):')
        print('  https://www.youtube.com/watch?v=XXXXX')
        print('  # comment lines are ignored')
        print()
        print('Pipeline: transcript → word-level timestamps → download →')
        print('          tight clip → energy center → quality gate → save')
        sys.exit(1)

    if not check_tools():
        sys.exit(1)

    # Parse args
    urls_file = sys.argv[1]
    dry_run = '--dry-run' in sys.argv

    global OUTPUT_DIR
    if '--output' in sys.argv:
        idx = sys.argv.index('--output')
        if idx + 1 < len(sys.argv):
            OUTPUT_DIR = Path(sys.argv[idx + 1])

    if not os.path.exists(urls_file):
        print(f'ERROR: {urls_file} not found')
        sys.exit(1)

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

    print('Athena Wake Word — YouTube Scraper v2')
    print('=' * 60)
    print(f'Videos:  {len(urls)}')
    print(f'Output:  {OUTPUT_DIR}/')
    print(f'Clip:    {CLIP_DURATION}s (centered on word)')
    if dry_run:
        print('Mode:    DRY RUN (transcript scan only)')
    print()

    OUTPUT_DIR.mkdir(exist_ok=True)

    totals = {'positive': 0, 'negative': 0, 'hard_negative': 0, 'rejected': 0}

    for i, url in enumerate(urls):
        counts = process_video(url, i, dry_run=dry_run)
        for k in totals:
            totals[k] += counts.get(k, 0)
        # Delay between videos to avoid YouTube rate-limiting
        if i < len(urls) - 1:
            time.sleep(3)

    # Summary
    print(f'\n{"=" * 60}')
    print('SUMMARY')
    print(f'{"=" * 60}')
    print(f'  Positive (athena):  {totals["positive"]}')
    print(f'  Hard negative:      {totals["hard_negative"]}')
    print(f'  Negative (ambient): {totals["negative"]}')
    print(f'  Rejected (quality): {totals["rejected"]}')

    if not dry_run:
        manifest = write_manifest(totals, urls)
        print(f'\n  Manifest: {OUTPUT_DIR}/manifest.json')

        # Recommendations
        pos = manifest['categories']['positive']['count']
        neg = manifest['categories']['negative']['count']
        hard = manifest['categories']['hard_negative']['count']

        print(f'\n  Training data totals:')
        print(f'    positive/:      {pos} clips')
        print(f'    negative/:      {neg} clips')
        print(f'    hard_negative/: {hard} clips')

        if pos < 200:
            print(f'\n  ⚠ {pos} positive samples — aim for 200+ for robust detection.')
            print(f'    Add more URLs with "Athena" mentions to your urls file.')
        if neg < pos * 2:
            print(f'  ⚠ Negatives ({neg}) should be ~2-3× positives ({pos}).')
            print(f'    Add longer videos or videos without "Athena" for ambient negatives.')

        print(f'\nNext steps:')
        print(f'  1. python cleanup_audio.py     (normalize + trim)')
        print(f'  2. python train_model.py       (train classifier)')
    else:
        print(f'\nDry run complete. Remove --dry-run to download and clip.')


if __name__ == '__main__':
    try:
        import numpy as np
    except ImportError:
        print('ERROR: numpy not found. Install: pip install numpy')
        sys.exit(1)
    main()
