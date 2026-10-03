import { Component, type ErrorInfo, type ReactNode } from "react";

// Top-level recovery (2026-10-03). Before this, any render error unmounted the
// whole React tree and left the capture tab blank white with nobody there to
// notice or reload it (DISP-4, 2026-10-02 and 2026-09-24). Now an error shows
// a visible message and the page reloads itself with backoff; the capture
// supervisor resumes capture after the reload.
//
// This component also marks the app as booted for the inline boot guard in
// client/index.html, which covers the case where the JS never runs at all.

const CRASH_RELOADS_KEY = "dm.crashReloads";
const BOOT_RELOADS_KEY = "dm.bootReloads";

declare global {
  interface Window {
    __dmBooted?: boolean;
  }
}

function readCount(key: string): number {
  try {
    return Number.parseInt(sessionStorage.getItem(key) ?? "0", 10) || 0;
  } catch {
    return 0;
  }
}

function writeCount(key: string, value: number | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, String(value));
  } catch {
    // ignore
  }
}

/** 15s, 30s, 60s ... capped at 5 minutes. */
export function crashReloadDelayMs(previousReloads: number): number {
  return Math.min(15_000 * 2 ** Math.min(Math.max(previousReloads, 0), 10), 5 * 60_000);
}

interface State {
  error: Error | null;
  reloadInMs: number;
}

export default class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, reloadInMs: 0 };
  private reloadTimer: number | null = null;
  private stableTimer: number | null = null;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidMount(): void {
    window.__dmBooted = true;
    // Ran cleanly for a minute: reset both reload backoffs.
    this.stableTimer = window.setTimeout(() => {
      if (!this.state.error) {
        writeCount(CRASH_RELOADS_KEY, null);
        writeCount(BOOT_RELOADS_KEY, null);
      }
    }, 60_000);
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("App crashed; scheduling automatic reload:", error, info.componentStack);
    if (this.reloadTimer !== null) return;
    const previous = readCount(CRASH_RELOADS_KEY);
    const delay = crashReloadDelayMs(previous);
    this.setState({ reloadInMs: delay });
    this.reloadTimer = window.setTimeout(() => {
      writeCount(CRASH_RELOADS_KEY, previous + 1);
      window.location.reload();
    }, delay);
  }

  componentWillUnmount(): void {
    if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
    if (this.stableTimer !== null) window.clearTimeout(this.stableTimer);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        data-testid="app-crashed"
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: 24,
          background: "#0b0f17",
          color: "#e2e8f0",
          font: "14px system-ui, sans-serif",
          textAlign: "center",
        }}
      >
        <strong style={{ fontSize: 18, color: "#f87171" }}>Dispatch Monitor hit an error</strong>
        <span>Reloading automatically in {Math.round(this.state.reloadInMs / 1000)}s; capture resumes by itself after the reload.</span>
        <code style={{ color: "#94a3b8", maxWidth: 720, overflowWrap: "anywhere" }}>{this.state.error.message}</code>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid #475569", background: "#1e293b", color: "#e2e8f0" }}
        >
          Reload now
        </button>
      </div>
    );
  }
}
