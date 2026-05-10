#!/usr/bin/env python3
"""
Athena Wake Word — Sample Preprocessor
Converts voice collector exports to 16kHz mono WAV files ready for OpenWakeWord training.

Usage:
  python preprocess_samples.py athena_samples_haven_1234.zip [more_zips...]

Outputs:
  training_data/
    positive/     ← "Athena" utterances (16kHz mono WAV)
    negative/     ← ambient noise clips (16kHz mono WAV, split into 2s windows)
    hard_negative/ ← similar-sounding words (16kHz mono WAV)
    manifest.json ← combined metadata
"""

import os
import sys
import json
import zipfile
import subprocess
import shutil
from pathlib import Path

OUTPUT_DIR = Path('training_data')
SAMPLE_RATE = 16000
NEGATIVE_WINDOW_SEC = 2  # split long ambient clips into 2s windows

def check_ffmpeg():
    """Verify ffmpeg is available."""
    if shutil.which('ffmpeg'):
        return True
    print('ERROR: ffmpeg not found. Install it:')
    print('  Windows: winget install ffmpeg')
    print('  Mac:     brew install ffmpeg')
    print('  Linux:   sudo apt install ffmpeg')
    return False

def convert_to_wav(input_path, output_path, sample_rate=16000):
    """Convert any audio file to 16kHz mono WAV using ffmpeg."""
    cmd = [
        'ffmpeg', '-y', '-i', str(input_path),
        '-ar', str(sample_rate),
        '-ac', '1',
        '-acodec', 'pcm_s16le',
        str(output_path)
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.returncode == 0

def split_audio(input_path, output_dir, prefix, window_sec=2):
    """Split a long audio file into fixed-length windows."""
    # Get duration
    cmd = [
        'ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
        '-of', 'csv=p=0', str(input_path)
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return []

    try:
        duration = float(result.stdout.strip())
    except (ValueError, AttributeError):
        return []

    outputs = []
    offset = 0
    idx = 0
    while offset + window_sec <= duration + 0.5:  # allow slight overshoot for last window
        out_path = output_dir / f'{prefix}_{idx:03d}.wav'
        cmd = [
            'ffmpeg', '-y', '-i', str(input_path),
            '-ss', str(offset), '-t', str(window_sec),
            '-ar', str(SAMPLE_RATE), '-ac', '1', '-acodec', 'pcm_s16le',
            str(out_path)
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0 and out_path.exists():
            outputs.append(out_path)
        offset += window_sec
        idx += 1

    return outputs

def process_zip(zip_path):
    """Extract and convert all samples from a collector export."""
    zip_path = Path(zip_path)
    if not zip_path.exists():
        print(f'  SKIP: {zip_path} not found')
        return {'positive': 0, 'negative': 0, 'hard_negative': 0}

    temp_dir = Path('_temp_extract')
    if temp_dir.exists():
        shutil.rmtree(temp_dir)
    temp_dir.mkdir()

    counts = {'positive': 0, 'negative': 0, 'hard_negative': 0}

    try:
        with zipfile.ZipFile(zip_path, 'r') as zf:
            zf.extractall(temp_dir)

        # Read manifest if present
        manifest_path = temp_dir / 'manifest.json'
        manifest = {}
        if manifest_path.exists():
            with open(manifest_path) as f:
                manifest = json.load(f)
            speakers = manifest.get('speakers', ['unknown'])
            print(f'  Speakers: {", ".join(speakers)}')
            print(f'  Samples:  {manifest.get("totalSamples", "?")}')

        # Process each category
        for category in ['positive', 'negative', 'hard_negative']:
            src_dir = temp_dir / category
            if not src_dir.exists():
                continue

            dst_dir = OUTPUT_DIR / category
            dst_dir.mkdir(parents=True, exist_ok=True)

            # Count existing files to avoid name collisions
            existing = len(list(dst_dir.glob('*.wav')))

            for audio_file in sorted(src_dir.iterdir()):
                if audio_file.is_dir():
                    continue

                if category == 'negative':
                    # Split long ambient clips into 2s windows
                    prefix = audio_file.stem
                    parts = split_audio(audio_file, dst_dir, f'{prefix}_{existing:03d}', NEGATIVE_WINDOW_SEC)
                    counts[category] += len(parts)
                    existing += len(parts)
                else:
                    # Convert directly
                    out_name = f'{audio_file.stem}_{existing:03d}.wav'
                    out_path = dst_dir / out_name
                    if convert_to_wav(audio_file, out_path, SAMPLE_RATE):
                        counts[category] += 1
                    else:
                        print(f'  WARN: Failed to convert {audio_file.name}')
                    existing += 1

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    return counts

def write_combined_manifest():
    """Generate a manifest of all processed training data."""
    manifest = {
        'sample_rate': SAMPLE_RATE,
        'format': 'PCM 16-bit signed little-endian',
        'channels': 1,
        'categories': {}
    }

    for category in ['positive', 'negative', 'hard_negative']:
        cat_dir = OUTPUT_DIR / category
        if cat_dir.exists():
            files = sorted([f.name for f in cat_dir.glob('*.wav')])
            manifest['categories'][category] = {
                'count': len(files),
                'files': files
            }
        else:
            manifest['categories'][category] = {'count': 0, 'files': []}

    manifest_path = OUTPUT_DIR / 'manifest.json'
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    return manifest

def main():
    if len(sys.argv) < 2:
        print('Usage: python preprocess_samples.py <zip_file> [more_zips...]')
        print('  Converts voice collector exports to 16kHz WAV for OWW training.')
        sys.exit(1)

    if not check_ffmpeg():
        sys.exit(1)

    # Create output directory
    OUTPUT_DIR.mkdir(exist_ok=True)
    for cat in ['positive', 'negative', 'hard_negative']:
        (OUTPUT_DIR / cat).mkdir(exist_ok=True)

    print('Athena Wake Word — Sample Preprocessor')
    print('=' * 50)

    total = {'positive': 0, 'negative': 0, 'hard_negative': 0}

    for zip_path in sys.argv[1:]:
        print(f'\nProcessing: {zip_path}')
        counts = process_zip(zip_path)
        for k, v in counts.items():
            total[k] += v
        print(f'  → {counts["positive"]} positive, {counts["negative"]} negative, {counts["hard_negative"]} hard negative')

    # Write combined manifest
    manifest = write_combined_manifest()

    print('\n' + '=' * 50)
    print('Training data ready:')
    print(f'  {OUTPUT_DIR}/positive/      {manifest["categories"]["positive"]["count"]} files')
    print(f'  {OUTPUT_DIR}/negative/      {manifest["categories"]["negative"]["count"]} files')
    print(f'  {OUTPUT_DIR}/hard_negative/ {manifest["categories"]["hard_negative"]["count"]} files')
    print(f'\nTotal: {sum(c["count"] for c in manifest["categories"].values())} WAV files at {SAMPLE_RATE}Hz mono')

    # Recommendations
    pos = manifest['categories']['positive']['count']
    neg = manifest['categories']['negative']['count']
    hard = manifest['categories']['hard_negative']['count']

    print('\nRecommendations:')
    if pos < 100:
        print(f'  ⚠ {pos} positive samples — aim for 200+ for robust detection')
    else:
        print(f'  ✓ {pos} positive samples — good coverage')

    if neg < 200:
        print(f'  ⚠ {neg} negative samples — aim for 500+ (record more ambient audio)')
    else:
        print(f'  ✓ {neg} negative samples — good coverage')

    if hard < 30:
        print(f'  ⚠ {hard} hard negative samples — aim for 50+ to reduce false triggers')
    else:
        print(f'  ✓ {hard} hard negative samples — good coverage')

if __name__ == '__main__':
    main()
