import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Radio, Send, MapPin } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SIGNAL_TYPES } from "@/lib/constants";

interface ManualDispatchProps {
  districts: string[];
}

export default function ManualDispatch({ districts }: ManualDispatchProps) {
  const [signalType, setSignalType] = useState("");
  const [address, setAddress] = useState("");
  const [description, setDescription] = useState("");
  const [district, setDistrict] = useState(districts[0] || "District 1");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const dispatchMutation = useMutation({
    mutationFn: async (data: any) => {
      return apiRequest("POST", "/api/dispatch", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      toast({
        title: "Manual Dispatch Sent",
        description: `${signalType} at ${address || "unknown address"}`,
      });
      setSignalType("");
      setAddress("");
      setDescription("");
    },
    onError: (err: any) => {
      toast({
        title: "Dispatch Failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!signalType || !description) {
      toast({
        title: "Missing Fields",
        description: "Signal type and description are required.",
        variant: "destructive",
      });
      return;
    }

    dispatchMutation.mutate({
      transcript: `Manual dispatch: ${signalType} — ${description}`,
      keywords: JSON.stringify([{ keyword: signalType, signalType }]),
      address: address || null,
      lat: null,
      lng: null,
      signalType,
      description,
      district,
      source: "Manual Dispatch",
      status: "active",
      isManual: true,
    });
  };

  return (
    <div className="max-w-2xl mx-auto p-4">
      <Card data-testid="manual-dispatch-form">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Radio className="h-5 w-5 text-primary" />
            Manual Fire Dispatch
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Send calls that were missed by the auto-dispatch system
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="signal-type" className="text-xs">Signal Type *</Label>
                <Select value={signalType} onValueChange={setSignalType}>
                  <SelectTrigger id="signal-type" data-testid="manual-signal-type">
                    <SelectValue placeholder="Select signal..." />
                  </SelectTrigger>
                  <SelectContent>
                    {SIGNAL_TYPES.map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="district" className="text-xs">District</Label>
                <Select value={district} onValueChange={setDistrict}>
                  <SelectTrigger id="district" data-testid="manual-district">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {districts.map((d) => (
                      <SelectItem key={d} value={d}>{d}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="address" className="text-xs flex items-center gap-1">
                <MapPin className="h-3 w-3" /> Address
              </Label>
              <Input
                id="address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="e.g., 123 Main St, Tampa, FL"
                className="font-mono text-sm"
                data-testid="manual-address"
              />
              <p className="text-[10px] text-muted-foreground">
                Geocoded for the dispatch record; automatic map placement is disabled.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description" className="text-xs">Description of Call *</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the incident..."
                rows={4}
                className="text-sm"
                data-testid="manual-description"
              />
            </div>

            <Button
              type="submit"
              disabled={dispatchMutation.isPending}
              className="w-full"
              data-testid="manual-submit"
            >
              <Send className="h-4 w-4 mr-2" />
              {dispatchMutation.isPending ? "Sending..." : "Send Dispatch"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
