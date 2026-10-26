"""GPU launcher for the UNMODIFIED fleet whisper_service.py (dispatch-monitor/whisper).

Same API as the fleet (:8178 POST /transcribe multipart 'audio' + 'prompt',
GET /health, X-Whisper-Key). Only differences: device=cuda, compute_type
float16 with automatic fallback to int8_float16, and model medium.en by
default (Zach 2026-10-22 7:48 PM: this RTX 2060 desk only; rest of fleet stays
small.en). Allowed: medium.en, small.en. turbo/large are refused.
"""
import argparse
import importlib
import os
import site
import sys
import traceback
from pathlib import Path

ALLOWED = {"medium.en", "small.en"}
DEFAULT_MODEL = "medium.en"


def add_nvidia_dll_dirs() -> None:
    """pip nvidia-cublas-cu12 / nvidia-cudnn-cu12 put DLLs in site-packages/nvidia/*/bin."""
    roots = [Path(p) for p in site.getsitepackages()] + [Path(site.getusersitepackages())]
    for root in roots:
        nv = root / "nvidia"
        if not nv.is_dir():
            continue
        for bin_dir in nv.glob("*/bin"):
            os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")
            if hasattr(os, "add_dll_directory"):
                os.add_dll_directory(str(bin_dir))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--app-dir", required=True, help="dispatch-monitor\\whisper")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8178)
    ap.add_argument("--compute-types", default="float16,int8_float16")
    args = ap.parse_args()

    model = (os.getenv("WHISPER_MODEL") or DEFAULT_MODEL).strip().lower()
    if model not in ALLOWED:
        print(f"[gpu-launch] model '{model}' not allowed on this desk; using {DEFAULT_MODEL}", flush=True)
        model = DEFAULT_MODEL
    os.environ["WHISPER_MODEL"] = model
    os.environ["WHISPER_DEVICE"] = "cuda"
    os.environ.setdefault("WHISPER_BEAM_SIZE", "5")
    os.environ.setdefault("WHISPER_BEST_OF", "5")

    add_nvidia_dll_dirs()
    sys.path.insert(0, args.app_dir)

    service = None
    for ct in [c.strip() for c in args.compute_types.split(",") if c.strip()]:
        os.environ["WHISPER_COMPUTE_TYPE"] = ct
        try:
            sys.modules.pop("whisper_service", None)
            service = importlib.import_module("whisper_service")  # loads WhisperModel at import
            print(f"[gpu-launch] loaded {model} on cuda compute_type={ct} "
                  f"beam={os.environ['WHISPER_BEAM_SIZE']}", flush=True)
            break
        except Exception:
            print(f"[gpu-launch] compute_type={ct} failed:\n{traceback.format_exc()}", flush=True)
    if service is None:
        print("[gpu-launch] FATAL: no CUDA compute type worked (check driver / cuDNN 9). "
              "Not falling back to CPU silently; exit 2.", flush=True)
        return 2

    import uvicorn
    uvicorn.run(service.app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
