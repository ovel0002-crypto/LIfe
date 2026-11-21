import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Button, Card, Chip, Empty, Screen, Title } from "../components/ui";
import { patch, post } from "../lib/api";
import { act, useApi } from "../lib/hooks";
import { space, useTheme } from "../lib/theme";
import type { CloseOutItem } from "../lib/types";

const LABEL: Record<CloseOutItem["suggestion"], string> = {
  tomorrow: "Tomorrow",
  "later-this-week": "Later this week",
  "break-down": "Break it down",
  drop: "Drop it",
};

/** One-minute end-of-day close-out: one tap per unfinished thing. */
export default function CloseOutScreen() {
  const t = useTheme();
  const { data } = useApi<CloseOutItem[]>("/api/closeout");
  const [handled, setHandled] = useState<Set<string>>(new Set());

  const apply = async (i: CloseOutItem, choice: CloseOutItem["suggestion"] | "done") => {
    setHandled((h) => new Set(h).add(i.taskId));
    if (choice === "done") return act(() => post(`/api/tasks/${i.taskId}/done`));
    if (choice === "tomorrow") return act(() => post(`/api/tasks/${i.taskId}/defer`, { until: "tomorrow" }));
    if (choice === "later-this-week") {
      const d = new Date();
      d.setDate(d.getDate() + 2);
      d.setHours(8, 0, 0, 0);
      return act(() => post(`/api/tasks/${i.taskId}/defer`, { until: d.toISOString() }));
    }
    if (choice === "break-down") return act(() => post(`/api/tasks/${i.taskId}/breakdown`, {}));
    return act(() => patch(`/api/tasks/${i.taskId}`, { status: "dropped" }));
  };

  const left = (data ?? []).filter((i) => !handled.has(i.taskId));

  return (
    <Screen>
      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="close" size={26} color={t.sub} />
        </Pressable>
      </View>
      <Title sub="Move today's leftovers on — no guilt, one tap each">Close out</Title>
      {data && left.length === 0 ? (
        <Card style={{ alignItems: "center", gap: space.md }}>
          <Ionicons name="moon" size={40} color={t.accent} />
          <Text style={{ color: t.text, fontSize: 18, fontWeight: "700" }}>All squared away</Text>
          <Text style={{ color: t.sub, textAlign: "center" }}>Tomorrow's list is ready. Have a good night.</Text>
          <Button label="Done" onPress={() => router.back()} />
        </Card>
      ) : null}
      {!data ? <Empty icon="hourglass-outline" text="Loading…" /> : null}
      {left.map((i) => (
        <Card key={i.taskId} style={{ marginBottom: space.md, gap: 8 }}>
          <Text style={{ color: t.text, fontSize: 16, fontWeight: "600" }}>{i.title}</Text>
          <Text style={{ color: t.faint, fontSize: 13 }}>{i.why}</Text>
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            <Chip label={LABEL[i.suggestion]} active onPress={() => apply(i, i.suggestion)} />
            <Chip label="Actually done" tone="good" onPress={() => apply(i, "done")} />
            {(["tomorrow", "later-this-week", "break-down", "drop"] as const)
              .filter((s) => s !== i.suggestion)
              .map((s) => (
                <Chip key={s} label={LABEL[s]} onPress={() => apply(i, s)} />
              ))}
          </View>
        </Card>
      ))}
    </Screen>
  );
}
