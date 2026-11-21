import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { Linking, Pressable, Text, View } from "react-native";
import { Button, Card, Empty, ProgressBar, Screen, SectionHeader, Tag } from "../../components/ui";
import { patch, post } from "../../lib/api";
import { fmtDay, fmtMins, fmtTime } from "../../lib/format";
import { act, useApi } from "../../lib/hooks";
import { areaColor, sourceLabel, space, useTheme } from "../../lib/theme";
import type { Block, Project, Task } from "../../lib/types";

interface Detail {
  task: Task;
  project: Project | null;
  steps: Task[];
  parent: Task | null;
  blocks: Block[];
  why: string | null;
}

/** Everything about one task: why it's planned, its steps, notes and where it came from. */
export default function TaskDetail() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error } = useApi<Detail>(id ? `/api/tasks/${id}` : null);
  if (error && !data) return <Screen><Empty icon="alert-circle-outline" text="Couldn't load this task." /></Screen>;
  if (!data) return <Screen><Empty icon="hourglass-outline" text="Loading…" /></Screen>;
  const { task, project, steps, parent, blocks, why } = data;
  const color = areaColor[task.area] ?? t.accent;
  const remaining = task.remainingMinutes ?? Math.round(task.estimateMinutes * (1 - (task.progress ?? 0)));
  const noteLines = (task.notes ?? "").split("\n").filter((l) => l.trim() && !/^\[[a-z]+:[^\]]+\]$/i.test(l.trim()));

  return (
    <Screen>
      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel="Close">
          <Ionicons name="close" size={26} color={t.sub} />
        </Pressable>
      </View>
      {parent ? (
        <Pressable onPress={() => router.replace(`/task/${parent.id}`)}>
          <Text style={{ color: t.accent, fontSize: 13, marginBottom: 4 }}>Step of: {parent.title}</Text>
        </Pressable>
      ) : null}
      <Text style={{ fontSize: 26, fontWeight: "700", color: t.text, letterSpacing: -0.4 }}>{task.title}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: space.sm }}>
        <Tag label={task.area} color={color} />
        {project ? <Tag label={project.title} color={color} /> : null}
        <Tag label={sourceLabel[task.source] ?? task.source} />
        <Tag label={task.status} />
      </View>
      {why ? <Text style={{ color: t.sub, marginTop: space.md }}>{why}</Text> : null}

      <Card style={{ marginTop: space.lg, gap: 8 }}>
        {task.due ? <Row icon="flag-outline" text={`Due ${fmtDay(task.due)} ${fmtTime(task.due)}`} /> : null}
        <Row icon="time-outline" text={`${fmtMins(remaining)} left of ${fmtMins(task.estimateMinutes)}${task.actualMinutes ? ` · ${fmtMins(task.actualMinutes)} spent` : ""}`} />
        {task.progress ? <ProgressBar value={task.progress} color={color} /> : null}
        {task.doneWhen ? <Row icon="checkmark-done-outline" text={`Done when: ${task.doneWhen}`} /> : null}
        {task.waitingOn ? <Row icon="hourglass-outline" text={`Waiting on ${task.waitingOn}`} /> : null}
        {task.sourceUrl?.startsWith("http") ? (
          <Pressable onPress={() => Linking.openURL(task.sourceUrl!)}>
            <Row icon="open-outline" text="Open source" accent />
          </Pressable>
        ) : null}
      </Card>

      {blocks.length ? (
        <>
          <SectionHeader title="Planned" count={blocks.length} />
          {blocks.slice(0, 6).map((b) => (
            <Text key={b.id} style={{ color: t.text, paddingVertical: 4 }}>
              {fmtDay(b.start)} · {fmtTime(b.start)}–{fmtTime(b.end)}
            </Text>
          ))}
        </>
      ) : null}

      {steps.length ? (
        <>
          <SectionHeader title="Steps" count={steps.length} />
          {steps.map((st) => (
            <Pressable key={st.id} onPress={() => router.push(`/task/${st.id}`)} style={{ flexDirection: "row", gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.line }}>
              <Ionicons name={st.status === "done" ? "checkmark-circle" : "ellipse-outline"} size={20} color={st.status === "done" ? t.good : color} />
              <Text style={{ flex: 1, color: st.status === "done" ? t.faint : t.text, textDecorationLine: st.status === "done" ? "line-through" : "none" }}>{st.title}</Text>
              <Text style={{ color: t.faint, fontSize: 12 }}>{fmtMins(st.estimateMinutes)}</Text>
            </Pressable>
          ))}
        </>
      ) : null}

      {noteLines.length ? (
        <>
          <SectionHeader title="Notes" />
          <Card style={{ gap: 4 }}>
            {noteLines.map((l, i) => (
              <Text key={i} selectable style={{ color: t.text, fontFamily: l.startsWith("  ") ? "monospace" : undefined }}>
                {l}
              </Text>
            ))}
          </Card>
        </>
      ) : null}

      {task.status !== "done" ? (
        <View style={{ flexDirection: "row", gap: 8, marginTop: space.xl, flexWrap: "wrap" }}>
          <Button label="Done" icon="checkmark" onPress={() => act(() => post(`/api/tasks/${task.id}/done`)).then(() => router.back())} />
          {!steps.length ? <Button label="Break it down" kind="secondary" onPress={() => act(() => post(`/api/tasks/${task.id}/breakdown`, {}))} /> : null}
          <Button label="Not today" kind="ghost" onPress={() => act(() => post(`/api/tasks/${task.id}/defer`, { until: "tomorrow" })).then(() => router.back())} />
          <Button label="Drop" kind="danger" onPress={() => act(() => patch(`/api/tasks/${task.id}`, { status: "dropped" })).then(() => router.back())} />
        </View>
      ) : null}
    </Screen>
  );
}

function Row({ icon, text, accent }: { icon: React.ComponentProps<typeof Ionicons>["name"]; text: string; accent?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
      <Ionicons name={icon} size={17} color={accent ? t.accent : t.sub} />
      <Text style={{ color: accent ? t.accent : t.text, flex: 1 }}>{text}</Text>
    </View>
  );
}
