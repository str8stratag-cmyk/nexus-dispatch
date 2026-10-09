import { useState, useEffect, useCallback, useRef } from "react";

interface UseAudioCaptureOptions {
  deviceId?: string;
  keywords?: string[];
  onTranscript?: (text: string, isFinal: boolean, meta?: { audioStartedAt?: number; audioEndedAt?: number }) => void;
}

export interface AudioCaptureHealth {
  /** ms epoch when the current capture started, 0 when not capturing. */
  startedAt: number;
  /** ms epoch when the recorder last finished a chunk, 0 if none yet. */
  lastChunkAt: number;
  /** ms epoch of the last successful Whisper POST, 0 if none yet. */
  lastSentAt: number;
  /** Chunks dropped because Whisper was two chunks behind (since page load). */
  droppedChunks: number;
}

interface UseAudioCaptureReturn {
  isCapturing: boolean;
  rms: number;
  error: string | null;
  devices: MediaDeviceInfo[];
  start: () => Promise<void>;
  stop: () => void;
  refreshDevices: () => Promise<void>;
  /** Snapshot of pipeline progress for the capture supervisor (audio-panel). */
  getHealth: () => AudioCaptureHealth;
  supported: boolean;
}

// Recording chunk length. Per-box override via VITE_CHUNK_MS in the untracked
// repo-root .env.local (restart the app after changing it). Longer chunks cut
// fewer words at chunk boundaries at the cost of latency; CPU per second of
// audio is unchanged. Out-of-range or missing values use the fleet default.
const DEFAULT_CHUNK_MS = 4_000;
function parseChunkMs(raw: unknown): number {
  const value = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(value) && value >= 2_000 && value <= 15_000 ? value : DEFAULT_CHUNK_MS;
}
export const CHUNK_DURATION_MS = parseChunkMs(import.meta.env.VITE_CHUNK_MS);
const WHISPER_SERVICE_URL = import.meta.env.VITE_WHISPER_SERVICE_URL || "http://127.0.0.1:8178";
const WHISPER_API_KEY = import.meta.env.VITE_WHISPER_API_KEY;

// Chunks whose average RMS falls below this are treated as silence and never
// sent to Whisper. Mic gain differs per box, so it is configurable via an
// untracked per-box setting: VITE_SILENCE_RMS in the repo-root .env.local
// (read at app start; restart the app after changing it). Invalid or missing
// values fall back to the fleet default.
const DEFAULT_SILENCE_RMS = 0.015;
function parseSilenceRms(raw: unknown): number {
  const value = typeof raw === "string" ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(value) && value > 0 && value < 1 ? value : DEFAULT_SILENCE_RMS;
}
const SILENCE_RMS = parseSilenceRms(import.meta.env.VITE_SILENCE_RMS);

// Raw capture: the browser's voice-call processing (echo cancellation, noise
// suppression, auto gain) mangles radio audio and pumps the level the silence
// gate measures. Applied fleet-wide; previously a local edit on every box.
const RAW_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export function useAudioCapture(options: UseAudioCaptureOptions = {}): UseAudioCaptureReturn {
  const { deviceId, keywords = [], onTranscript } = options;
  const [isCapturing, setIsCapturing] = useState(false);
  const [rms, setRms] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [supported, setSupported] = useState(true);

  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderTimerRef = useRef<number | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  // Serialize transcriptions and bound the backlog — firing every 4s chunk
  // without waiting piled concurrent /transcribe calls onto Whisper until
  // its threadpool wedged and the browser showed "Failed to fetch"
  // (2026-09-17 pileup on DISP-4). At ~7s CPU per chunk, sustained room
  // audio outproduces the service, so drop the oldest new chunk rather than
  // queue without bound; addresses get re-transmitted on later chunks.
  const transcribeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const transcribePendingRef = useRef(0);
  const droppedChunksRef = useRef(0);
  // Consecutive /transcribe failures — 3+ in a row means the local Whisper
  // service is down/wedged, not a transient blip (2026-09-18: DISP-1's
  // Whisper hung for 16h before anyone noticed). Surface a persistent,
  // unmistakable error so the operator fixes the box instead of trusting
  // a silently dead capture.
  const transcribeFailStreakRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const isCapturingRef = useRef(false);
  const startRecordingRef = useRef<() => void>(() => undefined);
  const startingRef = useRef(false);
  // Bumped on every teardown: a chunk finishing after a stop/restart must not
  // chain a second recorder onto the new session's stream.
  const sessionRef = useRef(0);
  const startedAtRef = useRef(0);
  const lastChunkAtRef = useRef(0);
  const lastSentAtRef = useRef(0);
  // Keywords and device are read through refs so transcribe/start keep a
  // stable identity. Before 2026-10-03 `keywords` was a fresh array on every
  // render, so start() changed identity every render and the auto-start
  // effect in audio-panel was cancelled by the very next re-render while it
  // was still in flight -- after a reload capture often never came back.
  const keywordsRef = useRef(keywords);
  keywordsRef.current = keywords;
  const deviceIdRef = useRef(deviceId);
  deviceIdRef.current = deviceId;
  const teardownRef = useRef<(reason: string | null) => void>(() => undefined);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && "MediaRecorder" in window);
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const deviceList = await navigator.mediaDevices.enumerateDevices();
      setDevices(deviceList.filter((device) => device.kind === "audioinput"));
    } catch (err) {
      console.error("Failed to enumerate devices:", err);
    }
  }, []);

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  const transcribe = useCallback(async (audio: Blob, isSilent: boolean, times?: { audioStartedAt: number; audioEndedAt: number }) => {
    if (audio.size === 0) return;
    if (isSilent) return;

    const form = new FormData();
    form.set("audio", audio, "dispatch.webm");
    // Keep this prompt generic. Whisper treats initial_prompt as prior context and
    // will hallucinate a concrete call example into unrelated audio.
    const kw = keywordsRef.current;
    form.set(
      "prompt",
      kw.length ? `Dispatch radio terminology: ${kw.join(", ")}.` : "Dispatch radio terminology."
    );

    try {
      const headers: Record<string, string> = {};
      if (WHISPER_API_KEY) headers["X-Whisper-Key"] = WHISPER_API_KEY;
      const response = await fetch(`${WHISPER_SERVICE_URL}/transcribe`, { method: "POST", body: form, headers });
      const result = await response.json() as { text?: string; message?: string };
      if (!response.ok) {
        throw new Error(result.message || "Local Whisper transcription failed.");
      }
      lastSentAtRef.current = Date.now();
      if (result.text?.trim()) {
        onTranscriptRef.current?.(result.text.trim(), true, times);
      }
      // A successful POST means Whisper is back: clear the failure banner,
      // not just the counter (the "NOT RESPONDING" message used to stick).
      if (transcribeFailStreakRef.current > 0) setError(null);
      transcribeFailStreakRef.current = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Local Whisper transcription failed.";
      console.error(message);
      transcribeFailStreakRef.current += 1;
      if (transcribeFailStreakRef.current >= 3) {
        setError(
          `Local Whisper is NOT RESPONDING (${transcribeFailStreakRef.current} consecutive failures) — ` +
          "capture is running but nothing is being transcribed. Restart Whisper/the watchdog on this machine, then Stop+Start Capture."
        );
      } else {
        setError(message);
      }
    }
  }, []);

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || !isCapturingRef.current) return;
    const session = sessionRef.current;

    // A recorder that cannot be created (ended/invalid stream) used to throw
    // inside the previous chunk's onstop and silently end the chunk chain
    // while the UI still said "capturing". Tear down instead, so the
    // supervisor sees capture stopped and restarts it.
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    } catch (err) {
      console.error("MediaRecorder could not start:", err);
      teardownRef.current("Recorder failed to start — restarting capture automatically.");
      return;
    }
    const chunks: Blob[] = [];
    let peakRms = 0;
    // Wall-clock span of this chunk's audio (same clock as the app server on
    // this desk). Sent with the call so events/quarantine can record WHEN it
    // was said, not when the server finished processing it.
    let chunkStartedAt = Date.now();
    recorderRef.current = recorder;

    const sampleRms = () => {
      const currentRms = analyserRef.current ? (() => {
        const data = new Uint8Array(analyserRef.current.fftSize);
        analyserRef.current.getByteTimeDomainData(data);
        const sumSquares = data.reduce((sum, value) => {
          const normalized = (value - 128) / 128;
          return sum + normalized * normalized;
        }, 0);
        return Math.sqrt(sumSquares / data.length);
      })() : 0;
      if (currentRms > peakRms) peakRms = currentRms;
      return currentRms;
    };

    const rmsInterval = window.setInterval(sampleRms, 200);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = (event) => {
      console.error("MediaRecorder error:", event);
      clearInterval(rmsInterval);
      if (sessionRef.current === session) {
        teardownRef.current("Recorder error — restarting capture automatically.");
      }
    };
    recorder.onstop = () => {
      if (recorderRef.current === recorder) {
        recorderRef.current = null;
        recorderTimerRef.current = null;
      }
      clearInterval(rmsInterval);
      const chunkEndedAt = Date.now();
      lastChunkAtRef.current = chunkEndedAt;
      // Gate on the chunk's PEAK sample, not the average (2026-09-30 call
      // review: a real Signal 4 was almost missed because a short, loud
      // transmission inside an otherwise-quiet 4s chunk got diluted below
      // the average threshold — the whole chunk would have been dropped
      // before ever reaching Whisper). A chunk is silent only if even its
      // loudest 200ms sample stayed under the gate; this only ever sends
      // MORE audio to Whisper than the old average-based gate did, never less.
      // If the AudioContext is not running (Chrome autoplay policy can keep
      // a gesture-less context suspended) the analyser reads flat zero, which
      // would gate EVERY chunk as silence while the UI shows capturing. Send
      // the audio instead of dropping it when the meter can't be trusted.
      const meterLive = audioContextRef.current?.state === "running";
      const isSilent = meterLive && peakRms < SILENCE_RMS;
      const blob = new Blob(chunks, { type: "audio/webm" });
      if (transcribePendingRef.current < 2) {
        transcribePendingRef.current += 1;
        transcribeQueueRef.current = transcribeQueueRef.current
          .then(() => transcribe(blob, isSilent, { audioStartedAt: chunkStartedAt, audioEndedAt: chunkEndedAt }))
          .finally(() => {
            transcribePendingRef.current -= 1;
          });
      } else {
        // Whisper is two chunks behind: this chunk is dropped. It used to vanish
        // silently; count it so a missing call can be traced (heartbeat counters).
        droppedChunksRef.current += 1;
        console.warn(`Chunk dropped: Whisper is behind (${droppedChunksRef.current} dropped since page load)`);
      }
      // Dropping a saturated chunk must NOT skip this — it schedules the
      // next recording chunk; returning early here silently kills capture.
      if (isCapturingRef.current && sessionRef.current === session) startRecordingRef.current();
    };
    try {
      recorder.start();
      chunkStartedAt = Date.now();
    } catch (err) {
      console.error("MediaRecorder.start failed:", err);
      clearInterval(rmsInterval);
      teardownRef.current("Recorder failed to start — restarting capture automatically.");
      return;
    }
    recorderTimerRef.current = window.setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, CHUNK_DURATION_MS);
  }, [transcribe]);
  startRecordingRef.current = startRecording;

  // Release everything. `reason` set = an unexpected pipeline failure (shown
  // to the operator; the audio-panel supervisor restarts capture).
  const teardown = useCallback((reason: string | null) => {
    sessionRef.current += 1;
    isCapturingRef.current = false;
    startedAtRef.current = 0;
    if (recorderTimerRef.current) {
      clearTimeout(recorderTimerRef.current);
      recorderTimerRef.current = null;
    }
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state === "recording") {
      try { recorder.stop(); } catch { /* already stopped */ }
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    streamRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    analyserRef.current = null;
    setRms(0);
    setIsCapturing(false);
    if (reason) setError(reason);
  }, []);
  teardownRef.current = teardown;

  const start = useCallback(async () => {
    if (isCapturingRef.current || startingRef.current) return;
    setError(null);
    if (!supported) {
      const message = "Audio recording is not supported in this browser. Use Chrome or Edge.";
      setError(message);
      throw new Error(message);
    }

    startingRef.current = true;
    try {
      const deviceId = deviceIdRef.current;
      const constraints: MediaStreamConstraints = {
        audio: deviceId
          ? { ...RAW_AUDIO_CONSTRAINTS, deviceId: { exact: deviceId } }
          : { ...RAW_AUDIO_CONSTRAINTS },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      // Mic released underneath us (device unplugged, Chrome revoked/reset
      // the capture, driver hiccup): tear down so the supervisor restarts.
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          if (streamRef.current === stream) {
            teardownRef.current("Microphone stream ended — restarting capture automatically.");
          }
        };
      });

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      // Gesture-less starts (auto-capture after a reload) may leave the
      // context suspended under Chrome's autoplay policy; try to resume, and
      // resume on the first click/key if it stays suspended. The silence gate
      // fails open while it is suspended (see recorder.onstop).
      if (audioContext.state !== "running") {
        void audioContext.resume().catch(() => undefined);
        const resumeOnGesture = () => {
          void audioContext.resume().catch(() => undefined);
        };
        window.addEventListener("pointerdown", resumeOnGesture, { once: true });
        window.addEventListener("keydown", resumeOnGesture, { once: true });
      }
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      analyserRef.current = analyser;

      const data = new Uint8Array(analyser.fftSize);
      const updateRms = () => {
        analyser.getByteTimeDomainData(data);
        const sumSquares = data.reduce((sum, value) => {
          const normalized = (value - 128) / 128;
          return sum + normalized * normalized;
        }, 0);
        setRms(Math.sqrt(sumSquares / data.length));
        rafRef.current = requestAnimationFrame(updateRms);
      };
      updateRms();

      isCapturingRef.current = true;
      startedAtRef.current = Date.now();
      lastChunkAtRef.current = 0;
      startRecording();
      if (!isCapturingRef.current) {
        throw new Error("Recorder failed to start.");
      }
      setIsCapturing(true);
      void refreshDevices();
    } catch (err: unknown) {
      // Release a half-built pipeline (mic acquired but recorder failed) so
      // the next attempt starts clean and Chrome's mic indicator is truthful.
      teardownRef.current(null);
      const message = err instanceof Error ? err.message : "Failed to access microphone.";
      const inIframe = typeof window !== "undefined" && window.self !== window.top;
      if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
        setError(inIframe
          ? "Microphone access is blocked in this preview. Open the app in a new tab."
          : "Microphone access was denied. Allow it in the browser settings.");
      } else {
        setError(message);
      }
      console.error("Audio capture error:", err);
      throw err;
    } finally {
      startingRef.current = false;
    }
  }, [refreshDevices, startRecording, supported]);

  const stop = useCallback(() => teardown(null), [teardown]);

  const getHealth = useCallback((): AudioCaptureHealth => ({
    startedAt: startedAtRef.current,
    lastChunkAt: lastChunkAtRef.current,
    lastSentAt: lastSentAtRef.current,
    droppedChunks: droppedChunksRef.current,
  }), []);

  // Unmount (and React Fast Refresh, which re-runs effects) releases the mic.
  // Capture coming back afterwards is the audio-panel supervisor's job.
  useEffect(() => stop, [stop]);

  return { isCapturing, rms, error, devices, start, stop, refreshDevices, getHealth, supported };
}
