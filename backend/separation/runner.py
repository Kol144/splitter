"""Small bridge to the upstream Demucs implementation; no simulated output."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import gc
import importlib.metadata
import importlib.util
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

REFINEMENT_MODES = ("off", "exact", "conservative-residual")

# Names are deliberately limited to the official Demucs v4 catalog bundled with
# the pinned Demucs release. This keeps model provenance and cache handling
# explicit rather than accepting arbitrary checkpoints from the command line.
MODEL_NAMES = ("htdemucs", "htdemucs_ft", "mdx_extra", "mdx_extra_q", "htdemucs_6s")


def load_demucs():
    try:
        import torch
        from demucs import pretrained
        return torch, pretrained
    except Exception as exc:  # setup errors are surfaced in the UI
        raise RuntimeError(f"PyTorch CPU y Demucs no están listos: {exc}") from exc


def get_model_signatures(name: str, pretrained) -> tuple[list[str], dict[str, str]]:
    if name not in MODEL_NAMES:
        raise ValueError(f"Modelo no admitido: {name}")
    files = pretrained._parse_remote_files(pretrained.REMOTE_ROOT / "files.txt")
    config = pretrained.REMOTE_ROOT / f"{name}.yaml"
    if not config.exists():
        raise RuntimeError(f"Demucs no incluye el modelo {name}.")
    ids = re.findall(r"['\"]([0-9a-f]{8})['\"]", config.read_text(encoding="utf-8"))
    if not ids:
        raise RuntimeError(f"No se encontraron pesos para {name} en el catálogo instalado.")
    signatures = {}
    for short_id in ids:
        url = next((url for key, url in files.items() if key.startswith(short_id)), None)
        if not url:
            raise RuntimeError(f"No hay una URL oficial para el peso {short_id}.")
        signatures[short_id] = url
    return ids, signatures


def installed_remote_data(name: str) -> tuple[list[str], dict[str, str], Path]:
    spec = importlib.util.find_spec("demucs")
    if spec is None or not spec.origin:
        raise RuntimeError("Demucs no está instalado.")
    remote = Path(spec.origin).parent / "remote"
    config = remote / f"{name}.yaml"
    if name not in MODEL_NAMES or not config.is_file():
        raise RuntimeError(f"Demucs no incluye el modelo {name}.")
    ids = re.findall(r"['\"]([0-9a-f]{8})['\"]", config.read_text(encoding="utf-8"))
    lines = (remote / "files.txt").read_text(encoding="utf-8").splitlines()
    root = ""
    urls = {}
    for line in lines:
        line = line.strip()
        if line.startswith("root:"):
            root = line.split(":", 1)[1].strip()
        elif line and not line.startswith("#"):
            urls[line.split("-", 1)[0]] = f"https://dl.fbaipublicfiles.com/demucs/{root}{line}"
    signatures = {short_id: urls[short_id] for short_id in ids if short_id in urls}
    if not ids or len(signatures) != len(ids):
        raise RuntimeError(f"No se pudieron resolver los pesos oficiales de {name}.")
    if os.environ.get("TORCH_HOME"):
        torch_home = Path(os.environ["TORCH_HOME"])
    elif os.environ.get("XDG_CACHE_HOME"):
        torch_home = Path(os.environ["XDG_CACHE_HOME"]) / "torch"
    else:
        torch_home = Path.home() / ".cache" / "torch"
    return ids, signatures, torch_home / "hub" / "checkpoints"


def cached_files(name: str) -> list[Path]:
    ids, signatures, checkpoint_dir = installed_remote_data(name)
    return [candidate for short_id in ids
            if (candidate := checkpoint_dir / signatures[short_id].rsplit("/", 1)[-1]).is_file()
            and candidate.stat().st_size > 1024]


def inventory():
    try:
        demucs_spec = importlib.util.find_spec("demucs")
        try:
            torch_version = importlib.metadata.version("torch")
        except importlib.metadata.PackageNotFoundError:
            torch_version = None
        if demucs_spec is None or not torch_version:
            print(json.dumps({name: {"installed": False, "cacheBytes": 0, "requiredFiles": 0} for name in MODEL_NAMES}))
            return 0
        result = {}
        diffq_available = importlib.util.find_spec("diffq") is not None
        for name in MODEL_NAMES:
            ids, _, _ = installed_remote_data(name)
            found = cached_files(name)
            dependency_available = name != "mdx_extra_q" or diffq_available
            result[name] = {
                "installed": len(found) == len(ids) and dependency_available,
                "weightsInstalled": len(found) == len(ids),
                "cacheBytes": sum(p.stat().st_size for p in found),
                "requiredFiles": len(ids),
                "dependencyAvailable": dependency_available,
                "dependencyError": None if dependency_available else "MDX-Extra-Q requires DiffQ. On Windows, DiffQ requires Microsoft C++ Build Tools to compile its extension."
            }
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


def has_diffq():
    print("available" if importlib.util.find_spec("diffq") is not None else "missing")


def check_size(name: str):
    ids, signatures, _ = installed_remote_data(name)
    def head_file(short_id: str):
        url = signatures[short_id]
        request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "AI-Music-Separator-Studio/0.1"})
        with urllib.request.urlopen(request, timeout=15) as response:
            size = int(response.headers.get("Content-Length", "0"))
        if size <= 0:
            raise RuntimeError(f"El servidor no indicó el tamaño del archivo {url.rsplit('/', 1)[-1]}.")
        return {"name": url.rsplit("/", 1)[-1], "bytes": size, "url": url}

    with ThreadPoolExecutor(max_workers=min(4, len(ids))) as pool:
        files = list(pool.map(head_file, ids))
    total = sum(item["bytes"] for item in files)
    print(json.dumps({"model": name, "bytes": total, "files": files, "source": "dl.fbaipublicfiles.com", "license": "MIT"}))


def install_model(name: str):
    if name == "mdx_extra_q" and importlib.util.find_spec("diffq") is None:
        raise RuntimeError("MDX-Extra-Q necesita DiffQ. Instala Microsoft C++ Build Tools y después ejecuta .venv\\Scripts\\python.exe -m pip install diffq==0.2.4.")
    torch, pretrained = load_demucs()
    ids, signatures = get_model_signatures(name, pretrained)
    missing = [short_id for short_id in ids if not (Path(torch.hub.get_dir()) / "checkpoints" / signatures[short_id].rsplit("/", 1)[-1]).exists()]
    print(f"Preparando {name}: {len(missing)} archivo(s) pendiente(s) desde dl.fbaipublicfiles.com", flush=True)
    model = pretrained.get_model(name=name)
    del model
    gc.collect()
    if hasattr(torch, "cuda") and torch.cuda.is_available():
        torch.cuda.empty_cache()
    installed = cached_files(name)
    if len(installed) != len(ids):
        raise RuntimeError(f"Descarga incompleta: se encontraron {len(installed)} de {len(ids)} archivos.")
    print(f"Modelo {name} instalado y comprobado ({sum(p.stat().st_size for p in installed)} bytes).", flush=True)


def remove_model(name: str):
    ids, signatures, checkpoint_dir = installed_remote_data(name)
    shared = set()
    for other in MODEL_NAMES:
        if other == name:
            continue
        other_ids, _, _ = installed_remote_data(other)
        shared.update(other_ids)
    removed = []
    freed = 0
    for short_id in ids:
        if short_id in shared:
            continue
        file_path = checkpoint_dir / signatures[short_id].rsplit("/", 1)[-1]
        if file_path.is_file():
            size = file_path.stat().st_size
            file_path.unlink()
            removed.append(file_path.name)
            freed += size
    print(json.dumps({"model": name, "removed": removed, "freedBytes": freed}, ensure_ascii=False))


def separate(args):
    torch, _ = load_demucs()
    threads = 6 if args.threads == 6 else 4
    torch.set_num_threads(threads)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    os.environ["OMP_NUM_THREADS"] = str(threads)
    os.environ["MKL_NUM_THREADS"] = str(threads)
    from demucs.separate import main as demucs_main

    output_args = {
        "pcm16": [],
        "pcm24": ["--int24"],
        "float32": ["--float32"],
    }[args.output_format]
    command = [
        "-d", "cpu", "-n", args.model, "-j", "1", "--shifts", args.shifts,
        "--overlap", args.overlap, *output_args, "-o", args.output, args.input,
    ]
    print(
        f"Modelo: {args.model}; CPU; hilos: {threads}; jobs: 1; "
        f"shifts: {args.shifts}; overlap: {args.overlap}; salida: {args.output_format}; "
        f"refinamiento: {args.silence_refinement}",
        flush=True,
    )
    demucs_main(command)
    gc.collect()
    from stem_refinement import refine_demucs_output
    print("Refinamiento: analizando silencios…", flush=True)
    refinement = refine_demucs_output(args.output, args.model, args.input, args.silence_refinement)
    print(
        "Refinamiento de silencio: "
        f"{refinement['mode']}; {refinement.get('maskedSeconds', 0)} s ajustados; "
        f"originales conservados: {refinement['nonDestructive']}",
        flush=True,
    )
    gc.collect()


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("inventory")
    subparsers.add_parser("has-diffq")
    for command in ("size", "install", "has-model", "remove"):
        sub = subparsers.add_parser(command)
        sub.add_argument("model", choices=MODEL_NAMES)
    sep = subparsers.add_parser("separate")
    sep.add_argument("--input", required=True)
    sep.add_argument("--output", required=True)
    sep.add_argument("--model", required=True, choices=MODEL_NAMES)
    sep.add_argument("--threads", type=int, default=4, choices=(4, 6))
    sep.add_argument("--shifts", default="0")
    sep.add_argument("--overlap", default="0.25")
    sep.add_argument("--output-format", default="pcm16", choices=("pcm16", "pcm24", "float32"))
    sep.add_argument("--silence-refinement", default="off", choices=REFINEMENT_MODES)
    refine = subparsers.add_parser("refine")
    refine.add_argument("--manifest", required=True)
    refine.add_argument("--output", required=True)
    refine.add_argument("--mode", choices=REFINEMENT_MODES, required=True)
    args = parser.parse_args()
    try:
        if args.command == "inventory":
            return inventory()
        if args.command == "has-diffq":
            has_diffq()
        if args.command == "size":
            check_size(args.model)
        elif args.command == "install":
            install_model(args.model)
        elif args.command == "remove":
            remove_model(args.model)
        elif args.command == "has-model":
            ids, _, _ = installed_remote_data(args.model)
            found = cached_files(args.model)
            dependency_available = args.model != "mdx_extra_q" or importlib.util.find_spec("diffq") is not None
            print("installed" if len(found) == len(ids) and dependency_available else "not-installed")
        elif args.command == "separate":
            separate(args)
        elif args.command == "refine":
            from stem_refinement import refine_manifest
            report = refine_manifest(Path(args.manifest), Path(args.output), args.mode)
            print(f"Refinamiento terminado: {report['maskedSeconds']} s revisados.", flush=True)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
