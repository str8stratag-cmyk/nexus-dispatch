import { useState, useEffect, useCallback, useRef } from "react";

interface UseAudioCaptureOptions {
  deviceId?: string;
  keywords?: string[];
  onTranscript?: (text: string, isFinal: boolean) => void;
}

interface UseAudioCaptureReturn {
  isCapturing: boolean;
  rms: number;
  error: string | null;
  devices: MediaDeviceInfo[];
  start: () => Promise<void>;
  stop: () => void;
  refreshDevices: () => Promise<void>;
  supported: boolean;
}

const CHUNK_DURATION_MS = 8_000;
const WHISPER_SERVICE_URL = import.meta.env.VITE_WHISPER_SERVICE_URL || "http://127.0.0.1:8178";

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
  const rafRef = useRef<number | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const isCapturingRef = useRef(false);
  const startRecordingRef = useRef<() => void>(() => undefined);

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

  const transcribe = useCallback(async (audio: Blob) => {
    if (audio.size === 0) return;

    const form = new FormData();
    form.set("audio", audio, "dispatch.webm");
    form.set(
      "prompt",
      keywords.length ? `Dispatch radio terminology: ${keywords.join(", ")}.` : "Dispatch radio terminology."
    );

    try {
      const response = await fetch(`${WHISPER_SERVICE_URL}/transcribe`, { method: "POST", body: form });
      const result = await response.json() as { text?: string; message?: string };
      if (!response.ok) {
        throw new Error(result.message || "Local Whisper transcription failed.");
      }
      if (result.text?.trim()) {
        onTranscriptRef.current?.(result.text.trim(), true);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Local Whisper transcription failed.";
      console.error(message);
      setError(message);
    }
  }, [keywords]);

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || !isCapturingRef.current) return;

    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    const chunks: Blob[] = [];
    recorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      recorderRef.current = null;
      recorderTimerRef.current = null;
      void transcribe(new Blob(chunks, { type: "audio/webm" }));
      if (isCapturingRef.current) startRecordingRef.current();
    };
    recorder.start();
    recorderTimerRef.current = window.setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, CHUNK_DURATION_MS);
  }, [transcribe]);
  startRecordingRef.current = startRecording;

  const start = useCallback(async () => {
    setError(null);
    if (!supported) {
      const message = "Audio recording is not supported in this browser. Use Chrome or Edge.";
      setError(message);
      throw new Error(message);
    }

    try {
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
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
      startRecording();
      await refreshDevices();
      setIsCapturing(true);
    } catch (err: unknown) {
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
    }
  }, [deviceId, refreshDevices, startRecording, supported]);

  const stop = useCallback(() => {
    isCapturingRef.current = false;
    if (recorderTimerRef.current) {
      clearTimeout(recorderTimerRef.current);
      recorderTimerRef.current = null;
    }
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    setRms(0);
    setIsCapturing(false);
  }, []);

  useEffect(() => stop, [stop]);

  return { isCapturing, rms, error, devices, start, stop, refreshDevices, supported };
}
