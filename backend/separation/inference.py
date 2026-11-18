"""Bounded, sequential orchestration of the unmodified official Demucs models."""
from __future__ import annotations

import gc
import json
import math
import os
from pathlib import Path
import random
import time

import torch
import yaml
from demucs.apply import apply_model
from demucs.audio import save_audio
from demucs.separate import load_track


def effective_threads(requested: int) -> int:
    """Respect the user's ceiling and the CPUs actually assigned to this process."""
    available = os.cpu_count() or 1
    if hasattr(os, "sched_getaffinity"):
        available = min(available, len(os.sched_getaffinity(0)))
    # Containers can expose the host CPU count despite a smaller CPU quota.
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        if quota != "max":
            available = min(available, max(1, math.floor(int(quota) / int(period))))
    except (OSError, ValueError):
        pass
    return max(1, min(int(requested), available))


def normalize_audio(wav):
    """Keep upstream scaling for normal audio, including very quiet music.

    A cancelled mono downmix must not divide stereo content by zero. There is
    deliberately no dB gate: only a truly constant signal takes the bypass.
    """
    if wav.ndim != 2 or wav.shape[-1] == 0:
        raise ValueError("El archivo no contiene muestras de audio válidas.")
    if not torch.isfinite(wav).all():
        raise ValueError("El audio contiene muestras NaN o infinitas.")
    ref = wav.mean(0)
    mean = ref.mean()
    scale = ref.std(unbiased=ref.numel() > 1)
    # Check channel energy without cancelling left against right.
    stereo_scale = wav.std(unbiased=wav.numel() > 1)
    if not all(bool(torch.isfinite(value)) for value in (mean, scale, stereo_scale)):
        raise ValueError("El nivel del archivo excede el rango de normalización admitido.")
    flat = bool(wav.amax() == wav.amin())
    if stereo_scale == 0 and not flat:
        # Do not mistake floating-point underflow for digital silence.
        stereo_scale = wav.double().std(unbiased=wav.numel() > 1)
    fallback = bool(scale < stereo_scale * 1e-4)
    if fallback:
        scale = stereo_scale
    if not flat:
        wav.sub_(mean).div_(scale)
    return mean, scale, {"kind": "constant" if flat else "stereo-fallback" if fallback else "mono",
                         "mean": float(mean), "scale": float(scale)}


def load_plan(name, pretrained):
    # Configuration comes from the installed, pinned official package, never
    # from an uploaded song or a user-supplied YAML/checkpoint.
    config = yaml.safe_load((pretrained.REMOTE_ROOT / f"{name}.yaml").read_text(encoding="utf-8"))
    signatures = config["models"]
    weights = config.get("weights")
    if weights is not None:
        if len(weights) != len(signatures) or not weights or any(len(row) != len(weights[0]) for row in weights):
            raise ValueError("Pesos del ensemble incompatibles.")
        if any(not math.isfinite(value) or value < 0 for row in weights for value in row):
            raise ValueError("Pesos del ensemble no válidos.")
        if any(sum(column) <= 0 for column in zip(*weights)):
            raise ValueError("El ensemble no asigna peso a todas sus fuentes.")
    return signatures, weights, config.get("segment")


def add_estimate(estimate, output, weights):
    # Match upstream accumulation order/precision, including zero-weight heads.
    for index, weight in enumerate(weights):
        output[:, index].mul_(weight)
    if estimate is None:
        return output
    estimate.add_(output)
    return estimate


def restore_audio(estimate, scale, mean, names):
    """Restore the mixture's DC component once, in its residual source."""
    estimate.mul_(scale)
    residual_index = names.index("other") if "other" in names else 0
    estimate[:, residual_index].add_(mean)


def prepare_output(estimate, output_format):
    """Preserve float headroom and use one shared gain for integer stems."""
    peak = max(float(source.abs().amax()) for source in estimate.unbind(dim=1))
    gain = 1.0
    if output_format != "float32" and peak > 1 / 1.01:
        gain = 1 / (1.01 * peak)
        estimate.mul_(gain)
    return {"peakBeforeGain": peak, "sharedGain": gain,
            "policy": "float-headroom" if output_format == "float32" else "shared-pcm-headroom"}


@torch.inference_mode()
def separate_audio(args, pretrained):
    started = time.perf_counter()
    signatures, weights, segment = load_plan(args.model, pretrained)
    overlap, shifts = float(args.overlap), int(args.shifts)
    if not 0 <= overlap < 1 or not 0 <= shifts <= 10:
        raise ValueError("Overlap debe estar entre 0 y 1 (excluido); shifts entre 0 y 10.")
    threads = effective_threads(args.threads)
    random.seed(0)
    torch.set_num_threads(threads)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    report = {"engine": "demucs-sequential-v1", "device": "cpu", "dtype": "float32",
              "torchVersion": torch.__version__, "cudaAvailable": torch.cuda.is_available(),
              "threads": threads, "requestedThreads": args.threads, "chunkWorkers": 0,
              "shifts": shifts, "shiftSeed": 0, "overlap": overlap, "models": [], "loadSeconds": 0.0,
              "inferenceSeconds": 0.0}
    estimate = None
    totals = None
    mix = None
    identity = None
    for index, signature in enumerate(signatures):
        print(f"Loading model {index + 1}/{len(signatures)}: {signature}", flush=True)
        tick = time.perf_counter()
        model = pretrained.get_model(name=signature)
        model.cpu().eval()
        report["loadSeconds"] += time.perf_counter() - tick
        current = (list(model.sources), model.audio_channels, model.samplerate)
        if identity is not None and identity != current:
            raise ValueError("Los modelos del ensemble tienen formatos de audio incompatibles.")
        identity = current
        names, channels, rate = identity
        if segment is not None:
            model.segment = segment
        if mix is None:
            tick = time.perf_counter()
            mix = load_track(Path(args.input), channels, rate)
            mean, scale, normalization = normalize_audio(mix)
            report["decodeNormalizeSeconds"] = time.perf_counter() - tick
            report["normalization"] = normalization
            report["frames"] = mix.shape[-1]
            report["sampleRate"] = rate
            totals = [0.0] * len(names)
        model_weights = weights[index] if weights is not None else [1.0] * len(names)
        if len(model_weights) != len(names):
            raise ValueError("Número de fuentes incompatible con los pesos oficiales.")
        report["models"].append({"signature": signature, "segmentSeconds": float(model.segment), "weights": model_weights})
        if normalization["kind"] == "constant":
            # Exact digital silence / DC has no separable instruments. Preserve
            # it once in 'other', without running four networks on zeros/NaNs.
            estimate = torch.zeros(1, len(names), channels, mix.shape[-1])
            estimate[0, names.index("other") if "other" in names else 0].copy_(mix)
            del model
            break
        print(f"Separating {args.model}; modelo {index + 1}/{len(signatures)}; CPU {threads} hilos", flush=True)
        tick = time.perf_counter()
        # The upstream lazy executor evaluates each chunk on demand and does
        # not retain completed Future results. inference_mode stays on this
        # thread. Upstream padding, triangular overlap-add and shifts remain.
        output = apply_model(model, mix[None], device="cpu", shifts=shifts,
                             split=True, overlap=overlap, progress=True, num_workers=0)
        report["inferenceSeconds"] += time.perf_counter() - tick
        estimate = add_estimate(estimate, output, model_weights)
        totals = [total + weight for total, weight in zip(totals, model_weights)]
        del output, model
        gc.collect()
    if normalization["kind"] != "constant":
        for index, total in enumerate(totals):
            estimate[:, index].div_(total)
        restore_audio(estimate, scale, mean, names)
    report["dcRestoration"] = "once-in-other"
    del mix
    if not torch.isfinite(estimate).all():
        raise RuntimeError("El modelo produjo muestras no finitas; no se publicarán stems inválidos.")
    report["outputGain"] = prepare_output(estimate, args.output_format)
    folder = Path(args.output) / args.model / Path(args.input).stem
    folder.mkdir(parents=True, exist_ok=True)
    tick = time.perf_counter()
    for name, audio in zip(names, estimate[0]):
        # Gain is handled across all stems above, preserving their balance.
        save_audio(audio, folder / f"{name}.wav", samplerate=rate,
                   clip="none",
                   as_float=args.output_format == "float32",
                   bits_per_sample=24 if args.output_format == "pcm24" else 16)
    report["writeSeconds"] = time.perf_counter() - tick
    report["processingSeconds"] = time.perf_counter() - started
    (Path(args.output) / "inference-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report
