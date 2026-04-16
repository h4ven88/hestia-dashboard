#!/usr/bin/env python3
"""
Extract OWW embeddings from WAV clips and train a classifier.
Usage: python train_classifier.py <word> <wav_dir> <neg_features_npy> 
                                  <mel_onnx> <emb_onnx> <output_dir>
"""
import os, sys, glob
import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset
import onnxruntime as ort
import soundfile as sf

def main():
    word      = sys.argv[1]
    wav_dir   = sys.argv[2]
    neg_file  = sys.argv[3]
    mel_model = sys.argv[4]
    emb_model = sys.argv[5]
    out_dir   = sys.argv[6]

    os.makedirs(out_dir, exist_ok=True)

    # ── Load backbone models ──────────────────────────────────────────────
    print("Loading backbone models...")
    mel_sess = ort.InferenceSession(mel_model)
    emb_sess = ort.InferenceSession(emb_model)
    mel_in   = mel_sess.get_inputs()[0].name
    emb_in   = emb_sess.get_inputs()[0].name
    mel_out  = mel_sess.get_outputs()[0].name
    emb_out  = emb_sess.get_outputs()[0].name

    def embed(chunk):
        a = chunk.astype(np.float32) / 32768.0
        a = a.reshape(1, 1, -1)
        mel = mel_sess.run([mel_out], {mel_in: a})[0]
        return emb_sess.run([emb_out], {emb_in: mel})[0].flatten()

    # ── Extract positive features ─────────────────────────────────────────
    print("Extracting positive features...")
    pos = []
    CHUNK, STRIDE = 1280, 640
    wav_files = sorted(glob.glob(f"{wav_dir}/*.wav"))
    print(f"  Found {len(wav_files)} WAV files")

    for i, f in enumerate(wav_files):
        try:
            audio, sr = sf.read(f, dtype='int16')
            if sr != 16000:
                continue
            if len(audio) < CHUNK:
                audio = np.pad(audio, (0, CHUNK - len(audio)))
            for s in range(0, len(audio) - CHUNK + 1, STRIDE):
                pos.append(embed(audio[s:s+CHUNK]))
        except Exception as e:
            pass
        if (i + 1) % 100 == 0:
            print(f"  {i+1}/{len(wav_files)} files, {len(pos)} features", flush=True)

    pos = np.array(pos, dtype=np.float32)
    print(f"  Total positive features: {len(pos)}")

    if len(pos) < 50:
        print("ERROR: Not enough positive features", file=sys.stderr)
        sys.exit(1)

    # ── Load negative features ────────────────────────────────────────────
    print("Loading negative features...")
    neg_all = np.load(neg_file, mmap_mode='r')
    n_neg   = min(len(neg_all), len(pos) * 15)
    neg     = neg_all[np.random.choice(len(neg_all), n_neg, replace=False)].astype(np.float32)
    print(f"  Using {n_neg} negative samples")

    # ── Build dataset ─────────────────────────────────────────────────────
    X = np.vstack([pos, neg])
    y = np.array([1.0] * len(pos) + [0.0] * n_neg, dtype=np.float32)
    p = np.random.permutation(len(X))
    X, y   = X[p], y[p]
    feat_dim = X.shape[1]
    print(f"  Dataset: {len(X)} samples, feature dim: {feat_dim}")

    dl = DataLoader(
        TensorDataset(torch.from_numpy(X), torch.from_numpy(y).unsqueeze(1)),
        batch_size=512, shuffle=True
    )

    # ── Train classifier ──────────────────────────────────────────────────
    print("Training classifier (150 epochs)...")
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

    # ── Export ONNX ───────────────────────────────────────────────────────
    print("Exporting ONNX model...")
    model.eval()
    word_slug = word.lower().replace(" ", "_")
    onnx_path = os.path.join(out_dir, f"{word_slug}.onnx")

    torch.onnx.export(
        model,
        torch.zeros(1, feat_dim),
        onnx_path,
        input_names=["embedding"],
        output_names=["score"],
        dynamic_axes={"embedding": {0: "batch"}, "score": {0: "batch"}},
        opset_version=11
    )
    size_kb = os.path.getsize(onnx_path) / 1024
    print(f"  Saved: {onnx_path} ({size_kb:.1f} KB)")

    # ── Verify ────────────────────────────────────────────────────────────
    sess   = ort.InferenceSession(onnx_path)
    score  = sess.run(None, {"embedding": np.zeros((1, feat_dim), dtype=np.float32)})[0][0][0]
    print(f"  Verified — zero-input score: {score:.4f}")
    print(f"\nTraining complete for '{word}'")

if __name__ == "__main__":
    main()
