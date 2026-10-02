import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShieldAlert, MapPin, Clock, RotateCcw, Wand2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface QuarantineRow {
  _id: string;
  reason: string;
  transcript: string;
  address: string | null;
  keywords: string | null;
  source: string | null;
  signalType: string | null;
  whisperModel: string | null;
  suggestion?: { address: string; score: number } | null;
  createdAt: string;
}

export default function QuarantinePanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [reasonFilter, setReasonFilter] = useState("all");

  const { data: items = [], isLoading } = useQuery<QuarantineRow[]>({
    queryKey: ["/api/quarantine"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/quarantine?limit=200");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const restoreMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("POST", `/api/quarantine/${id}/restore`);
    },
    onSuccess: (_data, id) => {
      // The restored event itself lands in the events list via the SSE
      // "dispatch" broadcast handled by useEventsStream — just drop the row here.
      queryClient.setQueryData<QuarantineRow[]>(["/api/quarantine"], (old = []) =>
        old.filter((item) => item._id !== id),
      );
      toast({ title: "Clip Restored", description: "Dispatch event created from quarantined clip" });
    },
    onError: (err: any) => {
      toast({
        title: "Restore Failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Street-dictionary reconcile: matches quarantined addresses against real
  // Tampa streets; very confident matches are auto-restored by the server,
  // the rest come back with a suggestion for one-click restore.
  const reconcileMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/quarantine/reconcile");
      return res.json() as Promise<{ scanned: number; suggested: number; autoRestored: number; failed: number }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/quarantine"] });
      toast({
        title: "Street Match Complete",
        description: `${data.suggested} suggested, ${data.autoRestored} auto-restored, ${data.failed} unmatched`,
      });
    },
    onError: (err: any) => {
      toast({
        title: "Street Match Failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const reasons = Array.from(new Set(items.map((item) => item.reason).filter(Boolean)));
  const filteredItems = reasonFilter === "all" ? items : items.filter((item) => item.reason === reasonFilter);

  return (
    <Card className="h-full flex flex-col" data-testid="quarantine-panel">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-500" />
            Quarantine
          </span>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs text-amber-600 border-amber-600/30 bg-amber-600/10">
              {items.length} quarantined
            </Badge>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => reconcileMutation.mutate()}
              disabled={reconcileMutation.isPending}
              data-testid="reconcile-streets"
            >
              <Wand2 className="h-3 w-3 mr-1" />
              {reconcileMutation.isPending ? "Matching..." : "Match streets"}
            </Button>
            {reasons.length > 0 && (
              <Select value={reasonFilter} onValueChange={setReasonFilter}>
                <SelectTrigger className="h-7 w-40 text-xs" data-testid="quarantine-reason-filter">
                  <SelectValue placeholder="Filter by reason" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs">All reasons</SelectItem>
                  {reasons.map((reason) => (
                    <SelectItem key={reason} value={reason} className="text-xs">
                      {reason}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto space-y-2 p-2">
        {isLoading && (
          <div className="text-xs text-muted-foreground text-center p-4">Loading quarantined clips...</div>
        )}
        {!isLoading && filteredItems.length === 0 && (
          <div className="text-xs text-muted-foreground text-center p-4 italic">
            {items.length === 0 ? "No quarantined clips" : "No clips match the selected reason"}
          </div>
        )}
        {filteredItems.map((item) => (
          <div
            key={item._id}
            className="rounded-r-lg border border-l-[3px] border-amber-900/30 border-l-amber-500 bg-amber-950/10 p-3 space-y-2 transition-all hover:translate-x-1 hover:bg-amber-950/20 hover:shadow-md"
            data-testid={`quarantine-${item._id}`}
          >
            <div className="flex items-center justify-between">
              <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-600/30 bg-amber-600/10">
                {item.reason}
              </Badge>
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Clock className="h-2.5 w-2.5" />
                {new Date(item.createdAt).toLocaleTimeString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}
              </div>
            </div>
            {item.address && (
              <div className="flex items-center gap-1 text-xs font-mono text-foreground">
                <MapPin className="h-3 w-3 text-primary shrink-0" />
                {item.address}
              </div>
            )}
            {item.suggestion && (
              <div className="flex items-center gap-1 text-xs font-mono text-emerald-600">
                <Wand2 className="h-3 w-3 shrink-0" />
                {item.suggestion.address}
                <span className="text-emerald-600/60">
                  · {Math.round(item.suggestion.score * 100)}%
                </span>
              </div>
            )}
            {item.transcript && (
              <div className="line-clamp-2 border-l border-border/70 pl-2 text-[11px] leading-relaxed text-muted-foreground">
                {item.transcript}
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono text-muted-foreground">
                {item.signalType || "Unknown signal"} • {item.source || "Unknown source"}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px] text-emerald-600 hover:text-emerald-500 hover:bg-emerald-950/20"
                disabled={restoreMutation.isPending}
                onClick={() => restoreMutation.mutate(item._id)}
                data-testid={`restore-quarantine-${item._id}`}
              >
                <RotateCcw className="h-3 w-3 mr-1" /> Restore
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
