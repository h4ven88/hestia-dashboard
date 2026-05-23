#!/usr/bin/env python3
"""
Hestia Wake Word — Local Training Setup (one-time)

Downloads all dependencies and datasets needed for local OWW model training.
Run once, then use train_local.py for each word.

Usage:
  python setup_training.py
  python setup_training.py --check    # verify setup without downloading

Requirements:
  - Python 3.11 or 3.12 (PyTorch needs compatible wheels)
  - NVIDIA GPU + CUDA drivers (RTX 3080 recommended)
  - ~6 GB disk space for datasets
  - git and git-lfs installed
"""

import os
import sys
import subprocess
import shutil
import tarfile
import urllib.request
from pathlib import Path

WORK_DIR = Path(__file__).parent / 'oww_training'

PIPER_REPO = 'https://github.com/rhasspy/piper-sample-generator'
PIPER_COMMIT = '213d4d5'
PIPER_MODEL_URL = 'https://github.com/rhasspy/piper-sample-generator/releases/download/v2.0.0/en_US-libritts_r-medium.pt'

OWW_REPO = 'https://github.com/dscripka/openwakeword'

OWW_MODELS = {
    'embedding_model.onnx': 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx',
    'embedding_model.tflite': 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.tflite',
    'melspectrogram.onnx': 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx',
    'melspectrogram.tflite': 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.tflite',
}

FEATURE_FILES = {
    'openwakeword_features_ACAV100M_2000_hrs_16bit.npy':
        'https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/openwakeword_features_ACAV100M_2000_hrs_16bit.npy',
    'validation_set_features.npy':
        'https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/validation_set_features.npy',
}


PIP_PACKAGES = [
    'piper-tts', 'webrtcvad',
    'mutagen', 'torchinfo', 'torchmetrics',
    'speechbrain', 'audiomentations',
    'torch-audiomentations', 'acoustics',
    'onnxruntime', 'ai_edge_litert', 'onnxsim',
    'onnx2tf', 'onnx', 'onnx_graphsurgeon', 'sng4onnx',
    'pronouncing', 'datasets', 'deep-phonemizer',
    'pyyaml', 'scipy', 'tqdm', 'numpy',
]


def download_file(url, dest, desc=None):
    dest = Path(dest)
    if dest.exists():
        print(f'  [skip] {desc or dest.name} already exists')
        return
    print(f'  Downloading {desc or dest.name}...')
    dest.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(url, str(dest))
    print(f'  Done ({dest.stat().st_size / 1024 / 1024:.1f} MB)')


def run(cmd, cwd=None, desc=None):
    if desc:
        print(f'  {desc}...')
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if result.returncode != 0:
        print(f'  FAILED: {" ".join(str(c) for c in cmd)}')
        if result.stderr:
            print(f'  {result.stderr[:500]}')
        return False
    return True


def check_python_version():
    v = sys.version_info
    print(f'\nPython {v.major}.{v.minor}.{v.micro}')
    if v.major != 3 or v.minor < 11:
        print(f'  WARNING: Python {v.major}.{v.minor} is too old. Need 3.11+.')
        return False
    return True


def check_gpu():
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=name,driver_version', '--format=csv,noheader'],
            capture_output=True, text=True
        )
        if result.returncode == 0:
            print(f'  GPU: {result.stdout.strip()}')
            return True
    except FileNotFoundError:
        pass
    print('  WARNING: nvidia-smi not found. Training will use CPU (slower).')
    return False


def setup_piper():
    print('\n[1/7] Piper Sample Generator')
    piper_dir = WORK_DIR / 'piper-sample-generator'
    if not piper_dir.exists():
        run(['git', 'clone', PIPER_REPO], cwd=WORK_DIR, desc='Cloning piper-sample-generator')
        run(['git', 'checkout', PIPER_COMMIT], cwd=piper_dir, desc=f'Checking out {PIPER_COMMIT}')
    else:
        print('  [skip] Already cloned')

    model_path = piper_dir / 'models' / 'en_US-libritts_r-medium.pt'
    download_file(PIPER_MODEL_URL, model_path, 'Piper TTS model')


def setup_oww():
    print('\n[2/7] OpenWakeWord')
    oww_dir = WORK_DIR / 'openwakeword'
    if not oww_dir.exists():
        run(['git', 'clone', OWW_REPO], cwd=WORK_DIR, desc='Cloning openwakeword')
    else:
        print('  [skip] Already cloned')

    run([sys.executable, '-m', 'pip', 'install', '-e', str(oww_dir), '--no-deps'],
        desc='Installing openwakeword (editable)')

    models_dir = oww_dir / 'openwakeword' / 'resources' / 'models'
    models_dir.mkdir(parents=True, exist_ok=True)
    for name, url in OWW_MODELS.items():
        download_file(url, models_dir / name, name)


def install_packages():
    print('\n[3/7] Python packages')

    # PyTorch with CUDA — check if already installed with GPU support
    try:
        import torch
        if torch.cuda.is_available():
            print(f'  [skip] PyTorch {torch.__version__} with CUDA already installed')
        else:
            print('  PyTorch installed but no CUDA. Installing CUDA build...')
            run([sys.executable, '-m', 'pip', 'install',
                 'torch', 'torchvision', 'torchaudio',
                 '--force-reinstall', '--index-url', 'https://download.pytorch.org/whl/cu126'],
                desc='PyTorch + CUDA 12.6')
    except ImportError:
        print('  Installing PyTorch with CUDA 12.6...')
        run([sys.executable, '-m', 'pip', 'install',
             'torch', 'torchvision', 'torchaudio',
             '--index-url', 'https://download.pytorch.org/whl/cu126'],
            desc='PyTorch + CUDA 12.6')

    print('  Installing remaining packages...')
    run([sys.executable, '-m', 'pip', 'install'] + PIP_PACKAGES,
        desc='Dependencies')


def setup_rir_data():
    print('\n[4/7] MIT Room Impulse Responses')
    rir_dir = WORK_DIR / 'mit_rirs'
    if rir_dir.exists() and any(rir_dir.glob('*.wav')):
        print(f'  [skip] Already have {len(list(rir_dir.glob("*.wav")))} RIR files')
        return

    rir_repo = WORK_DIR / 'MIT_environmental_impulse_responses'
    if not rir_repo.exists():
        run(['git', 'lfs', 'install'], cwd=WORK_DIR, desc='git lfs install')
        run(['git', 'clone', 'https://huggingface.co/datasets/davidscripka/MIT_environmental_impulse_responses'],
            cwd=WORK_DIR, desc='Cloning MIT RIR dataset')

    print('  Copying RIR WAV files...')
    import numpy as np
    import librosa
    import scipy.io.wavfile

    rir_dir.mkdir(exist_ok=True)
    src_dir = rir_repo / '16khz'
    wav_files = list(src_dir.glob('*.wav'))
    print(f'  Found {len(wav_files)} source files')
    for f in wav_files:
        audio, sr = librosa.load(str(f), sr=16000, mono=True)
        scipy.io.wavfile.write(str(rir_dir / f.name), 16000,
                               (audio * 32767).astype(np.int16))
    print(f'  Done: {len(list(rir_dir.glob("*.wav")))} files')


def setup_audioset():
    print('\n[5/7] Background noise data (ESC-50)')
    audioset_dir = WORK_DIR / 'audioset_16k'
    if audioset_dir.exists() and any(audioset_dir.glob('*.wav')):
        print(f'  [skip] Already have {len(list(audioset_dir.glob("*.wav")))} noise files')
        return

    import numpy as np
    import librosa
    import scipy.io.wavfile
    import zipfile

    esc_zip = WORK_DIR / 'ESC-50-master.zip'
    download_file(
        'https://github.com/karoldvl/ESC-50/archive/refs/heads/master.zip',
        esc_zip, 'ESC-50 environmental sounds (~600 MB)')

    print('  Extracting and converting to 16kHz...')
    audioset_dir.mkdir(exist_ok=True)
    count = 0
    with zipfile.ZipFile(str(esc_zip)) as zf:
        audio_files = [n for n in zf.namelist()
                       if (n.endswith('.wav') or n.endswith('.ogg')) and '/audio/' in n]
        for name in audio_files:
            try:
                import io
                data = zf.read(name)
                audio, sr = librosa.load(io.BytesIO(data), sr=16000, mono=True)
                if len(audio) < 16000:
                    continue
                wav_name = Path(name).stem + '.wav'
                scipy.io.wavfile.write(str(audioset_dir / wav_name), 16000,
                                       (audio * 32767).astype(np.int16))
                count += 1
                if count % 200 == 0:
                    print(f'    {count}/{len(audio_files)}...')
            except Exception:
                continue
    print(f'  Done: {count} files')


def setup_fma():
    print('\n[6/7] Music background noise')
    fma_dir = WORK_DIR / 'fma'
    if fma_dir.exists() and any(fma_dir.glob('*.wav')):
        print(f'  [skip] Already have {len(list(fma_dir.glob("*.wav")))} music files')
        return

    import numpy as np
    import scipy.io.wavfile

    fma_dir.mkdir(exist_ok=True)

    gtzan_tar = WORK_DIR / 'genres.tar.gz'
    gtzan_dir = WORK_DIR / 'genres'

    try:
        if not gtzan_dir.exists():
            download_file(
                'https://huggingface.co/datasets/marsyas/gtzan/resolve/main/data/genres.tar.gz',
                gtzan_tar, 'GTZAN genres (~1.2 GB)')

            print('  Extracting...')
            import tarfile
            with tarfile.open(str(gtzan_tar), 'r:gz') as tf:
                tf.extractall(str(WORK_DIR))

        import librosa
        print('  Converting to 16kHz WAV...')
        au_files = list(gtzan_dir.rglob('*.au')) + list(gtzan_dir.rglob('*.wav'))
        count = 0
        for f in au_files:
            try:
                audio, sr = librosa.load(str(f), sr=16000, mono=True)
                if len(audio) < 16000:
                    continue
                scipy.io.wavfile.write(str(fma_dir / f'music_{count:04d}.wav'),
                                       16000, (audio * 32767).astype(np.int16))
                count += 1
                if count % 100 == 0:
                    print(f'    {count}/{len(au_files)}...')
            except Exception:
                continue
        print(f'  Done: {count} music files')
    except Exception as e:
        print(f'  WARNING: Music download failed: {e}')
        print('  Generating synthetic noise clips as fallback...')
        rng = np.random.default_rng(42)
        for i in range(200):
            dur = rng.integers(3, 10)
            samples = dur * 16000
            noise = rng.normal(0, 0.3, samples).astype(np.float32)
            b = rng.uniform(0.5, 2.0)
            freqs = np.fft.rfftfreq(len(noise), 1.0 / 16000)
            freqs[0] = 1.0
            pink_filter = 1.0 / np.power(freqs, b / 2)
            spectrum = np.fft.rfft(noise) * pink_filter
            colored = np.fft.irfft(spectrum, len(noise))
            colored = colored / (np.abs(colored).max() + 1e-8) * 0.7
            scipy.io.wavfile.write(str(fma_dir / f'synth_{i:04d}.wav'),
                                   16000, (colored * 32767).astype(np.int16))
        print(f'  Generated 200 synthetic noise clips as fallback')


def setup_features():
    print('\n[7/7] Pre-computed OWW features')
    for name, url in FEATURE_FILES.items():
        download_file(url, WORK_DIR / name, name)


def check_setup():
    print('\n' + '=' * 60)
    print('Setup Verification')
    print('=' * 60)
    ok = True

    checks = [
        ('Piper repo', WORK_DIR / 'piper-sample-generator' / 'generate_samples.py'),
        ('Piper model', WORK_DIR / 'piper-sample-generator' / 'models' / 'en_US-libritts_r-medium.pt'),
        ('OWW repo', WORK_DIR / 'openwakeword' / 'openwakeword' / 'train.py'),
        ('OWW embedding model', WORK_DIR / 'openwakeword' / 'openwakeword' / 'resources' / 'models' / 'embedding_model.onnx'),
        ('MIT RIRs', WORK_DIR / 'mit_rirs'),
        ('AudioSet', WORK_DIR / 'audioset_16k'),
        ('FMA', WORK_DIR / 'fma'),
        ('ACAV features', WORK_DIR / 'openwakeword_features_ACAV100M_2000_hrs_16bit.npy'),
        ('Validation features', WORK_DIR / 'validation_set_features.npy'),
        ('OWW config template', WORK_DIR / 'openwakeword' / 'examples' / 'custom_model.yml'),
    ]

    for name, path in checks:
        exists = path.exists()
        if path.is_dir() and exists:
            count = len(list(path.glob('*.wav')))
            status = f'OK ({count} files)' if count > 0 else 'EMPTY'
            if count == 0:
                ok = False
        elif exists:
            status = 'OK'
        else:
            status = 'MISSING'
            ok = False
        print(f'  {"[OK]" if "OK" in status else "[!!]"} {name}: {status}')

    # Check PyTorch + CUDA
    try:
        import torch
        gpu = torch.cuda.is_available()
        print(f'  {"[OK]" if gpu else "[!!]"} PyTorch {torch.__version__}, CUDA: {gpu}')
        if gpu:
            print(f'       GPU: {torch.cuda.get_device_name(0)}')
        if not gpu:
            ok = False
    except ImportError:
        print('  [!!] PyTorch: NOT INSTALLED')
        ok = False

    print()
    if ok:
        print('  All checks passed! Ready to train.')
        print('  Usage: python train_local.py --word athena --examples 50000 --steps 50000 --fa-penalty 2500')
    else:
        print('  Some checks failed. Run setup_training.py again or fix manually.')
    return ok


def main():
    if '--check' in sys.argv:
        check_setup()
        return

    print('Hestia Wake Word — Local Training Setup')
    print('=' * 60)

    WORK_DIR.mkdir(exist_ok=True)

    compatible = check_python_version()
    if not compatible:
        resp = input('\nContinue anyway? (y/n): ').strip().lower()
        if resp != 'y':
            print('Install Python 3.12, create a venv, and re-run.')
            sys.exit(1)

    check_gpu()

    setup_piper()
    setup_oww()
    install_packages()
    setup_rir_data()
    setup_audioset()
    setup_fma()
    setup_features()

    check_setup()


if __name__ == '__main__':
    main()
