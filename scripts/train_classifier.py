#!/usr/bin/env python3
"""
Extract OWW embeddings from WAV clips and train a classifier.

OpenWakeWord pipeline (corrected):
  1. Feed 1280-sample chunks to mel model → [1, 1, 5, 32] per chunk
  2. Accumulate 5 frames per chunk until we have 76 frames
  3. Reshape [76, 32] → [1, 76, 32, 1] for embedding model
  4. Embedding model outputs [1, 1, 1, 96] → flatten to 96-dim feature

Usage: python train_classifier.py <word> <wav_dir> <neg_npy>
                                  <mel_onnx> <emb_onnx> <out_dir>
"""
import os, sys, glob
import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset
import onnxruntime as ort
import soundfile as sf

CHUNK        = 1280   # samples per mel chunk (80ms at 16kHz)
FRAMES_CHUNK = 5      # mel frames produced per 1280-sample chunk
FRAMES_NEED  = 76     # frames needed by embedding model
CHUNKS_NEED  = 16     # ceil(76/5) — 16 chunks × 5 frames = 80, take first 76
WINDOW       = CHUNKS_NEED * CHUNK   # 20480 samples per embedding

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
    print(f"  Mel: {mel_in}{mel_sess.get_inputs()[0].shape} → "
          f"{mel_out}{mel_sess.get_outputs()[0].shape}")
    print(f"  Emb: {emb_in}{emb_sess.get_inputs()[0].shape} → "
          f"{emb_out}{emb_sess.get_outputs()[0].shape}")

    def get_mel_frames(audio_window):
        """
        Process WINDOW (20480) samples through mel model in 1280-sample chunks.
        Returns [80, 32] mel frames (16 chunks × 5 frames each).
        """
        frames = []
        for i in range(CHUNKS_NEED):
            chunk = audio_window[i*CHUNK:(i+1)*CHUNK]
            a = chunk.astype(np.float32) / 32768.0
            a = a.reshape(1, -1)                        # [1, 1280]
            mel = mel_sess.run([mel_out], {mel_in: a})[0]  # [1, 1, 5, 32]
            frames.append(mel[0, 0, :, :])              # [5, 32]
        return np.concatenate(frames, axis=0)           # [80, 32]

    def embed(mel_frames_80):
        """
        Convert 80 mel frames → one embedding.
        Takes first 76 frames → [1, 76, 32, 1] → embedding model → 96-dim vector.
        """
        window = mel_frames_80[:FRAMES_NEED, :]         # [76, 32]
        inp    = window.reshape(1, FRAMES_NEED, 32, 1).astype(np.float32)
        emb    = emb_sess.run([emb_out], {emb_in: inp})[0]
        return emb.flatten()

    # ── Probe ─────────────────────────────────────────────────────────────
    wav_files = sorted(glob.glob(f"{wav_dir}/*.wav"))
    print(f"\nFound {len(wav_files)} WAV files")
    if not wav_files:
        print(f"ERROR: no WAV files in {wav_dir}", file=sys.stderr)
        sys.exit(1)

    try:
        probe, sr = sf.read(wav_files[0], dtype='int16')
        if len(probe.shape) > 1:
            probe = probe[:, 0]
        print(f"  Probe: {os.path.basename(wav_files[0])} "
              f"sr={sr} dur={len(probe)/sr:.2f}s")
        # Pad probe to at least WINDOW samples
        if len(probe) < WINDOW:
            probe = np.pad(probe, (0, WINDOW - len(probe)))
        mel_frames = get_mel_frames(probe[:WINDOW])
        print(f"  Mel frames shape: {mel_frames.shape}")   # expect [80, 32]
        test_emb = embed(mel_frames)
        print(f"  Embedding shape: {test_emb.shape} ✓")
    except Exception as e:
        import traceback
        print(f"ERROR in probe: {e}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)

    # ── Extract positive features ─────────────────────────────────────────
    print("\nExtracting positive features...")
    pos = []
    STRIDE_SAMPLES = CHUNK  # slide by 80ms

    for i, f in enumerate(wav_files):
        try:
            audio, sr = sf.read(f, dtype='int16')
            if len(audio.shape) > 1:
                audio = audio[:, 0]
            if sr != 16000:
                continue
            # Pad to at least WINDOW so we always get ≥1 embedding
            if len(audio) < WINDOW:
                audio = np.pad(audio, (0, WINDOW - len(audio)))
            # Slide a WINDOW-sized window across the clip
            for start in range(0, len(audio) - WINDOW + 1, STRIDE_SAMPLES):
                window = audio[start:start + WINDOW]
                mel_frames = get_mel_frames(window)
                emb = embed(mel_frames)
                pos.append(emb)
        except Exception as e:
            if len(pos) == 0:
                print(f"  ERROR {os.path.basename(f)}: {e}", file=sys.stderr)

        if (i + 1) % 100 == 0:
            print(f"  {i+1}/{len(wav_files)} files → {len(pos)} features",
                  flush=True)

    print(f"  Total positive features: {len(pos)}")
    if len(pos) < 50:
        print(f"ERROR: only {len(pos)} features (need ≥50)", file=sys.stderr)
        sys.exit(1)

    pos = np.array(pos, dtype=np.float32)

    # ── Load negative features ────────────────────────────────────────────
    print("\nLoading negative features...")
    neg_all = np.load(neg_file, mmap_mode='r')
    n_neg   = min(len(neg_all), len(pos) * 15)
    neg     = neg_all[np.random.choice(len(neg_all), n_neg, replace=False)].astype(np.float32)
    # Flatten to 2D if stored as 3D (e.g. shape [N, 1, 96] or [N, 1, 1, 96])
    if neg.ndim > 2:
        print(f"  Reshaping negatives from {neg.shape} to 2D")
        neg = neg.reshape(len(neg), -1)
    print(f"  {n_neg} negative samples, shape={neg.shape}")

    # ── Build dataset ─────────────────────────────────────────────────────
    X = np.vstack([pos, neg])
    y = np.array([1.0] * len(pos) + [0.0] * n_neg, dtype=np.float32)
    p = np.random.permutation(len(X))
    X, y     = X[p], y[p]
    feat_dim = X.shape[1]
    print(f"\nDataset: {len(X)} samples, dim={feat_dim}")

    dl = DataLoader(
        TensorDataset(torch.from_numpy(X), torch.from_numpy(y).unsqueeze(1)),
        batch_size=512, shuffle=True
    )

    # ── Train ─────────────────────────────────────────────────────────────
    print("Training (150 epochs)...")
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
    print(f"  Saved: {onnx_path} ({size_kb:.1f} KB)")

    sess  = ort.InferenceSession(onnx_path)
    score = sess.run(None, {"embedding": np.zeros((1, feat_dim), dtype=np.float32)})[0][0][0]
    print(f"  Verified — zero-input score: {score:.4f}")
    print(f"\nTraining complete for '{word}'")

if __name__ == "__main__":
    main()
