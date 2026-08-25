import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { DEFAULT_KEYWORDS, type KeywordEntry } from "@shared/keywords";

const KEYWORDS_QUERY_KEY = ["/api/keywords"];

// Shared React Query cache — every component that calls this hook reads
// from the same cached list and network request, so adding/removing a
// keyword anywhere (Settings panel) instantly updates detection everywhere
// (audio capture, transcript feed) without prop drilling.
export function useKeywords() {
  const queryClient = useQueryClient();

  const query = useQuery<KeywordEntry[]>({
    queryKey: KEYWORDS_QUERY_KEY,
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/keywords");
      return res.json();
    },
  });

  const addMutation = useMutation({
    mutationFn: async (entry: KeywordEntry) => {
      const res = await apiRequest("POST", "/api/keywords", entry);
      return res.json() as Promise<KeywordEntry[]>;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(KEYWORDS_QUERY_KEY, updated);
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (pattern: string) => {
      const res = await apiRequest("DELETE", "/api/keywords", { pattern });
      return res.json() as Promise<KeywordEntry[]>;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(KEYWORDS_QUERY_KEY, updated);
    },
  });

  return {
    // Fall back to the built-in defaults while the persisted list is still
    // loading, so live keyword detection never silently goes blank during
    // the brief window before the first fetch resolves.
    keywords: query.data ?? DEFAULT_KEYWORDS,
    isLoading: query.isLoading,
    addKeyword: addMutation.mutateAsync,
    isAdding: addMutation.isPending,
    addError: addMutation.error as Error | null,
    removeKeyword: removeMutation.mutateAsync,
    isRemoving: removeMutation.isPending,
  };
}
