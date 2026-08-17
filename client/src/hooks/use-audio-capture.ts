import { useState, useEffect, useCallback, useRef } from "react";

interface UseAudioCaptureOptions {
  deviceId?: string;
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

export function useAudioCapture(options: UseAudioCaptureOptions = {}): UseAudioCaptureReturn {
  const { deviceId, onTranscript } = options;
  const [isCapturing, setIsCapturing] = useState(false);
  const [rms, setRms] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [supported, setSupported] = useState(true);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const recognitionRef = useRef<any>(null);
  const onTranscriptRef = useRef(onTranscript);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  // Check for Web Speech API support
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSupported(false);
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const deviceList = await navigator.mediaDevices.enumerateDevices();
      setDevices(deviceList.filter((d) => d.kind === "audioinput"));
    } catch (err) {
      console.error("Failed to enumerate devices:", err);
    }
  }, []);

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  const start = useCallback(async () => {
    setError(null);

    try {
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      // Set up audio analysis for RMS
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      analyserRef.current = analyser;

      // RMS calculation loop
      const bufferLength = analyser.fftSize;
      const dataArray = new Uint8Array(bufferLength);

      const updateRms = () => {
        analyser.getByteTimeDomainData(dataArray);
        let sumSquares = 0;
        for (let i = 0; i < bufferLength; i++) {
          const normalized = (dataArray[i] - 128) / 128;
          sumSquares += normalized * normalized;
        }
        const rmsValue = Math.sqrt(sumSquares / bufferLength);
        setRms(rmsValue);
        rafRef.current = requestAnimationFrame(updateRms);
      };
      updateRms();

      // Set up speech recognition
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = "en-US";

        recognition.onresult = (event: any) => {
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            const transcript = result[0].transcript;
            const isFinal = result.isFinal;
            onTranscriptRef.current?.(transcript, isFinal);
          }
        };

        recognition.onerror = (event: any) => {
          if (event.error !== "no-speech" && event.error !== "aborted") {
            console.error("Speech recognition error:", event.error);
          }
        };

        recognition.onend = () => {
          // Auto-restart if still capturing
          if (streamRef.current) {
            try {
              recognition.start();
            } catch (e) {
              // Already started
            }
          }
        };

        recognition.start();
        recognitionRef.current = recognition;
      } else {
        setError("Speech recognition not supported. Use Chrome or Edge for transcription.");
      }

      // Refresh device list to get labels (requires permission)
      refreshDevices();
      setIsCapturing(true);
    } catch (err: any) {
      const inIframe = typeof window !== "undefined" && window.self !== window.top;
      if (err?.name === "NotAllowedError" || err?.name === "SecurityError" || err?.message?.includes("not allowed") || err?.message?.includes("permission")) {
        if (inIframe) {
          setError("Microphone access blocked in preview. Click \"Open in New Tab\" to enable audio capture.");
        } else {
          setError("Microphone access denied. Please allow microphone permissions in your browser settings.");
        }
      } else {
        setError(err.message || "Failed to access microphone");
      }
      console.error("Audio capture error:", err);
    }
  }, [deviceId, refreshDevices]);

  const stop = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      try {
        recognitionRef.current.stop();
      } catch (e) {
        // Already stopped
      }
      recognitionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setRms(0);
    setIsCapturing(false);
  }, []);

  useEffect(() => {
    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isCapturing, rms, error, devices, start, stop, refreshDevices, supported };
}
