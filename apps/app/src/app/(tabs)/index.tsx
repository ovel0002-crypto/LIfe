import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { ChatSheet } from "../../components/ChatSheet";
import { NowCard } from "../../components/NowCard";
import { TaskItem } from "../../components/TaskItem";
import { ActionSheet, Button, Card, Chip, Empty, Screen, SectionHeader, Toast, type SheetAction } from "../../components/ui";
import { patch, post } from "../../lib/api";
import { fmtMins, greeting } from "../../lib/format";
import { act, useApi } from "../../lib/hooks";
import { success } from "../../lib/haptics";
import { radius, space, useTheme } from "../../lib/theme";
import type { Conflict, DayMode, TodayItem, TodayList } from "../../lib/types";

type Today = TodayList & { conflicts: Conflict[]; freshStart?: { message: string } };

const MODES: { mode: DayMode; label: string; icon: "sunny-outline" | "battery-half-outline" | "medkit-outline" | "flash-outline" | "happy-outline" }[] = [
  { mode: "normal", label: "Normal", icon: "sunny-outline" },
  { mode: "low-energy", label: "Low energy", icon: "battery-half-outline" },
  { mode: "busy", label: "Slammed", icon: "flash-outline" },
  { mode: "sick", label: "Sick", icon: "medkit-outline" },
  { mode: "free", label: "Free day", icon: "happy-outline" },
];

export default function TodayScreen() {
  const t = useTheme();
  const { data, error, reload } = useApi<Today>("/api/today", { refreshMs: 60_000 });
  const { data: plan } = useApi<{ days: { date: string; mode: DayMode }[] }>("/api/plan");
  const { data: ob } = useApi<{ banner: "setup" | "retune" | null }>("/api/onboarding");
  const [menu, setMenu] = useState<TodayItem | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const [reorder, setReorder] = useState(false);
  const [order, setOrder] = useState<string[] | null>(null);
  const [prefill, setPrefill] = useState<string | undefined>();
  const params = useLocalSearchParams<{ checkin?: string; action?: string }>();

  // Notification actions open the app with ?checkin=<block>&action=<response>.
  useEffect(() => {
    if (params.checkin && params.action) {
      act(() => post(`/api/checkins/${params.checkin}`, { response: params.action })).then(() => flash("Got it — plan updated"));
      router.setParams({ checkin: undefined, action: undefined });
    }
  }, [params.checkin, params.action]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(id);
  }, [toast]);

  const flash = (text: string, undo?: () => void) => setToast({ text, undo });

  const done = useCallback(async (i: TodayItem) => {
    if (!i.taskId) return;
    success();
    const r = await act(() => post<{ changeId?: string }>(`/api/tasks/${i.taskId}/done`));
    flash(`Done: ${i.title}`, r.changeId ? () => act(() => post(`/api/changes/${r.changeId}/revert`)) : undefined);
  }, []);

  const defer = useCallback(async (i: TodayItem, until: "tomorrow" | "next-week" = "tomorrow") => {
    if (!i.taskId) return;
    await act(() => post(`/api/tasks/${i.taskId}/defer`, { until }));
    flash(until === "tomorrow" ? "Moved to tomorrow" : "Moved to next week", () => act(() => patch(`/api/tasks/${i.taskId}`, { deferredUntil: null })));
  }, []);

  const breakdown = async (i: TodayItem, stuck: boolean) => {
    flash(stuck ? "Finding an easy first step…" : "Breaking it down…");
    const r = await act(() => post<{ reply: string }>(`/api/tasks/${i.taskId}/breakdown`, { stuck }));
    flash(r.reply);
  };

  const progress = async (i: TodayItem, body: { minutesSpent: number; fractionDone?: number }) => {
    await act(() => post(`/api/tasks/${i.taskId}/progress`, body));
    flash("Progress saved — re-planned the rest");
  };

  const setMode = async (mode: DayMode) => {
    await act(() => post("/api/daymode", { mode }));
    flash(mode === "normal" ? "Back to a normal day" : mode === "sick" ? "Rest up — only true musts stay. Everything else moved." : "Re-planned for how today's going");
  };

  const checkin = async (response: "on-it" | "done") => {
    const n = data?.now;
    if (!n) return;
    if (n.blockId) await act(() => post(`/api/checkins/${n.blockId}`, { response }));
    else if (response === "done" && n.taskId) await done(n);
    else if (n.taskId) await act(() => patch(`/api/tasks/${n.taskId}`, { status: "doing" }));
    if (response === "on-it") flash("Nice. I'll keep the rest of the day flowing around it.");
  };

  const should = useMemo(() => {
    const list = data?.should ?? [];
    if (!order) return list;
    return [...list].sort((a, b) => order.indexOf(a.taskId!) - order.indexOf(b.taskId!));
  }, [data?.should, order]);

  const move = (idx: number, dir: -1 | 1) => {
    const ids = should.map((i) => i.taskId!);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    setOrder(ids);
  };

  const saveOrder = async () => {
    if (order) await act(() => post("/api/tasks/reorder", { ids: order }));
    setOrder(null);
    setReorder(false);
    flash("Order saved — your calendar follows");
  };

  const actions = (i: TodayItem): SheetAction[] =>
    i.kind !== "task"
      ? [{ label: "Tell Life about this", icon: "chatbubble-outline", onPress: () => setPrefill(`About "${i.title}": `) }]
      : [
          { label: "Details & steps", icon: "document-text-outline", onPress: () => router.push(`/task/${i.taskId}`) },
          { label: "Done", icon: "checkmark-circle-outline", onPress: () => done(i) },
          { label: "Did some — about half", icon: "pie-chart-outline", onPress: () => progress(i, { minutesSpent: Math.round((i.minutes ?? 60) / 2), fractionDone: 0.5 }) },
          { label: "Did 30 minutes", icon: "time-outline", onPress: () => progress(i, { minutesSpent: 30 }) },
          { label: "Not today", icon: "arrow-forward-circle-outline", onPress: () => defer(i, "tomorrow") },
          { label: "Next week", icon: "calendar-outline", onPress: () => defer(i, "next-week") },
          { label: "Too big — break it down", icon: "git-branch-outline", onPress: () => breakdown(i, false) },
          { label: "I'm stuck starting", icon: "help-buoy-outline", onPress: () => breakdown(i, true) },
          { label: "Must do today", icon: "flag-outline", onPress: () => act(() => patch(`/api/tasks/${i.taskId}`, { mustToday: data?.date })).then(() => flash("Marked as a must today")) },
          { label: "Change something…", icon: "create-outline", onPress: () => setPrefill(`For "${i.title}": `) },
          { label: "Drop it", icon: "trash-outline", destructive: true, onPress: () => act(() => patch(`/api/tasks/${i.taskId}`, { status: "dropped" })).then(() => flash("Dropped", () => act(() => patch(`/api/tasks/${i.taskId}`, { status: "todo" })))) },
        ];

  const todayMode = plan?.days?.[0]?.mode ?? "normal";
  const dateLabel = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  const evening = new Date().getHours() >= 18;
  const dow = new Date().getDay();

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Screen>
        <View style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: space.md }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.sub, fontSize: 15 }}>{dateLabel}</Text>
            <Text style={{ fontSize: 30, fontWeight: "700", color: t.text, letterSpacing: -0.5 }}>{greeting()}</Text>
          </View>
          {data ? (
            <View style={{ alignItems: "flex-end", paddingTop: 4 }}>
              <Text style={{ color: t.text, fontWeight: "700", fontSize: 18 }}>
                {data.stats.doneToday}/{Math.max(data.stats.totalToday, data.stats.doneToday)}
              </Text>
              <Text style={{ color: t.faint, fontSize: 12 }}>done · {fmtMins(data.stats.plannedMinutes)} planned</Text>
            </View>
          ) : null}
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.lg, marginBottom: space.lg }} contentContainerStyle={{ gap: 6, paddingHorizontal: space.lg }}>
          {MODES.map((m) => (
            <Chip key={m.mode} label={m.label} icon={m.icon} active={todayMode === m.mode} onPress={() => setMode(m.mode)} />
          ))}
        </ScrollView>

        {error && !data ? (
          <Card>
            <Text style={{ color: t.bad, fontWeight: "600" }}>Can't reach your Life server</Text>
            <Text style={{ color: t.sub, marginTop: 4 }}>{error.message}. Check Settings → Server.</Text>
          </Card>
        ) : null}

        {ob?.banner ? (
          <Card style={{ backgroundColor: t.accentSoft, borderColor: t.accentSoft, marginBottom: space.md }}>
            <Text style={{ color: t.text, fontWeight: "600" }}>
              {ob.banner === "setup" ? "Set up Life (about 5 minutes)" : "2-minute re-tune: has anything changed?"}
            </Text>
            <Text style={{ color: t.sub, marginTop: 2 }}>
              {ob.banner === "setup" ? "Connect your stuff, check what I noticed, and tell me about your projects." : "New roster pattern, new projects, different hours? Let's keep the plan honest."}
            </Text>
            <View style={{ marginTop: space.md, flexDirection: "row", gap: 8 }}>
              <Button label={ob.banner === "setup" ? "Start" : "Re-tune"} icon="sparkles-outline" small onPress={() => router.push("/onboarding")} />
              {ob.banner === "retune" ? <Button label="Not now" small kind="ghost" onPress={() => act(() => post("/api/onboarding/retune/dismiss"))} /> : null}
            </View>
          </Card>
        ) : null}

        {data?.freshStart ? (
          <Card style={{ backgroundColor: t.accentSoft, borderColor: t.accentSoft, marginBottom: space.md }}>
            <Text style={{ color: t.text, fontWeight: "600" }}>{data.freshStart.message}</Text>
            <View style={{ marginTop: space.md, flexDirection: "row" }}>
              <Button label="Fresh start review" icon="refresh" small onPress={() => router.push("/review")} />
            </View>
          </Card>
        ) : null}

        {(data?.conflicts ?? []).slice(0, 2).map((c, idx) => (
          <Card key={idx} style={{ backgroundColor: t.warnSoft, borderColor: t.warnSoft, marginBottom: space.md }}>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Ionicons name="alert-circle" size={18} color={t.warn} />
              <Text style={{ color: t.text, fontWeight: "600", flex: 1 }}>{c.message}</Text>
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: space.md }}>
              {c.options.map((o) => (
                <Chip key={o} label={o} tone="warn" onPress={() => setPrefill(`About "${c.message}" — let's do this: ${o}`)} />
              ))}
            </View>
          </Card>
        ))}

        {data?.now ? (
          <NowCard
            item={data.now}
            onStart={() => checkin("on-it")}
            onDone={() => checkin("done")}
            onNotNow={() => (data.now?.blockId ? act(() => post(`/api/checkins/${data.now!.blockId}`, { response: "snooze" })).then(() => flash("Pushed back 30 min")) : defer(data.now!))}
            onStuck={() => breakdown(data.now!, true)}
          />
        ) : data ? (
          <Card>
            <Empty icon="leaf-outline" text="Nothing scheduled right now. Pick something from below, or tell Life what's on your mind." />
          </Card>
        ) : null}

        {data?.must.length ? (
          <>
            <SectionHeader title="Must do" count={data.must.length} hint="Deadlines and locked plans" />
            {data.must.map((i) => (
              <TaskItem key={i.key} item={i} onDone={() => done(i)} onDefer={() => defer(i)} onMenu={() => setMenu(i)} />
            ))}
          </>
        ) : null}

        <SectionHeader
          title="Should do"
          count={should.length}
          hint="Planned into your day"
          right={
            should.length > 1 ? (
              reorder ? (
                <Button label="Save order" small onPress={saveOrder} />
              ) : (
                <Pressable onPress={() => setReorder(true)} hitSlop={8}>
                  <Text style={{ color: t.accent, fontWeight: "600" }}>Reorder</Text>
                </Pressable>
              )
            ) : null
          }
        />
        {should.length ? (
          should.map((i, idx) => (
            <TaskItem key={i.key} item={i} reorder={reorder} onMove={(d) => move(idx, d)} onDone={() => done(i)} onDefer={() => defer(i)} onMenu={() => setMenu(i)} />
          ))
        ) : (
          <Empty icon="sparkles-outline" text={data ? "No planned work blocks today." : "Loading…"} />
        )}

        {data?.could.length ? (
          <>
            <SectionHeader title="Could do" count={data.could.length} hint="Quick wins if you have a gap" />
            {data.could.map((i) => (
              <TaskItem key={i.key} item={i} onDone={() => done(i)} onDefer={() => defer(i)} onMenu={() => setMenu(i)} />
            ))}
          </>
        ) : null}

        {data?.tentative.length ? (
          <>
            <SectionHeader title="Up in the air" count={data.tentative.length} hint="Not confirmed — I've left room" />
            {data.tentative.map((i) => (i.kind === "question" ? <QuestionCard key={i.key} item={i} onAnswered={(r) => flash(r)} /> : <TaskItem key={i.key} item={i} onMenu={() => setMenu(i)} />))}
          </>
        ) : null}

        {data?.waiting.length ? (
          <>
            <SectionHeader title="Waiting on" count={data.waiting.length} />
            {data.waiting.map((i) => (
              <TaskItem key={i.key} item={i} onDone={() => done(i)} onMenu={() => setMenu(i)} />
            ))}
          </>
        ) : null}

        <View style={{ flexDirection: "row", gap: 8, marginTop: space.xl, flexWrap: "wrap" }}>
          {evening ? <Button label="Close out today" icon="moon-outline" kind="secondary" onPress={() => router.push("/closeout")} /> : null}
          {dow === 0 || dow === 1 || dow === 6 ? <Button label="Weekly admin hour" icon="clipboard-outline" kind="secondary" onPress={() => router.push("/review")} /> : null}
          <Button label="Refresh" icon="refresh" kind="ghost" onPress={() => act(() => post("/api/replan")).then(reload)} />
        </View>
      </Screen>

      <ChatSheet prefill={prefill} onPrefillUsed={() => setPrefill(undefined)} />
      <Toast text={toast?.text} onUndo={toast?.undo} onHide={() => setToast(null)} />
      <ActionSheet visible={!!menu} title={menu?.title} actions={menu ? actions(menu) : []} onClose={() => setMenu(null)} />
    </View>
  );
}

function QuestionCard({ item, onAnswered }: { item: TodayItem; onAnswered: (reply: string) => void }) {
  const t = useTheme();
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!answer.trim()) return;
    setBusy(true);
    const r = await act(() => post<{ reply?: string }>(`/api/questions/${item.questionId}/answer`, { answer }));
    setBusy(false);
    onAnswered(r.reply ?? "Thanks — updated");
  };
  return (
    <View style={{ backgroundColor: t.card, borderRadius: radius.md, borderWidth: 1, borderColor: t.line, padding: space.md + 2, marginBottom: 8 }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Ionicons name="help-circle-outline" size={20} color={t.warn} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontSize: 16, fontWeight: "500" }}>{item.title}</Text>
          {item.why ? <Text style={{ color: t.faint, fontSize: 13, marginTop: 2 }}>{item.why}</Text> : null}
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 8, marginTop: space.sm }}>
        <TextInput
          value={answer}
          onChangeText={setAnswer}
          placeholder="Answer, or 'not sure yet'"
          placeholderTextColor={t.faint}
          onSubmitEditing={submit}
          style={{ flex: 1, backgroundColor: t.cardAlt, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 8, color: t.text, fontSize: 15 }}
        />
        <Button label="Save" small onPress={submit} loading={busy} />
        <Button label="Skip" small kind="ghost" onPress={() => act(() => post(`/api/questions/${item.questionId}/dismiss`))} />
      </View>
    </View>
  );
}
