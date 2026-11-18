"""Reproducible, offline A/B benchmark. Never downloads weights or test audio.

Place the four hdemucs_*_segment.wav tutorial references as <stem>.wav in
data/temp/separation-benchmark/references. They are research fixtures, not
redistributable application assets. See docs/SEPARATION_OPTIMIZATION.md.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "data" / "temp" / "separation-benchmark"
STEMS = ("drums", "bass", "other", "vocals")


def memory():
    if sys.platform == "win32":
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                (key, ctypes.c_size_t) for key in ("PeakWorkingSetSize", "WorkingSetSize",
                "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
                "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage", "PrivateUsage")]
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        process = ctypes.windll.kernel32.GetCurrentProcess
        process.restype = wintypes.HANDLE
        query = ctypes.windll.psapi.GetProcessMemoryInfo
        query.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        if not query(process(), ctypes.byref(counters), counters.cb):
            raise ctypes.WinError()
        return {"peakRssBytes": counters.PeakWorkingSetSize, "peakCommitBytes": counters.PeakPagefileUsage}
    import resource
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {"peakRssBytes": rss if sys.platform == "darwin" else rss * 1024}


def available_memory():
    if sys.platform == "win32":
        class Status(ctypes.Structure):
            _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [
                (key, ctypes.c_ulonglong) for key in ('total', 'available', 'pageTotal', 'pageAvailable', 'virtualTotal', 'virtualAvailable', 'extended')]
        status = Status()
        status.length = ctypes.sizeof(status)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            raise ctypes.WinError()
        return status.available
    if sys.platform.startswith('linux'):
        for line in Path('/proc/meminfo').read_text().splitlines():
            if line.startswith('MemAvailable:'): return int(line.split()[1]) * 1024
    return None


def prepare():
    import numpy as np
    import soundfile as sf
    references = []
    for stem in STEMS:
        audio, rate = sf.read(WORK / "references" / f"{stem}.wav", dtype="float32", always_2d=True)
        assert rate == 44100 and audio.shape == (220500, 2), "Expected official 5 s stereo references"
        references.append(audio)
    mix = np.stack(references).sum(axis=0)
    sf.write(WORK / "music.wav", mix, 44100, subtype="FLOAT")
    sf.write(WORK / "repeated20.wav", np.tile(mix, (4, 1)), 44100, subtype="FLOAT")
    sf.write(WORK / "silence.wav", np.zeros_like(mix), 44100, subtype="FLOAT")
    mono = mix.mean(axis=1)
    sf.write(WORK / "antiphase.wav", np.stack((mono, -mono), axis=1), 44100, subtype="FLOAT")
    manifest = {stem: hashlib.sha256((WORK / "references" / f"{stem}.wav").read_bytes()).hexdigest() for stem in STEMS}
    (WORK / "fixture-hashes.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def metrics(folder, case):
    import numpy as np
    import soundfile as sf
    mix, _ = sf.read(WORK / f"{case}.wav", dtype="float64", always_2d=True)
    result = {}
    estimated_mix = np.zeros_like(mix)
    for stem in STEMS:
        audio, rate = sf.read(folder / f"{stem}.wav", dtype="float64", always_2d=True)
        valid = audio.shape == mix.shape and rate == 44100 and bool(np.isfinite(audio).all())
        row = {"valid": valid, "frames": len(audio)}
        if valid:
            estimated_mix += audio
            row.update(peak=float(np.abs(audio).max()), rms=float(np.sqrt(np.mean(audio ** 2))))
            if case in ("music", "repeated20", "falcon"):
                reference_folder = "falcon-references" if case == "falcon" else "references"
                reference, _ = sf.read(WORK / reference_folder / f"{stem}.wav", dtype="float64", always_2d=True)
                if case == "repeated20": reference = np.tile(reference, (4, 1))
                target = reference - reference.mean()
                estimate = audio - audio.mean()
                projection = target * (np.sum(target * estimate) / max(np.sum(target ** 2), 1e-30))
                row["siSdrDb"] = float(10 * np.log10(max(np.sum(projection ** 2), 1e-30) / max(np.sum((estimate - projection) ** 2), 1e-30)))
                row["errorRms"] = float(np.sqrt(np.mean((audio - reference) ** 2)))
                row["differenceErrorRms"] = float(np.sqrt(np.mean((np.diff(audio, axis=0) - np.diff(reference, axis=0)) ** 2)))
                row["stereoSideErrorRms"] = float(np.sqrt(np.mean(((audio[:, 0] - audio[:, 1]) - (reference[:, 0] - reference[:, 1])) ** 2)))
        result[stem] = row
    if all(row["valid"] for row in result.values()):
        result["mixtureErrorRms"] = float(np.sqrt(np.mean((estimated_mix - mix) ** 2)))
    return result


def worker(args):
    started = time.perf_counter()
    import numpy as np
    import torch
    from demucs import apply, pretrained
    import demucs.separate
    random.seed(0)
    np.random.seed(0)
    torch.manual_seed(0)
    timings = {"loadSeconds": 0.0, "inferenceSeconds": 0.0}
    original_load = pretrained.get_model
    original_apply = apply.apply_model
    depth = 0
    def load(*values, **kwargs):
        start = time.perf_counter()
        try: return original_load(*values, **kwargs)
        finally: timings["loadSeconds"] += time.perf_counter() - start
    def infer(*values, **kwargs):
        nonlocal depth
        depth += 1
        start = time.perf_counter()
        try: return original_apply(*values, **kwargs)
        finally:
            depth -= 1
            if not depth: timings["inferenceSeconds"] += time.perf_counter() - start
    pretrained.get_model = load
    apply.apply_model = demucs.separate.apply_model = infer
    sys.path.insert(0, str(Path(args.runner).resolve().parent))
    spec = importlib.util.spec_from_file_location("benchmark_runner", args.runner)
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    output = WORK / args.label / args.model / f"{args.case}-{args.iteration}"
    params = SimpleNamespace(input=str(WORK / f"{args.case}.wav"), output=str(output), model=args.model,
                             threads=args.threads, shifts=str(args.shifts), overlap=str(args.overlap),
                             output_format="float32", silence_refinement="off")
    output.mkdir(parents=True, exist_ok=True)
    failure = None
    try:
        runner.separate(params)
    except Exception as exc:
        failure = f"{type(exc).__name__}: {exc}"
        traceback.print_exc()
    elapsed = time.perf_counter() - started
    record = {"label": args.label, "model": args.model, "case": args.case, "iteration": args.iteration,
              "threads": args.threads, "shifts": args.shifts, "overlap": args.overlap, "format": "float32",
              "totalSeconds": elapsed, **timings, **memory(), "torch": torch.__version__,
              "runnerSha256": hashlib.sha256(Path(args.runner).read_bytes()).hexdigest(),
              "inferenceSha256": hashlib.sha256(Path(args.runner).with_name('inference.py').read_bytes()).hexdigest()
                  if Path(args.runner).with_name('inference.py').is_file() else None,
              "inputSha256": hashlib.sha256(Path(params.input).read_bytes()).hexdigest(),
              "failure": failure,
              "metrics": {} if failure else metrics(output / args.model / args.case, args.case)}
    (output / "benchmark.json").write_text(json.dumps(record, indent=2, allow_nan=False), encoding="utf-8")
    print("BENCHMARK " + json.dumps({key: value for key, value in record.items() if key != "metrics"}), flush=True)
    if failure:
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--runner", default=str(ROOT / "backend" / "separation" / "runner.py"))
    parser.add_argument("--label", default="after")
    parser.add_argument("--model", choices=("htdemucs", "htdemucs_ft"), default="htdemucs")
    parser.add_argument("--case", choices=("music", "repeated20", "private-excerpt", "silence", "antiphase", "falcon"), default="music")
    parser.add_argument("--threads", type=int, choices=(4, 6), default=4)
    parser.add_argument("--shifts", type=int, default=0)
    parser.add_argument("--overlap", type=float, default=.25)
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--iteration", type=int, default=1)
    args = parser.parse_args()
    if args.prepare:
        prepare()
    elif args.worker:
        worker(args)
    else:
        try:
            with urllib.request.urlopen('http://127.0.0.1:4173/api/health', timeout=5) as response:
                if json.load(response).get('activeJob'):
                    raise RuntimeError('Benchmark postponed while a web separation is running.')
        except (urllib.error.URLError, TimeoutError):
            pass
        for iteration in range(1, args.repeat + 1):
            command = [sys.executable, __file__, "--worker", "--runner", args.runner, "--label", args.label,
                       "--model", args.model, "--case", args.case, "--threads", str(args.threads),
                       "--shifts", str(args.shifts), "--overlap", str(args.overlap), "--iteration", str(iteration)]
            # Standalone, short benchmarks are monitored separately from the
            # app's conservative job-admission guard, which is not changed.
            free = available_memory()
            if free is not None and free < 2 * 1024**3:
                raise RuntimeError('Benchmark postponed: less than 2 GiB available.')
            with subprocess.Popen(command, cwd=ROOT) as child:
                while child.poll() is None:
                    time.sleep(.25)
                    free = available_memory()
                    if free is not None and free < 512 * 1024**2:
                        if child.poll() is not None:
                            break
                        if sys.platform == 'win32':
                            subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'], capture_output=True)
                        else:
                            child.kill()
                        raise RuntimeError('Benchmark stopped: system memory reserve reached.')
                if child.returncode:
                    raise subprocess.CalledProcessError(child.returncode, command)


if __name__ == "__main__":
    main()
