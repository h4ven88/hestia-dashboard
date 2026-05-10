#!/usr/bin/env python3
"""
Batch scrape all wake words in sequence.

Usage:
  python scrape_all.py              # scrape all words
  python scrape_all.py --dry-run    # transcript scan only
  python scrape_all.py --only apollo odin   # scrape specific words
"""

import subprocess
import sys
import time
from pathlib import Path

WORDS = [
    ('apollo',    'urls_apollo.txt'),
    ('achilles',  'urls_achilles.txt'),
    ('andromeda', 'urls_andromeda.txt'),
    ('hermes',    'urls_hermes.txt'),
    ('odin',      'urls_odin.txt'),
    ('osiris',    'urls_osiris.txt'),
    ('anubis',    'urls_anubis.txt'),
]

def main():
    dry_run = '--dry-run' in sys.argv
    only = []
    if '--only' in sys.argv:
        idx = sys.argv.index('--only')
        only = [w.lower() for w in sys.argv[idx + 1:] if not w.startswith('--')]

    script = Path(__file__).parent / 'scrape_wakeword.py'

    for word, urls_file in WORDS:
        if only and word not in only:
            continue

        urls_path = Path(__file__).parent / urls_file
        if not urls_path.exists():
            print(f'\n⚠ Skipping {word} — {urls_file} not found')
            continue

        print(f'\n{"=" * 60}')
        print(f'  SCRAPING: {word.upper()}')
        print(f'{"=" * 60}')

        cmd = [sys.executable, str(script), '--word', word, str(urls_path)]
        if dry_run:
            cmd.append('--dry-run')

        result = subprocess.run(cmd)

        if result.returncode != 0:
            print(f'\n⚠ {word} scrape failed (exit code {result.returncode})')

        time.sleep(5)

    print(f'\n{"=" * 60}')
    print('ALL DONE')
    print(f'{"=" * 60}')

    for word, _ in WORDS:
        if only and word not in only:
            continue
        d = Path(__file__).parent / f'training_data_{word}'
        if d.exists():
            pos = len(list((d / 'positive').glob('*.wav'))) if (d / 'positive').exists() else 0
            neg = len(list((d / 'negative').glob('*.wav'))) if (d / 'negative').exists() else 0
            print(f'  {word:12s}  {pos:4d} positive  {neg:4d} negative')


if __name__ == '__main__':
    main()
