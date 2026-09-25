"""Opt-in transcript text fixes for whisper_service (2026-09-25).

Kept in a separate, model-free module so they can be unit-tested without
loading a Whisper model:  python whisper/test_text_fixes.py
"""
import re

# Extra fixes from the 2026-09-25 call review + ranked mis-hearings across
# all 2,085 stored events/quarantined calls (2026-09-11..25). Gated by
# WHISPER_EXTRA_FIXES=1. Order matters: the "Signal 4" rule runs before the
# "Florida tag" rule so "single floor" is claimed as a signal first.
_SIGNAL_WORDS = {
    "three": "3", "five": "5", "six": "6", "seven": "7", "twelve": "12",
    "thirteen": "13", "fourteen": "14", "fifteen": "15", "sixteen": "16",
    "twenty": "20", "thirty": "30", "fifty": "50", "eighty": "80",
}
# Words after "single <N>" that mean a real count, not a signal code.
_NOT_SIGNAL_AFTER = (
    r"(?![-\s]*(?:door|doors|story|stories|lane|lanes|family|car|cars|vehicle|"
    r"vehicles|unit|units|dollar|dollars|inch|inches|feet|foot|year|years|yr|"
    r"hour|hours|minute|minutes|mile|miles|percent|%|wide|person|people|room|"
    r"rooms|bed|beds|bedroom|shot|shots|round|rounds)\b)"
)
EXTRA_HOMOPHONE_FIXES: list[tuple[re.Pattern[str], str]] = [
    # "Signal 4" heard as single/shingle/symbol four|for|4|floor|flow (66 of
    # 2,085 stored transcripts). "for" followed by a pronoun/article is left
    # alone ("single for you"); "single floor home/house..." is a building.
    (re.compile(
        r"\b(?:single|shingle|symbol)[\s-]+(?:four|4|floor|flow|for(?!\s+(?:you|me|them|him|her|us|it|a|an|years?|months?|weeks?|days?|life|now|ever|long|good|so|the\s+(?:first|past|last|rest)|awhile|a\s+while)\b))\b"
        r"(?![-\s]*(?:home|house|building|residence|structure|apartment|dwelling|plan|door|doors)\b)",
        re.IGNORECASE), "Signal 4"),
    # "single 50" / "symbol 28" / "single-fifty" -> Signal N (1-2 digits or a
    # common signal number word), unless a count noun follows ("single 2 car").
    (re.compile(r"\b(?:single|shingle|symbol)[\s-]+(\d{1,2})\b" + _NOT_SIGNAL_AFTER, re.IGNORECASE),
     r"Signal \1"),
    (re.compile(r"\b(?:single|shingle|symbol)[\s-]+(" + "|".join(_SIGNAL_WORDS) + r")\b" + _NOT_SIGNAL_AFTER,
                re.IGNORECASE), lambda m: "Signal " + _SIGNAL_WORDS[m.group(1).lower()]),
    # Bruce B Downs Blvd (crispy/bricey/brucey downs, bruce viana, bruce be downs).
    (re.compile(r"\b(?:crispy|bricey|brucey|brucie)\s+downs\b", re.IGNORECASE), "Bruce B Downs"),
    (re.compile(r"\bbruce\s+(?:b|be|bee|v|vee|d|p)\.?\s+downs?\b", re.IGNORECASE), "Bruce B Downs"),
    (re.compile(r"\bbruce\s+downs\b", re.IGNORECASE), "Bruce B Downs"),
    (re.compile(r"\bbruce\s+vi(?:a|e)nn?a\b", re.IGNORECASE), "Bruce B Downs"),
    # Plate reads: "Florida tag" as floor/florida/kansas/flurry attack|tag|tech.
    (re.compile(r"\b(?:floor|florida|kansas|flurry)\s+(?:attack|tag|tech)\b", re.IGNORECASE), "Florida tag"),
    (re.compile(r"\btampa\s+ponds\b", re.IGNORECASE), "Tampa Palms"),
    (re.compile(r"\b(?:del|dell|dail|daily)\s+mabry\b", re.IGNORECASE), "Dale Mabry"),
    # "2908 S Ellis Dr" came out "LS drive" / "L.S. drive".
    (re.compile(r"\b(?:l\.?\s?s\.?|l-s)\s+(?:drive|dr)\b\.?", re.IGNORECASE), "Ellis Dr"),
]


# Whole-chunk hallucination blocklist (WHISPER_BLOCKLIST=1). Only an entire
# chunk that is exactly one of these phrases (case/punctuation-insensitive)
# is dropped; the phrase inside a longer transcript is kept, and repeated
# phrases are never collapsed (dispatchers repeat addresses on purpose).
HALLUCINATION_BLOCKLIST = frozenset({
    "thank you",
    "thank you very much",
    "thank you so much",
    "ill see you in the next one",
    "well see you next week",
    "well be right back",
})


def _normalize_for_blocklist(text: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9 ]+", "", text.lower().replace("\u2019", "'").replace("'", "")).split())


def is_blocklisted_chunk(text: str) -> bool:
    return _normalize_for_blocklist(text) in HALLUCINATION_BLOCKLIST
