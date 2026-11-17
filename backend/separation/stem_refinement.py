"""Conservative, non-destructive cleanup for Demucs stem residue.

The model output always remains available.  This module only creates a sibling
refined WAV when it finds a long stretch that is very quiet *and* noise-like.
It intentionally leaves uncertain, tonal or short material untouched.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf


MODES = ("off", "exact", "conservative-residual")
WINDOW_SECONDS = 0.100
EXACT_MIN_SECONDS = 0.250
RESIDUAL_MIN_SECONDS = 1.200
BOUNDARY_GUARD_SECONDS = 0.200
FADE_SECONDS = 0.020
RESIDUAL_RMS_DB = -72.0
RESIDUAL_PEAK_DB = -58.0
RESIDUAL_FLATNESS = 0.65


def _dbfs(value: float) -> float:
    return float(20.0 * math.log10(max(value, 1e-12)))


def _epsilon_for_subtype(subtype: str) -> float:
    if subtype == "PCM_16":
        return 1.0 / 32768.0
    if subtype == "PCM_24":
        return 1.0 / (2 ** 23)
    if subtype == "PCM_32":
        return 1.0 / (2 ** 31)
    return 1e-7


def _spectral_flatness(frame: np.ndarray) -> float:
    if len(frame) < 32:
        return 0.0
    window = np.hanning(len(frame)).astype(np.float32, copy=False)
    spectrum = np.abs(np.fft.rfft(frame * window)) + 1e-12
    return float(np.exp(np.mean(np.log(spectrum))) / np.mean(spectrum))


def _analyse_frames(source: Path, window_frames: int) -> list[dict[str, float]]:
    features: list[dict[str, float]] = []
    with sf.SoundFile(source) as wav:
        for frame in wav.blocks(blocksize=window_frames, dtype="float32", always_2d=True):
            if not len(frame):
                continue
            channel_rms = np.sqrt(np.mean(np.square(frame), axis=0))
            rms = float(np.max(channel_rms))
            peak = float(np.max(np.abs(frame)))
            # Protect tonal content in either channel, including a quiet side
            # under noise in the other. Strong frames never need an FFT.
            weak = _dbfs(rms) <= RESIDUAL_RMS_DB and _dbfs(peak) <= RESIDUAL_PEAK_DB
            non_silent_channels = [channel for channel in range(frame.shape[1]) if np.max(np.abs(frame[:, channel])) > 1e-10]
            flatness = min((_spectral_flatness(frame[:, channel]) for channel in non_silent_channels), default=1.0) if weak else 0.0
            features.append({
                "rmsDb": _dbfs(rms),
                "peakDb": _dbfs(peak),
                "flatness": flatness,
            })
    return features


def _runs(mask: list[bool]) -> list[tuple[int, int]]:
    result: list[tuple[int, int]] = []
    start: int | None = None
    for index, enabled in enumerate([*mask, False]):
        if enabled and start is None:
            start = index
        elif not enabled and start is not None:
            result.append((start, index))
            start = None
    return result


def _intervals(features: list[dict[str, float]], mode: str, sample_rate: int, window_frames: int, epsilon: float) -> list[dict[str, Any]]:
    if mode == "off" or not features:
        return []
    if mode == "exact":
        # RMS below epsilon is enough here only because the level bound is tied
        # to the source precision (one PCM16 LSB or less).
        epsilon_db = _dbfs(epsilon)
        mask = [item["peakDb"] <= epsilon_db for item in features]
        minimum = math.ceil(EXACT_MIN_SECONDS * sample_rate / window_frames)
        guard = 0
    else:
        mask = [
            item["rmsDb"] <= RESIDUAL_RMS_DB
            and item["peakDb"] <= RESIDUAL_PEAK_DB
            and item["flatness"] >= RESIDUAL_FLATNESS
            for item in features
        ]
        minimum = math.ceil(RESIDUAL_MIN_SECONDS * sample_rate / window_frames)
        guard = math.ceil(BOUNDARY_GUARD_SECONDS * sample_rate / window_frames)

    result: list[dict[str, Any]] = []
    for start, end in _runs(mask):
        if end - start < minimum:
            continue
        # Do not gate directly beside potentially musical content.  The guard
        # remains untouched and the actual muted core must still be audible in
        # duration after removing both protected edges.
        core_start = start + guard
        core_end = end - guard
        if core_end <= core_start:
            continue
        selected = features[start:end]
        if max(item["peakDb"] for item in selected) <= -240.0:
            # Zero is already silence. Do not create a duplicate WAV or count
            # unchanged digital silence as an improvement.
            continue
        result.append({
            "startFrame": core_start * window_frames,
            "endFrame": core_end * window_frames,
            "sourceStartFrame": start * window_frames,
            "sourceEndFrame": end * window_frames,
            "rmsMaxDb": round(max(item["rmsDb"] for item in selected), 2),
            "peakMaxDb": round(max(item["peakDb"] for item in selected), 2),
            "flatnessMin": round(min(item["flatness"] for item in selected), 4),
        })
    return result


def _apply_intervals(frame: np.ndarray, frame_start: int, intervals: list[dict[str, Any]], fade_frames: int) -> np.ndarray:
    if not intervals:
        return frame
    frame_end = frame_start + len(frame)
    gain = np.ones(len(frame), dtype=np.float32)
    for interval in intervals:
        start = max(frame_start, int(interval["startFrame"]))
        end = min(frame_end, int(interval["endFrame"]))
        if end <= start:
            continue
        absolute = np.arange(start, end, dtype=np.int64)
        local = absolute - frame_start
        interval_start = int(interval["startFrame"])
        interval_end = int(interval["endFrame"])
        down_end = min(interval_start + fade_frames, interval_end)
        up_start = max(interval_end - fade_frames, interval_start)
        values = np.zeros(len(absolute), dtype=np.float32)
        entering = absolute < down_end
        leaving = absolute >= up_start
        if entering.any():
            progress = (absolute[entering] - interval_start) / max(1, fade_frames)
            values[entering] = .5 + .5 * np.cos(np.pi * progress)
        if leaving.any():
            progress = (interval_end - absolute[leaving]) / max(1, fade_frames)
            values[leaving] = .5 + .5 * np.cos(np.pi * progress)
        gain[local] = np.minimum(gain[local], values)
    return frame * gain[:, None]


def refine_file(source: Path, output: Path, mode: str) -> dict[str, Any]:
    if mode not in MODES:
        raise ValueError(f"Modo de refinamiento no admitido: {mode}")
    if source.resolve() == output.resolve():
        raise ValueError("El refinamiento debe escribir una copia distinta del original.")
    info = sf.info(source)
    window_frames = max(256, round(info.samplerate * WINDOW_SECONDS))
    features = _analyse_frames(source, window_frames)
    intervals = _intervals(features, mode, info.samplerate, window_frames, _epsilon_for_subtype(info.subtype))
    report: dict[str, Any] = {
        "stem": source.stem,
        "mode": mode,
        "applied": bool(intervals),
        "sampleRate": info.samplerate,
        "channels": info.channels,
        "sourceBytes": source.stat().st_size,
        "intervals": [],
        "maskedSeconds": 0.0,
    }
    if not intervals:
        return report

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".partial.wav")
    # Digital silence is already below the audible precision of its container,
    # so it needs no fade. Residual mode uses a short cosine transition to
    # avoid clicks at the boundary of a detected noise interval.
    fade_frames = 0 if mode == "exact" else max(1, round(info.samplerate * FADE_SECONDS))
    position = 0
    try:
        with sf.SoundFile(source) as reader, sf.SoundFile(
            temporary, mode="w", samplerate=info.samplerate, channels=info.channels,
            format=info.format, subtype=info.subtype,
        ) as writer:
            for frame in reader.blocks(blocksize=window_frames, dtype="float32", always_2d=True):
                writer.write(_apply_intervals(frame, position, intervals, fade_frames))
                position += len(frame)
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink(missing_ok=True)

    for interval in intervals:
        start = int(interval["startFrame"])
        end = min(position, int(interval["endFrame"]))
        if end <= start:
            continue
        report["intervals"].append({
            "startSeconds": round(start / info.samplerate, 3),
            "endSeconds": round(end / info.samplerate, 3),
            "rmsMaxDb": interval["rmsMaxDb"],
            "peakMaxDb": interval["peakMaxDb"],
            "flatnessMin": interval["flatnessMin"],
        })
        report["maskedSeconds"] += (end - start) / info.samplerate
    report["maskedSeconds"] = round(report["maskedSeconds"], 3)
    report["outputBytes"] = output.stat().st_size
    return report


def refine_demucs_output(output_root: str | Path, model: str, input_path: str | Path, mode: str) -> dict[str, Any]:
    root = Path(output_root)
    source_folder = root / model / Path(input_path).stem
    result: dict[str, Any] = {
        "mode": mode,
        "nonDestructive": True,
        "criteria": {
            "exact": f"tramos de al menos {EXACT_MIN_SECONDS:.2f}s por debajo de un LSB del formato",
            "conservativeResidual": {
                "minimumDurationSeconds": RESIDUAL_MIN_SECONDS,
                "boundaryGuardSeconds": BOUNDARY_GUARD_SECONDS,
                "fadeSeconds": FADE_SECONDS,
                "maximumRmsDb": RESIDUAL_RMS_DB,
                "maximumPeakDb": RESIDUAL_PEAK_DB,
                "minimumFlatness": RESIDUAL_FLATNESS,
            },
        },
        "stems": [],
    }
    if mode == "off" or not source_folder.is_dir():
        return result
    refined_folder = root / "refined" / model / source_folder.name
    for source in sorted(source_folder.glob("*.wav")):
        report = refine_file(source, refined_folder / source.name, mode)
        result["stems"].append(report)
    result["maskedSeconds"] = round(sum(item["maskedSeconds"] for item in result["stems"]), 3)
    report_path = root / "refinement-report.json"
    report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def refine_manifest(manifest_path: Path, output_root: Path, mode: str) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    output_root.mkdir(parents=True, exist_ok=True)
    result: dict[str, Any] = {"mode": mode, "nonDestructive": True, "stems": [], "maskedSeconds": 0.0}
    for item in manifest["stems"]:
        name = item["name"]
        if not name or Path(name).name != name or name in (".", "..") or "/" in name or "\\" in name:
            raise ValueError("Nombre de stem no válido.")
        print(f"Refinamiento: {name}", flush=True)
        report = refine_file(Path(item["path"]), output_root / f"{name}.wav", mode)
        report["stem"] = name
        result["stems"].append(report)
    result["maskedSeconds"] = round(sum(item["maskedSeconds"] for item in result["stems"]), 3)
    (output_root / "refinement-report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result
