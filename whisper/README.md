# Local dispatch transcription

This service replaces browser speech recognition with local CPU `faster-whisper`.

1. Run `npm run whisper:setup` once. It installs Python if needed, creates `.venv-whisper`, installs the runtime, and downloads `medium.en`.
2. Run `npm run whisper:start` in a separate terminal.
3. Run the app locally with `npm run dev`.

`medium.en` with CPU `int8` is the primary high-accuracy profile for one or two radio feeds on a 32 GB device. To use a smaller, faster model, run `npm run whisper:setup -- -Model small.en` and set `WHISPER_MODEL=small.en` before starting the service.

The browser sends live audio directly to the loopback Whisper service, so the existing deployed app works as long as the service is running on the capture device. The app sends its live keyword list to Whisper as a dispatch-domain prompt on every audio chunk. Add call signs, street names, agencies, unit numbers, and common radio phrases in **Settings → Keywords**; include likely mishearings as separate patterns. This improves recognition context and preserves the existing keyword normalization.

This is vocabulary adaptation, not model fine-tuning. True fine-tuning needs a held-out, manually transcribed set of representative recordings and should only be evaluated after collecting enough correctly labeled calls to measure an improvement over this baseline.

Run `npm run whisper:bundle` after setup to create a USB-ready offline bundle on the Desktop. It includes the model cache and Python dependency wheels but never includes app credentials.

## Per-box tuning keys (2026-09-25)

Put these in the untracked repo-root `whisper-model.local` (KEY=VALUE); `scripts/start-whisper.ps1`
forwards only whitelisted keys. Every default equals the previous hard-coded behavior.

| Key | Default | Effect |
|---|---|---|
| `WHISPER_BEAM_SIZE` / `WHISPER_BEST_OF` | 5 / 5 | Decoder beam; 2/2 roughly halves decode time on 2-core boxes |
| `WHISPER_NSP_THRESHOLD` | 0.5 | Drop a segment when no_speech_prob exceeds this |
| `WHISPER_CR_THRESHOLD` | 2.0 | Drop a segment when compression_ratio exceeds this (loops) |
| `WHISPER_EXTRA_FIXES` | off | Extra homophone fixes in `text_fixes.py` (single four -> Signal 4, crispy downs -> Bruce B Downs, ...) |
| `WHISPER_BLOCKLIST` | off | Drop a chunk whose ENTIRE text is a known hallucination ("Thank you.", "Thanks for watching!", "I'll see you in the next one. Bye.", "Bye bye.") and strip a trailing YouTube-style sign-off after real speech ("10-4. Thanks for watching!" -> "10-4."). Mid-sentence "see you"/"bye" is never touched. |
| `WHISPER_HOTWORDS` | off | faster-whisper hotwords; audit debug-audio sidecars for prompt echo before fleet use. `recommended` = built-in list (Signal 4, MacDill, McDill, Adamo, Orient, ...) |

`/health` reports the effective values. Tests: `python whisper/test_text_fixes.py`.
Client chunk length: `VITE_CHUNK_MS` (2000-15000, default 4000) in the untracked `.env.local`.
