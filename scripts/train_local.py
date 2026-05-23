#!/usr/bin/env python3
"""
Hestia Wake Word — Local Model Trainer

Trains an OpenWakeWord model locally using your GPU.
Each word gets an isolated output directory, so you can train multiple words in parallel.

Usage:
  python train_local.py --word athena
  python train_local.py --word athena --examples 50000 --steps 50000 --fa-penalty 2500
  python train_local.py --word athena --skip-generate   # re-train without regenerating clips

Prerequisites:
  python setup_training.py   (one-time setup)
"""

import argparse
import os
import sys
import shutil
import glob
import subprocess
import time
import yaml
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent
WORK_DIR = SCRIPTS_DIR / 'oww_training'
MODELS_DIR = SCRIPTS_DIR.parent / 'models'


def check_setup():
    issues = []
    if not (WORK_DIR / 'openwakeword' / 'openwakeword' / 'train.py').exists():
        issues.append('OpenWakeWord repo not found')
    if not (WORK_DIR / 'piper-sample-generator' / 'generate_samples.py').exists():
        issues.append('Piper sample generator not found')
    if not (WORK_DIR / 'openwakeword_features_ACAV100M_2000_hrs_16bit.npy').exists():
        issues.append('ACAV features not found')
    if not (WORK_DIR / 'validation_set_features.npy').exists():
        issues.append('Validation features not found')
    if issues:
        print('Setup incomplete:')
        for i in issues:
            print(f'  - {i}')
        print('\nRun: python setup_training.py')
        sys.exit(1)


def train_word(word, n_examples, n_steps, fa_penalty, skip_generate=False, phrase=None):
    training_data = SCRIPTS_DIR / f'training_data_{word}'
    if not training_data.exists():
        print(f'ERROR: {training_data} not found')
        sys.exit(1)

    pos_count = len(list((training_data / 'positive').glob('*.wav')))
    neg_count = len(list((training_data / 'negative').glob('*.wav')))
    print(f'Training data: {pos_count} positive, {neg_count} negative clips')

    output_dir = WORK_DIR / f'output_{word}'
    output_dir.mkdir(exist_ok=True)

    config_path = WORK_DIR / f'config_{word}.yaml'
    oww_dir = WORK_DIR / 'openwakeword'
    train_script = oww_dir / 'openwakeword' / 'train.py'

    # Load default config and customize
    default_config = oww_dir / 'examples' / 'custom_model.yml'
    config = yaml.load(open(default_config, 'r').read(), yaml.Loader)

    config['target_phrase'] = [phrase or word]
    config['model_name'] = word.replace(' ', '_')
    config['n_samples'] = n_examples
    config['n_samples_val'] = max(500, n_examples // 10)
    config['steps'] = n_steps
    config['target_accuracy'] = 0.5
    config['target_recall'] = 0.25
    config['output_dir'] = str(output_dir)
    config['max_negative_weight'] = fa_penalty
    config['background_paths'] = [
        str(WORK_DIR / 'audioset_16k'),
        str(WORK_DIR / 'fma'),
    ]
    config['rir_paths'] = [str(WORK_DIR / 'mit_rirs')]
    config['piper_sample_generator_path'] = str(WORK_DIR / 'piper-sample-generator')
    config['false_positive_validation_data_path'] = str(WORK_DIR / 'validation_set_features.npy')
    config['feature_data_files'] = {
        'ACAV100M_sample': str(WORK_DIR / 'openwakeword_features_ACAV100M_2000_hrs_16bit.npy')
    }
    config['batch_n_per_class'] = {
        'ACAV100M_sample': 1024,
        'adversarial_negative': 128,
        'positive': 256,
    }
    config['augmentation_rounds'] = 2

    with open(config_path, 'w') as f:
        yaml.dump(config, f)

    # Ensure piper-sample-generator is on the path
    piper_dir = str(WORK_DIR / 'piper-sample-generator')
    if piper_dir not in sys.path:
        sys.path.insert(0, piper_dir)
    os.environ['PYTHONPATH'] = piper_dir + os.pathsep + os.environ.get('PYTHONPATH', '')

    env = os.environ.copy()
    env['PYTHONPATH'] = piper_dir + os.pathsep + env.get('PYTHONPATH', '')

    if not skip_generate:
        # Step 1: Generate synthetic clips
        print('\n' + '=' * 60)
        print(f'  Step 1/4: Generating {n_examples} synthetic clips')
        print('=' * 60)
        t0 = time.time()
        result = subprocess.run(
            [sys.executable, str(train_script), '--training_config', str(config_path), '--generate_clips'],
            cwd=str(WORK_DIR), env=env
        )
        if result.returncode != 0:
            print('ERROR: Clip generation failed')
            sys.exit(1)
        print(f'  Completed in {(time.time() - t0) / 60:.1f} minutes')

        # Step 2: Inject real recordings
        print('\n' + '=' * 60)
        print(f'  Step 2/4: Injecting real clips')
        print('=' * 60)
        import random as _rng

        model_dir = output_dir / config['model_name']
        pos_train_dir = model_dir / 'positive_train'
        pos_test_dir = model_dir / 'positive_test'
        neg_train_dir = model_dir / 'negative_train'
        neg_test_dir = model_dir / 'negative_test'

        # Inject positive clips (80% train, 20% test)
        real_pos = list((training_data / 'positive').glob('*.wav'))
        _rng.shuffle(real_pos)
        split = int(len(real_pos) * 0.8)
        for clip in real_pos[:split]:
            shutil.copy2(str(clip), str(pos_train_dir / clip.name))
        for clip in real_pos[split:]:
            shutil.copy2(str(clip), str(pos_test_dir / clip.name))
        print(f'  Positive: {split} -> train, {len(real_pos) - split} -> test')

        # Inject negative + hard_negative clips
        real_neg = list((training_data / 'negative').glob('*.wav'))
        hard_neg = list((training_data / 'hard_negative').glob('*.wav')) if (training_data / 'hard_negative').exists() else []
        all_neg = real_neg + hard_neg
        _rng.shuffle(all_neg)
        neg_split = int(len(all_neg) * 0.8)
        for clip in all_neg[:neg_split]:
            shutil.copy2(str(clip), str(neg_train_dir / clip.name))
        for clip in all_neg[neg_split:]:
            shutil.copy2(str(clip), str(neg_test_dir / clip.name))
        print(f'  Negative: {neg_split} -> train, {len(all_neg) - neg_split} -> test ({len(hard_neg)} hard negatives)')

        # Step 3: Augment clips
        print('\n' + '=' * 60)
        print(f'  Step 3/4: Augmenting clips')
        print('=' * 60)

        # Always clean feature files so augmentation runs fresh with injected clips
        feature_dir = output_dir / config['model_name']
        for f in ['positive_features_train.npy', 'positive_features_test.npy',
                   'negative_features_train.npy', 'negative_features_test.npy']:
            fp = feature_dir / f
            if fp.exists():
                fp.unlink()
                print(f'  Removed cached {f}')

        t0 = time.time()
        result = subprocess.run(
            [sys.executable, str(train_script), '--training_config', str(config_path), '--augment_clips'],
            cwd=str(WORK_DIR), env=env
        )
        if result.returncode != 0:
            print('ERROR: Augmentation failed')
            sys.exit(1)
        print(f'  Completed in {(time.time() - t0) / 60:.1f} minutes')
    else:
        print('\n  Skipping clip generation/augmentation (--skip-generate)')

    # Step 4: Train model
    print('\n' + '=' * 60)
    print(f'  Step 4/4: Training model ({n_steps} steps)')
    print('=' * 60)
    t0 = time.time()
    result = subprocess.run(
        [sys.executable, str(train_script), '--training_config', str(config_path), '--train_model'],
        cwd=str(WORK_DIR), env=env
    )
    if result.returncode != 0:
        print('ERROR: Training failed')
        sys.exit(1)
    elapsed = (time.time() - t0) / 60
    print(f'  Training completed in {elapsed:.1f} minutes')

    # Locate output model
    onnx_path = output_dir / f'{config["model_name"]}.onnx'
    if not onnx_path.exists():
        print(f'WARNING: Expected model at {onnx_path} not found')
        onnx_candidates = list(output_dir.glob('**/*.onnx'))
        if onnx_candidates:
            onnx_path = onnx_candidates[0]
            print(f'  Found: {onnx_path}')
        else:
            print('ERROR: No .onnx model file found')
            sys.exit(1)

    # Convert ONNX to tflite (requires tensorflow — not available on Python 3.14)
    tflite_dst = output_dir / f'{config["model_name"]}.tflite'
    try:
        tflite_result = subprocess.run(
            ['onnx2tf', '-i', str(onnx_path), '-o', str(output_dir), '-kat', 'onnx____Flatten_0'],
            cwd=str(WORK_DIR), env=env,
            capture_output=True, text=True, encoding='utf-8', errors='replace'
        )
        tflite_src = output_dir / f'{config["model_name"]}_float32.tflite'
        if tflite_src.exists():
            shutil.move(str(tflite_src), str(tflite_dst))
            print(f'\n  tflite saved: {tflite_dst.name}')
        elif tflite_result.returncode != 0:
            print(f'\n  Skipping tflite (tensorflow not available — ONNX model is all you need)')
    except FileNotFoundError:
        print(f'\n  Skipping tflite (onnx2tf not found — ONNX model is all you need)')

    # Copy to models/ directory
    print('\n' + '=' * 60)
    print('  Deploying model')
    print('=' * 60)

    dest_onnx = MODELS_DIR / f'{word}.onnx'
    dest_tflite = MODELS_DIR / f'{word.capitalize()}.tflite'

    # Backup existing model
    if dest_onnx.exists():
        backup = MODELS_DIR / f'{word}_backup.onnx'
        shutil.copy2(str(dest_onnx), str(backup))
        print(f'  Backed up existing model to {backup.name}')

    # Embed external data into single ONNX file (needed for browser deployment)
    import onnx
    model_data = onnx.load(str(onnx_path), load_external_data=True)
    onnx.save(model_data, str(dest_onnx), save_as_external_data=False)
    print(f'  Deployed: {dest_onnx} ({dest_onnx.stat().st_size / 1024:.1f} KB)')

    if tflite_dst.exists():
        shutil.copy2(str(tflite_dst), str(dest_tflite))
        print(f'  Deployed: {dest_tflite}')

    print(f'\n  Model size: {dest_onnx.stat().st_size / 1024:.1f} KB')
    print(f'\n  Done! Run benchmark to verify:')
    print(f'  python benchmark_model.py --word {word}')


def main():
    parser = argparse.ArgumentParser(description='Train OWW wake word model locally')
    parser.add_argument('--word', required=True, help='Wake word to train (e.g., athena)')
    parser.add_argument('--examples', type=int, default=50000, help='Synthetic examples to generate (default: 50000)')
    parser.add_argument('--steps', type=int, default=50000, help='Training steps (default: 50000)')
    parser.add_argument('--fa-penalty', type=int, default=2500, help='False activation penalty (default: 2500)')
    parser.add_argument('--phrase', default=None,
                        help='Phonetic phrase for TTS (e.g., "uh thee nuh"). Model still named after --word.')
    parser.add_argument('--skip-generate', action='store_true',
                        help='Skip clip generation/augmentation, only retrain')
    args = parser.parse_args()

    phrase = args.phrase or args.word

    print('Hestia Wake Word — Local Model Trainer')
    print('=' * 60)
    print(f'  Word:       {args.word}')
    if args.phrase:
        print(f'  Phrase:     {args.phrase}')
    print(f'  Examples:   {args.examples:,}')
    print(f'  Steps:      {args.steps:,}')
    print(f'  FA penalty: {args.fa_penalty:,}')
    print(f'  GPU:        ', end='')

    try:
        import torch
        if torch.cuda.is_available():
            print(f'{torch.cuda.get_device_name(0)}')
        else:
            print('None (CPU mode — will be slow)')
    except ImportError:
        print('PyTorch not found')

    check_setup()
    train_word(args.word, args.examples, args.steps, args.fa_penalty, args.skip_generate, phrase)


if __name__ == '__main__':
    main()
