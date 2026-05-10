#!/usr/bin/env python3
"""
Athena Wake Word — Model Trainer (v3 — MLP)

Uses a multi-layer neural network instead of logistic regression for
better accuracy on wake word classification.

Usage:
  python train_model.py

Expects training_data/ with positive/, negative/, hard_negative/ WAV files.
Outputs: athena_trained.onnx → auto-deployed to models/athena.onnx
"""

import os
import sys
import struct
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
TRAINING_DIR = Path('training_data')
MODELS_DIR = Path('../models')
OUTPUT_MODEL = Path('athena_trained.onnx')

SAMPLE_RATE = 16000
FRAME_SIZE = 1280
RANDOM_SEED = 42
TEST_SPLIT = 0.15

# MLP architecture: 96 → 256 → 128 → 64 → 1
HIDDEN_LAYERS = (256, 128, 64)
MAX_ITER = 1000
LEARNING_RATE = 0.0005


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


def load_audio_files(d):
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
    all_emb = []
    total = len(audio_list)
    mel_in = mel_sess.get_inputs()[0].name
    emb_in = emb_sess.get_inputs()[0].name
    errs = 0

    for idx, audio in enumerate(audio_list):
        if (idx + 1) % 100 == 0:
            print(f'    [{label}] {idx+1}/{total} ({len(all_emb)} embeddings)')

        n_af = (len(audio) - FRAME_SIZE) // FRAME_SIZE + 1
        if n_af < 1:
            continue

        # Mel features
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

        # Pad short clips
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


def export_mlp_to_onnx(model, scaler, output_path, input_dim):
    """Export sklearn MLPClassifier to ONNX with normalization baked in."""
    import onnx
    from onnx import helper, TensorProto, numpy_helper

    nodes = []
    initializers = []

    # Normalization: scaled = input * (1/std) + (-mean/std)
    scale = (1.0 / scaler.scale_).astype(np.float32)
    offset = (-scaler.mean_ / scaler.scale_).astype(np.float32)
    initializers.append(numpy_helper.from_array(scale.reshape(1, -1), name='norm_scale'))
    initializers.append(numpy_helper.from_array(offset.reshape(1, -1), name='norm_offset'))
    nodes.append(helper.make_node('Mul', ['input', 'norm_scale'], ['s1']))
    nodes.append(helper.make_node('Add', ['s1', 'norm_offset'], ['normalized']))

    # Hidden layers
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
            # Hidden layer: ReLU activation
            relu_out = f'relu{i}'
            nodes.append(helper.make_node('Relu', [add_out], [relu_out]))
            prev_output = relu_out
        else:
            # Output layer: Sigmoid
            nodes.append(helper.make_node('Sigmoid', [add_out], ['output']))

    X = helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, input_dim])
    Y = helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 1])

    graph = helper.make_graph(nodes, 'athena_wakeword', [X], [Y], initializer=initializers)
    onnx_model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 13)])
    onnx_model.ir_version = 7
    onnx_model.doc_string = 'Athena wake word — MLP classifier'

    meta = onnx_model.metadata_props.add()
    meta.key = 'wake_word'
    meta.value = 'athena'

    onnx.checker.check_model(onnx_model)
    onnx.save(onnx_model, str(output_path))
    return True


def main():
    print('Athena Wake Word — Model Trainer v3 (MLP)')
    print('=' * 50)

    mel_path = MODELS_DIR / 'melspectrogram.onnx'
    emb_path = MODELS_DIR / 'embedding_model.onnx'
    if not mel_path.exists() or not emb_path.exists():
        mel_path, emb_path = Path('melspectrogram.onnx'), Path('embedding_model.onnx')
        if not mel_path.exists() or not emb_path.exists():
            print(f'ERROR: Backbone models not found')
            sys.exit(1)
    print(f'Models: {mel_path.parent}/')

    # Load data
    print(f'\nLoading from {TRAINING_DIR}/')
    pos = load_audio_files(TRAINING_DIR / 'positive')
    neg = load_audio_files(TRAINING_DIR / 'negative')
    hard = load_audio_files(TRAINING_DIR / 'hard_negative')
    print(f'  {len(pos)} positive, {len(neg)} negative, {len(hard)} hard negative')

    if len(pos) < 10 or len(neg) < 10:
        print('ERROR: Need at least 10 positive and 10 negative samples')
        sys.exit(1)

    # Probe models
    print('\nProbing models...')
    mel_sess = ort.InferenceSession(str(mel_path))
    emb_sess = ort.InferenceSession(str(emb_path))
    n_frames, n_bands = probe_models(mel_sess, emb_sess)

    # Extract embeddings
    print('\nExtracting embeddings...')
    pos_emb = compute_embeddings(pos, mel_sess, emb_sess, n_frames, n_bands, 'POS')
    neg_emb = compute_embeddings(neg, mel_sess, emb_sess, n_frames, n_bands, 'NEG')
    hard_emb = compute_embeddings(hard, mel_sess, emb_sess, n_frames, n_bands, 'HARD')

    print(f'\n  Positive: {len(pos_emb)}, Negative: {len(neg_emb)}, Hard: {len(hard_emb)}')

    if not pos_emb or not neg_emb:
        print('ERROR: No embeddings extracted')
        sys.exit(1)

    # Prepare data
    print('\nPreparing data...')
    neg_all = neg_emb + hard_emb
    X_pos = np.array(pos_emb)
    X_neg = np.array(neg_all)

    # Balance: cap negatives at 1.5× positives for better recall
    if len(X_neg) > int(len(X_pos) * 1.5):
        rng = np.random.RandomState(RANDOM_SEED)
        idx = rng.choice(len(X_neg), size=int(len(X_pos) * 1.5), replace=False)
        X_neg = X_neg[idx]
        print(f'  Balanced: {len(X_neg)} neg (from {len(neg_all)})')

    X = np.vstack([X_pos, X_neg])
    y = np.hstack([np.ones(len(X_pos)), np.zeros(len(X_neg))])
    print(f'  Total: {len(X)} ({int(y.sum())} pos, {int(len(y)-y.sum())} neg)')

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    X_train, X_test, y_train, y_test = train_test_split(
        X_scaled, y, test_size=TEST_SPLIT, random_state=RANDOM_SEED, stratify=y
    )
    print(f'  Train: {len(X_train)}  Test: {len(X_test)}')

    # Train MLP
    print(f'\nTraining MLP {(96,) + HIDDEN_LAYERS + (1,)}...')
    model = MLPClassifier(
        hidden_layer_sizes=HIDDEN_LAYERS,
        activation='relu',
        solver='adam',
        learning_rate_init=LEARNING_RATE,
        max_iter=MAX_ITER,
        random_state=RANDOM_SEED,
        early_stopping=True,
        validation_fraction=0.1,
        n_iter_no_change=20,
        verbose=False
    )
    model.fit(X_train, y_train)

    # Evaluate
    print('\n' + '=' * 50)
    print('RESULTS')
    print('=' * 50)
    train_acc = model.score(X_train, y_train)
    test_acc = model.score(X_test, y_test)
    print(f'  Train accuracy: {train_acc:.4f}')
    print(f'  Test accuracy:  {test_acc:.4f}')
    print(f'  Epochs:         {model.n_iter_}')

    y_pred = model.predict(X_test)
    report = classification_report(y_test, y_pred, target_names=['not_athena', 'athena'], digits=3)
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
    print('\n  Threshold tuning:')
    y_proba = model.predict_proba(X_test)[:, 1]
    best_thresh = 0.5
    best_f1 = 0
    for thresh in np.arange(0.1, 0.9, 0.05):
        y_t = (y_proba >= thresh).astype(int)
        cm_t = confusion_matrix(y_test, y_t)
        tn_t, fp_t, fn_t, tp_t = cm_t.ravel()
        fpr_t = fp_t / (fp_t + tn_t) if (fp_t + tn_t) > 0 else 0
        fnr_t = fn_t / (fn_t + tp_t) if (fn_t + tp_t) > 0 else 0
        recall = tp_t / (tp_t + fn_t) if (tp_t + fn_t) > 0 else 0
        prec = tp_t / (tp_t + fp_t) if (tp_t + fp_t) > 0 else 0
        f1 = 2 * prec * recall / (prec + recall) if (prec + recall) > 0 else 0
        if f1 > best_f1:
            best_f1 = f1
            best_thresh = thresh
        if int(thresh * 100) % 10 == 0:
            print(f'    thresh={thresh:.2f}  FPR={fpr_t:.3f}  FNR={fnr_t:.3f}  F1={f1:.3f}')

    # Show best threshold results
    y_best = (y_proba >= best_thresh).astype(int)
    cm_best = confusion_matrix(y_test, y_best)
    tn_b, fp_b, fn_b, tp_b = cm_best.ravel()
    fpr_b = fp_b / (fp_b + tn_b)
    fnr_b = fn_b / (fn_b + tp_b)
    print(f'\n  ★ Best threshold: {best_thresh:.2f}')
    print(f'    FPR={fpr_b:.3f}  FNR={fnr_b:.3f}  F1={best_f1:.3f}')
    print(f'    → Set OWW.THRESHOLD in dashboard to {best_thresh:.2f}')

    cv = cross_val_score(model, X_scaled, y, cv=5, scoring='accuracy', verbose=0)
    print(f'\n  Cross-val: {cv.mean():.4f} +/- {cv.std():.4f}')

    # Export
    print(f'\nExporting to {OUTPUT_MODEL}...')

    # sklearn MLP with binary classification uses 1 output neuron
    # but stores it differently — need to handle the output layer shape
    # For binary, coefs_[-1] shape is (hidden, 1) and intercepts_[-1] shape is (1,)
    if export_mlp_to_onnx(model, scaler, OUTPUT_MODEL, X.shape[1]):
        sz = OUTPUT_MODEL.stat().st_size
        print(f'  ✓ Saved: {OUTPUT_MODEL} ({sz:,} bytes)')

        if MODELS_DIR.exists():
            import shutil
            old = MODELS_DIR / 'athena.onnx'
            if old.exists():
                shutil.copy2(old, MODELS_DIR / 'athena_backup.onnx')
                print(f'  ✓ Old model backed up')
            shutil.copy2(OUTPUT_MODEL, MODELS_DIR / 'athena.onnx')
            print(f'  ✓ Deployed to {MODELS_DIR}/athena.onnx')

        print(f'\n{"=" * 50}')
        print(f'DONE — Accuracy: {test_acc:.1%}')
        print(f'  At optimal threshold {best_thresh:.2f}: FPR={fpr_b:.2%}, FNR={fnr_b:.2%}')
        print(f'  Update OWW.THRESHOLD in dashboard.html to {best_thresh:.2f}')
        print(f'  Deploy: push models/athena.onnx to GitHub')
    else:
        print('  ✗ Export failed')


if __name__ == '__main__':
    main()
