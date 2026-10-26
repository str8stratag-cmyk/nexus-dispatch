import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type BoardStatus = "accepted" | "resolved" | "active";

/**
 * Status changes for board events. Same endpoint and payloads the old inline
 * EventLog buttons used (PATCH /api/events/:id/status) — moved into a hook so
 * the queue cards and the incident detail panel share one implementation.
 */
export function useEventActions() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: BoardStatus }) => {
      return apiRequest("PATCH", `/api/events/${id}/status`, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
    },
    onError: (err: any) => {
      toast({ title: "Update failed", description: err?.message ?? String(err), variant: "destructive" });
    },
  });

  const pendingId = mutation.isPending ? mutation.variables?.id ?? null : null;

  return {
    accept: (id: number) => mutation.mutate({ id, status: "accepted" }),
    resolve: (id: number) => mutation.mutate({ id, status: "resolved" }),
    /** needs_review → active ("Make active"). */
    promote: (id: number) => mutation.mutate({ id, status: "active" }),
    pendingId,
  };
}
