import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { UploadIcs } from "../components/UploadIcs";
import { Button, Card, Chip, Empty, ProgressBar, Screen } from "../components/ui";
import { patch, post } from "../lib/api";
import { fmtDay } from "../lib/format";
import { act, useApi } from "../lib/hooks";
import { radius, space, useTheme } from "../lib/theme";
import type { Preferences, Project, TodayList } from "../lib/types";

type Step = "connect" | "inferences" | "projects" | "rhythm" | "matters" | "plan";

interface Data {
  state: { steps: Partial<Record<Step, string>>; completedAt?: string };
  steps: Step[];
  sources: { id: string; name: string; ok: boolean; detail: string; setup: string }[];
  inferences: { id: string; kind: string; text: string; detail?: string; items?: { id: string; title: string; due?: string; project?: string }[] }[];
}

const TITLES: Record<Step, { title: string; sub: string }> = {
  connect: { title: "Connect your life", sub: "Whatever's connected, Life reads first, so you type less" },
  inferences: { title: "Here's what I noticed", sub: "Confirm, fix or dismiss. Nothing is set in stone" },
  projects: { title: "What are you working on?", sub: "Tell me about your projects outside uni and work" },
  rhythm: { title: "Your rhythm", sub: "When your day starts, ends, and when you think best" },
  matters: { title: "What matters", sub: "What I should act on and how I should nudge you" },
  plan: { title: "Your first plan", sub: "Built from everything above. It'll keep adapting" },
};

/**
 * "Set up Life / Tune Life": runs on first launch and any time from Settings. Every step is
 * skippable and every answer can be changed later (Settings → About me).
 */
export default function OnboardingScreen() {
  const t = useTheme();
  const { data } = useApi<Data>("/api/onboarding");
  const current = useMemo(() => data?.steps.find((s) => !data.state.steps[s]), [data]);
  const done = data ? data.steps.filter((s) => data.state.steps[s]).length : 0;
  const mark = (step: Step, outcome: "done" | "skipped") => act(() => post("/api/onboarding/step", { step, outcome }));

  if (!data) return <Screen><Empty icon="hourglass-outline" text="Loading…" /></Screen>;
  return (
    <Screen>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: space.md }}>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel="Close">
          <Ionicons name="close" size={26} color={t.sub} />
        </Pressable>
        <Text style={{ flex: 1, textAlign: "center", color: t.sub, fontWeight: "600" }}>{data.state.completedAt ? "Tune Life" : "Set up Life"}</Text>
        <View style={{ width: 26 }} />
      </View>
      <ProgressBar value={done / data.steps.length} color={t.accent} />
      <Text style={{ color: t.faint, fontSize: 12, marginTop: 6 }}>Step {Math.min(done + 1, data.steps.length)} of {data.steps.length} · skip anything, change it all later</Text>

      {!current ? (
        <Card style={{ marginTop: space.xl, alignItems: "center", gap: space.md }}>
          <Ionicons name="sparkles" size={44} color={t.accent} />
          <Text style={{ fontSize: 20, fontWeight: "700", color: t.text }}>You're set up</Text>
          <Text style={{ color: t.sub, textAlign: "center" }}>Life will keep learning. Every couple of weeks I'll offer a 2-minute re-tune, and Settings → About me shows everything I believe about you.</Text>
          <Button label="Go to Today" onPress={() => router.replace("/")} />
        </Card>
      ) : (
        <View style={{ marginTop: space.xl }}>
          <Text style={{ fontSize: 26, fontWeight: "700", color: t.text, letterSpacing: -0.4 }}>{TITLES[current].title}</Text>
          <Text style={{ color: t.sub, fontSize: 15, marginTop: 2, marginBottom: space.lg }}>{TITLES[current].sub}</Text>
          {current === "connect" ? <Connect data={data} /> : null}
          {current === "inferences" ? <Inferences data={data} /> : null}
          {current === "projects" ? <ProjectsInterview /> : null}
          {current === "rhythm" ? <Rhythm /> : null}
          {current === "matters" ? <Matters /> : null}
          {current === "plan" ? <FirstPlan /> : null}
          <View style={{ flexDirection: "row", gap: 8, marginTop: space.xl, flexWrap: "wrap" }}>
            <Button label={current === "plan" ? "Finish" : "Next"} icon={current === "plan" ? "checkmark" : "arrow-forward"} onPress={() => mark(current, "done")} />
            {current !== "plan" ? <Button label="Skip for now" kind="ghost" onPress={() => mark(current, "skipped")} /> : null}
          </View>
        </View>
      )}
    </Screen>
  );
}

function Connect({ data }: { data: Data }) {
  const t = useTheme();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <View style={{ gap: 8 }}>
      {data.sources.map((s) => (
        <Card key={s.id} onPress={() => setOpen(open === s.id ? null : s.id)} style={{ padding: space.md }}>
          <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
            <Ionicons name={s.ok ? "checkmark-circle" : "ellipse-outline"} size={20} color={s.ok ? t.good : t.faint} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontWeight: "600" }}>{s.name}</Text>
              <Text style={{ color: t.faint, fontSize: 13 }}>{s.detail}</Text>
            </View>
            <Ionicons name={open === s.id ? "chevron-up" : "chevron-down"} size={18} color={t.faint} />
          </View>
          {open === s.id ? (
            <View style={{ marginTop: space.sm, gap: space.sm }}>
              <Text style={{ color: t.sub, fontSize: 14 }}>{s.setup}</Text>
              {s.id === "roster" ? <UploadIcs /> : null}
              {s.id !== "roster" ? <Button label="Open Settings" small kind="secondary" onPress={() => router.push("/settings")} /> : null}
            </View>
          ) : null}
        </Card>
      ))}
    </View>
  );
}

function Inferences({ data }: { data: Data }) {
  const t = useTheme();
  const [edit, setEdit] = useState<Record<string, string>>({});
  if (!data.inferences.length) return <Empty icon="search-outline" text="Nothing to confirm yet. Connect a few sources and I'll have more to go on." />;
  const verdict = (id: string, v: "confirmed" | "dismissed" | "edited") =>
    act(() => post("/api/onboarding/verdict", { id, verdict: v, edit: v === "edited" ? { text: edit[id] } : undefined }));
  return (
    <View style={{ gap: space.md }}>
      {data.inferences.map((i) =>
        i.kind === "overdue" ? (
          <Card key={i.id} style={{ gap: 8 }}>
            <Text style={{ color: t.text, fontWeight: "600" }}>{i.text}</Text>
            {i.items?.map((it) => (
              <View key={it.id} style={{ gap: 6, paddingVertical: 6, borderTopWidth: 1, borderTopColor: t.line }}>
                <Text style={{ color: t.text }}>{it.title}</Text>
                <Text style={{ color: t.faint, fontSize: 12 }}>
                  {it.project ? `${it.project} · ` : ""}
                  {it.due ? `was due ${fmtDay(it.due)}` : ""}
                </Text>
                <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                  <Chip label="Keep — due next week" onPress={() => act(() => post("/api/onboarding/overdue", { taskId: it.id, action: "keep" }))} />
                  <Chip label="Already done" tone="good" onPress={() => act(() => post("/api/onboarding/overdue", { taskId: it.id, action: "done" }))} />
                  <Chip label="Drop" onPress={() => act(() => post("/api/onboarding/overdue", { taskId: it.id, action: "drop" }))} />
                </View>
              </View>
            ))}
          </Card>
        ) : (
          <Card key={i.id} style={{ gap: 8 }}>
            <Text style={{ color: t.text, fontSize: 16 }}>{i.text}</Text>
            {i.detail ? <Text style={{ color: t.faint, fontSize: 13 }}>{i.detail}</Text> : null}
            {edit[i.id] !== undefined ? (
              <TextInput
                value={edit[i.id]}
                onChangeText={(v) => setEdit({ ...edit, [i.id]: v })}
                multiline
                style={{ backgroundColor: t.cardAlt, borderRadius: radius.sm, padding: 10, color: t.text }}
              />
            ) : null}
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
              {edit[i.id] !== undefined ? (
                <Chip label="Save my version" active onPress={() => verdict(i.id, "edited")} />
              ) : (
                <>
                  <Chip label="That's right" tone="good" onPress={() => verdict(i.id, "confirmed")} />
                  <Chip label="Not quite…" onPress={() => setEdit({ ...edit, [i.id]: i.text })} />
                  <Chip label="Ignore" onPress={() => verdict(i.id, "dismissed")} />
                </>
              )}
            </View>
          </Card>
        ),
      )}
    </View>
  );
}

function ProjectsInterview() {
  const t = useTheme();
  const { data: projects } = useApi<Project[]>("/api/projects");
  const [text, setText] = useState("");
  const [reply, setReply] = useState("Tell me about a project in a sentence or two: what it is, what stage it's at, and what 'done' looks like. I'll set it up and suggest the next steps.");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const r = await act(() =>
      post<{ reply: string }>("/api/chat", {
        message: `(Onboarding: I'm describing my projects. For each one, add_project with sensible stages, set the current stage, and add the next 2–3 concrete steps as tasks. Then ask me briefly about the next one, or whether that's all.)\n\n${text}`,
      }),
    );
    setReply(r.reply);
    setText("");
    setBusy(false);
  };
  return (
    <View style={{ gap: space.md }}>
      <Card style={{ gap: 10 }}>
        <Text style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>{reply}</Text>
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          placeholder="e.g. Robot arm: 6-DOF arm for my desk, I've finished the design and I'm wiring it now. Done = it can pick up a cup."
          placeholderTextColor={t.faint}
          style={{ minHeight: 80, backgroundColor: t.cardAlt, borderRadius: radius.sm, padding: 10, color: t.text, textAlignVertical: "top" }}
        />
        <View style={{ flexDirection: "row" }}>
          {busy ? <ActivityIndicator color={t.sub} /> : <Button label="Send" icon="arrow-up" small onPress={send} disabled={!text.trim()} />}
        </View>
      </Card>
      {(projects ?? []).filter((p) => p.status !== "done").map((p) => (
        <View key={p.id} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <Ionicons name="layers-outline" size={16} color={t.sub} />
          <Text style={{ color: t.text, flex: 1 }}>{p.title}</Text>
          <Text style={{ color: t.faint, fontSize: 12 }}>{p.stage ?? ""}</Text>
        </View>
      ))}
    </View>
  );
}

const HOURS = ["06:00", "07:00", "08:00", "09:00", "10:00"];
const ENDS = ["20:00", "21:00", "22:00", "23:00", "00:00"];
const QUIET = ["21:30", "22:30", "23:30"];

function Rhythm() {
  const t = useTheme();
  const { data: p } = useApi<Preferences>("/api/prefs");
  if (!p) return null;
  const set = (patchBody: Partial<Preferences>) => act(() => patch("/api/prefs", patchBody));
  const best = (["morning", "afternoon", "evening"] as const).find((k) => p.energyByHour[k] === "high") ?? "morning";
  const setBest = (k: "morning" | "afternoon" | "evening") =>
    set({ energyByHour: { morning: k === "morning" ? "high" : "medium", afternoon: k === "afternoon" ? "high" : "medium", evening: k === "evening" ? "high" : "low" } });
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <View style={{ gap: 6 }}>
      <Text style={{ color: t.sub, fontWeight: "600", fontSize: 13 }}>{label}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{children}</View>
    </View>
  );
  return (
    <Card style={{ gap: space.lg }}>
      <Row label="Start planning my day at">
        {HOURS.map((h) => <Chip key={h} label={h} active={p.dayStart === h} onPress={() => set({ dayStart: h })} />)}
      </Row>
      <Row label="Stop planning at">
        {ENDS.map((h) => <Chip key={h} label={h === "00:00" ? "Midnight" : h} active={p.dayEnd === (h === "00:00" ? "23:59" : h)} onPress={() => set({ dayEnd: h === "00:00" ? "23:59" : h })} />)}
      </Row>
      <Row label="Quiet from (no nudges)">
        {QUIET.map((h) => <Chip key={h} label={h} active={p.quietStart === h} onPress={() => set({ quietStart: h })} />)}
      </Row>
      <Row label="I think best in the">
        {(["morning", "afternoon", "evening"] as const).map((k) => <Chip key={k} label={k} active={best === k} onPress={() => setBest(k)} />)}
      </Row>
    </Card>
  );
}

function Matters() {
  const t = useTheme();
  const { data: p } = useApi<Preferences>("/api/prefs");
  if (!p) return null;
  const rules = p.emailImportance ?? { payments: true, calendar: true, personal: true, uni: true, asks: true };
  const set = (patchBody: Partial<Preferences>) => act(() => patch("/api/prefs", patchBody));
  const LABELS: Record<keyof typeof rules, string> = {
    payments: "Bills & payments due",
    calendar: "Bookings & appointments",
    personal: "Personal emails from people",
    uni: "Uni deadlines & changes",
    asks: "Things people ask me to do",
  };
  return (
    <View style={{ gap: space.md }}>
      <Card style={{ gap: 10 }}>
        <Text style={{ color: t.text, fontWeight: "600" }}>Act on these (everything else is ignored)</Text>
        {(Object.keys(LABELS) as (keyof typeof rules)[]).map((k) => (
          <Pressable key={k} onPress={() => set({ emailImportance: { ...rules, [k]: !rules[k] } })} style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
            <Ionicons name={rules[k] ? "checkbox" : "square-outline"} size={22} color={rules[k] ? t.accent : t.faint} />
            <Text style={{ color: t.text }}>{LABELS[k]}</Text>
          </Pressable>
        ))}
      </Card>
      <Card style={{ gap: 10 }}>
        <Text style={{ color: t.text, fontWeight: "600" }}>Check-ins when a planned block starts</Text>
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          {(["gentle", "direct", "quiet"] as const).map((k) => (
            <Chip key={k} label={k === "quiet" ? "Off — just the lists" : k} active={(p.checkinStyle ?? "gentle") === k} onPress={() => set({ checkinStyle: k })} />
          ))}
        </View>
        <Text style={{ color: t.text, fontWeight: "600", marginTop: 6 }}>How full to plan my free time</Text>
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          {[0.5, 0.65, 0.8].map((r) => (
            <Chip key={r} label={r === 0.5 ? "Light (50%)" : r === 0.65 ? "Balanced (65%)" : "Packed (80%)"} active={p.capacityRatio === r} onPress={() => set({ capacityRatio: r })} />
          ))}
        </View>
      </Card>
    </View>
  );
}

function FirstPlan() {
  const t = useTheme();
  const { data } = useApi<TodayList>("/api/today");
  if (!data) return <ActivityIndicator color={t.sub} />;
  return (
    <Card style={{ gap: 6 }}>
      <Text style={{ color: t.text }}>Today: {data.must.length} must-do, {data.should.length} planned, {data.could.length} quick wins.</Text>
      {data.now ? <Text style={{ color: t.sub }}>First up: {data.now.title}</Text> : null}
      <Text style={{ color: t.faint, fontSize: 13 }}>Hit Finish and I'll lock in the week. Plans will still move as life does.</Text>
    </Card>
  );
}
