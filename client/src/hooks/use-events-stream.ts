import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useEventsStream(enabled = true): void {
  const queryClient = useQueryClient();
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabledRef.current || typeof window === "undefined") return;
    if (!window.EventSource) return;

    const source = new EventSource("/api/events/stream");

    source.addEventListener("dispatch", (event) => {
      const updated = JSON.parse((event as MessageEvent).data);
      queryClient.setQueryData<any[]>(["/api/events"], (old = []) => {
        const exists = old.some((e) => e.id === updated.id);
        if (exists) {
          return old.map((e) => (e.id === updated.id ? updated : e));
        }
        return [updated, ...old].slice(0, 500);
      });
    });

    return () => source.close();
  }, [queryClient]);
}
