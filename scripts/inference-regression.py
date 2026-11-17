"""Audio correctness tests; uses small deterministic models, no downloads."""
import gc
import json
from pathlib import Path
import random
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import weakref

import torch
from demucs.apply import apply_model, BagOfModels
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend" / "separation"))
import inference

torch.set_num_threads(2)
torch.manual_seed(42)
audio = torch.randn(2, 1001) * .03
ref = audio.mean(0)
expected = (audio - ref.mean()) / ref.std()
actual = audio.clone()
mean, scale, report = inference.normalize_audio(actual)
assert torch.equal(expected, actual), "Normal music must keep upstream normalization exactly"
assert torch.allclose(actual * scale + mean, audio, atol=1e-8)
for level in [1., 1e-8, 1e-25]:
    phase = torch.stack((audio[0], -audio[0])) * level
    original = phase.clone()
    mean, scale, report = inference.normalize_audio(phase)
    assert report["kind"] == "stereo-fallback"
    assert torch.isfinite(phase).all()
    assert torch.allclose(phase * scale + mean, original, rtol=1e-6, atol=level * 1e-8)
for data in [torch.zeros(2, 441), torch.full((2, 441), .125), torch.zeros(2, 1)]:
    assert inference.normalize_audio(data)[2]["kind"] == "constant"
for data in [torch.empty(2, 0), torch.tensor([[float('nan')]]), torch.tensor([[float('inf')]])]:
    try: inference.normalize_audio(data)
    except ValueError: pass
    else: raise AssertionError("Invalid audio accepted")
with patch.object(inference.os, 'cpu_count', return_value=2):
    assert inference.effective_threads(6) <= 2


class Model(torch.nn.Module):
    sources = ['drums', 'bass', 'other', 'vocals']
    samplerate = 100
    audio_channels = 2
    segment = 2
    def __init__(self, number):
        super().__init__()
        self.dummy = torch.nn.Parameter(torch.tensor(float(number)))
    def forward(self, mix):
        # Slight nonlinearity exposes incorrect scaling/weighting and chunk boundaries.
        return torch.stack([torch.tanh(mix * (self.dummy + index + 1)) / 12 for index in range(4)], dim=1)


# Check overlap, final short chunks and random shift alignment against upstream.
for shifts in (0, 2):
    model = Model(1).eval()
    random.seed(42)
    reference = apply_model(model, audio[None], device='cpu', shifts=shifts, overlap=.25, num_workers=1)
    random.seed(42)
    with torch.inference_mode():
        actual = apply_model(model, audio[None], device='cpu', shifts=shifts, overlap=.25, num_workers=0)
    assert torch.equal(reference, actual), "Chunk scheduler changed the waveform"

temp_root = ROOT / 'data' / 'temp'
temp_root.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='inference-regression-', dir=temp_root) as directory:
    folder = Path(directory)
    for weights in ([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
                    [[1, 2, 3, 4], [4, 3, 2, 1], [1, 1, 1, 1], [2, 2, 2, 2]]):
        # Contrast lazy checkpoint loading with a complete upstream BagOfModels.
        (folder / 'fixture.yaml').write_text(json.dumps({'models': ['0','1','2','3'], 'weights': weights, 'segment': 2}))
        bag = BagOfModels([Model(i) for i in range(4)], weights=weights, segment=2)
        normalized = audio.clone()
        mean, scale, _ = inference.normalize_audio(normalized)
        reference = apply_model(bag, normalized[None], device='cpu', shifts=0, overlap=.25, num_workers=0)[0] * scale + mean
        del bag
        gc.collect()
        live = weakref.WeakSet()
        def get_model(name):
            assert not live, 'Two checkpoints were resident at once'
            model = Model(int(name))
            live.add(model)
            return model
        pretrained = SimpleNamespace(REMOTE_ROOT=folder, get_model=get_model)
        for output_format, subtype, tolerance in [('float32', 'FLOAT', 1e-8), ('pcm24', 'PCM_24', 2**-23), ('pcm16', 'PCM_16', 2**-15)]:
            args = SimpleNamespace(model='fixture', overlap='.25', shifts='0', threads=4,
                                   input=str(folder / 'input.wav'), output=str(folder / output_format), output_format=output_format)
            with patch.object(inference, 'load_track', return_value=audio.clone()):
                report = inference.separate_audio(args, pretrained)
            assert report['frames'] == audio.shape[-1]
            for index, name in enumerate(Model.sources):
                file = Path(args.output) / 'fixture' / 'input' / f'{name}.wav'
                result, rate = sf.read(file, dtype='float32', always_2d=True)
                assert rate == Model.samplerate and sf.info(file).subtype == subtype
                assert torch.allclose(torch.from_numpy(result.T), reference[index], atol=tolerance, rtol=0)
        # Exact DC is preserved once, not copied into every source.
        with patch.object(inference, 'load_track', return_value=torch.full_like(audio, .125)), patch.object(inference, 'apply_model', side_effect=AssertionError('Constant audio must bypass inference')):
            inference.separate_audio(args, pretrained)
        summed = sum(sf.read(Path(args.output) / 'fixture' / 'input' / f'{name}.wav')[0] for name in Model.sources)
        assert abs(summed - .125).max() == 0
print('PASS: normalization, anti-phase, quiet audio, invalid input, shifts, chunk joins, lazy ensembles, WAV contracts, DC.')
