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

# ── Audio validation and normalization ─────────────────────────────────────
EXPECTED_SAMPLE_RATE = 16000
MIN_AUDIO_DURATION = 0.5  # seconds
TARGET_AUDIO_DURATION = 1.0  # seconds

def validate_and_pad_audio(audio, sr, expected_sr=EXPECTED_SAMPLE_RATE, 
                           min_duration=MIN_AUDIO_DURATION):
    """
    Validate audio properties and pad/trim to ensure consistency.
    
    Args:
        audio: Audio samples (numpy array, int16 or float32)
        sr: Sample rate (Hz)
        expected_sr: Expected sample rate
        min_duration: Minimum acceptable duration in seconds
    
    Returns:
        Validated audio array (int16, mono) or None if invalid
    """
    try:
        # Ensure mono
        if len(audio.shape) > 1:
            audio = np.mean(audio, axis=1)
        
        # Check sample rate
        if sr != expected_sr:
            print(f"    WARNING: Sample rate {sr}Hz != {expected_sr}Hz, skipping")
            return None
        
        # Check minimum duration
        duration = len(audio) / sr
        if duration < min_duration:
            min_samples = int(min_duration * sr)
            print(f"    WARNING: Duration {duration:.3f}s < {min_duration}s, padding...")
            # Pad with silence
            audio = np.pad(audio, (0, min_samples - len(audio)), mode='constant')
        
        # Ensure int16
        if audio.dtype != np.int16:
            audio = np.clip(audio, -32768, 32767).astype(np.int16)
        
        return audio
    except Exception as e:
        print(f"    ERROR validating audio: {type(e).__name__}: {e}")
        return None

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

    # Print model input shapes so we know what we're working with
    print(f"  Mel input:  name={mel_in}  shape={mel_sess.get_inputs()[0].shape}")
    print(f"  Emb input:  name={emb_in}  shape={emb_sess.get_inputs()[0].shape}")
    print(f"  Mel output: name={mel_out} shape={mel_sess.get_outputs()[0].shape}")
    print(f"  Emb output: name={emb_out} shape={emb_sess.get_outputs()[0].shape}")

    def embed(chunk):
        """Convert audio chunk to embedding using backbone models."""
        a = chunk.astype(np.float32) / 32768.0
        a = a.reshape(1, -1)  # rank 2: [batch, samples] as expected by mel model
        mel = mel_sess.run([mel_out], {mel_in: a})[0]
        return emb_sess.run([emb_out], {emb_in: mel})[0].flatten()

    # ── Probe first WAV file to verify format ─────────────────────────────
    wav_files = sorted(glob.glob(f"{wav_dir}/*.wav"))
    print(f"\nExtracting positive features...")
    print(f"  Found {len(wav_files)} WAV files")

    if len(wav_files) == 0:
        print(f"ERROR: No WAV files found in {wav_dir}", file=sys.stderr)
        sys.exit(1)

    # Probe first file
    try:
        probe_audio, probe_sr = sf.read(wav_files[0], dtype='int16')
        print(f"  Probe file: {os.path.basename(wav_files[0])}")
        print(f"    Sample rate: {probe_sr} Hz")
        print(f"    Duration:    {len(probe_audio)/probe_sr:.3f}s ({len(probe_audio)} samples)")
        print(f"    dtype:       {probe_audio.dtype}")
        if len(probe_audio.shape) > 1:
            print(f"    Channels:    {probe_audio.shape[1]} (will use first)")
            probe_audio = probe_audio[:, 0]

        # Validate probe audio
        probe_audio = validate_and_pad_audio(probe_audio, probe_sr)
        if probe_audio is None:
            raise RuntimeError("Probe file failed validation")

        # Try embedding on a chunk from the probe file
        CHUNK = 1280
        if len(probe_audio) >= CHUNK:
            test_chunk = probe_audio[:CHUNK]
            test_emb = embed(test_chunk)
            print(f"  Test embedding shape: {test_emb.shape} ✓")
        else:
            raise RuntimeError(f"Probe file too short after padding ({len(probe_audio)} < {CHUNK} samples)")
    except Exception as e:
        print(f"  ERROR probing first WAV file: {type(e).__name__}: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)

    # ── Extract features from all clips ───────────────────────────────────
    pos = []
    CHUNK  = 1280
    STRIDE = 640
    sr_skip = 0
    short_skip = 0
    padded_count = 0
    err_count = 0

    for i, f in enumerate(wav_files):
        try:
            audio, sr = sf.read(f, dtype='int16')

            # Handle stereo
            if len(audio.shape) > 1:
                audio = audio[:, 0]

            # Validate and normalize audio
            original_len = len(audio)
            audio = validate_and_pad_audio(audio, sr)
            
            if audio is None:
                sr_skip += 1
                continue
            
            # Track padding
            if len(audio) > original_len:
                padded_count += 1

            # Extract embeddings
            for s in range(0, len(audio) - CHUNK + 1, STRIDE):
                emb = embed(audio[s:s+CHUNK])
                pos.append(emb)

        except Exception as e:
            err_count += 1
            if err_count <= 5:
                print(f"  ERROR on {os.path.basename(f)}: {type(e).__name__}: {e}",
                      file=sys.stderr)

        if (i + 1) % 100 == 0:
            print(f"  {i+1}/{len(wav_files)} files, {len(pos)} features "
                  f"(sr_skip={sr_skip} padded={padded_count} err={err_count})",
                  flush=True)

    print(f"  Total positive features: {len(pos)}")
    if sr_skip:      print(f"  Skipped (wrong sr): {sr_skip}")
    if padded_count: print(f"  Padded (too short): {padded_count}")
    if err_count:    print(f"  Errors: {err_count}")

    if len(pos) < 50:
        print(f"ERROR: Not enough positive features ({len(pos)} < 50)", file=sys.stderr)
        sys.exit(1)

    pos = np.array(pos, dtype=np.float32)

    # ── Load negative features ────────────────────────────���───────────────
    print("\nLoading negative features...")
    neg_all = np.load(neg_file, mmap_mode='r')
    n_neg   = min(len(neg_all), len(pos) * 15)
    neg     = neg_all[np.random.choice(len(neg_all), n_neg, replace=False)].astype(np.float32)
    print(f"  Using {n_neg} negative samples (from {len(neg_all)} total)")

    # ── Build dataset ─────────────────────────────────────────────────────
    X = np.vstack([pos, neg])
    y = np.array([1.0] * len(pos) + [0.0] * n_neg, dtype=np.float32)
    p = np.random.permutation(len(X))
    X, y     = X[p], y[p]
    feat_dim = X.shape[1]
    print(f"\nDataset: {len(X)} samples, feature dim: {feat_dim}")

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
    print("\nExporting ONNX model...")
    model.eval()
    word_slug = word.lower().replace(" ", "_")
    onnx_path = os.path.join(out_dir, f"{word_slug}.onnx")

    torch.onnx.export(
        model, torch.zeros(1, feat_dim), onnx_path,
        input_names=["embedding"], output_names=["score"],
        dynamic_axes={"embedding": {0: "batch"}, "score": {0: "batch"}},
        opset_version=11
    )
    size_kb = os.path.getsize(onnx_path) / 1024
    print(f"  Saved: {onnx_path} ({size_kb:.1f} KB)")

    # ── Verify ────────────────────────────────────────────────────────────
    sess  = ort.InferenceSession(onnx_path)
    score = sess.run(None, {"embedding": np.zeros((1, feat_dim), dtype=np.float32)})[0][0][0]
    print(f"  Verified — zero-input score: {score:.4f}")
    print(f"\nTraining complete for '{word}'")

if __name__ == "__main__":
    main()
