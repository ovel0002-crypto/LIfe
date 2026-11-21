import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { ProposalList, describe } from "../../components/Proposals";
import { ScreenshotUpload } from "../../components/ScreenshotUpload";
import { Button, Card, Screen, SectionHeader, Title } from "../../components/ui";
import { post } from "../../lib/api";
import { fmtDay, fmtTime } from "../../lib/format";
import { act, useApi } from "../../lib/hooks";
import { radius, space, useTheme } from "../../lib/theme";
import type { Change } from "../../lib/types";

/** Things the connectors picked up, waiting for one-tap approval, plus a history you can undo. */
export default function InboxScreen() {
  const t = useTheme();
  const { data: proposed } = useApi<Change[]>("/api/changes?status=proposed");
  const { data: applied } = useApi<Change[]>("/api/changes?status=applied");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);

  const capture = async () => {
    if (!note.trim()) return;
    setBusy(true);
    const r = await act(() => post<{ summary: string }>("/api/capture/text", { text: note }));
    setBusy(false);
    setNote("");
    setReply(r.summary);
  };

  const history = (applied ?? []).filter((c) => c.entityType === "task" || c.entityType === "event").slice(0, 25);

  return (
    <Screen>
      <Title sub="Picked up from email, Moodle, Notion, Discord and screenshots">Inbox</Title>

      <SectionHeader title="To review" count={proposed?.length ?? 0} />
      <ProposalList changes={proposed ?? []} />

      <SectionHeader title="Capture" hint="Paste a message, forward a thought — I'll pull out what matters" />
      <Card style={{ gap: space.md }}>
        <TextInput
          value={note}
          onChangeText={setNote}
          multiline
          placeholder={'e.g. "Jess: bbq at mine sat arvo? also can you bring the speaker"'}
          placeholderTextColor={t.faint}
          style={{ minHeight: 70, color: t.text, fontSize: 15, backgroundColor: t.cardAlt, borderRadius: radius.sm, padding: 10, textAlignVertical: "top" }}
        />
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Button label="Pull out tasks & plans" icon="sparkles-outline" small onPress={capture} loading={busy} />
        </View>
        {reply ? <Text style={{ color: t.sub }}>{reply}</Text> : null}
        <ScreenshotUpload label="Or upload screenshots" />
      </Card>

      <SectionHeader title="Recent changes" hint="Anything automatic can be undone" />
      {history.map((c) => {
        const d = describe(c);
        return (
          <View key={c.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.line }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontSize: 14 }} numberOfLines={1}>
                {c.reason ?? c.op} · {d.title}
              </Text>
              <Text style={{ color: t.faint, fontSize: 12 }}>
                {c.actor} · {fmtDay(c.at)} {fmtTime(c.at)}
              </Text>
            </View>
            <Button label="Undo" kind="ghost" small onPress={() => act(() => post(`/api/changes/${c.id}/revert`))} />
          </View>
        );
      })}
    </Screen>
  );
}
