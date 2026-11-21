import { Ionicons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ActionSheet, Empty, Screen, Title, type SheetAction } from "../../components/ui";
import { patch, post, api } from "../../lib/api";
import { fmtDay, fmtMins, fmtTime } from "../../lib/format";
import { act, useApi } from "../../lib/hooks";
import { areaColor, radius, space, useTheme } from "../../lib/theme";
import type { CalEvent, DayMode, PlanResult, Task } from "../../lib/types";

type Row = { key: string; start: string; end: string; title: string; kind: "block" | "event"; area?: string; event?: CalEvent };

const LOCK_LABEL = { hard: "Locked", soft: "Ask first", flexible: "Flexible" } as const;

/** List-first agenda: the calendar exists to serve the list, so the week reads like one too. */
export default function WeekScreen() {
  const t = useTheme();
  const { data: plan } = useApi<PlanResult>("/api/plan");
  const { data: events } = useApi<CalEvent[]>("/api/events");
  const { data: tasks } = useApi<Task[]>("/api/tasks");
  const [menu, setMenu] = useState<{ title: string; actions: SheetAction[] } | null>(null);

  const days = useMemo(() => {
    if (!plan) return [];
    const byId = new Map((tasks ?? []).map((x) => [x.id, x]));
    return plan.days.slice(0, 7).map((d) => {
      const rows: Row[] = [];
      for (const b of plan.blocks) {
        if (localDate(b.start) !== d.date) continue;
        const task = byId.get(b.taskId);
        rows.push({ key: b.id, start: b.start, end: b.end, title: task?.title ?? "Work block", kind: "block", area: task?.area });
      }
      for (const e of events ?? []) {
        const day = e.certainty === "unknown-time" ? e.day ?? localDate(e.start) : localDate(e.start);
        if (day !== d.date) continue;
        rows.push({ key: e.id, start: e.start, end: e.end, title: e.title, kind: "event", area: e.area, event: e });
      }
      rows.sort((a, b) => a.start.localeCompare(b.start));
      return { ...d, rows };
    });
  }, [plan, events, tasks]);

  const eventActions = (e: CalEvent): SheetAction[] => [
    { label: "Locked — never move", icon: "lock-closed-outline", onPress: () => act(() => patch(`/api/events/${e.id}`, { lock: "hard" })) },
    { label: "Ask before moving", icon: "hand-left-outline", onPress: () => act(() => patch(`/api/events/${e.id}`, { lock: "soft" })) },
    { label: "Flexible — move it if needed", icon: "swap-vertical-outline", onPress: () => act(() => patch(`/api/events/${e.id}`, { lock: "flexible" })) },
    e.certainty === "confirmed"
      ? { label: "Mark as maybe", icon: "help-outline", onPress: () => act(() => patch(`/api/events/${e.id}`, { certainty: "maybe" })) }
      : { label: "It's confirmed", icon: "checkmark-outline", onPress: () => act(() => patch(`/api/events/${e.id}`, { certainty: "confirmed" })) },
    { label: "Cancelled — remove", icon: "trash-outline", destructive: true, onPress: () => act(() => api(`/api/events/${e.id}`, { method: "DELETE" })) },
  ];

  const dayActions = (date: string): SheetAction[] =>
    (["normal", "low-energy", "busy", "sick", "free"] as DayMode[]).map((mode) => ({
      label: { normal: "Normal day", "low-energy": "Low energy", busy: "Unexpectedly busy", sick: "Sick", free: "Free day" }[mode],
      icon: "ellipse-outline",
      onPress: () => act(() => post("/api/daymode", { date, mode })),
    }));

  return (
    <Screen>
      <Title sub="Your plan re-flows whenever anything changes">This week</Title>
      {(plan?.conflicts ?? []).map((c, i) => (
        <View key={i} style={{ backgroundColor: t.warnSoft, borderRadius: radius.md, padding: space.md, marginBottom: space.sm }}>
          <Text style={{ color: t.text, fontWeight: "600" }}>{c.message}</Text>
          <Text style={{ color: t.sub, marginTop: 4, fontSize: 13 }}>Options: {c.options.join(" · ")}</Text>
        </View>
      ))}
      {days.map((d) => {
        const load = d.capacityMinutes ? d.plannedMinutes / Math.max(d.capacityMinutes, 1) : 0;
        return (
          <View key={d.date} style={{ marginTop: space.lg }}>
            <Pressable onPress={() => setMenu({ title: `How's ${fmtDay(d.date + "T12:00:00")} looking?`, actions: dayActions(d.date) })} style={{ flexDirection: "row", alignItems: "baseline", marginBottom: space.sm }}>
              <Text style={{ fontSize: 18, fontWeight: "700", color: t.text, flex: 1 }}>
                {fmtDay(d.date + "T12:00:00")}
                {d.mode !== "normal" ? <Text style={{ color: t.warn, fontSize: 14 }}>  · {d.mode}</Text> : null}
              </Text>
              <Text style={{ color: load > 0.95 ? t.warn : t.faint, fontSize: 13 }}>
                {fmtMins(d.plannedMinutes)} of {fmtMins(d.capacityMinutes)} planned
              </Text>
            </Pressable>
            {d.rows.length === 0 ? <Empty icon="sunny-outline" text="Open day" /> : null}
            {d.rows.map((r) => {
              const e = r.event;
              const color = areaColor[r.area ?? ""] ?? t.faint;
              const tentative = e && (e.certainty === "maybe" || e.certainty === "unknown-time");
              return (
                <Pressable
                  key={r.key}
                  onPress={() => e && setMenu({ title: e.title, actions: eventActions(e) })}
                  style={{
                    flexDirection: "row",
                    gap: space.md,
                    paddingVertical: 10,
                    paddingHorizontal: space.md,
                    marginBottom: 6,
                    borderRadius: radius.sm + 2,
                    backgroundColor: r.kind === "block" ? t.card : t.cardAlt,
                    borderWidth: 1,
                    borderColor: tentative ? t.warn : t.line,
                    borderStyle: tentative ? "dashed" : "solid",
                  }}
                >
                  <View style={{ width: 3, borderRadius: 2, backgroundColor: color }} />
                  <View style={{ width: 66 }}>
                    <Text style={{ color: t.sub, fontSize: 13, fontWeight: "600" }}>{e?.certainty === "unknown-time" ? "TBC" : fmtTime(r.start)}</Text>
                    {e?.certainty !== "unknown-time" ? <Text style={{ color: t.faint, fontSize: 12 }}>{fmtTime(r.end)}</Text> : null}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: t.text, fontSize: 15, fontWeight: r.kind === "block" ? "500" : "400" }}>{r.title}</Text>
                    {e ? (
                      <Text style={{ color: t.faint, fontSize: 12, marginTop: 2 }}>
                        {LOCK_LABEL[e.lock]}
                        {tentative ? " · not confirmed" : ""}
                        {e.location ? ` · ${e.location}` : ""}
                      </Text>
                    ) : (
                      <Text style={{ color: t.faint, fontSize: 12, marginTop: 2 }}>Planned work</Text>
                    )}
                  </View>
                  {e?.lock === "hard" ? <Ionicons name="lock-closed" size={14} color={t.sub} /> : null}
                </Pressable>
              );
            })}
          </View>
        );
      })}
      <ActionSheet visible={!!menu} title={menu?.title} actions={menu?.actions ?? []} onClose={() => setMenu(null)} />
    </Screen>
  );
}

function localDate(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
