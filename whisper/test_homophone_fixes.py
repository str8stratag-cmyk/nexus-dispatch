"""Unit tests for the always-on HOMOPHONE_FIXES in whisper/whisper_service.py.

Loads only the HOMOPHONE_FIXES list from the source (via ast), so neither
faster_whisper nor fastapi nor a Whisper model is needed.

Run:  python whisper/test_homophone_fixes.py
"""
import ast
import re
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent / "whisper_service.py"


def load_homophone_fixes():
    tree = ast.parse(SRC.read_text(encoding="utf-8"))
    for node in tree.body:
        target = None
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            target = node.target.id
        elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            target = node.targets[0].id
        if target == "HOMOPHONE_FIXES":
            expr = ast.Expression(node.value)
            return eval(compile(expr, str(SRC), "eval"), {"re": re})
    raise SystemExit("HOMOPHONE_FIXES not found in whisper_service.py")


FIXES = load_homophone_fixes()


def fix(text: str) -> str:
    for pattern, replacement in FIXES:
        text = pattern.sub(replacement, text)
    return text


CASES = [
    # 2026-10-01 real quarantine misses (near-verbatim)
    ("Signal 4, Barat Street and Armenian Avenue.", "Signal 4, Broad Street and Armenia Avenue."),
    ("304 East Tambler, 304 East Tambler.", "304 East Handler, 304 East Handler."),
    ("signal 4 at west barat", "signal 4 at west Broad"),
    ("signal 4 at Dale Labrie and Henderson", "signal 4 at Dale Mabry and Henderson"),
    # Anderson and Henderson are both real Tampa roads: Anderson is NOT rewritten
    ("signal 4 at Dale Labrie Anderson", "signal 4 at Dale Mabry Anderson"),
    # --- negatives: must be unchanged ---
    ("signal 4 at Dale Mabry and Anderson", None),
    ("officer Anderson on scene", None),
    ("they did it in broad daylight", None),
    ("caller is Mr. Barat, on scene", None),
    ("suspect described as an Armenian male", None),
    ("the k9 handler is on scene", None),
]


def main() -> int:
    fails = 0
    for text, want in CASES:
        want = text if want is None else want
        got = fix(text)
        if got != want:
            fails += 1
            print(f"FAIL: {text!r}\n   got:  {got!r}\n   want: {want!r}")
    print(f"{len(CASES) - fails}/{len(CASES)} passed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
