#!/usr/bin/env python3
"""
Hestia Wake Word — Model Trainer v4 (Augmented MLP)

Trains a robust wake word classifier with built-in data augmentation:
  - Noise injection (music, TV, HVAC, ambient at various SNR levels)
  - Volume shifting (±6dB)
  - Time stretching (0.9x–1.1x)
  - Pitch shifting (±1.5 semitones)

Works for any wake word: athena, artemis, hestia, apollo, etc.

Usage:
  python train_model.py --word athena
  python train_model.py --word artemis --training-dir training_data_artemis
  python train_model.py --word athena --no-augment   (skip augmentation)
  python train_model.py --word athena --augment-only  (just generate augmented clips)

Expects:
  training_data[_word]/
    positive/        ← wake word utterances (16kHz mono WAV)
    negative/        ← ambient/speech without wake word
    hard_negative/   ← similar-sounding words
    noise/           ← (optional) background noise clips for augmentation
                       If empty, uses negative/ clips as noise source

Outputs:
  {word}_trained.onnx → auto-deployed to models/{word}.onnx
"""

import os
import sys
import struct
import argparse
import numpy as np
from pathlib import Path

try:
    import onnxruntime as ort
except ImportError:
    print('ERROR: pip install onnxruntime')
    sys.exit(1)

try:
    from sklearn.neural_network import MLPClassifier
    from sklearn.model_selection import cross_val_score, train_test_split
    from sklearn.metrics import classification_report, confusion_matrix
    from sklearn.preprocessing import StandardScaler
except ImportError:
    print('ERROR: pip install scikit-learn')
    sys.exit(1)

# ── Config ─────────────────────────────────────────────────────────────
MODELS_DIR = Path('../models')
SAMPLE_RATE = 16000
FRAME_SIZE = 1280
RANDOM_SEED = 42
TEST_SPLIT = 0.15

# MLP architecture: 96 → 384 → 256 → 128 → 64 → 1
HIDDEN_LAYERS = (384, 256, 128, 64)
MAX_ITER = 2000
LEARNING_RATE = 0.0003

# ── Augmentation config ────────────────────────────────────────────────
AUG_COPIES_PER_POSITIVE = 8
SNR_LEVELS_DB = [20, 15, 10, 6, 3]
VOLUME_SHIFTS_DB = [-6, -3, 3, 6]
TIME_STRETCH_FACTORS = [0.9, 0.95, 1.05, 1.1]
PITCH_SHIFT_SEMITONES = [-1.5, -0.75, 0.75, 1.5]


# ── Audio utilities ────────────────────────────────────────────────────

def read_wav(path):
    """Read 16-bit PCM WAV, return float32 array normalized to [-1, 1]."""
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


def load_audio_files(d):
    """Load all WAV files from a directory."""
    out = []
    p = Path(d)
    if not p.exists():
        return out
    for f in sorted(p.glob('*.wav')):
        try:
            s = read_wav(f)
            if len(s) > FRAME_SIZE:
                out.append(s)
        except Exception:
            pass
    return out


# ── Augmentation functions ─────────────────────────────────────────────

def add_noise(signal, noise, snr_db):
    """Mix signal with noise at a given SNR (dB). Loops noise if shorter."""
    if len(noise) < len(signal):
        repeats = (len(signal) // len(noise)) + 1
        noise = np.tile(noise, repeats)
    noise = noise[:len(signal)]

    sig_power = np.mean(signal ** 2) + 1e-10
    noise_power = np.mean(noise ** 2) + 1e-10

    snr_linear = 10 ** (snr_db / 10)
    scale = np.sqrt(sig_power / (noise_power * snr_linear))

    mixed = signal + noise * scale
    return np.clip(mixed, -1.0, 1.0)


def shift_volume(signal, db):
    """Shift volume by dB amount."""
    factor = 10 ** (db / 20)
    return np.clip(signal * factor, -1.0, 1.0)


def time_stretch(signal, factor):
    """Simple time stretch via linear interpolation (no pitch change).
    factor > 1.0 = slower (longer), factor < 1.0 = faster (shorter)."""
    indices = np.arange(0, len(signal), factor)
    indices = indices[indices < len(signal) - 1].astype(np.float32)
    int_part = indices.astype(np.int32)
    frac_part = indices - int_part
    stretched = signal[int_part] * (1 - frac_part) + signal[int_part + 1] * frac_part
    return stretched


def pitch_shift(signal, semitones, sr=SAMPLE_RATE):
    """Shift pitch by resampling (stretch then resample back to original length)."""
    factor = 2 ** (-semitones / 12.0)
    stretched = time_stretch(signal, factor)
    # Resample back to original length
    target_len = len(signal)
    indices = np.linspace(0, len(stretched) - 1, target_len)
    int_part = indices.astype(np.int32)
    int_part = np.clip(int_part, 0, len(stretched) - 2)
    frac_part = indices - int_part
    resampled = stretched[int_part] * (1 - frac_part) + stretched[int_part + 1] * frac_part
    return resampled.astype(np.float32)


def augment_positives(positives, noise_clips, rng):
    """
    Generate augmented copies of positive samples.
    Returns list of augmented audio arrays.
    """
    augmented = []
    total = len(positives) * AUG_COPIES_PER_POSITIVE
    print(f'  Generating {total} augmented positives ({AUG_COPIES_PER_POSITIVE}x per clip)...')

    for idx, clip in enumerate(positives):
        if (idx + 1) % 100 == 0:
            print(f'    Augmenting {idx+1}/{len(positives)}...')

        for aug_i in range(AUG_COPIES_PER_POSITIVE):
            augmented_clip = clip.copy()

            # Each augmentation applies a random combination of transforms

            # 1. Volume shift (50% chance)
            if rng.random() < 0.5:
                db = rng.choice(VOLUME_SHIFTS_DB)
                augmented_clip = shift_volume(augmented_clip, db)

            # 2. Time stretch (30% chance)
            if rng.random() < 0.3:
                factor = rng.choice(TIME_STRETCH_FACTORS)
                augmented_clip = time_stretch(augmented_clip, factor)
                # Pad or trim to original length
                target_len = len(clip)
                if len(augmented_clip) > target_len:
                    augmented_clip = augmented_clip[:target_len]
                elif len(augmented_clip) < target_len:
                    pad = np.zeros(target_len - len(augmented_clip), dtype=np.float32)
                    augmented_clip = np.concatenate([augmented_clip, pad])

            # 3. Pitch shift (30% chance)
            if rng.random() < 0.3:
                semitones = rng.choice(PITCH_SHIFT_SEMITONES)
                augmented_clip = pitch_shift(augmented_clip, semitones)
                target_len = len(clip)
                if len(augmented_clip) > target_len:
                    augmented_clip = augmented_clip[:target_len]
                elif len(augmented_clip) < target_len:
                    pad = np.zeros(target_len - len(augmented_clip), dtype=np.float32)
                    augmented_clip = np.concatenate([augmented_clip, pad])

            # 4. Noise injection (70% chance — this is the key augmentation)
            if rng.random() < 0.7 and noise_clips:
                noise = noise_clips[rng.randint(0, len(noise_clips))]
                # Random start offset within noise clip
                if len(noise) > len(augmented_clip):
                    start = rng.randint(0, len(noise) - len(augmented_clip))
                    noise_segment = noise[start:start + len(augmented_clip)]
                else:
                    noise_segment = noise
                snr = rng.choice(SNR_LEVELS_DB)
                augmented_clip = add_noise(augmented_clip, noise_segment, snr)

            augmented.append(augmented_clip)

    print(f'  ✓ Generated {len(augmented)} augmented clips')
    return augmented


# ── Model pipeline ─────────────────────────────────────────────────────

def probe_models(mel_sess, emb_sess):
    mel_in = mel_sess.get_inputs()[0].name
    test = np.zeros((1, FRAME_SIZE), dtype=np.float32)
    mel_out = mel_sess.run(None, {mel_in: test})[0]
    n_bands = mel_out.shape[-1]
    print(f'  Mel output: {mel_out.shape} ({n_bands} bands)')

    emb_in = emb_sess.get_inputs()[0]
    emb_shape = emb_in.shape
    print(f'  Embedding input: {emb_shape}')

    n_frames = emb_shape[1] if len(emb_shape) >= 2 and isinstance(emb_shape[1], int) else 76

    test_mel = np.zeros((1, n_frames, n_bands, 1), dtype=np.float32)
    try:
        emb_out = emb_sess.run(None, {emb_in.name: test_mel})[0]
        emb_dim = emb_out.flatten().shape[0]
        print(f'  Embedding output: {emb_out.shape} ({emb_dim}-dim)')
        print(f'  Window: {n_frames} frames × {n_bands} bands → {emb_dim}d embedding')
    except Exception as e:
        print(f'  WARNING: Probe failed: {e}')
        emb_dim = 96

    return n_frames, n_bands


def compute_embeddings(audio_list, mel_sess, emb_sess, n_frames, n_bands, label):
    """Extract embeddings from audio clips through mel + embedding pipeline."""
    all_emb = []
    total = len(audio_list)
    mel_in = mel_sess.get_inputs()[0].name
    emb_in = emb_sess.get_inputs()[0].name
    errs = 0

    for idx, audio in enumerate(audio_list):
        if (idx + 1) % 500 == 0:
            print(f'    [{label}] {idx+1}/{total} ({len(all_emb)} embeddings)')

        n_af = (len(audio) - FRAME_SIZE) // FRAME_SIZE + 1
        if n_af < 1:
            continue

        mel_buf = []
        for f in range(n_af):
            frame = audio[f*FRAME_SIZE:(f+1)*FRAME_SIZE].astype(np.float32).reshape(1, -1)
            try:
                mo = mel_sess.run(None, {mel_in: frame})[0]
                for mf in mo.reshape(-1, n_bands):
                    mel_buf.append(mf)
            except Exception:
                if errs < 2:
                    errs += 1

        while len(mel_buf) < n_frames:
            mel_buf.append(np.zeros(n_bands, dtype=np.float32))

        mel_arr = np.array(mel_buf, dtype=np.float32)
        stride = max(1, n_frames // 2)

        for w in range(0, len(mel_arr) - n_frames + 1, stride):
            window = mel_arr[w:w+n_frames].reshape(1, n_frames, n_bands, 1)
            try:
                eo = emb_sess.run(None, {emb_in: window})[0]
                all_emb.append(eo.flatten())
            except Exception:
                if errs < 2:
                    errs += 1

    print(f'    [{label}] Done — {len(all_emb)} embeddings from {total} files')
    return all_emb


def export_mlp_to_onnx(model, scaler, output_path, input_dim, word_name):
    """Export sklearn MLPClassifier to ONNX with normalization baked in."""
    import onnx
    from onnx import helper, TensorProto, numpy_helper

    nodes = []
    initializers = []

    scale = (1.0 / scaler.scale_).astype(np.float32)
    offset = (-scaler.mean_ / scaler.scale_).astype(np.float32)
    initializers.append(numpy_helper.from_array(scale.reshape(1, -1), name='norm_scale'))
    initializers.append(numpy_helper.from_array(offset.reshape(1, -1), name='norm_offset'))
    nodes.append(helper.make_node('Mul', ['input', 'norm_scale'], ['s1']))
    nodes.append(helper.make_node('Add', ['s1', 'norm_offset'], ['normalized']))

    prev_output = 'normalized'
    for i, (W, b) in enumerate(zip(model.coefs_, model.intercepts_)):
        w_name = f'W{i}'
        b_name = f'b{i}'
        mm_out = f'mm{i}'
        add_out = f'add{i}'

        initializers.append(numpy_helper.from_array(W.astype(np.float32), name=w_name))
        initializers.append(numpy_helper.from_array(b.astype(np.float32).reshape(1, -1), name=b_name))

        nodes.append(helper.make_node('MatMul', [prev_output, w_name], [mm_out]))
        nodes.append(helper.make_node('Add', [mm_out, b_name], [add_out]))

        if i < len(model.coefs_) - 1:
            relu_out = f'relu{i}'
            nodes.append(helper.make_node('Relu', [add_out], [relu_out]))
            prev_output = relu_out
        else:
            nodes.append(helper.make_node('Sigmoid', [add_out], ['output']))

    X = helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, input_dim])
    Y = helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 1])

    graph = helper.make_graph(nodes, f'{word_name}_wakeword', [X], [Y], initializer=initializers)
    onnx_model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 13)])
    onnx_model.ir_version = 7
    onnx_model.doc_string = f'{word_name} wake word — augmented MLP classifier v4'

    meta = onnx_model.metadata_props.add()
    meta.key = 'wake_word'
    meta.value = word_name

    meta2 = onnx_model.metadata_props.add()
    meta2.key = 'trainer_version'
    meta2.value = '4.0-augmented'

    onnx.checker.check_model(onnx_model)
    onnx.save(onnx_model, str(output_path))
    return True


# ── Main ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Hestia Wake Word — Model Trainer v4 (Augmented MLP)')
    parser.add_argument('--word', required=True,
                        help='Wake word name (athena, artemis, hestia, etc.)')
    parser.add_argument('--training-dir', default=None,
                        help='Training data directory (default: training_data or training_data_{word})')
    parser.add_argument('--models-dir', default=None,
                        help='Backbone models directory (default: ../models)')
    parser.add_argument('--no-augment', action='store_true',
                        help='Skip augmentation (train on raw data only)')
    parser.add_argument('--augment-only', action='store_true',
                        help='Generate augmented clips to disk and exit')
    parser.add_argument('--aug-copies', type=int, default=AUG_COPIES_PER_POSITIVE,
                        help=f'Augmented copies per positive (default: {AUG_COPIES_PER_POSITIVE})')
    args = parser.parse_args()

    word = args.word.lower()
    global AUG_COPIES_PER_POSITIVE
    AUG_COPIES_PER_POSITIVE = args.aug_copies

    # Resolve directories
    if args.training_dir:
        training_dir = Path(args.training_dir)
    else:
        training_dir = Path(f'training_data_{word}')
        if not training_dir.exists():
            training_dir = Path('training_data')

    models_dir = Path(args.models_dir) if args.models_dir else MODELS_DIR
    output_model = Path(f'{word}_trained.onnx')

    print(f'Hestia Wake Word — Model Trainer v4 (Augmented MLP)')
    print(f'=' * 60)
    print(f'  Word:         {word}')
    print(f'  Training dir: {training_dir}/')
    print(f'  Models dir:   {models_dir}/')
    print(f'  Augmentation: {"OFF" if args.no_augment else f"ON ({AUG_COPIES_PER_POSITIVE}x per positive)"}')
    print(f'  Architecture: 96 → {" → ".join(str(h) for h in HIDDEN_LAYERS)} → 1')

    # Find backbone models
    mel_path = models_dir / 'melspectrogram.onnx'
    emb_path = models_dir / 'embedding_model.onnx'
    if not mel_path.exists() or not emb_path.exists():
        mel_path, emb_path = Path('melspectrogram.onnx'), Path('embedding_model.onnx')
        if not mel_path.exists() or not emb_path.exists():
            print(f'\nERROR: Backbone models not found in {models_dir}/ or ./')
            print(f'  Need: melspectrogram.onnx, embedding_model.onnx')
            sys.exit(1)
    print(f'  Backbones:    {mel_path.parent}/')

    # Load data
    print(f'\n{"─" * 60}')
    print(f'Loading training data...')
    pos = load_audio_files(training_dir / 'positive')
    neg = load_audio_files(training_dir / 'negative')
    hard = load_audio_files(training_dir / 'hard_negative')
    noise = load_audio_files(training_dir / 'noise')

    # If no dedicated noise folder, sample from negatives
    if not noise and neg:
        noise = neg[:200]
        print(f'  No noise/ folder — using {len(noise)} negative clips as noise source')

    print(f'  Positive:      {len(pos)}')
    print(f'  Negative:      {len(neg)}')
    print(f'  Hard negative: {len(hard)}')
    print(f'  Noise clips:   {len(noise)}')

    if len(pos) < 10 or len(neg) < 10:
        print('\nERROR: Need at least 10 positive and 10 negative samples')
        sys.exit(1)

    # Augmentation
    rng = np.random.RandomState(RANDOM_SEED)
    aug_pos = []

    if not args.no_augment:
        print(f'\n{"─" * 60}')
        print(f'Augmenting positives...')
        aug_pos = augment_positives(pos, noise, rng)

        if args.augment_only:
            aug_dir = training_dir / 'augmented'
            aug_dir.mkdir(parents=True, exist_ok=True)
            print(f'\n  Saving {len(aug_pos)} augmented clips to {aug_dir}/')
            for i, clip in enumerate(aug_pos):
                save_wav(aug_dir / f'aug_{word}_{i:05d}.wav', clip)
                if (i + 1) % 1000 == 0:
                    print(f'    Saved {i+1}/{len(aug_pos)}...')
            print(f'  ✓ Done. Run without --augment-only to train.')
            return

    # Combine original + augmented positives for training
    all_pos = pos + aug_pos
    print(f'\n  Total positives for training: {len(all_pos)} '
          f'({len(pos)} original + {len(aug_pos)} augmented)')

    # Probe backbone models
    print(f'\n{"─" * 60}')
    print(f'Probing backbone models...')
    mel_sess = ort.InferenceSession(str(mel_path))
    emb_sess = ort.InferenceSession(str(emb_path))
    n_frames, n_bands = probe_models(mel_sess, emb_sess)

    # Extract embeddings
    print(f'\n{"─" * 60}')
    print(f'Extracting embeddings (this may take a while with augmented data)...')
    pos_emb = compute_embeddings(all_pos, mel_sess, emb_sess, n_frames, n_bands, 'POS')
    neg_emb = compute_embeddings(neg, mel_sess, emb_sess, n_frames, n_bands, 'NEG')
    hard_emb = compute_embeddings(hard, mel_sess, emb_sess, n_frames, n_bands, 'HARD')

    print(f'\n  Embeddings: {len(pos_emb)} pos, {len(neg_emb)} neg, {len(hard_emb)} hard neg')

    if not pos_emb or not neg_emb:
        print('ERROR: No embeddings extracted')
        sys.exit(1)

    # Prepare training data
    print(f'\n{"─" * 60}')
    print(f'Preparing training data...')
    neg_all = neg_emb + hard_emb
    X_pos = np.array(pos_emb)
    X_neg = np.array(neg_all)

    # Balance: cap negatives at 2× positives (higher ratio with augmented data)
    neg_ratio = 2.0
    if len(X_neg) > int(len(X_pos) * neg_ratio):
        idx = rng.choice(len(X_neg), size=int(len(X_pos) * neg_ratio), replace=False)
        X_neg = X_neg[idx]
        print(f'  Balanced negatives: {len(X_neg)} (from {len(neg_all)}, capped at {neg_ratio}x)')
    else:
        print(f'  Using all negatives: {len(X_neg)}')

    X = np.vstack([X_pos, X_neg])
    y = np.hstack([np.ones(len(X_pos)), np.zeros(len(X_neg))])
    print(f'  Total samples: {len(X)} ({int(y.sum())} pos, {int(len(y)-y.sum())} neg)')

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    X_train, X_test, y_train, y_test = train_test_split(
        X_scaled, y, test_size=TEST_SPLIT, random_state=RANDOM_SEED, stratify=y
    )
    print(f'  Train: {len(X_train)}  Test: {len(X_test)}')

    # Train MLP
    print(f'\n{"─" * 60}')
    print(f'Training MLP (96 → {" → ".join(str(h) for h in HIDDEN_LAYERS)} → 1)...')
    print(f'  Max iterations: {MAX_ITER}')
    print(f'  Learning rate:  {LEARNING_RATE}')
    print(f'  Early stopping: patience 30 epochs')
    print()

    model = MLPClassifier(
        hidden_layer_sizes=HIDDEN_LAYERS,
        activation='relu',
        solver='adam',
        learning_rate_init=LEARNING_RATE,
        max_iter=MAX_ITER,
        random_state=RANDOM_SEED,
        early_stopping=True,
        validation_fraction=0.1,
        n_iter_no_change=30,
        verbose=True
    )
    model.fit(X_train, y_train)

    # Evaluate
    print(f'\n{"=" * 60}')
    print(f'RESULTS — {word.upper()}')
    print(f'{"=" * 60}')
    train_acc = model.score(X_train, y_train)
    test_acc = model.score(X_test, y_test)
    print(f'  Train accuracy: {train_acc:.4f}')
    print(f'  Test accuracy:  {test_acc:.4f}')
    print(f'  Epochs:         {model.n_iter_}')

    y_pred = model.predict(X_test)
    target_names = [f'not_{word}', word]
    report = classification_report(y_test, y_pred, target_names=target_names, digits=3)
    print(f'\n{report}')

    cm = confusion_matrix(y_test, y_pred)
    tn, fp, fn, tp = cm.ravel()
    fpr = fp / (fp + tn)
    fnr = fn / (fn + tp)
    print(f'  TN: {tn}  |  FP: {fp}')
    print(f'  FN: {fn}  |  TP: {tp}')
    print(f'\n  False Positive Rate: {fpr:.4f}')
    print(f'  False Negative Rate: {fnr:.4f}')

    # Threshold optimization
    print(f'\n{"─" * 60}')
    print(f'Threshold tuning:')
    y_proba = model.predict_proba(X_test)[:, 1]
    best_thresh = 0.5
    best_f1 = 0
    results = []
    for thresh in np.arange(0.1, 0.9, 0.05):
        y_t = (y_proba >= thresh).astype(int)
        cm_t = confusion_matrix(y_test, y_t)
        tn_t, fp_t, fn_t, tp_t = cm_t.ravel()
        fpr_t = fp_t / (fp_t + tn_t) if (fp_t + tn_t) > 0 else 0
        fnr_t = fn_t / (fn_t + tp_t) if (fn_t + tp_t) > 0 else 0
        recall = tp_t / (tp_t + fn_t) if (tp_t + fn_t) > 0 else 0
        prec = tp_t / (tp_t + fp_t) if (tp_t + fp_t) > 0 else 0
        f1 = 2 * prec * recall / (prec + recall) if (prec + recall) > 0 else 0
        results.append((thresh, fpr_t, fnr_t, f1, recall, prec))
        if f1 > best_f1:
            best_f1 = f1
            best_thresh = thresh

    # Print table
    print(f'  {"Thresh":>6} {"FPR":>7} {"FNR":>7} {"Prec":>7} {"Recall":>7} {"F1":>7}')
    print(f'  {"─"*6} {"─"*7} {"─"*7} {"─"*7} {"─"*7} {"─"*7}')
    for thresh, fpr_t, fnr_t, f1, recall, prec in results:
        marker = ' ★' if abs(thresh - best_thresh) < 0.01 else ''
        print(f'  {thresh:6.2f} {fpr_t:7.3f} {fnr_t:7.3f} {prec:7.3f} {recall:7.3f} {f1:7.3f}{marker}')

    print(f'\n  ★ Best threshold: {best_thresh:.2f} (F1={best_f1:.3f})')

    # Cross-validation
    print(f'\n  Cross-validation (5-fold):')
    cv = cross_val_score(model, X_scaled, y, cv=5, scoring='accuracy', verbose=0)
    print(f'    {cv.mean():.4f} ± {cv.std():.4f}')

    # Export
    print(f'\n{"─" * 60}')
    print(f'Exporting to {output_model}...')

    if export_mlp_to_onnx(model, scaler, output_model, X.shape[1], word):
        sz = output_model.stat().st_size
        print(f'  ✓ Saved: {output_model} ({sz:,} bytes)')

        if models_dir.exists():
            import shutil
            deploy_path = models_dir / f'{word}.onnx'
            backup_path = models_dir / f'{word}_backup.onnx'
            if deploy_path.exists():
                shutil.copy2(deploy_path, backup_path)
                print(f'  ✓ Old model backed up to {backup_path}')
            shutil.copy2(output_model, deploy_path)
            print(f'  ✓ Deployed to {deploy_path}')

        print(f'\n{"=" * 60}')
        print(f'DONE — {word.upper()} model trained successfully')
        print(f'{"=" * 60}')
        print(f'  Accuracy:       {test_acc:.1%}')
        print(f'  Best threshold: {best_thresh:.2f} (FPR={fpr:.2%}, FNR={fnr:.2%})')
        print(f'  Architecture:   96 → {" → ".join(str(h) for h in HIDDEN_LAYERS)} → 1')
        if not args.no_augment:
            print(f'  Training data:  {len(pos)} clean + {len(aug_pos)} augmented positives')
            print(f'                  {len(neg)} negatives + {len(hard)} hard negatives')
        print(f'\n  Next steps:')
        print(f'    1. Update OWW THRESHOLD in dashboard.html → {best_thresh:.2f}')
        print(f'    2. Deploy: push models/{word}.onnx to GitHub')
        print(f'    3. Test: open dashboard, say "{word}" at various volumes/distances')
    else:
        print('  ✗ Export failed')


if __name__ == '__main__':
    main()
