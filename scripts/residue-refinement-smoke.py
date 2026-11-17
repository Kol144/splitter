"""Technical regression test for the non-destructive stem residue cleaner.

This checks DSP policy only.  It does not claim a synthetic fixture measures
musical separation quality.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend" / "separation"))
from stem_refinement import refine_file  # noqa: E402


SAMPLE_RATE = 44_100


def region(signal: np.ndarray, start: float, end: float) -> np.ndarray:
    return signal[round(start * SAMPLE_RATE):round(end * SAMPLE_RATE)]


def rms(values: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(values), dtype=np.float64)))


def db(value: float) -> float:
    return float(20 * np.log10(max(value, 1e-12)))


def correlation(left: np.ndarray, right: np.ndarray) -> float:
    a = left.reshape(-1)
    b = right.reshape(-1)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def main() -> int:
    work = Path(tempfile.mkdtemp(prefix="aims-residue-smoke-"))
    try:
        frames = 12 * SAMPLE_RATE
        source = np.zeros((frames, 2), dtype=np.float32)
        rng = np.random.default_rng(725_119)
        residual_start, residual_end = round(2.15 * SAMPLE_RATE), round(4.15 * SAMPLE_RATE)
        residual = rng.standard_normal((residual_end - residual_start, 2), dtype=np.float32)
        residual *= np.float32((10 ** (-78 / 20)) / rms(residual))
        source[residual_start:residual_end] = residual

        quiet_start, quiet_end = round(4.3 * SAMPLE_RATE), round(6.3 * SAMPLE_RATE)
        quiet_time = np.arange(quiet_end - quiet_start, dtype=np.float32) / SAMPLE_RATE
        quiet_amplitude = np.float32(np.sqrt(2) * 10 ** (-42 / 20))
        source[quiet_start:quiet_end, 0] = quiet_amplitude * np.sin(2 * np.pi * 173 * quiet_time)
        source[quiet_start:quiet_end, 1] = quiet_amplitude * np.sin(2 * np.pi * 241 * quiet_time)

        content_start, content_end = round(8.6 * SAMPLE_RATE), round(10.6 * SAMPLE_RATE)
        content_time = np.arange(content_end - content_start, dtype=np.float32) / SAMPLE_RATE
        content_amplitude = np.float32(np.sqrt(2) * 10 ** (-18 / 20))
        source[content_start:content_end, 0] = content_amplitude * np.sin(2 * np.pi * 110 * content_time)
        source[content_start:content_end, 1] = content_amplitude * np.sin(2 * np.pi * 220 * content_time)

        input_file = work / "fixture.wav"
        output_file = work / "refined.wav"
        sf.write(input_file, source, SAMPLE_RATE, subtype="FLOAT")
        report = refine_file(input_file, output_file, "conservative-residual")
        assert report["applied"], report
        assert report["maskedSeconds"] >= 1.0, report
        output, rate = sf.read(output_file, dtype="float32", always_2d=True)
        assert rate == SAMPLE_RATE and output.shape == source.shape

        # Central regions exclude the 200 ms guards and 20 ms fades.
        residual_before = rms(region(source, 2.55, 3.75))
        residual_after = rms(region(output, 2.55, 3.75))
        assert db(residual_before) - db(residual_after) >= 24, (db(residual_before), db(residual_after), report)
        assert rms(region(output, 0.15, 1.85)) == 0.0
        assert rms(region(output, 6.6, 8.3)) == 0.0

        quiet_before, quiet_after = region(source, 4.55, 6.05), region(output, 4.55, 6.05)
        content_before, content_after = region(source, 8.85, 10.35), region(output, 8.85, 10.35)
        assert 0.89 <= rms(quiet_after) / rms(quiet_before) <= 1.12
        assert correlation(quiet_before, quiet_after) >= 0.995
        assert rms(content_after) / rms(content_before) >= 10 ** (-0.5 / 20)
        assert correlation(content_before, content_after) >= 0.999

        exact_source = np.full((SAMPLE_RATE, 2), 1 / 32768, dtype=np.float32)
        exact_input, exact_output = work / "exact.wav", work / "exact-clean.wav"
        sf.write(exact_input, exact_source, SAMPLE_RATE, subtype="PCM_16")
        exact_report = refine_file(exact_input, exact_output, "exact")
        exact_clean, _ = sf.read(exact_output, dtype="float32", always_2d=True)
        assert exact_report["applied"] and np.max(np.abs(exact_clean)) == 0.0

        # Tonal content far below the gate threshold must remain intact. Test
        # both a quiet stereo tone and a quiet tone beside a noisier channel.
        tone_time = np.arange(3 * SAMPLE_RATE, dtype=np.float32) / SAMPLE_RATE
        tone = np.float32(np.sqrt(2) * 10 ** (-80 / 20)) * np.sin(2 * np.pi * 223 * tone_time)
        for mixed_channel in (False, True):
            tonal = np.column_stack((tone, tone)).astype(np.float32)
            if mixed_channel:
                tonal[:, 0] = rng.standard_normal(len(tone)).astype(np.float32) * np.float32(10 ** (-76 / 20))
            tonal_input, tonal_output = work / 'tonal.wav', work / 'tonal-clean.wav'
            sf.write(tonal_input, tonal, SAMPLE_RATE, subtype='FLOAT')
            tonal_report = refine_file(tonal_input, tonal_output, 'conservative-residual')
            assert not tonal_report['applied'] and not tonal_output.exists(), tonal_report

        short_input, short_output = work / 'short.wav', work / 'short-clean.wav'
        sf.write(short_input, residual[:round(.8 * SAMPLE_RATE)], SAMPLE_RATE, subtype='FLOAT')
        assert not refine_file(short_input, short_output, 'conservative-residual')['applied']

        zero_input, zero_output = work / 'zero.wav', work / 'zero-clean.wav'
        sf.write(zero_input, np.zeros((2 * SAMPLE_RATE, 2), dtype=np.float32), SAMPLE_RATE, subtype='FLOAT')
        assert not refine_file(zero_input, zero_output, 'conservative-residual')['applied']
        assert not zero_output.exists(), 'Already silent files should not be duplicated.'

        unchanged = np.ones(len(source), dtype=bool)
        for item in report['intervals']:
            unchanged[round(item['startSeconds'] * SAMPLE_RATE):round(item['endSeconds'] * SAMPLE_RATE)] = False
        assert np.array_equal(source[unchanged], output[unchanged]), 'Samples outside detected intervals changed.'
        assert np.array_equal(sf.read(input_file, dtype='float32', always_2d=True)[0], source), 'Original was modified.'

        print(json.dumps({
            "result": "PASS",
            "residualReductionDb": round(db(residual_before) - db(residual_after), 2),
            "quietGainDb": round(db(rms(quiet_after) / rms(quiet_before)), 3),
            "quietCorrelation": round(correlation(quiet_before, quiet_after), 6),
            "contentCorrelation": round(correlation(content_before, content_after), 6),
            "maskedSeconds": report["maskedSeconds"],
            "exactModeMasked": exact_report["maskedSeconds"],
            "quietTonePreserved": True,
            "stereoTonePreserved": True,
            "shortTailPreserved": True,
            "originalUnchanged": True,
        }, ensure_ascii=False, indent=2))
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
