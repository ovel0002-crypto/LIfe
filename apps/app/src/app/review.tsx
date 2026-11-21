import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { ProposalList } from "../components/Proposals";
import { ScreenshotUpload } from "../components/ScreenshotUpload";
import { Button, Card, Chip, Empty, ProgressBar, Screen } from "../components/ui";
import { patch, post } from "../lib/api";
import { fmtDay, fmtMins } from "../lib/format";
import { act, useApi } from "../lib/hooks";
import { radius, space, useTheme } from "../lib/theme";
import type { Change, Conflict, DaySummary, OpenQuestion, Preferences } from "../lib/types";

type Step = "screenshots" | "inbox" | "projects" | "uni" | "week" | "memory" | "commit";

interface ReviewData {
  state: { steps: Partial<Record<Step, string>>; short: boolean; completedAt?: string };
  steps: Step[];
  screenshots: { prompts: string[] };
  inbox: { proposed: Change[]; questions: OpenQuestion[] };
  projects: { id: string; title: string; stage?: string; stages?: string[]; doneThisWeek: string[]; open: { id: string; title: string }[] }[];
  uni: { id: string; title: string; due: string; progress: number; plannedMinutes: number }[];
  week: { days: DaySummary[]; conflicts: Conflict[] };
  memory: { id: string; subject: string; text: string }[];
}

const TITLES: Record<Step, { title: string; sub: string }> = {
  screenshots: { title: "Screenshots", sub: "Anything I can't see on my own" },
  inbox: { title: "Inbox sweep", sub: "Confirm what I picked up this week" },
  projects: { title: "Projects", sub: "Where is each one at?" },
  uni: { title: "Uni look-ahead", sub: "Next 3 weeks of assessments" },
  week: { title: "Shape the week", sub: "What deserves more of you?" },
  memory: { title: "What I learned", sub: "Fix anything I got wrong" },
  commit: { title: "Lock it in", sub: "I'll plan the week and build Monday's list" },
};

/**
 * The weekly admin hour: guided, resumable (progress saves after every step), every step
 * skippable, with a 15-minute short version.
 */
export default function ReviewScreen() {
  const t = useTheme();
  const { data } = useApi<ReviewData>("/api/review");
  const [note, setNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);

  const current: Step | undefined = useMemo(() => data?.steps.find((s) => !data.state.steps[s]), [data]);
  const doneCount = data ? data.steps.filter((s) => data.state.steps[s]).length : 0;

  const mark = (step: Step, outcome: "done" | "skipped" | "nothing", short?: boolean) => act(() => post("/api/review/step", { step, outcome, short }));
  const chat = async (message: string) => {
    setBusy(true);
    const r = await act(() => post<{ reply: string }>("/api/chat", { message }));
    setReply(r.reply);
    setBusy(false);
  };

  if (!data) return <Screen><Empty icon="hourglass-outline" text="Loading…" /></Screen>;

  return (
    <Screen>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: space.md }}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="close" size={26} color={t.sub} />
        </Pressable>
        <Text style={{ flex: 1, textAlign: "center", color: t.sub, fontWeight: "600" }}>Weekly admin hour</Text>
        <Pressable onPress={() => act(() => post("/api/review/short", { short: !data.state.short }))} hitSlop={10}>
          <Text style={{ color: t.accent, fontWeight: "600" }}>{data.state.short ? "Full version" : "Short version"}</Text>
        </Pressable>
      </View>
      <ProgressBar value={doneCount / data.steps.length} color={t.accent} />
      <Text style={{ color: t.faint, fontSize: 12, marginTop: 6 }}>
        Step {Math.min(doneCount + 1, data.steps.length)} of {data.steps.length} · saved as you go — stop any time
      </Text>

      {!current ? (
        <Card style={{ marginTop: space.xl, alignItems: "center", gap: space.md }}>
          <Ionicons name="checkmark-circle" size={48} color={t.good} />
          <Text style={{ fontSize: 20, fontWeight: "700", color: t.text }}>Week planned</Text>
          <Text style={{ color: t.sub, textAlign: "center" }}>Your calendar and Monday's list are ready. Things will still shift — I'll re-flow as they do.</Text>
          <Button label="Back to Today" onPress={() => router.replace("/")} />
        </Card>
      ) : (
        <View style={{ marginTop: space.xl }}>
          <Text style={{ fontSize: 26, fontWeight: "700", color: t.text, letterSpacing: -0.4 }}>{TITLES[current].title}</Text>
          <Text style={{ color: t.sub, fontSize: 15, marginTop: 2, marginBottom: space.lg }}>{TITLES[current].sub}</Text>

          {current === "screenshots" ? <PullsCard /> : null}
          {current === "screenshots" ? (
            <Card style={{ gap: space.md }}>
              {data.screenshots.prompts.map((p) => (
                <View key={p} style={{ flexDirection: "row", gap: 8 }}>
                  <Ionicons name="image-outline" size={18} color={t.sub} />
                  <Text style={{ color: t.text, flex: 1 }}>{p}</Text>
                </View>
              ))}
              <ScreenshotUpload hint="Weekly review screenshots: chats with plans, rosters, posters" />
              <Text style={{ color: t.faint, fontSize: 13 }}>What I find shows up in the next step for you to confirm.</Text>
            </Card>
          ) : null}

          {current === "inbox" ? (
            <View style={{ gap: space.md }}>
              <ProposalList changes={data.inbox.proposed} emptyText="Nothing waiting — all caught up." />
              {data.inbox.questions.map((q) => (
                <Card key={q.id} style={{ gap: 8 }}>
                  <Text style={{ color: t.text, fontWeight: "600" }}>{q.question}</Text>
                  <TextInput
                    value={note[q.id] ?? ""}
                    onChangeText={(v) => setNote({ ...note, [q.id]: v })}
                    placeholder="Answer, or 'not sure yet'"
                    placeholderTextColor={t.faint}
                    style={{ backgroundColor: t.cardAlt, borderRadius: radius.sm, padding: 10, color: t.text }}
                  />
                  <View style={{ flexDirection: "row" }}>
                    <Button label="Save" small onPress={() => act(() => post(`/api/questions/${q.id}/answer`, { answer: note[q.id] ?? "" }))} />
                  </View>
                </Card>
              ))}
            </View>
          ) : null}

          {current === "projects" ? (
            <View style={{ gap: space.md }}>
              {data.projects.length === 0 ? <Empty icon="layers-outline" text="No projects yet — add some in the Projects tab or tell me about them." /> : null}
              {data.projects.map((p) => (
                <Card key={p.id} style={{ gap: 8 }}>
                  <Text style={{ color: t.text, fontSize: 17, fontWeight: "700" }}>{p.title}</Text>
                  <Text style={{ color: t.sub, fontSize: 13 }}>
                    {p.stage ?? "No stage set"} · done this week: {p.doneThisWeek.length ? p.doneThisWeek.join(", ") : "nothing yet"}
                  </Text>
                  {p.stages?.length ? (
                    <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                      {p.stages.map((s) => (
                        <Chip key={s} label={s} active={p.stage === s} onPress={() => act(() => patch(`/api/projects/${p.id}`, { stage: s }))} />
                      ))}
                    </View>
                  ) : null}
                  <TextInput
                    value={note[p.id] ?? ""}
                    onChangeText={(v) => setNote({ ...note, [p.id]: v })}
                    placeholder="What happened? What's blocking it?"
                    placeholderTextColor={t.faint}
                    multiline
                    style={{ backgroundColor: t.cardAlt, borderRadius: radius.sm, padding: 10, color: t.text, minHeight: 44 }}
                  />
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Button
                      label="Plan next week's steps"
                      small
                      loading={busy}
                      onPress={() =>
                        chat(
                          `Weekly review for project "${p.title}" [${p.id}]. Stage: ${p.stage ?? "unknown"}. Open steps: ${p.open.map((o) => o.title).join("; ") || "none"}. My update: ${note[p.id] || "no update"}. Update the stage if it changed, drop steps that no longer make sense, and add the next 2–3 concrete steps for this week.`,
                        )
                      }
                    />
                    <Button label="Pause it" small kind="ghost" onPress={() => act(() => patch(`/api/projects/${p.id}`, { status: "paused" }))} />
                  </View>
                </Card>
              ))}
              {reply ? <Text style={{ color: t.sub }}>{reply}</Text> : null}
            </View>
          ) : null}

          {current === "uni" ? (
            <View style={{ gap: 8 }}>
              {data.uni.length === 0 ? <Empty icon="school-outline" text="No assessments in the next 3 weeks." /> : null}
              {data.uni.map((u) => (
                <Card key={u.id} style={{ gap: 6 }}>
                  <Text style={{ color: t.text, fontWeight: "600", fontSize: 16 }}>{u.title}</Text>
                  <Text style={{ color: t.sub, fontSize: 13 }}>
                    Due {fmtDay(u.due)} · {Math.round(u.progress * 100)}% done · {fmtMins(u.plannedMinutes)} planned
                  </Text>
                  <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                    <Chip label="On track" tone="good" />
                    <Chip label="Needs more time" tone="warn" onPress={() => chat(`I'm behind on "${u.title}" [${u.id}]. It needs more time than planned — increase the remaining estimate sensibly and prioritise it.`)} />
                    <Chip label="Haven't started" onPress={() => chat(`I haven't started "${u.title}" [${u.id}]. Break it down with a 10-minute starter step first.`)} />
                  </View>
                </Card>
              ))}
              {reply ? <Text style={{ color: t.sub }}>{reply}</Text> : null}
            </View>
          ) : null}

          {current === "week" ? <WeekShape days={data.week.days} conflicts={data.week.conflicts} /> : null}

          {current === "memory" ? (
            <View style={{ gap: 8 }}>
              {data.memory.length === 0 ? <Empty icon="bulb-outline" text="Nothing new remembered this week." /> : null}
              {data.memory.map((m) => (
                <Card key={m.id} style={{ gap: 6 }}>
                  <Text style={{ color: t.sub, fontSize: 12, fontWeight: "700" }}>{m.subject}</Text>
                  <Text style={{ color: t.text }}>{m.text}</Text>
                  <View style={{ flexDirection: "row" }}>
                    <Button label="That's wrong" small kind="ghost" onPress={() => chat(`This thing you remembered is wrong: "${m.text}" (about ${m.subject}). Ask me what's right if you need to, then remember the correction.`)} />
                  </View>
                </Card>
              ))}
              {reply ? <Text style={{ color: t.sub }}>{reply}</Text> : null}
            </View>
          ) : null}

          {current === "commit" ? (
            <Card style={{ gap: space.md }}>
              <Text style={{ color: t.text }}>I'll re-plan the next 7 days around everything you confirmed and build Monday's to-do list. Nothing is set in stone — plans will keep moving as life does.</Text>
              <Button label="Plan my week" icon="checkmark" onPress={() => mark("commit", "done")} />
            </Card>
          ) : null}

          {current !== "commit" ? (
            <View style={{ flexDirection: "row", gap: 8, marginTop: space.xl, flexWrap: "wrap" }}>
              <Button label="Next" icon="arrow-forward" onPress={() => mark(current, "done")} />
              <Button label="Nothing here" kind="secondary" onPress={() => mark(current, "nothing")} />
              <Button label="Skip" kind="ghost" onPress={() => mark(current, "skipped")} />
            </View>
          ) : null}
        </View>
      )}
    </Screen>
  );
}

/** What the automatic pulls (Humanforce, Instagram…) captured this week. */
function PullsCard() {
  const t = useTheme();
  const { data } = useApi<{ pulls: Record<string, { at: string; proposed?: number; summary?: string } | null> }>("/api/pulls");
  const entries = Object.entries(data?.pulls ?? {});
  if (!entries.length) return null;
  const weekAgo = Date.now() - 8 * 86_400_000;
  return (
    <Card style={{ gap: 8, marginBottom: space.md }}>
      <Text style={{ color: t.text, fontWeight: "700" }}>This week's automatic pulls</Text>
      {entries.map(([id, p]) => {
        const fresh = p && Date.parse(p.at) > weekAgo;
        return (
          <View key={id} style={{ flexDirection: "row", gap: 8 }}>
            <Ionicons name={fresh ? "checkmark-circle" : "alert-circle-outline"} size={18} color={fresh ? t.good : t.warn} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, textTransform: "capitalize" }}>{id}</Text>
              <Text style={{ color: t.faint, fontSize: 13 }}>
                {p ? `${fmtDay(p.at)} · ${p.proposed ?? 0} to review · ${p.summary ?? ""}` : "Hasn't run yet — check its setup, or add screenshots below instead."}
              </Text>
            </View>
          </View>
        );
      })}
    </Card>
  );
}

function WeekShape({ days, conflicts }: { days: DaySummary[]; conflicts: Conflict[] }) {
  const t = useTheme();
  const { data: prefs } = useApi<Preferences>("/api/prefs");
  const focus = prefs?.focus ?? {};
  const setFocus = (key: string, weight: number) => {
    const next = { ...focus };
    if (weight === 0) delete next[key];
    else next[key] = weight;
    return act(() => patch("/api/prefs", { focus: next }));
  };
  return (
    <View style={{ gap: space.md }}>
      <Card style={{ gap: 6 }}>
        {days.map((d) => (
          <View key={d.date} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ width: 90, color: t.text }}>{fmtDay(d.date + "T12:00:00")}</Text>
            <View style={{ flex: 1 }}>
              <ProgressBar value={d.capacityMinutes ? d.plannedMinutes / d.capacityMinutes : 0} color={t.accent} />
            </View>
            <Text style={{ width: 70, textAlign: "right", color: t.faint, fontSize: 12 }}>{fmtMins(d.plannedMinutes)}</Text>
          </View>
        ))}
      </Card>
      {conflicts.map((c, i) => (
        <Card key={i} style={{ backgroundColor: t.warnSoft, borderColor: t.warnSoft }}>
          <Text style={{ color: t.text, fontWeight: "600" }}>{c.message}</Text>
          <Text style={{ color: t.sub, fontSize: 13, marginTop: 4 }}>{c.options.join(" · ")}</Text>
        </Card>
      ))}
      <Card style={{ gap: 10 }}>
        <Text style={{ color: t.text, fontWeight: "600" }}>Focus this week</Text>
        {["uni", "work", "personal", "social", "health", "admin"].map((a) => (
          <View key={a} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={{ width: 80, color: t.text, textTransform: "capitalize" }}>{a}</Text>
            <Chip label="Less" active={(focus[a] ?? 0) < 0} onPress={() => setFocus(a, -0.5)} />
            <Chip label="Normal" active={!focus[a]} onPress={() => setFocus(a, 0)} />
            <Chip label="More" active={(focus[a] ?? 0) > 0} onPress={() => setFocus(a, 1)} />
          </View>
        ))}
      </Card>
    </View>
  );
}
