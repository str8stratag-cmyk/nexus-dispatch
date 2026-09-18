import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useKeywords } from "@/hooks/use-keywords";
import { Send, Save, Plus, Trash2, Settings as SettingsIcon, Bot, Tag } from "lucide-react";

export default function SettingsPanel() {
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [newDistrict, setNewDistrict] = useState("");
  const [districts, setDistricts] = useState<string[]>(["District 1", "District 2", "District 3", "District 4", "District 5", "District 6", "District 7"]);
  const [newPattern, setNewPattern] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newSignalType, setNewSignalType] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { keywords, isLoading: keywordsLoading, addKeyword, isAdding, removeKeyword } = useKeywords();

  const { data: settings } = useQuery({
    queryKey: ["/api/settings"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/settings");
      return res.json();
    },
  });

  const saveSettingMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      return apiRequest("POST", "/api/settings", { key, value });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
    },
  });

  const testTelegramMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/telegram/test", {});
    },
    onSuccess: async (res) => {
      const data = await res.json();
      if (data.success) {
        toast({ title: "Telegram Test", description: "Test message sent successfully." });
      } else {
        toast({ title: "Telegram Test Failed", description: data.message, variant: "destructive" });
      }
    },
    onError: (err: any) => {
      toast({ title: "Telegram Test Failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSaveToken = () => {
    if (!botToken) {
      toast({ title: "Error", description: "Bot token is required", variant: "destructive" });
      return;
    }
    saveSettingMutation.mutate(
      { key: "telegram_bot_token", value: botToken },
      {
        onSuccess: () => {
          toast({ title: "Saved", description: "Telegram bot token saved." });
          setBotToken("");
        },
      }
    );
  };

  const handleSaveChatId = () => {
    if (!chatId) {
      toast({ title: "Error", description: "Chat ID is required", variant: "destructive" });
      return;
    }
    saveSettingMutation.mutate(
      { key: "telegram_chat_id", value: chatId },
      {
        onSuccess: () => {
          toast({ title: "Saved", description: "Telegram chat ID saved." });
          setChatId("");
        },
      }
    );
  };

  const handleAddDistrict = () => {
    if (!newDistrict.trim()) return;
    if (districts.includes(newDistrict.trim())) {
      toast({ title: "Duplicate", description: "District already exists.", variant: "destructive" });
      return;
    }
    setDistricts([...districts, newDistrict.trim()]);
    setNewDistrict("");
  };

  const handleRemoveDistrict = (d: string) => {
    setDistricts(districts.filter((dist) => dist !== d));
  };

  const handleAddKeyword = async () => {
    if (!newPattern.trim()) return;
    try {
      await addKeyword({
        pattern: newPattern.trim(),
        label: newLabel.trim() || newPattern.trim(),
        signalType: newSignalType.trim() || newLabel.trim() || newPattern.trim(),
      });
      setNewPattern("");
      setNewLabel("");
      setNewSignalType("");
      toast({ title: "Keyword added", description: `"${newPattern.trim()}" is now being detected.` });
    } catch (err: any) {
      toast({ title: "Could not add keyword", description: err.message, variant: "destructive" });
    }
  };

  const telegramConfigured = settings?.some((s: any) => s.key === "telegram_bot_token" && s.value && !s.value.includes("***"));

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      {/* Telegram Configuration */}
      <Card data-testid="telegram-settings">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Bot className="h-5 w-5 text-primary" />
            Telegram Dispatch Configuration
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Configure the Telegram bot that receives dispatch events
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Current config status */}
          {settings && (
            <div className="space-y-1 text-xs">
              {settings.filter((s: any) => s.key !== "keyword_list").map((s: any) => (
                <div key={s.key} className="flex justify-between items-center py-1 border-b border-border/50">
                  <span className="text-muted-foreground font-mono">{s.key}</span>
                  <span className="font-mono">{s.value ? `✓ ${s.value}` : "Not set"}</span>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="bot-token" className="text-xs">Telegram Bot Token</Label>
            <div className="flex gap-2">
              <Input
                id="bot-token"
                type="password"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                className="font-mono text-xs"
                data-testid="bot-token-input"
              />
              <Button onClick={handleSaveToken} size="sm" variant="outline" data-testid="save-token">
                <Save className="h-3 w-3 mr-1" /> Save
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="chat-id" className="text-xs">Telegram Chat ID</Label>
            <div className="flex gap-2">
              <Input
                id="chat-id"
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder="-1001234567890"
                className="font-mono text-xs"
                data-testid="chat-id-input"
              />
              <Button onClick={handleSaveChatId} size="sm" variant="outline" data-testid="save-chat-id">
                <Save className="h-3 w-3 mr-1" /> Save
              </Button>
            </div>
          </div>

          <Button
            onClick={() => testTelegramMutation.mutate()}
            disabled={testTelegramMutation.isPending}
            variant="outline"
            className="w-full"
            data-testid="test-telegram"
          >
            <Send className="h-4 w-4 mr-2" />
            {testTelegramMutation.isPending ? "Sending test..." : "Send Test Message"}
          </Button>
        </CardContent>
      </Card>

      {/* District Management */}
      <Card data-testid="district-settings">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <SettingsIcon className="h-5 w-5 text-primary" />
            District Configuration
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Manage districts for multi-device capture
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={newDistrict}
              onChange={(e) => setNewDistrict(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleAddDistrict())}
              placeholder="Add new district..."
              className="text-sm"
              data-testid="new-district-input"
            />
            <Button onClick={handleAddDistrict} size="sm" data-testid="add-district">
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          <div className="space-y-1">
            {districts.map((d) => (
              <div
                key={d}
                className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2"
              >
                <span className="text-sm font-mono">{d}</span>
                <Button
                  onClick={() => handleRemoveDistrict(d)}
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                  data-testid={`remove-district-${d}`}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Keyword & Homophone Management */}
      <Card data-testid="keyword-settings">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Tag className="h-5 w-5 text-primary" />
            Keywords &amp; Homophones
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Transcription is filtered for these terms. Add a homophone by giving it the same Signal Type as the term it should be treated the same as (e.g. "signal for" → Signal 4).
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Input
              value={newPattern}
              onChange={(e) => setNewPattern(e.target.value)}
              placeholder="Pattern / homophone (e.g. signal for)"
              className="text-sm"
              data-testid="new-keyword-pattern-input"
            />
            <Input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Display label (optional)"
              className="text-sm"
              data-testid="new-keyword-label-input"
            />
            <div className="flex gap-2">
              <Input
                value={newSignalType}
                onChange={(e) => setNewSignalType(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleAddKeyword())}
                placeholder="Signal type (optional)"
                className="text-sm"
                data-testid="new-keyword-signaltype-input"
              />
              <Button onClick={handleAddKeyword} size="sm" disabled={isAdding} data-testid="add-keyword">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {keywordsLoading ? (
            <p className="text-xs text-muted-foreground">Loading keywords…</p>
          ) : (
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {keywords.map((kw) => (
                <div
                  key={kw.pattern}
                  className="flex items-center justify-between rounded-md border border-orange-900/30 bg-orange-500/10 px-3 py-2"
                  data-testid={`keyword-row-${kw.pattern}`}
                >
                  <div className="flex flex-col">
                    <span className="text-sm font-mono text-orange-300">{kw.pattern}</span>
                    <span className="text-[10px] text-muted-foreground">
                      label: {kw.label} · signal: {kw.signalType}
                    </span>
                  </div>
                  <Button
                    onClick={() => removeKeyword(kw.pattern)}
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    data-testid={`remove-keyword-${kw.pattern}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
              {keywords.length === 0 && (
                <p className="text-xs text-muted-foreground italic">No keywords configured.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
