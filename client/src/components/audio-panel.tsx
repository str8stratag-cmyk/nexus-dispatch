import { useState, useCallback, useRef, useEffect, useSyncExternalStore } from "react";
import { useAudioCapture, CHUNK_DURATION_MS } from "@/hooks/use-audio-capture";
import {
  readAutoCapture,
  writeAutoCapture,
  startBackoffMs,
  isStalled,
  stallThresholdMs,
  shouldForceReload,
  readLastForcedReload,
  writeLastForcedReload,
  isPermissionError,
} from "@/lib/capture-supervisor";
import { getCaptureLockState, subscribeCaptureLock, releaseCaptureLock, stealCaptureLock } from "@/lib/capture-lock";
import { requestLease, hookLeaseRelease, releaseLeaseNow, TAB_ID, type LeaseState } from "@/lib/capture-lease";
import { LEASE_RENEW_MS, decideTabAction, mayRunCapture, minuteLevel, type TabSnapshot } from "@shared/capture-lease";
import { useDispatchBuffer } from "@/hooks/use-dispatch-buffer";
import { isTrueRepeat } from "@/lib/dispatch-buffer-core";
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

// Bound the live feed — an unbounded list grows for hours of capture and
// Chrome kills the tab with "Error code: Out of Memory" (2026-09-17).
const MAX_TRANSCRIPT_ENTRIES = 300;

export interface DetectedEvent {
  transcript: string;
  keywords: { keyword: string; signalType: string }[];
  address: string | null;
  crossStreet: string | null;
  district: string;
  source: string;
  /** Neighbouring transcripts (oldest -> newest), only when `address` is missing. */
  contextTranscripts?: string[];
  /** Intake-only double-dispatch guard id. */
  clientRequestId?: string;
  /** Client epoch ms of the call's first/last audio chunk (hints). */
  audioStartedAt?: number;
  audioEndedAt?: number;
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

// Address hold (see lib/dispatch-buffer-core.ts). Per-box kill switch in the
// untracked .env.local: VITE_ADDRESS_HOLD=off (needs app restart + page reload).
const ADDRESS_HOLD_ENABLED =
  String(import.meta.env.VITE_ADDRESS_HOLD ?? "on").trim().toLowerCase() !== "off";
const ADDRESS_HOLD_MS = (() => {
  const v = Number(import.meta.env.VITE_ADDRESS_HOLD_MS);
  return Number.isFinite(v) && v >= 5_000 && v <= 60_000 ? v : undefined;
})();

export default function AudioPanel({
  district,
  sourceName,
  onDistrictChange,
  onSourceChange,
  districts,
  onDispatchDetected,
}: AudioPanelProps) {
  const [selectedDevice, setSelectedDeviceState] = useState<string>(() => localStorage.getItem("dispatch.audioDevice") || "");
  const setSelectedDevice = useCallback((value: string) => {
    localStorage.setItem("dispatch.audioDevice", value);
    setSelectedDeviceState(value);
  }, []);
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([]);
  const [lastDispatch, setLastDispatch] = useState<DetectedEvent | null>(null);
  const entryIdRef = useRef(0);
  // Last dispatch, for the cooldown: only a TRUE repeat (same address + same
  // incident class within DISPATCH_COOLDOWN_MS) is suppressed.
  const lastDispatchRef = useRef<{ address: string | null; signalType: string | null; at: number } | null>(null);
  // Counters sent with the capture heartbeat (visibility for missed calls).
  const cooldownDropsRef = useRef(0);
  const { toast } = useToast();
  const { keywords: keywordList } = useKeywords();

  const handleDispatch = useCallback(async (payload: {
    transcript: string;
    keywords: { keyword: string; signalType: string }[];
    address: string | null;
    crossStreet: string | null;
    contextTranscripts?: string[];
    clientRequestId?: string;
    audioStartedAt?: number;
    audioEndedAt?: number;
  }) => {
    const now = Date.now();
    const signalType = payload.keywords[0]?.signalType ?? null;
    // The old blanket 15 s cooldown silently dropped a DIFFERENT call that
    // followed within 15 s. Now only a repeat of the same address + incident
    // class is suppressed (the server would dedup it anyway), and it is logged.
    if (isTrueRepeat(lastDispatchRef.current, { address: payload.address, signalType }, now, DISPATCH_COOLDOWN_MS)) {
      cooldownDropsRef.current += 1;
      console.log(`[cooldown] suppressed repeat dispatch (${signalType} @ ${payload.address})`);
      return;
    }
    const previousDispatch = lastDispatchRef.current;
    lastDispatchRef.current = { address: payload.address, signalType, at: now };

    const event: DetectedEvent = {
      transcript: payload.transcript,
      keywords: payload.keywords,
      address: payload.address,
      crossStreet: payload.crossStreet,
      district,
      source: sourceName || district,
      contextTranscripts: payload.contextTranscripts,
      clientRequestId: payload.clientRequestId,
      audioStartedAt: payload.audioStartedAt,
      audioEndedAt: payload.audioEndedAt,
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
      lastDispatchRef.current = previousDispatch; // allow retry
    }
  }, [district, sourceName, onDispatchDetected, toast]);

  const { addFinalTranscript, flush, isPending, getStats } = useDispatchBuffer({
    keywordList,
    silenceMs: 5000,
    maxChunks: 6,
    holdEnabled: ADDRESS_HOLD_ENABLED,
    holdMs: ADDRESS_HOLD_MS,
    onDispatch: handleDispatch,
  });
  const getStatsRef = useRef(getStats);
  getStatsRef.current = getStats;

  const handleTranscript = useCallback((text: string, isFinal: boolean, meta?: { audioStartedAt?: number; audioEndedAt?: number }) => {
    const id = `entry-${entryIdRef.current++}`;
    setTranscriptEntries((prev) => {
      let next: TranscriptEntry[];
      if (!isFinal && prev.length > 0 && !prev[prev.length - 1].isFinal) {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          text,
          timestamp: Date.now(),
        };
        next = updated;
      } else {
        next = [...prev, { id, text, isFinal, timestamp: Date.now() }];
      }
      return next.length > MAX_TRANSCRIPT_ENTRIES
        ? next.slice(next.length - MAX_TRANSCRIPT_ENTRIES)
        : next;
    });

    if (isFinal) {
      addFinalTranscript(text, meta);
    }
  }, [addFinalTranscript]);

  const isInIframe = typeof window !== "undefined" && window.self !== window.top;

  const { isCapturing, rms, error, devices, start, stop, getHealth, takeLevelPeakMax, supported } = useAudioCapture({
    deviceId: selectedDevice || undefined,
    keywords: keywordList.map((keyword) => keyword.pattern),
    onTranscript: handleTranscript,
  });

  const [micBlocked, setMicBlocked] = useState(false);

  // Self-reload before Chrome kills the tab with "Error code: Out of
  // Memory" — the V8 heap only resets on navigation and capture
  // auto-resumes after reload, so a preemptive reload beats a crashed tab.
  // With desk HMR off (server/vite.ts) this 2h reload is also how a pulled
  // client update reaches the page; the supervisor resumes capture after it.
  // Crash dumps showed the RENDERER ballooning far beyond the JS heap, so
  // reload periodically to bound any slow leak. A DOM-node guard was tried
  // here and removed: EventLog legitimately renders ~30k+ nodes with the
  // full collection, so the guard reload-looped the tab every 30s.
  useEffect(() => {
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } };
    const hasMem = typeof perf.memory !== "undefined";
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (hasMem) {
        const { usedJSHeapSize, jsHeapSizeLimit } = perf.memory!;
        if (jsHeapSizeLimit > 0 && usedJSHeapSize > 0.6 * jsHeapSizeLimit) {
          window.location.reload();
          return;
        }
      }
      if (Date.now() - started > 2 * 60 * 60 * 1000) {
        window.location.reload();
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // ---- Capture supervisor (2026-10-03) -------------------------------------
  // Replaces the old one-shot auto-start, which (a) was skipped forever after a
  // Vite HMR / React Fast Refresh update because its "tried" ref survives the
  // refresh while the hook's cleanup stopped the mic, and (b) was cancelled by
  // any re-render while in flight. Now: a persisted auto-capture intent (ON
  // unless an operator pressed Stop) and a 2s supervisor tick that starts
  // capture whenever it is wanted but not running -- after page load, HMR,
  // a server restart, a mic stream ending, or a stalled recorder -- with
  // backoff, never giving up. Last resort: a rate-limited page reload.
  const lockState = useSyncExternalStore(subscribeCaptureLock, getCaptureLockState);
  const [autoCapture, setAutoCaptureState] = useState(() => readAutoCapture(window.localStorage));
  const [supervisorNote, setSupervisorNote] = useState<string | null>(null);
  const autoCaptureRef = useRef(autoCapture);
  autoCaptureRef.current = autoCapture;
  const lockStateRef = useRef(lockState);
  lockStateRef.current = lockState;
  // Cross-origin single-capturer lease from the server (127.0.0.1 vs
  // localhost tabs on one box). "unknown" = server unreachable/old: fail open.
  const [leaseState, setLeaseStateValue] = useState<LeaseState>("unknown");
  const leaseRef = useRef<LeaseState>("unknown");
  const leaseCheckedRef = useRef(false);
  const setLeaseState = useCallback((next: LeaseState) => {
    leaseRef.current = next;
    setLeaseStateValue(next);
  }, []);
  const startRef = useRef(start);
  startRef.current = start;
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const getHealthRef = useRef(getHealth);
  getHealthRef.current = getHealth;
  const takeLevelPeakMaxRef = useRef(takeLevelPeakMax);
  takeLevelPeakMaxRef.current = takeLevelPeakMax;
  const supRef = useRef({ failures: 0, nextAttemptAt: 0, attempting: false, recoveries: 0, unhealthySince: 0 });
  // When this tab started holding the lock without capturing (0 = not idle).
  const idleHolderSinceRef = useRef(0);
  const micPermRef = useRef<TabSnapshot["micPermission"]>("unknown");

  const setAutoCapture = useCallback((on: boolean) => {
    writeAutoCapture(window.localStorage, on);
    autoCaptureRef.current = on;
    setAutoCaptureState(on);
  }, []);

  const resetSupervisor = useCallback(() => {
    supRef.current = { failures: 0, nextAttemptAt: 0, attempting: false, recoveries: 0, unhealthySince: 0 };
    setSupervisorNote(null);
  }, []);

  useEffect(() => {
    if (isInIframe || !supported) return;
    let disposed = false;
    let lastTickAt = Date.now();

    const tick = async () => {
      if (disposed) return;
      const sup = supRef.current;
      const now = Date.now();
      const tickGap = now - lastTickAt;
      lastTickAt = now;
      const health = getHealthRef.current();
      const capturingNow = health.startedAt > 0;
      if (lockStateRef.current === "held" && !capturingNow) {
        if (!idleHolderSinceRef.current) idleHolderSinceRef.current = now;
      } else {
        idleHolderSinceRef.current = 0;
      }
      if (idleHolderSinceRef.current && navigator.permissions?.query) {
        navigator.permissions
          .query({ name: "microphone" as PermissionName })
          .then((p) => { micPermRef.current = p.state; })
          .catch(() => undefined);
      }
      // 2026-10-20 (DISP-1): an idle lock holder yields so the capturing tab
      // can take over; a tab whose lease is held elsewhere stops capturing.
      const action = decideTabAction({
        lock: lockStateRef.current,
        lease: leaseRef.current,
        capturing: capturingNow,
        autoCapture: autoCaptureRef.current,
        micPermission: micPermRef.current,
        idleHolderSince: idleHolderSinceRef.current,
        now,
      });
      if (action === "yield") {
        console.warn(`[capture-supervisor] tab ${TAB_ID} holds the capture lock but is not capturing; yielding lock + lease`);
        idleHolderSinceRef.current = 0;
        releaseLeaseNow();
        setLeaseState("unknown");
        releaseCaptureLock();
        return;
      }
      // Another tab on this box holds the capture lease: never run a second
      // capture loop on the same audio.
      if (leaseRef.current === "denied") {
        if (action === "stop") {
          console.warn("[capture-supervisor] another tab holds the capture lease; stopping this tab's capture");
          stopRef.current();
        }
        sup.failures = 0;
        sup.recoveries = 0;
        sup.unhealthySince = 0;
        return;
      }
      if (!autoCaptureRef.current || !mayRunCapture(lockStateRef.current, leaseRef.current, capturingNow) || !leaseCheckedRef.current) {
        sup.failures = 0;
        sup.recoveries = 0;
        sup.unhealthySince = 0;
        return;
      }

      if (health.startedAt > 0) {
        if (isStalled(health, now, CHUNK_DURATION_MS, tickGap)) {
          // Recorder stopped finishing chunks (silent ones included): the
          // pipeline is wedged even though the UI says capturing.
          console.warn("[capture-supervisor] no audio chunk for", now - Math.max(health.startedAt, health.lastChunkAt), "ms; restarting capture");
          sup.recoveries += 1;
          if (!sup.unhealthySince) sup.unhealthySince = now;
          sup.nextAttemptAt = now + 1_000;
          setSupervisorNote(`Capture stalled (no audio for ${Math.round(stallThresholdMs(CHUNK_DURATION_MS) / 1000)}s+) — restarting automatically…`);
          stopRef.current();
        } else if (health.lastChunkAt > health.startedAt) {
          sup.failures = 0;
          sup.recoveries = 0;
          sup.unhealthySince = 0;
          setSupervisorNote((prev) => (prev === null ? prev : null));
        }
        return;
      }

      // Wanted but not running.
      if (!sup.unhealthySince) sup.unhealthySince = now;
      if (shouldForceReload({
        now,
        recoveriesSinceHealthy: sup.recoveries,
        unhealthySince: sup.unhealthySince,
        lastForcedReloadAt: readLastForcedReload(window.localStorage),
      })) {
        console.warn("[capture-supervisor] in-page restarts keep failing; reloading the page");
        writeLastForcedReload(window.localStorage, now);
        window.location.reload();
        return;
      }
      if (sup.attempting || now < sup.nextAttemptAt) return;

      sup.attempting = true;
      try {
        let permState: PermissionState | "unknown" = "unknown";
        try {
          permState = (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
          micPermRef.current = permState;
        } catch {
          // Permissions API unavailable: attempt the start anyway.
        }
        if (disposed) return;
        if (permState === "prompt" || permState === "denied") {
          sup.failures += 1;
          sup.nextAttemptAt = Date.now() + 60_000;
          setMicBlocked(permState === "denied");
          setSupervisorNote(permState === "denied"
            ? "Microphone access denied — allow it in the browser site settings (auto-capture rechecks every minute)."
            : "Microphone permission not granted yet — press Start Capture once to enable auto-capture.");
          return;
        }
        await startRef.current();
        sup.failures = 0;
        setMicBlocked(false);
        setSupervisorNote(null);
      } catch (err) {
        sup.failures += 1;
        sup.recoveries += 1;
        const denied = isPermissionError(err);
        const delay = denied ? 60_000 : startBackoffMs(sup.failures);
        sup.nextAttemptAt = Date.now() + delay;
        if (denied) setMicBlocked(true);
        setSupervisorNote(`Auto-capture could not start (attempt ${sup.failures}); retrying in ${Math.round(delay / 1000)}s…`);
      } finally {
        sup.attempting = false;
      }
    };

    const timer = window.setInterval(() => void tick(), 2_000);
    void tick();
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [isInIframe, supported, setLeaseState]);

  // Lease renewal. Only a tab that wants to capture asks for the lease.
  useEffect(() => {
    if (isInIframe) return;
    hookLeaseRelease();
    let disposed = false;
    const renew = async () => {
      const capturingNow = getHealthRef.current().startedAt > 0;
      if (!autoCaptureRef.current && !capturingNow) {
        leaseCheckedRef.current = true;
        return;
      }
      // A standby tab that is not capturing must not grab the lease: it can't
      // start anyway (lock elsewhere) and would block the real capturer.
      if (lockStateRef.current === "standby" && !capturingNow) {
        leaseCheckedRef.current = true;
        if (leaseRef.current !== "unknown") setLeaseState("unknown");
        return;
      }
      const next = await requestLease(capturingNow);
      if (disposed) return;
      leaseCheckedRef.current = true;
      if (next !== "unknown") setLeaseState(next);
    };
    void renew();
    const timer = window.setInterval(() => void renew(), LEASE_RENEW_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [isInIframe, setLeaseState]);

  // Liveness heartbeat for the desk watchdog: it reopens the page only when
  // NO heartbeat arrives at all (tab closed, crashed, or stuck blank). A page
  // that is alive but not capturing is the supervisor's job, not the watchdog's.
  const heartbeatSourceRef = useRef(sourceName || district);
  const heartbeatNowRef = useRef<(() => void) | null>(null);
  heartbeatSourceRef.current = sourceName || district;
  useEffect(() => {
    if (isInIframe) return;
    let prev = { chunksRecorded: 0, chunksSent: 0, sendErrors: 0, droppedChunks: 0, levelPeakSum: 0 };
    const beat = () => {
      const health = getHealthRef.current();
      const now = Date.now();
      // Deltas since the previous beat: the server logs one summary line per tab per minute.
      const minute = {
        chunksRecorded: health.chunksRecorded - prev.chunksRecorded,
        chunksSent: health.chunksSent - prev.chunksSent,
        sendErrors: health.sendErrors - prev.sendErrors,
        droppedChunks: health.droppedChunks - prev.droppedChunks,
        ...minuteLevel(health.chunksRecorded - prev.chunksRecorded, health.levelPeakSum - prev.levelPeakSum, takeLevelPeakMaxRef.current()),
        audioContextState: health.audioContextState,
      };
      prev = { chunksRecorded: health.chunksRecorded, chunksSent: health.chunksSent, sendErrors: health.sendErrors, droppedChunks: health.droppedChunks, levelPeakSum: health.levelPeakSum };
      void fetch("/api/capture/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tabId: TAB_ID,
          origin: window.location.origin,
          source: heartbeatSourceRef.current,
          minute,
          capturing: health.startedAt > 0,
          autoCapture: autoCaptureRef.current,
          lock: lockStateRef.current,
          lease: leaseRef.current,
          lastChunkAgoMs: health.lastChunkAt ? now - health.lastChunkAt : null,
          lastSentAgoMs: health.lastSentAt ? now - health.lastSentAt : null,
          // Missed-call visibility (cumulative since page load).
          counters: {
            ...getStatsRef.current(),
            cooldownDrops: cooldownDropsRef.current,
            droppedChunks: health.droppedChunks,
          },
        }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { recover?: string; url?: string; takeLock?: boolean } | null) => {
          // 2026-10-21: server saw the lock holder dead (no beat/chunk 5+ min).
          if (body?.takeLock) stealCaptureLock();
          // Desk watchdog saw no audio chunks for minutes (2026-10-20): reload,
          // or move to the canonical origin (http://localhost:5000). The server
          // sends this to ONE tab, never while any tab is lock=pending.
          if (!body?.recover) return;
          console.warn(`[capture] watchdog requested recovery (${body.recover})`);
          releaseLeaseNow();
          if (body.recover === "navigate" && body.url) window.location.replace(body.url);
          else window.location.reload();
        })
        .catch(() => undefined);
    };
    beat();
    heartbeatNowRef.current = beat;
    const timer = window.setInterval(beat, 60_000);
    return () => {
      heartbeatNowRef.current = null;
      window.clearInterval(timer);
    };
  }, [isInIframe]);
  // 2026-10-21: report lock changes at once (not up to 60 s later) so the
  // watchdog's 90 s post-recover check sees a tab that took the lock.
  useEffect(() => {
    const t = window.setTimeout(() => heartbeatNowRef.current?.(), 1_000);
    return () => window.clearTimeout(t);
  }, [lockState]);

  const handleStart = async () => {
    setAutoCapture(true);
    resetSupervisor();
    // The tab the operator clicked wins: take the lease over from any other tab.
    setLeaseState("granted");
    leaseCheckedRef.current = true;
    void requestLease(false, true);
    try {
      await start();
      setMicBlocked(false);
    } catch (err: unknown) {
      if (isPermissionError(err)) {
        setMicBlocked(true);
      }
    }
  };

  const handleStop = useCallback(() => {
    // An explicit Stop is the only thing that turns auto-capture off.
    setAutoCapture(false);
    resetSupervisor();
    releaseLeaseNow();
    setLeaseState("unknown");
    flush().finally(() => stop());
  }, [flush, stop, setAutoCapture, resetSupervisor]);

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

      {!isCapturing && !autoCapture && (
        <div className="text-xs text-yellow-500 p-2 rounded bg-yellow-950/30 border border-yellow-900/40" data-testid="auto-capture-off">
          Auto-capture is OFF because Stop was pressed. Press Start Capture to resume; it then restarts by itself after updates and reloads.
        </div>
      )}

      {autoCapture && (lockState === "standby" || leaseState === "denied") && !isCapturing && (
        <div className="text-xs text-sky-400 p-2 rounded bg-sky-950/30 border border-sky-900/40" data-testid="capture-standby">
          Standby: another Dispatch Monitor tab on this desk is capturing. This tab takes over automatically if that one closes.
        </div>
      )}

      {supervisorNote && autoCapture && (
        <div className="text-xs text-yellow-500 p-2 rounded bg-yellow-950/30 border border-yellow-900/40" data-testid="auto-start-note">
          {supervisorNote}
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
