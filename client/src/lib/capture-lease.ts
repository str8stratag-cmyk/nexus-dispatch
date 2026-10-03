// Client side of the per-box capture lease (shared/capture-lease.ts). The
// lease is the cross-origin guard; the Web Lock in capture-lock.ts is the
// instant same-origin one. Fails OPEN: if the server can't be reached (app
// restarting) or predates the endpoint, keep the current state -- a server
// blip must never stop a working capture.

export type LeaseState = "unknown" | "granted" | "denied";

// Fresh per page load (not sessionStorage: Chrome's "Duplicate tab" copies
// sessionStorage, which would give two tabs the same id).
// Kept on window so a re-executed module (HMR) does not mint a second id.
const w = window as Window & { __dmTabId?: string };
export const TAB_ID = (w.__dmTabId ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

export async function requestLease(capturing: boolean, force = false): Promise<LeaseState> {
  try {
    const res = await fetch("/api/capture/lease", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tabId: TAB_ID, capturing, force }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return "unknown";
    const body = (await res.json()) as { granted?: boolean };
    return body.granted ? "granted" : "denied";
  } catch {
    return "unknown";
  }
}

export function releaseLeaseNow(): void {
  void fetch("/api/capture/lease/release", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tabId: TAB_ID }),
  }).catch(() => undefined);
}

let releaseHooked = false;
/** Free the lease the moment this page goes away so a reload/other tab can take over at once. */
export function hookLeaseRelease(): void {
  if (releaseHooked || typeof window === "undefined") return;
  releaseHooked = true;
  window.addEventListener("pagehide", () => {
    try {
      navigator.sendBeacon("/api/capture/lease/release", new Blob([JSON.stringify({ tabId: TAB_ID })], { type: "text/plain" }));
    } catch {
      // best effort; the lease expires on its own
    }
  });
}
