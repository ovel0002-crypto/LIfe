import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { Button, Card, Screen, Title } from "../components/ui";
import { post } from "../lib/api";
import { invalidateAll } from "../lib/hooks";
import { radius, space, useTheme } from "../lib/theme";

/**
 * Drop-off page for weekly browser runs (Claude in Chrome): it pastes what it read from
 * Instagram/Humanforce here and presses "Send to Life". You can use it by hand too.
 */
export default function CaptureScreen() {
  const t = useTheme();
  const { source = "messages", kind = "messages" } = useLocalSearchParams<{ source?: string; kind?: string }>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await post<{ summary: string; proposed: number }>("/api/capture/pull", { source, kind, text });
      setResult(`Sent. ${r.summary}${r.proposed ? ` — ${r.proposed} thing(s) waiting in Inbox.` : ""}`);
      setText("");
      invalidateAll();
    } catch (e) {
      setResult(`Couldn't send: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title sub={`From ${source} · I'll pull out plans, invites, shifts and asks for you to confirm`}>Send to Life</Title>
      <Card style={{ gap: space.md }}>
        <TextInput
          testID="capture-text"
          accessibilityLabel="Captured text"
          value={text}
          onChangeText={setText}
          multiline
          placeholder={kind === "roster" ? "Mon 24 Nov 5:00pm–10:00pm Grill'd Clayton…" : "[Jess] (Sat 3:12pm) bbq at mine sat arvo?"}
          placeholderTextColor={t.faint}
          style={{ minHeight: 260, color: t.text, fontSize: 15, backgroundColor: t.cardAlt, borderRadius: radius.sm, padding: 12, textAlignVertical: "top" }}
        />
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button label="Send to Life" icon="paper-plane-outline" onPress={send} loading={busy} disabled={!text.trim()} />
          <Button label="Open Inbox" kind="ghost" onPress={() => router.push("/inbox")} />
        </View>
        {result ? (
          <Text testID="capture-result" style={{ color: t.sub }}>
            {result}
          </Text>
        ) : null}
      </Card>
    </Screen>
  );
}
