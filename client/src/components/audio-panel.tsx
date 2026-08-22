import { useState, useCallback, useRef, useEffect } from "react";
import { useAudioCapture } from "@/hooks/use-audio-capture";
import { useDispatchBuffer } from "@/hooks/use-dispatch-buffer";
import { useKeywords } from "@/hooks/use-keywords";
import RmsMeter from "./rms-meter";
import TranscriptFeed from "./transcript-feed";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Mic, MicOff, Radio, MapPin, ExternalLink, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface TranscriptEntry {
  id: string;
  text: string;
  isFinal: boolean;
  timestamp: number;
}

export interface DetectedEvent {
  transcript: string;
  keywords: { keyword: string; signalType: string }[];
  address: string | null;
  crossStreet: string | null;
  district: string;
  source: string;
}

interface AudioPanelProps {
  district: string;
  sourceName: string;
  onDistrictChange: (district: string) => void;
  onSourceChange: (source: string) => void;
  districts: string[];
  onDispatchDetected: (event: DetectedEvent) => void;
}

const DISPATCH_COOLDOWN_MS = 15000;

export default function AudioPanel({
  district,
  sourceName,
  onDistrictChange,
  onSourceChange,
  districts,
  onDispatchDetected,
}: AudioPanelProps) {
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([]);
  const [lastDispatch, setLastDispatch] = useState<DetectedEvent | null>(null);
  const entryIdRef = useRef(0);
  const lastDispatchTimeRef = useRef(0);
  const { toast } = useToast();
  const { keywords: keywordList } = useKeywords();

  const handleDispatch = useCallback(async (payload: {
    transcript: string;
    keywords: { keyword: string; signalType: string }[];
    address: string | null;
    crossStreet: string | null;
  }) => {
    const now = Date.now();
    if (now - lastDispatchTimeRef.current < DISPATCH_COOLDOWN_MS) {
      return;
    }
    lastDispatchTimeRef.current = now;

    const event: DetectedEvent = {
      transcript: payload.transcript,
      keywords: payload.keywords,
      address: payload.address,
      crossStreet: payload.crossStreet,
      district,
      source: sourceName || district,
    };

    try {
      await onDispatchDetected(event);
      setLastDispatch(event);

      toast({
        title: "Dispatch Auto-Fired",
        description: `${payload.keywords.map((k) => k.signalType).join(", ")} — ${payload.address || "Address pending geocode"}`,
      });
    } catch (error) {
      console.error("Dispatch failed:", error);
      lastDispatchTimeRef.current = 0; // allow retry
    }
  }, [district, sourceName, onDispatchDetected, toast]);

  const { addFinalTranscript, flush, isPending } = useDispatchBuffer({
    keywordList,
    silenceMs: 5000,
    maxChunks: 6,
    onDispatch: handleDispatch,
  });

  const handleTranscript = useCallback((text: string, isFinal: boolean) => {
    const id = `entry-${entryIdRef.current++}`;
    setTranscriptEntries((prev) => {
      if (!isFinal && prev.length > 0 && !prev[prev.length - 1].isFinal) {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          text,
          timestamp: Date.now(),
        };
        return updated;
      }
      return [...prev, { id, text, isFinal, timestamp: Date.now() }];
    });

    if (isFinal) {
      addFinalTranscript(text);
    }
  }, [addFinalTranscript]);

  const isInIframe = typeof window !== "undefined" && window.self !== window.top;

  const { isCapturing, rms, error, devices, start, stop, supported } = useAudioCapture({
    deviceId: selectedDevice || undefined,
    keywords: keywordList.map((keyword) => keyword.pattern),
    onTranscript: handleTranscript,
  });

  const [micBlocked, setMicBlocked] = useState(false);

  const handleStart = async () => {
    try {
      await start();
      setMicBlocked(false);
    } catch (err: any) {
      if (err?.name === "NotAllowedError" || err?.message?.includes("not allowed") || err?.message?.includes("permission")) {
        setMicBlocked(true);
      }
    }
  };

  const handleStop = useCallback(() => {
    flush().finally(() => stop());
  }, [flush, stop]);

  return (
    <div className="flex flex-col h-full gap-3" data-testid="audio-panel">
      {/* Device Selection */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Select value={selectedDevice} onValueChange={setSelectedDevice}>
            <SelectTrigger className="text-xs" data-testid="device-select">
              <SelectValue placeholder="Select microphone..." />
            </SelectTrigger>
            <SelectContent>
              {devices.length === 0 && (
                <SelectItem value="default">Default Microphone</SelectItem>
              )}
              {devices.map((device) => (
                <SelectItem key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${device.deviceId.slice(0, 8)}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Select value={district} onValueChange={onDistrictChange}>
            <SelectTrigger className="text-xs" data-testid="district-select">
              <SelectValue placeholder="District..." />
            </SelectTrigger>
            <SelectContent>
              {districts.map((d) => (
                <SelectItem key={d} value={d}>{d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input
            type="text"
            value={sourceName}
            onChange={(e) => onSourceChange(e.target.value)}
            placeholder="Source name..."
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-xs font-mono"
            data-testid="source-input"
          />
        </div>
      </div>

      {/* Open in New Tab banner if inside iframe */}
      {isInIframe && (
        <div className="rounded-md border-2 border-orange-700/50 bg-orange-950/20 p-3 space-y-2" data-testid="iframe-warning">
          <div className="flex items-center gap-2 text-orange-400 font-semibold text-xs">
            <AlertTriangle className="h-4 w-4" />
            Microphone Access Requires New Tab
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            This app runs inside a sandboxed preview that blocks microphone access. Open it in a new browser tab to enable audio capture and live transcription.
          </p>
          <Button
            onClick={() => window.open(window.location.href, "_blank")}
            size="sm"
            className="w-full text-xs"
            data-testid="open-new-tab"
          >
            <ExternalLink className="h-3 w-3 mr-1" />
            Open App in New Tab
          </Button>
        </div>
      )}

      {/* RMS Meter */}
      <div className="rounded-md border border-border bg-card p-3">
        <RmsMeter rms={rms} active={isCapturing} />
      </div>

      {/* Start/Stop Button */}
      <Button
        onClick={isCapturing ? handleStop : handleStart}
        variant={isCapturing ? "destructive" : "default"}
        className="w-full"
        data-testid="capture-toggle"
      >
        {isCapturing ? (
          <>
            <MicOff className="h-4 w-4 mr-2" />
            Stop Capture
          </>
        ) : (
          <>
            <Mic className="h-4 w-4 mr-2" />
            Start Capture
          </>
        )}
      </Button>

      {isPending && (
        <div className="text-xs text-yellow-600 animate-pulse p-2 rounded bg-yellow-950/30 border border-yellow-900/40" data-testid="dispatch-pending">
          ⏳ Keyword detected. Waiting for address/details...
        </div>
      )}

      {error && (
        <div className="text-xs text-red-500 p-2 rounded bg-red-950/30 border border-red-900/40" data-testid="capture-error">
          {error}
          {isInIframe && (
            <div className="mt-2">
              <Button
                onClick={() => window.open(window.location.href, "_blank")}
                size="sm"
                variant="outline"
                className="w-full text-xs h-7"
                data-testid="open-new-tab-error"
              >
                <ExternalLink className="h-3 w-3 mr-1" />
                Open in New Tab to Enable Mic
              </Button>
            </div>
          )}
        </div>
      )}

      {!supported && (
        <div className="text-xs text-yellow-500 p-2 rounded bg-yellow-950/30 border border-yellow-900/40">
          Local Whisper capture requires a browser with MediaRecorder support, such as Chrome or Edge.
        </div>
      )}

      {/* Last Auto-Dispatch Notification */}
      {lastDispatch && (
        <div className="rounded-md border border-green-700/40 bg-green-950/20 p-2 space-y-1" data-testid="last-dispatch">
          <div className="flex items-center gap-2 text-green-400 font-semibold text-xs">
            <Radio className="h-3 w-3" />
            Auto-Dispatch Sent
          </div>
          <div className="flex flex-wrap gap-1">
            {lastDispatch.keywords.map((kw, i) => (
              <span key={i} className="inline-flex items-center rounded bg-green-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-green-400">
                {kw.signalType}
              </span>
            ))}
          </div>
          {lastDispatch.address && (
            <div className="flex items-center gap-1 text-xs font-mono text-muted-foreground">
              <MapPin className="h-3 w-3 shrink-0" />
              {lastDispatch.crossStreet
                ? `${lastDispatch.address} & ${lastDispatch.crossStreet}`
                : lastDispatch.address}
            </div>
          )}
          <div className="text-[10px] text-muted-foreground italic truncate">"{lastDispatch.transcript}"</div>
        </div>
      )}

      {/* Transcript Feed */}
      <div className="flex-1 min-h-0 rounded-md border border-border bg-card overflow-hidden flex flex-col">
        <div className="px-3 py-2 border-b border-border bg-muted/30">
          <span className="text-xs font-mono text-muted-foreground">LIVE TRANSCRIPT</span>
        </div>
        <div className="flex-1 min-h-0">
          <TranscriptFeed entries={transcriptEntries} />
        </div>
      </div>
    </div>
  );
}
