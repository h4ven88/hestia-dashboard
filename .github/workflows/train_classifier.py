#!/usr/bin/env python3
"""
Train a wake word classifier for OpenWakeWord.

Pipeline:
  1. Load positive/negative WAV clips (16kHz mono, 1.5s)
  2. Extract 96-dim embeddings using melspectrogram.onnx + embedding_model.onnx
  3. Train a logistic regression classifier
  4. Export as ONNX (input: [1,96] → output: [1,1] score)

Usage:
  python train_classifier.py --word athena --clips-dir clips --output models/athena.onnx
"""
import os, sys, struct, math, random, argparse
from pathlib import Path

# ── Constants matching the browser inference pipeline ──────────────────
SAMPLE_RATE = 16000
CHUNK_SIZE = 1280            # samples per mel chunk
CHUNKS_NEEDED = 16           # chunks to accumulate
FRAMES_PER_CHUNK = 5         # mel frames per chunk
FRAME_DIM = 32               # mel frame dimension
TOTAL_FRAMES = CHUNKS_NEEDED * FRAMES_PER_CHUNK  # 80
EMB_FRAMES = 76              # frames used for embedding
EMB_DIM = 96                 # embedding output dimension

def read_wav_float(path):
    """Read 16-bit mono WAV, return float list."""
    with open(path, 'rb') as f:
        riff = f.read(4)
        if riff != b'RIFF':
            raise ValueError(f'Not WAV: {path}')
        f.read(4)
        f.read(4)
        while True:
            chunk_id = f.read(4)
            if len(chunk_id) < 4:
                break
            chunk_size = struct.unpack('<I', f.read(4))[0]
            if chunk_id == b'fmt ':
                f.read(chunk_size)
            elif chunk_id == b'data':
                raw = f.read(chunk_size)
                n = len(raw) // 2
                samples = struct.unpack(f'<{n}h', raw[:n*2])
                return [s / 32768.0 for s in samples]
            else:
                f.read(chunk_size)
    return []

def extract_embedding(samples, mel_session, emb_session):
    """Extract 96-dim embedding from audio samples, matching the browser pipeline."""
    import numpy as np
    
    # Ensure we have enough samples for all chunks
    needed = CHUNK_SIZE * CHUNKS_NEEDED
    if len(samples) < needed:
        samples = samples + [0.0] * (needed - len(samples))
    
    # Process chunks through mel model
    mel_frames = []
    for c in range(CHUNKS_NEEDED):
        chunk = np.array(samples[c * CHUNK_SIZE:(c + 1) * CHUNK_SIZE], dtype=np.float32)
        chunk = chunk.reshape(1, CHUNK_SIZE)
        mel_out = mel_session.run(None, {'input': chunk})
        frame_data = mel_out[0].flatten()[:FRAMES_PER_CHUNK * FRAME_DIM]
        mel_frames.append(frame_data)
    
    # Assemble frames and take first 76
    all_frames = np.concatenate(mel_frames)
    emb_input = all_frames[:EMB_FRAMES * FRAME_DIM].reshape(1, EMB_FRAMES, FRAME_DIM, 1).astype(np.float32)
    
    # Run embedding model
    emb_out = emb_session.run(None, {'input_1': emb_input})
    embedding = emb_out[0].flatten()[:EMB_DIM]
    
    return embedding

def train_classifier(pos_embeddings, neg_embeddings, epochs=500, lr=0.05):
    """Train logistic regression classifier. Returns (weights, bias)."""
    import numpy as np
    
    # Prepare data
    X = np.vstack(pos_embeddings + neg_embeddings).astype(np.float32)
    y = np.array([1.0] * len(pos_embeddings) + [0.0] * len(neg_embeddings), dtype=np.float32)
    
    # Shuffle
    indices = list(range(len(y)))
    random.shuffle(indices)
    X = X[indices]
    y = y[indices]
    
    # Initialize weights
    n_features = X.shape[1]
    W = np.zeros(n_features, dtype=np.float32)
    b = np.float32(0.0)
    
    # Mini-batch gradient descent
    batch_size = min(64, len(y))
    best_acc = 0.0
    best_W, best_b = W.copy(), b
    
    for epoch in range(epochs):
        # Shuffle each epoch
        perm = np.random.permutation(len(y))
        X_shuf = X[perm]
        y_shuf = y[perm]
        
        for start in range(0, len(y), batch_size):
            end = min(start + batch_size, len(y))
            X_batch = X_shuf[start:end]
            y_batch = y_shuf[start:end]
            
            # Forward: sigmoid(X @ W + b)
            logits = X_batch @ W + b
            probs = 1.0 / (1.0 + np.exp(-np.clip(logits, -30, 30)))
            
            # Gradient
            error = probs - y_batch
            grad_W = (X_batch.T @ error) / len(y_batch)
            grad_b = np.mean(error)
            
            # L2 regularization
            grad_W += 0.001 * W
            
            # Update
            W -= lr * grad_W
            b -= lr * grad_b
        
        # Evaluate accuracy
        logits_all = X @ W + b
        preds = (1.0 / (1.0 + np.exp(-np.clip(logits_all, -30, 30)))) > 0.5
        acc = np.mean(preds == y)
        
        if acc > best_acc:
            best_acc = acc
            best_W = W.copy()
            best_b = float(b)
        
        if (epoch + 1) % 50 == 0:
            print(f'  Epoch {epoch + 1}/{epochs} — accuracy: {acc:.4f} (best: {best_acc:.4f})')
        
        # Decay learning rate
        if (epoch + 1) % 200 == 0:
            lr *= 0.5
    
    print(f'  Final best accuracy: {best_acc:.4f}')
    return best_W, best_b

def export_onnx(weights, bias, output_path):
    """Export classifier as ONNX model."""
    import numpy as np
    
    try:
        import onnx
        from onnx import helper, TensorProto, numpy_helper
        
        # Input: [1, 96]
        X = helper.make_tensor_value_info('embedding', TensorProto.FLOAT, [1, EMB_DIM])
        # Output: [1, 1]
        Y = helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 1])
        
        # Weights and bias as initializers
        W_init = numpy_helper.from_array(
            weights.reshape(EMB_DIM, 1).astype(np.float32), name='W'
        )
        b_init = numpy_helper.from_array(
            np.array([bias], dtype=np.float32), name='b'
        )
        
        # MatMul + Add + Sigmoid
        matmul = helper.make_node('MatMul', ['embedding', 'W'], ['matmul_out'])
        add = helper.make_node('Add', ['matmul_out', 'b'], ['add_out'])
        sigmoid = helper.make_node('Sigmoid', ['add_out'], ['output'])
        
        graph = helper.make_graph(
            [matmul, add, sigmoid],
            'wake_word_classifier',
            [X], [Y],
            [W_init, b_init]
        )
        
        model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 13)])
        model.ir_version = 7
        onnx.save(model, output_path)
        print(f'  Saved ONNX model: {output_path} ({os.path.getsize(output_path):,} bytes)')
        
    except ImportError:
        # Fallback: use onnxruntime to create a simple model
        print('  [!] onnx package not available, using sklearn+skl2onnx fallback')
        from sklearn.linear_model import LogisticRegression
        from skl2onnx import convert_sklearn
        from skl2onnx.common.data_types import FloatTensorType
        
        clf = LogisticRegression()
        clf.coef_ = weights.reshape(1, -1)
        clf.intercept_ = np.array([bias])
        clf.classes_ = np.array([0, 1])
        
        initial_type = [('embedding', FloatTensorType([1, EMB_DIM]))]
        onnx_model = convert_sklearn(clf, initial_types=initial_type, 
                                      options={id(clf): {'zipmap': False}})
        with open(output_path, 'wb') as f:
            f.write(onnx_model.SerializeToString())
        print(f'  Saved ONNX model: {output_path} ({os.path.getsize(output_path):,} bytes)')

def main():
    parser = argparse.ArgumentParser(description='Train wake word classifier')
    parser.add_argument('--word', default='athena', help='Wake word name')
    parser.add_argument('--clips-dir', default='clips', help='Directory with positive/ and negative/ subdirs')
    parser.add_argument('--models-dir', default='models', help='Directory with backbone ONNX models')
    parser.add_argument('--output', default=None, help='Output ONNX path (default: models/<word>.onnx)')
    parser.add_argument('--epochs', type=int, default=500, help='Training epochs')
    args = parser.parse_args()
    
    import numpy as np
    import onnxruntime as ort
    
    if args.output is None:
        args.output = f'{args.models_dir}/{args.word.lower()}.onnx'
    
    # Load backbone models
    mel_path = os.path.join(args.models_dir, 'melspectrogram.onnx')
    emb_path = os.path.join(args.models_dir, 'embedding_model.onnx')
    
    if not os.path.exists(mel_path) or not os.path.exists(emb_path):
        print(f'ERROR: Backbone models not found in {args.models_dir}/')
        print(f'  Need: melspectrogram.onnx and embedding_model.onnx')
        sys.exit(1)
    
    print('Loading backbone models…')
    mel_sess = ort.InferenceSession(mel_path)
    emb_sess = ort.InferenceSession(emb_path)
    
    # Load clips
    pos_dir = Path(args.clips_dir) / 'positive'
    neg_dir = Path(args.clips_dir) / 'negative'
    
    pos_files = sorted(pos_dir.glob('*.wav'))
    neg_files = sorted(neg_dir.glob('*.wav'))
    
    print(f'Found {len(pos_files)} positive clips, {len(neg_files)} negative clips')
    
    if len(pos_files) < 10 or len(neg_files) < 10:
        print('ERROR: Not enough training clips. Run generate_clips.py first.')
        sys.exit(1)
    
    # Extract embeddings
    print('\nExtracting positive embeddings…')
    pos_emb = []
    for i, f in enumerate(pos_files):
        try:
            samples = read_wav_float(str(f))
            emb = extract_embedding(samples, mel_sess, emb_sess)
            pos_emb.append(emb)
            if (i + 1) % 100 == 0:
                print(f'  [{i + 1}/{len(pos_files)}]')
        except Exception as e:
            pass  # skip bad clips silently
    
    print(f'\nExtracting negative embeddings…')
    neg_emb = []
    for i, f in enumerate(neg_files):
        try:
            samples = read_wav_float(str(f))
            emb = extract_embedding(samples, mel_sess, emb_sess)
            neg_emb.append(emb)
            if (i + 1) % 200 == 0:
                print(f'  [{i + 1}/{len(neg_files)}]')
        except Exception:
            pass
    
    print(f'\nUsable embeddings: {len(pos_emb)} positive, {len(neg_emb)} negative')
    
    # Train
    print(f'\nTraining classifier ({args.epochs} epochs)…')
    weights, bias = train_classifier(pos_emb, neg_emb, epochs=args.epochs)
    
    # Export
    print(f'\nExporting ONNX model…')
    os.makedirs(os.path.dirname(args.output) or '.', exist_ok=True)
    export_onnx(weights, bias, args.output)
    
    # Quick eval
    print('\n── Quick evaluation ──')
    all_emb = pos_emb + neg_emb
    all_labels = [1] * len(pos_emb) + [0] * len(neg_emb)
    
    correct = 0
    for emb, label in zip(all_emb, all_labels):
        logit = float(np.dot(emb, weights) + bias)
        prob = 1.0 / (1.0 + math.exp(-max(-30, min(30, logit))))
        pred = 1 if prob > 0.5 else 0
        if pred == label:
            correct += 1
    
    print(f'  Accuracy: {correct}/{len(all_labels)} ({100*correct/len(all_labels):.1f}%)')
    print(f'\nDone! Deploy {args.output} to hestari.com/models/')

if __name__ == '__main__':
    main()
