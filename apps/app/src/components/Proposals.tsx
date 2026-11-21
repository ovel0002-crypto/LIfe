import { Ionicons } from "@expo/vector-icons";
import { Text, View } from "react-native";
import { post } from "../lib/api";
import { fmtDay, fmtTime } from "../lib/format";
import { act } from "../lib/hooks";
import { radius, sourceLabel, space, useTheme } from "../lib/theme";
import type { Change } from "../lib/types";
import { Button, Empty } from "./ui";

/** Plain-English summary of a proposed change. */
export function describe(c: Change): { title: string; detail: string; icon: "checkbox-outline" | "calendar-outline" | "create-outline" | "trash-outline" } {
  const a = (c.after ?? c.before ?? {}) as Record<string, unknown>;
  const when = (iso?: unknown) => (typeof iso === "string" ? `${fmtDay(iso)} ${fmtTime(iso)}` : "");
  if (c.entityType === "task") {
    const due = a.due ? `due ${when(a.due)}` : "";
    const verb = c.op === "create" ? (a.status === "waiting" ? "Waiting on" : "New task") : c.op === "delete" ? "Remove task" : "Update task";
    return { title: String(a.title ?? "Task"), detail: [verb, due, a.waitingOn ? `from ${a.waitingOn}` : ""].filter(Boolean).join(" · "), icon: c.op === "delete" ? "trash-outline" : c.op === "create" ? "checkbox-outline" : "create-outline" };
  }
  if (c.entityType === "event") {
    const time = a.certainty === "unknown-time" ? `${a.day ?? ""} (time TBC)` : when(a.start);
    const verb = c.op === "create" ? "New event" : c.op === "delete" ? "Cancel event" : "Change event";
    const tag = a.certainty === "maybe" ? "maybe" : a.lock === "hard" ? "locked" : "";
    return { title: String(a.title ?? "Event"), detail: [verb, time, tag].filter(Boolean).join(" · "), icon: c.op === "delete" ? "trash-outline" : "calendar-outline" };
  }
  return { title: `${c.op} ${c.entityType}`, detail: c.reason ?? "", icon: "create-outline" };
}

export function ProposalList({ changes, emptyText = "Nothing waiting for review." }: { changes: Change[]; emptyText?: string }) {
  const t = useTheme();
  if (!changes.length) return <Empty icon="checkmark-done-outline" text={emptyText} />;
  return (
    <View style={{ gap: 8 }}>
      {changes.map((c) => {
        const d = describe(c);
        return (
          <View key={c.id} style={{ backgroundColor: t.card, borderRadius: radius.md, borderWidth: 1, borderColor: t.line, padding: space.md, gap: 8 }}>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Ionicons name={d.icon} size={20} color={t.accent} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>{d.title}</Text>
                <Text style={{ color: t.sub, fontSize: 13, marginTop: 2 }}>{d.detail}</Text>
                <Text style={{ color: t.faint, fontSize: 12, marginTop: 2 }}>From {sourceLabel[(c.after as { source?: string })?.source ?? ""] ?? c.actor}</Text>
              </View>
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button label="Add" icon="checkmark" small onPress={() => act(() => post(`/api/changes/${c.id}/accept`))} />
              <Button label="Not right" kind="ghost" small onPress={() => act(() => post(`/api/changes/${c.id}/reject`))} />
            </View>
          </View>
        );
      })}
    </View>
  );
}
