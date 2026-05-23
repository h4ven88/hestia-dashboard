#!/usr/bin/env python3
"""
Hestia Wake Word — Model Benchmarker (OWW native)

Uses openwakeword's own inference pipeline to evaluate two models
side-by-side on the same test clips. This matches exactly how the
browser/production OWW runtime scores audio.

Usage:
  python benchmark_model.py --word athena
  python benchmark_model.py --word athena --model-a ../models/athena.onnx --model-b ../models/athena_backup.onnx
  python benchmark_model.py --word athena --threshold 0.40 --limit 200
"""

import sys
import os
import struct
import argparse
import numpy as np
from pathlib import Path

if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

try:
    from openwakeword.model import Model
except ImportError:
    print('ERROR: pip install openwakeword')
    sys.exit(1)

SAMPLE_RATE = 16000
FRAME_SIZE = 1280
MODELS_DIR = Path('../models')


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
    raise ValueError('No data chunk')


def load_audio_files(d, limit=None):
    out = []
    p = Path(d)
    if not p.exists():
        return out
    files = sorted(p.glob('*.wav'))
    if limit:
        files = files[:limit]
    for f in files:
        try:
            s = read_wav(f)
            if len(s) > FRAME_SIZE:
                out.append((f.name, s))
        except Exception:
            pass
    return out


def score_clip_oww(audio_float32, oww_model, model_key):
    """Feed audio through OWW in 1280-sample chunks, return max score."""
    oww_model.reset()
    audio_int16 = (np.clip(audio_float32, -1.0, 1.0) * 32767).astype(np.int16)

    max_score = 0.0
    all_scores = []
    for i in range(0, len(audio_int16) - FRAME_SIZE + 1, FRAME_SIZE):
        chunk = audio_int16[i:i+FRAME_SIZE]
        prediction = oww_model.predict(chunk)
        score = prediction.get(model_key, 0.0)
        all_scores.append(score)
        if score > max_score:
            max_score = score

    return max_score, all_scores


def run_benchmark(clips, oww_model, model_key, threshold):
    results = []
    for idx, (name, audio) in enumerate(clips):
        if (idx + 1) % 10 == 0 or idx == 0:
            print(f'    Processing {idx+1}/{len(clips)}...', flush=True)
        max_score, _ = score_clip_oww(audio, oww_model, model_key)
        detected = max_score >= threshold
        results.append((name, max_score, detected))
    return results


def print_results_table(label, results, threshold):
    detected = sum(1 for _, _, d in results if d)
    total = len(results)
    scores = [s for _, s, _ in results]
    avg = np.mean(scores) if scores else 0
    median = np.median(scores) if scores else 0
    mn = np.min(scores) if scores else 0
    mx = np.max(scores) if scores else 0

    print(f'\n  {label}:')
    print(f'    Detection rate: {detected}/{total} ({detected/total*100:.1f}%)')
    print(f'    Avg score:      {avg:.4f}')
    print(f'    Median score:   {median:.4f}')
    print(f'    Min / Max:      {mn:.4f} / {mx:.4f}')
    print(f'    Threshold:      {threshold}')

    return detected, total, avg, scores


def main():
    parser = argparse.ArgumentParser(description='Hestia Wake Word — Model Benchmarker (OWW native)')
    parser.add_argument('--word', required=True, help='Wake word name')
    parser.add_argument('--model-a', default=None, help='Path to model A (default: models/{word}.onnx)')
    parser.add_argument('--model-b', default=None, help='Path to model B (default: models/{word}_backup.onnx)')
    parser.add_argument('--label-a', default='New Model', help='Label for model A')
    parser.add_argument('--label-b', default='Backup Model', help='Label for model B')
    parser.add_argument('--threshold', type=float, default=0.40, help='Detection threshold (default: 0.40)')
    parser.add_argument('--limit', type=int, default=None, help='Max clips per category')
    parser.add_argument('--training-dir', default=None, help='Training data directory')
    parser.add_argument('--models-dir', default=None, help='Backbone models directory')
    args = parser.parse_args()

    word = args.word.lower()
    models_dir = Path(args.models_dir) if args.models_dir else MODELS_DIR

    model_a_path = Path(args.model_a) if args.model_a else models_dir / f'{word}.onnx'
    model_b_path = Path(args.model_b) if args.model_b else models_dir / f'{word}_backup.onnx'

    if not model_a_path.exists():
        print(f'ERROR: Model A not found: {model_a_path}')
        sys.exit(1)
    if not model_b_path.exists():
        print(f'ERROR: Model B not found: {model_b_path}')
        sys.exit(1)

    if args.training_dir:
        training_dir = Path(args.training_dir)
    else:
        training_dir = Path(f'training_data_{word}')
        if not training_dir.exists():
            training_dir = Path('training_data')

    print(f'Hestia Wake Word — Model Benchmarker (OWW native)', flush=True)
    print(f'{"=" * 60}')
    print(f'  Word:       {word}')
    print(f'  Model A:    {model_a_path} ({args.label_a})')
    print(f'  Model B:    {model_b_path} ({args.label_b})')
    print(f'  Threshold:  {args.threshold}')
    print(f'  Data dir:   {training_dir}/', flush=True)

    # Load test data
    print(f'\n{"=" * 60}')
    print(f'Loading test clips...', flush=True)
    positives = load_audio_files(training_dir / 'positive', args.limit)
    negatives = load_audio_files(training_dir / 'negative', args.limit)
    hard_negatives = load_audio_files(training_dir / 'hard_negative', args.limit)

    print(f'  Positive clips:      {len(positives)}')
    print(f'  Negative clips:      {len(negatives)}')
    print(f'  Hard negative clips: {len(hard_negatives)}', flush=True)

    if not positives:
        print('ERROR: No positive clips found')
        sys.exit(1)

    # Load OWW models
    print(f'\nLoading OWW model A: {model_a_path}', flush=True)
    oww_a = Model(wakeword_models=[str(model_a_path)], inference_framework='onnx')
    models_a = list(oww_a.models.keys())
    key_a = models_a[0] if models_a else word
    print(f'  Model key: {key_a}', flush=True)

    print(f'Loading OWW model B: {model_b_path}', flush=True)
    oww_b = Model(wakeword_models=[str(model_b_path)], inference_framework='onnx')
    models_b = list(oww_b.models.keys())
    key_b = models_b[0] if models_b else word
    print(f'  Model key: {key_b}', flush=True)

    threshold = args.threshold

    # ── Positives ──
    print(f'\n{"=" * 60}')
    print(f'POSITIVE CLIPS (should detect)')
    print(f'{"=" * 60}')

    print(f'\n  Running {args.label_a} on {len(positives)} clips...')
    pos_a = run_benchmark(positives, oww_a, key_a, threshold)
    det_a, tot_a, avg_a, scores_a = print_results_table(args.label_a, pos_a, threshold)

    print(f'\n  Running {args.label_b} on {len(positives)} clips...')
    pos_b = run_benchmark(positives, oww_b, key_b, threshold)
    det_b, tot_b, avg_b, scores_b = print_results_table(args.label_b, pos_b, threshold)

    # ── Negatives ──
    neg_results = None
    if negatives:
        print(f'\n{"=" * 60}')
        print(f'NEGATIVE CLIPS (should NOT detect)')
        print(f'{"=" * 60}')

        print(f'\n  Running {args.label_a} on {len(negatives)} clips...')
        neg_a = run_benchmark(negatives, oww_a, key_a, threshold)
        fa_a, neg_tot_a, neg_avg_a, _ = print_results_table(args.label_a, neg_a, threshold)

        print(f'\n  Running {args.label_b} on {len(negatives)} clips...')
        neg_b = run_benchmark(negatives, oww_b, key_b, threshold)
        fa_b, neg_tot_b, neg_avg_b, _ = print_results_table(args.label_b, neg_b, threshold)
        neg_results = (fa_a, neg_tot_a, neg_avg_a, fa_b, neg_tot_b, neg_avg_b)

    # ── Hard Negatives ──
    hard_results = None
    if hard_negatives:
        print(f'\n{"=" * 60}')
        print(f'HARD NEGATIVE CLIPS (similar words — should NOT detect)')
        print(f'{"=" * 60}')

        print(f'\n  Running {args.label_a} on {len(hard_negatives)} clips...')
        hard_a = run_benchmark(hard_negatives, oww_a, key_a, threshold)
        hfa_a, htot_a, _, _ = print_results_table(args.label_a, hard_a, threshold)

        print(f'\n  Running {args.label_b} on {len(hard_negatives)} clips...')
        hard_b = run_benchmark(hard_negatives, oww_b, key_b, threshold)
        hfa_b, htot_b, _, _ = print_results_table(args.label_b, hard_b, threshold)
        hard_results = (hfa_a, htot_a, hfa_b, htot_b)

    # ── Summary ──
    print(f'\n{"=" * 60}')
    print(f'SUMMARY — {word.upper()} @ threshold {threshold}')
    print(f'{"=" * 60}')
    print(f'  {"Metric":<30} {args.label_a:>14} {args.label_b:>14}   {"Delta":>8}')
    print(f'  {"-" * 30} {"-" * 14} {"-" * 14}   {"-" * 8}')

    rate_a = det_a / tot_a * 100
    rate_b = det_b / tot_b * 100
    delta_det = rate_a - rate_b
    sign = '+' if delta_det > 0 else ''
    print(f'  {"Detection rate (pos)":<30} {rate_a:>13.1f}% {rate_b:>13.1f}%   {sign}{delta_det:>7.1f}%')

    delta_avg = avg_a - avg_b
    sign = '+' if delta_avg > 0 else ''
    print(f'  {"Avg confidence (pos)":<30} {avg_a:>14.4f} {avg_b:>14.4f}   {sign}{delta_avg:>.4f}')

    if neg_results:
        fa_a, neg_tot_a, neg_avg_a, fa_b, neg_tot_b, neg_avg_b = neg_results
        fa_rate_a = fa_a / neg_tot_a * 100
        fa_rate_b = fa_b / neg_tot_b * 100
        delta_fa = fa_rate_a - fa_rate_b
        sign = '+' if delta_fa > 0 else ''
        print(f'  {"False activations (neg)":<30} {fa_rate_a:>13.1f}% {fa_rate_b:>13.1f}%   {sign}{delta_fa:>7.1f}%')

    if hard_results:
        hfa_a, htot_a, hfa_b, htot_b = hard_results
        hfa_rate_a = hfa_a / htot_a * 100
        hfa_rate_b = hfa_b / htot_b * 100
        delta_hfa = hfa_rate_a - hfa_rate_b
        sign = '+' if delta_hfa > 0 else ''
        print(f'  {"False activations (hard)":<30} {hfa_rate_a:>13.1f}% {hfa_rate_b:>13.1f}%   {sign}{delta_hfa:>7.1f}%')

    # Per-clip comparison (biggest differences)
    print(f'\n{"-" * 60}')
    print(f'Biggest per-clip differences (positive clips):')
    print(f'  {"Clip":<35} {"A":>8} {"B":>8} {"Diff":>8}')
    print(f'  {"-" * 35} {"-" * 8} {"-" * 8} {"-" * 8}')

    diffs = []
    for (name_a, score_a, _), (_, score_b, _) in zip(pos_a, pos_b):
        diffs.append((name_a, score_a, score_b, score_a - score_b))

    diffs.sort(key=lambda x: abs(x[3]), reverse=True)
    for name, sa, sb, d in diffs[:15]:
        sign = '+' if d > 0 else ''
        short = name[:33] + '..' if len(name) > 35 else name
        print(f'  {short:<35} {sa:>8.4f} {sb:>8.4f} {sign}{d:>7.4f}')

    # Score distribution
    print(f'\n{"-" * 60}')
    print(f'Score distribution (positive clips):')
    for label, scores in [(args.label_a, scores_a), (args.label_b, scores_b)]:
        bins = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
        hist, _ = np.histogram(scores, bins=bins)
        print(f'\n  {label}:')
        for i in range(len(hist)):
            bar = '#' * min(hist[i], 50)
            print(f'    {bins[i]:.1f}-{bins[i+1]:.1f}: {hist[i]:>4}  {bar}')

    # Verdict
    print(f'\n{"=" * 60}')
    better_detection = rate_a > rate_b
    fewer_fa = True
    if neg_results:
        fewer_fa = fa_a <= fa_b

    if better_detection and fewer_fa:
        print(f'  VERDICT: {args.label_a} is BETTER (higher detection, same or fewer false activations)')
    elif better_detection and not fewer_fa:
        print(f'  VERDICT: TRADEOFF — {args.label_a} detects more but has more false activations')
    elif not better_detection and fewer_fa:
        print(f'  VERDICT: TRADEOFF — {args.label_a} has fewer false activations but lower detection')
    elif rate_a == rate_b and avg_a > avg_b:
        print(f'  VERDICT: {args.label_a} is SLIGHTLY BETTER (same detection rate, higher confidence)')
    elif rate_a == rate_b and avg_a < avg_b:
        print(f'  VERDICT: {args.label_b} is SLIGHTLY BETTER (same detection rate, higher confidence)')
    else:
        print(f'  VERDICT: {args.label_b} is BETTER')
    print(f'{"=" * 60}')


if __name__ == '__main__':
    main()
