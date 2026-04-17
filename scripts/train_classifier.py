#!/usr/bin/env python3
"""
Extract OWW embeddings from WAV clips and train a classifier.
Usage: python train_classifier.py <word> <pos_wav_dir> <neg_wav_dir>
                                  <mel_onnx> <emb_onnx> <out_dir>

Uses own generated negative samples instead of pre-computed HuggingFace dataset.
This guarantees format compatibility between positive and negative features.
"""
import os, sys, glob
import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset
import onnxruntime as ort
import soundfile as sf

CHUNK        = 1280   # samples per mel chunk (80ms at 16kHz)
FRAMES_CHUNK = 5      # mel frames per chunk
FRAMES_NEED  = 76     # embedding model input frames
CHUNKS_NEED  = 16     # 16 × 5 = 80 frames, use first 76
WINDOW       = CHUNKS_NEED * CHUNK   # 20480 samples per embedding


def extract_features(wav_dir, mel_sess, emb_sess, mel_in, emb_in,
                     mel_out, emb_out, label):
    """Extract one 96-dim embedding per WAV file."""
    def get_mel_frames(audio_window):
        frames = []
        for i in range(CHUNKS_NEED):
            chunk = audio_window[i*CHUNK:(i+1)*CHUNK]
            a = chunk.astype(np.float32) / 32768.0
            a = a.reshape(1, -1)
            mel = mel_sess.run([mel_out], {mel_in: a})[0]
            frames.append(mel[0, 0, :, :])
        return np.concatenate(frames, axis=0)  # [80, 32]

    def embed(mel_frames):
        window = mel_frames[:FRAMES_NEED, :]
        inp    = window.reshape(1, FRAMES_NEED, 32, 1).astype(np.float32)
        return emb_sess.run([emb_out], {emb_in: inp})[0].flatten()

    wav_files = sorted(glob.glob(f"{wav_dir}/*.wav"))
    print(f"  {label}: {len(wav_files)} WAV files")
    if not wav_files:
        print(f"ERROR: no WAV files in {wav_dir}", file=sys.stderr)
        sys.exit(1)

    features = []
    err = 0
    for i, f in enumerate(wav_files):
        try:
            audio, sr = sf.read(f, dtype='int16')
            if len(audio.shape) > 1:
                audio = audio[:, 0]
            if sr != 16000:
                continue
            if len(audio) < WINDOW:
                audio = np.pad(audio, (0, WINDOW - len(audio)))
            mel_frames = get_mel_frames(audio[:WINDOW])
            emb = embed(mel_frames)
            features.append(emb)
        except Exception as e:
            err += 1
            if err <= 3:
                print(f"    ERR {os.path.basename(f)}: {e}", file=sys.stderr)
        if (i + 1) % 100 == 0:
            print(f"    {i+1}/{len(wav_files)} → {len(features)} features",
                  flush=True)

    print(f"    Total: {len(features)} features (errors: {err})")
    return np.array(features, dtype=np.float32)


def main():
    word      = sys.argv[1]
    pos_dir   = sys.argv[2]
    neg_dir   = sys.argv[3]
    mel_model = sys.argv[4]
    emb_model = sys.argv[5]
    out_dir   = sys.argv[6]
    os.makedirs(out_dir, exist_ok=True)

    # ── Load backbone ─────────────────────────────────────────────────────
    print("Loading backbone models...")
    mel_sess = ort.InferenceSession(mel_model)
    emb_sess = ort.InferenceSession(emb_model)
    mel_in   = mel_sess.get_inputs()[0].name
    emb_in   = emb_sess.get_inputs()[0].name
    mel_out  = mel_sess.get_outputs()[0].name
    emb_out  = emb_sess.get_outputs()[0].name
    print(f"  Mel: {mel_sess.get_inputs()[0].shape} → {mel_sess.get_outputs()[0].shape}")
    print(f"  Emb: {emb_sess.get_inputs()[0].shape} → {emb_sess.get_outputs()[0].shape}")

    # ── Extract features ──────────────────────────────────────────────────
    print("\nExtracting features...")
    pos = extract_features(pos_dir, mel_sess, emb_sess,
                           mel_in, emb_in, mel_out, emb_out, "Positive")
    neg = extract_features(neg_dir, mel_sess, emb_sess,
                           mel_in, emb_in, mel_out, emb_out, "Negative")

    print(f"\nPos shape: {pos.shape}  Neg shape: {neg.shape}")

    if len(pos) < 50:
        print(f"ERROR: only {len(pos)} positive features", file=sys.stderr)
        sys.exit(1)
    if len(neg) < 50:
        print(f"ERROR: only {len(neg)} negative features", file=sys.stderr)
        sys.exit(1)

    # ── Build dataset ─────────────────────────────────────────────────────
    X = np.vstack([pos, neg])
    y = np.array([1.0]*len(pos) + [0.0]*len(neg), dtype=np.float32)
    p = np.random.permutation(len(X))
    X, y     = X[p], y[p]
    feat_dim = X.shape[1]
    print(f"Dataset: {len(X)} samples, dim={feat_dim}")

    dl = DataLoader(
        TensorDataset(torch.from_numpy(X), torch.from_numpy(y).unsqueeze(1)),
        batch_size=256, shuffle=True
    )

    # ── Train ─────────────────────────────────────────────────────────────
    print("\nTraining (150 epochs)...")
    model = nn.Sequential(
        nn.Linear(feat_dim, 128), nn.ReLU(), nn.Dropout(0.2),
        nn.Linear(128, 64),       nn.ReLU(), nn.Dropout(0.1),
        nn.Linear(64, 1),         nn.Sigmoid()
    )
    opt     = torch.optim.Adam(model.parameters(), lr=1e-3, weight_decay=1e-4)
    sched   = torch.optim.lr_scheduler.ReduceLROnPlateau(opt, patience=10)
    loss_fn = nn.BCELoss()

    for epoch in range(150):
        model.train()
        total = 0
        for xb, yb in dl:
            opt.zero_grad()
            loss = loss_fn(model(xb), yb)
            loss.backward()
            opt.step()
            total += loss.item()
        avg = total / len(dl)
        sched.step(avg)
        if (epoch + 1) % 30 == 0:
            print(f"  Epoch {epoch+1}/150 — loss: {avg:.4f}", flush=True)

    # ── Export ────────────────────────────────────────────────────────────
    print("\nExporting ONNX...")
    model.eval()
    slug      = word.lower().replace(" ", "_")
    onnx_path = os.path.join(out_dir, f"{slug}.onnx")
    torch.onnx.export(
        model, torch.zeros(1, feat_dim), onnx_path,
        input_names=["embedding"], output_names=["score"],
        dynamic_axes={"embedding": {0: "batch"}, "score": {0: "batch"}},
        opset_version=11
    )
    size_kb = os.path.getsize(onnx_path) / 1024
    print(f"  {onnx_path} ({size_kb:.1f} KB)")

    sess  = ort.InferenceSession(onnx_path)
    score = sess.run(None, {"embedding": np.zeros((1, feat_dim), dtype=np.float32)})[0][0][0]
    print(f"  Zero-input score: {score:.4f}")
    print(f"\nDone — '{word}' model ready")

if __name__ == "__main__":
    main()
