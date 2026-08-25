# Local dispatch transcription

This service replaces browser speech recognition with local CPU `faster-whisper`.

1. Run `npm run whisper:setup` once. It installs Python if needed, creates `.venv-whisper`, installs the runtime, and downloads `medium.en`.
2. Run `npm run whisper:start` in a separate terminal.
3. Run the app locally with `npm run dev`.

`medium.en` with CPU `int8` is the primary high-accuracy profile for one or two radio feeds on a 32 GB device. To use a smaller, faster model, run `npm run whisper:setup -- -Model small.en` and set `WHISPER_MODEL=small.en` before starting the service.

The browser sends live audio directly to the loopback Whisper service, so the existing deployed app works as long as the service is running on the capture device. The app sends its live keyword list to Whisper as a dispatch-domain prompt on every audio chunk. Add call signs, street names, agencies, unit numbers, and common radio phrases in **Settings → Keywords**; include likely mishearings as separate patterns. This improves recognition context and preserves the existing keyword normalization.

This is vocabulary adaptation, not model fine-tuning. True fine-tuning needs a held-out, manually transcribed set of representative recordings and should only be evaluated after collecting enough correctly labeled calls to measure an improvement over this baseline.

Run `npm run whisper:bundle` after setup to create a USB-ready offline bundle on the Desktop. It includes the model cache and Python dependency wheels but never includes app credentials.
