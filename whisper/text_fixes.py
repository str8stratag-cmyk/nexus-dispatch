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
    # "Dale may be" (2026-09-30, live in the DISP-5 quarantine queue). Only in
    # a street position, so a person named Dale ("Dale may be late") is left alone.
    (re.compile(r"\bdale\s+may\s+be\b(?=\s*(?:[,.;:!?]|$)|\s+(?:&|(?:and|at|highway|hwy|north|south|east|west|northbound|southbound|thank)\b))", re.IGNORECASE), "Dale Mabry"),
    # Lois Ave heard as "Wallace"/"Wallis" at Hillsborough Ave (2026-10-02,
    # DISP-1: radio "Signal 4 Hillsborough and Lois" -> "Hillsborough and
    # Wallace"). Only rewritten when directly paired with Hillsborough via
    # "and"/"&", in either order, so "Wallace" anywhere else (a surname,
    # "Hillsborough County ... Wallace") is left alone.
    (re.compile(r"\b(hillsborough\s+(?:and|&)\s+)(?:wallace|wallis)\b", re.IGNORECASE), r"\1Lois"),
    (re.compile(r"\b(?:wallace|wallis)(\s+(?:and|&)\s+hillsborough)\b", re.IGNORECASE), r"Lois\1"),
    # --- 2026-10-02 quarantine review (187 items, 2026-09-30..10-02). Each
    # rule below was confirmed against a manual / other-desk push of the same
    # call within +-10 min. Already handled on main and NOT repeated here:
    # "Dale Labrie", "Dale may be", "Tambler"->Handler, "Barat Street"/"West
    # Barat"->Broad, "Armenian Avenue"->Armenia, salmon/sellman/settlement->
    # Selmon (whisper_service.py HOMOPHONE_FIXES), "high park"->Hyde Park and
    # "maybury"/"mayberry" (shared/extract-address.ts). Deliberately NOT added:
    # Anderson/Peterson->Henderson (owner decision 2026-10-01, both are real
    # roads) and Handler->Hanlon ("Handler" is the user-confirmed name).
    #
    # Dale Mabry with "South" fused or garbled (DISP-1/5/7 2026-09-30 15:10,
    # confirmed by #1341): "Southdale, Mayberry", "Southdale, Avery",
    # "south deal bay", "south day of Adrian".
    (re.compile(r"\bsouth\s*dale,?\s+(?:mayberry|maybury|avery|bay)\b", re.IGNORECASE), "South Dale Mabry"),
    (re.compile(r"\bsouth\s+(?:deal|day\s+of)\s+(?:bay|adrian|mabry)\b", re.IGNORECASE), "South Dale Mabry"),
    # "Dale Magree and Peterson" / "down they bring in Anderson" (DISP-1/3
    # 2026-09-30 16:50; DISP-5 manual push #1364 "DALE MABRY AND HENDERSON").
    # The cross street is left as heard (see Anderson note above).
    (re.compile(r"\bdale\s+(?:magree|maybury|mayberry)\b", re.IGNORECASE), "Dale Mabry"),
    (re.compile(r"\bdown\s+they\s+bring\b", re.IGNORECASE), "Dale Mabry"),
    # Armenia Ave (2026-10-01, confirmed by #1376 and the 10-01 19:48 bike
    # crash): "Armanium" is not a word -> always Armenia. "Armenian" (a real
    # adjective) only when directly paired with a known Armenia Ave cross street
    # ("Armenian Broad", "Armenian and Waters", "Waters on Armenian") - never
    # "an Armenian male" / "Armenian community".
    (re.compile(r"\barmanium\b", re.IGNORECASE), "Armenia"),
    (re.compile(r"\barmenian(?=\s+(?:(?:and|&|at)\s+)?(?:broad|waters|hillsborough|columbus|kennedy|cypress|spruce|"
                r"sligh|busch|linebaugh|lambright|osborne|buffalo|mlk|martin|tampa\s+bay|swann|platt|main|"
                r"chestnut|fig|lemon|gray|azeele|bay\s+to\s+bay)\b)", re.IGNORECASE), "Armenia"),
    (re.compile(r"\b((?:broad|waters|hillsborough|columbus|kennedy|cypress|sligh|busch|linebaugh)\s+(?:and|&|at|on)\s+)armenian\b",
                re.IGNORECASE), r"\1Armenia"),
    # "Barat" for Broad when paired with Armenia (main already handles
    # "Barat Street" / "West Barat").
    (re.compile(r"\bbarat(?=\s+(?:and|&|at)\s+armenia)", re.IGNORECASE), "Broad"),
    (re.compile(r"\b(armenia(?:n)?(?:\s+(?:ave|avenue))?\s+(?:and|&|at)\s+)barat\b", re.IGNORECASE), r"\1Broad"),
    # Selmon Expressway (2026-10-01 08:48, confirmed by #1383 "SELMON
    # EXPRESSWAY AND 50TH STREET"): "Selman" (not in main's list) and
    # "Southern Express(way)" - the latter currently MIS-GEOCODES to Sulphur
    # Springs. "Southern" alone is a real word, so only with "express".
    (re.compile(r"\b(?:selman|southern)\s+express(?:\s*way)?\b", re.IGNORECASE), "Selmon Expressway"),
    (re.compile(r"\bselman\b", re.IGNORECASE), "Selmon"),
    # "Signal 4" heard as "signal for" (9 quarantined + 12 stored events),
    # only when an injury / report-type word follows - "signal for you" and
    # "signal for a bicycle" are left alone. "Siegel 4" (DISP-2 10-01 07:42).
    (re.compile(r"\bsignal\s+for(?=\s+(?:(?:an?|no|unknown|other|any)\s+)?(?:injur\w*|short[- ]form|long[- ]form)\b)",
                re.IGNORECASE), "Signal 4"),
    (re.compile(r"\b(?:siegel|seagull)\s+(?:4|four)\b", re.IGNORECASE), "Signal 4"),
    # Bayshore Blvd: two-word "Bay Shore" fails geocoding (DISP-1 09-30 18:49
    # "Bay Shore and Hyde Park"); "Space shore in Ganyan" = Bayshore & Gandy.
    (re.compile(r"\b(?:bay|space)\s+shore\b", re.IGNORECASE), "Bayshore"),
    # One-off confirmed calls: Spruce & Himes (#1452), Bruce B Downs (#1331),
    # 46th & Fowler (#1415), Platt St (#1373), 3415 W Hillsborough (#1428).
    (re.compile(r"\bspruce\s+(?:in|and|&)\s+(?:high|hines|hymes)\b", re.IGNORECASE), "Spruce and Himes"),
    (re.compile(r"\bbrew\s+speed\s+downs?\b", re.IGNORECASE), "Bruce B Downs"),
    (re.compile(r"\b(\d{1,3}(?:st|nd|rd|th))\s+(?:in|and|&)\s+pallor\b", re.IGNORECASE), r"\1 and Fowler"),
    (re.compile(r"\bplatte\b", re.IGNORECASE), "Platt"),
    (re.compile(r"\bhillsboro\b", re.IGNORECASE), "Hillsborough"),
    # Whisper fuses "Dale Mabry" into one word (2026-10-01 Cypress & Dale
    # Mabry call transcribed as "Cypress and Delmigras").
    (re.compile(r"\bdelmigras\b", re.IGNORECASE), "Dale Mabry"),
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


# Phrases that are hallucinations with NO legitimate-repeat exception (unlike
# "thank you", which real dispatchers can plausibly say twice \u2014 see the
# "Thank you. Thank you." negative case below and in test_text_fixes.py).
# Whisper tends to loop these, or emit two different ones back-to-back, in a
# single chunk (2026-09-28: "We'll be right back. We'll be right back." and a
# song-lyric hallucination emitted twice with slightly different endings), so
# unlike HALLUCINATION_BLOCKLIST's exact-single-phrase check, the WHOLE chunk
# is blocked when it's made up entirely of one-or-more of these, in any
# combination/order \u2014 never a partial phrase, never mixed with real speech.
REPEATABLE_HALLUCINATIONS = frozenset({
    "well be right back",
    "ill be right back",
    "get out of here",
    "one night till youre over cant i get out of here",
    "one night till youre over cant i get out",
})
_REPEATABLE_ALT = "|".join(
    re.escape(p) for p in sorted(REPEATABLE_HALLUCINATIONS, key=len, reverse=True)
)
REPEATABLE_WHOLE_RE = re.compile(rf"^(?:(?:{_REPEATABLE_ALT})\s*)+$")


# YouTube-style sign-offs Whisper hallucinates on near-silence. Matched
# case-insensitively with optional punctuation and trailing "bye"s.
_AP = "['\u2019]"
_SIGNOFF_NEXT_ONE = (
    rf"(?:(?:i|we)(?:{_AP}ll|\s+will)\s+)?see\s+(?:you|ya)\s+(?:guys\s+|all\s+)?"
    r"(?:in|on|at)\s+the\s+next\s+(?:one|video|episode|time)"
)
_SIGNOFF_NEXT_TIME = (
    rf"(?:(?:i|we)(?:{_AP}ll|\s+will)\s+)?see\s+(?:you|ya)\s+(?:guys\s+|all\s+)?"
    r"next\s+(?:time|week|video|one|episode)"
)
_SIGNOFF_WATCHING = r"(?:thanks|thank\s+you)(?:\s+(?:so|very)\s+much)?\s+for\s+watching"
# "Thanks for tuning in" (2026-09-28: TV/radio-outro chatter picked up like
# "thanks for watching") — same shape, different verb.
_SIGNOFF_TUNING_IN = r"(?:thanks|thank\s+you)(?:\s+(?:so|very)\s+much)?\s+for\s+tuning\s+in"
_SIGNOFF_SUBSCRIBE = (
    rf"(?:(?:please|and)\s+)?(?:(?:don{_AP}t|do\s+not)\s+forget\s+to\s+)?"
    r"(?:like(?:\s*(?:,|and|&)\s*)(?:comment(?:\s*(?:,|and|&)\s*))?)?"
    r"subscribe(?:\s+to\s+(?:my|our|the)\s+channel)?"
)
# Whole chunk = one or more sign-offs, optionally followed by "bye"s.
_SIGNOFF_ANY = "|".join(
    (_SIGNOFF_NEXT_ONE, _SIGNOFF_NEXT_TIME, _SIGNOFF_WATCHING, _SIGNOFF_TUNING_IN, _SIGNOFF_SUBSCRIBE)
)
SIGNOFF_WHOLE_RE = re.compile(
    rf"^\s*(?:(?:{_SIGNOFF_ANY})[\s,.!?-]*)+(?:bye[\s,.!?-]*)*$", re.IGNORECASE
)
# YouTube-style narration Whisper hallucinates on near-silence/noise
# (2026-10-01, DISP-5: a 158-char transcript from one 4s chunk, "So, I'm going
# to do a little bit of a quick look at the video and see how it loo[ks]...").
# Unlike the sign-offs above, these are matched ANYWHERE in the chunk and the
# whole chunk is dropped: the phrases are video-creator narration that does not
# occur in dispatch radio, and a chunk that produced one is hallucinated
# throughout. Each pattern is deliberately multi-word so ordinary radio talk
# about video evidence ("pull the surveillance video", "take a quick look at
# the video from the store", "the male in this video is...") never matches.
_VIDEO_NARRATION = (
    # "a little bit of a quick look at the video" (the DISP-5 hallucination)
    r"\ba\s+little\s+bit\s+of\s+a\s+quick\s+look\s+at\s+(?:the|this|my)\s+video\b",
    # "...look at the video and see how it looks" (editing-vlog narration)
    r"\blook\s+at\s+(?:the|this|my)\s+video\s+and\s+see\s+how\s+it\s+looks?\b",
    # "In this video, I'm going to show you..." / "In today's video we'll..."
    rf"\bin\s+(?:this|today{_AP}?s)\s+video\s*,?\s+(?:i|we)(?:{_AP}m|{_AP}re|{_AP}ll|\s+am|\s+are|\s+will)?\s+"
    r"(?:going\s+to|gonna|show|talk|take|be)\b",
    # "Welcome back to my channel"
    r"\bwelcome\s+back\s+to\s+(?:my|the|our)\s+channel\b",
)
VIDEO_NARRATION_RE = re.compile("|".join(_VIDEO_NARRATION), re.IGNORECASE)
# "Bye bye" (two or more) as the entire chunk. A single "Bye." is kept.
BYE_BYE_RE = re.compile(r"^\s*bye(?:[\s,.!?-]+bye)+[\s,.!?-]*$", re.IGNORECASE)
# Trailing strip: only the unmistakable YouTube phrases, and only after a
# sentence/clause break (. ! ? ,), so "see you" / "bye" mid-sentence and
# ordinary radio farewells ("10-4, see you next time") are never touched.
_SIGNOFF_STRONG = "|".join((_SIGNOFF_NEXT_ONE, _SIGNOFF_WATCHING, _SIGNOFF_TUNING_IN, _SIGNOFF_SUBSCRIBE))
SIGNOFF_TRAILING_RE = re.compile(
    rf"(?<=[.!?,])\s*(?:(?:{_SIGNOFF_STRONG})[\s,.!?-]*)+(?:bye[\s,.!?-]*)*$", re.IGNORECASE
)


def is_blocklisted_chunk(text: str) -> bool:
    """True when the ENTIRE chunk is a known hallucination / sign-off."""
    norm = _normalize_for_blocklist(text)
    if norm in HALLUCINATION_BLOCKLIST:
        return True
    if norm and REPEATABLE_WHOLE_RE.match(norm):
        return True
    if VIDEO_NARRATION_RE.search(text):
        return True
    return bool(SIGNOFF_WHOLE_RE.match(text) or BYE_BYE_RE.match(text))


def strip_trailing_signoff(text: str) -> str:
    """Remove a trailing YouTube-style sign-off that follows real speech."""
    return SIGNOFF_TRAILING_RE.sub("", text).rstrip()
