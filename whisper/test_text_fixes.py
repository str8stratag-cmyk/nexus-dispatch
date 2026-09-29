"""Unit tests for whisper/text_fixes.py (no Whisper model needed).

Run:  python whisper/test_text_fixes.py
Cases are real 2026-09-25 fleet transcripts plus negative controls.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from text_fixes import EXTRA_HOMOPHONE_FIXES, is_blocklisted_chunk, strip_trailing_signoff  # noqa: E402


def fix(text: str) -> str:
    for pattern, replacement in EXTRA_HOMOPHONE_FIXES:
        text = pattern.sub(replacement, text)
    return text


CASES = [
    # --- real excerpts (2026-09-25 call review / stored calls) ---
    ("You're holding a single floor with an injury, crispy downs, and sour, and fine.",
     "You're holding a Signal 4 with an injury, Bruce B Downs, and sour, and fine."),
    ("3-3-1, copy of Shingle 4.", "3-3-1, copy of Signal 4."),
    ("Number three, one copy of single four and I'm interested.",
     "Number three, one copy of Signal 4 and I'm interested."),
    ("Can you pop your single for no injuries at Florida and Jackson?",
     "Can you pop your Signal 4 no injuries at Florida and Jackson?".replace("Signal 4 no", "Signal 4 no")),
    ("You can hear my first transmission, single 50 on North Road.",
     "You can hear my first transmission, Signal 50 on North Road."),
    ("I guess you didn't hear my first transmission, uh, single-fifty on-",
     "I guess you didn't hear my first transmission, uh, Signal 50 on-"),
    ("copy symbol 28 at the district", "copy Signal 28 at the district"),
    ("holding a single twenty day shift", "holding a Signal 20 day shift"),
    ("Signal 4 at Bruce Viana, I'll bring my part 10-8",
     "Signal 4 at Bruce B Downs, I'll bring my part 10-8"),
    ("signal 4 at bricey downs and fowler", "signal 4 at Bruce B Downs and fowler"),
    ("signal 4 at bruce be downs", "signal 4 at Bruce B Downs"),
    ("It's going to be a floor attack. Robert, Sam, Victor, two seven.",
     "It's going to be a Florida tag. Robert, Sam, Victor, two seven."),
    ("It's going to be a Kansas attack, 5-1-8-7.", "It's going to be a Florida tag, 5-1-8-7."),
    ("running a floor tag on it", "running a Florida tag on it"),
    ("First beat out was in Tampa Ponds.", "First beat out was in Tampa Palms."),
    ("Signal 4 and something in the LS drive.", "Signal 4 and something in the Ellis Dr"),
    ("south end at 2908 L.S. Drive", "south end at 2908 Ellis Dr"),
    ("crash at del mabry and columbus", "crash at Dale Mabry and columbus"),
    # --- negatives: must be unchanged ---
    ("single car crash on the ramp", None),
    ("we have a single unit on scene", None),
    ("a single 2 car garage", None),
    ("she lives in a single floor home", None),
    ("single-family residence, single 4-door sedan", None),
    ("he was single for years", None),
    ("I'm single for you", None),
    ("a single five dollar bill", None),
    ("single occupant vehicle", None),
    ("that's a single story house", None),
    ("the floor is clean", None),
    ("bruce is on scene, the car is upside down", None),
    ("ups and downs all morning", None),
    ("Florida Avenue and Busch", None),
    ("attack on the floor", None),
    ("tampa police", None),
    ("els drive", None),
]

BLOCK_CASES = [
    ("Thank you.", True),
    ("thank you", True),
    ("Thank you very much.", True),
    ("Thank you so much!", True),
    ("I'll see you in the next one.", True),
    ("I\u2019ll see you in the next one.", True),
    ("We'll see you next week.", True),
    ("We'll be right back.", True),
    ("Thank you, Gabby.", False),
    ("Thank you. Good job.", False),
    ("Thank you very much. 10-4, Signal 4 at Florida and Busch.", False),
    ("Thank you. Thank you.", False),
    ("Bye.", False),
    ("2320 Westchester, 2320 Westchester", False),
    # --- repeated/looped hallucinations, no legitimate-repeat exception (2026-09-28) ---
    ("We'll be right back. We'll be right back.", True),
    ("We'll be right back.", True),
    ("We'll be right back. We'll be right back. We'll be right back.", True),
    ("One night till you're over, can't I get out of here? One night till you're over, can't I get out?", True),
    ("One night till you're over, can't I get out of here?", True),
    ("One night till you're over, can't I get out?", True),
    ("I'll be right back.", True),
    ("I'll be right back. I'll be right back.", True),
    ("We'll be right back. I'll be right back.", True),
    ("Get out of here!", True),
    ("Get out of here! We'll be right back.", True),
    ("Thanks for tuning in!", True),
    ("Thank you so much for tuning in.", True),
    ("Bye-bye!", True),
    # negative: real speech must never match just because it contains these words
    ("We'll be right back after we clear this scene.", False),
    ("Copy, we'll be right back, Henry 4.", False),
    ("I'll be right back at the station in ten.", False),
    ("Everybody get out of here, structure fire.", False),
    # --- sign-offs (2026-09-25: D3 let "I'll see you on the next one. Bye." through) ---
    ("I'll see you on the next one. Bye.", True),
    ("I\u2019ll see you on the next one, bye bye!", True),
    ("I'll see you in the next one.", True),
    ("See you in the next video.", True),
    ("We'll see you next time.", True),
    ("see you next time", True),
    ("See you guys next time. Bye!", True),
    ("Bye bye.", True),
    ("Bye-bye!", True),
    ("bye, bye, bye", True),
    ("Thanks for watching!", True),
    ("Thank you for watching.", True),
    ("Thank you so much for watching. Bye.", True),
    ("Thanks for tuning in.", True),
    ("Thank you so much for tuning in!", True),
    ("Please subscribe.", True),
    ("Like and subscribe!", True),
    ("Don't forget to like and subscribe.", True),
    ("Thanks for watching, please subscribe, see you next time. Bye.", True),
    ("  THANKS FOR WATCHING  ", True),
    # negative: real dispatch speech containing "bye" / "see you"
    ("unit 12 I'll see you on scene", False),
    ("Unit 12, I'll see you on scene.", False),
    ("I'll see you at Florida and Busch.", False),
    ("Copy, see you next time.", False),
    ("Okay, bye bye.", False),
    ("Bye, Henry 4.", False),
    ("Tell him bye and clear the scene.", False),
    ("10-4, I'll see you in the next one hour at 30th Street.", False),
    ("Thanks for watching the door, Kilo 71.", False),
    ("Subscriber called in a Signal 4 at Fowler.", False),
]

STRIP_CASES = [
    # (input, expected after strip_trailing_signoff)
    ("10-4. Thanks for watching!", "10-4."),
    ("Signal 4 at Busch and 30th. I'll see you in the next one. Bye.", "Signal 4 at Busch and 30th."),
    ("Clear, thanks for watching, please subscribe.", "Clear,"),
    ("Henry 5 copy. Like and subscribe!", "Henry 5 copy."),
    # untouched
    ("unit 12 I'll see you on scene", "unit 12 I'll see you on scene"),
    ("Copy, see you next time.", "Copy, see you next time."),
    ("Okay, bye bye.", "Okay, bye bye."),
    ("Thanks for watching the door, Kilo 71.", "Thanks for watching the door, Kilo 71."),
    ("I thanks for watching", "I thanks for watching"),
]


def main() -> int:
    failures = 0
    for text, expected in CASES:
        want = text if expected is None else expected
        got = fix(text)
        if got != want:
            failures += 1
            print(f"FAIL fix: {text!r}\n   got:  {got!r}\n   want: {want!r}")
    for text, expected in BLOCK_CASES:
        if is_blocklisted_chunk(text) != expected:
            failures += 1
            print(f"FAIL blocklist: {text!r} expected {expected}")
    for text, want in STRIP_CASES:
        got = strip_trailing_signoff(text)
        if got != want:
            failures += 1
            print(f"FAIL strip: {text!r}\n   got:  {got!r}\n   want: {want!r}")
    total = len(CASES) + len(BLOCK_CASES) + len(STRIP_CASES)
    print(f"{total - failures}/{total} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
