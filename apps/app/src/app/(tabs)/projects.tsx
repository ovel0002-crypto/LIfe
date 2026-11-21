import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { ActionSheet, Button, Card, Chip, Empty, ProgressBar, Screen, SectionHeader, Title, type SheetAction } from "../../components/ui";
import { patch, post } from "../../lib/api";
import { fmtDay, fmtMins } from "../../lib/format";
import { act, useApi } from "../../lib/hooks";
import { areaColor, radius, space, useTheme } from "../../lib/theme";
import type { Project, Task } from "../../lib/types";

const AREAS = ["uni", "work", "personal", "social", "admin", "health"] as const;

/** Goals → projects → stages → tasks, with progress rolled up. */
export default function ProjectsScreen() {
  const t = useTheme();
  const { data: projects } = useApi<Project[]>("/api/projects");
  const { data: tasks } = useApi<Task[]>("/api/tasks");
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [area, setArea] = useState<(typeof AREAS)[number]>("personal");
  const [open, setOpen] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ title: string; actions: SheetAction[] } | null>(null);
  const [newTask, setNewTask] = useState("");

  const grouped = useMemo(() => {
    const list = (projects ?? []).filter((p) => p.status !== "done");
    return list.map((p) => {
      const pt = (tasks ?? []).filter((x) => x.projectId === p.id && x.status !== "dropped" && !(x.remainingMinutes === 0 && x.status === "doing"));
      const done = pt.filter((x) => x.status === "done").length;
      return { p, tasks: pt, done, total: pt.length };
    });
  }, [projects, tasks]);

  const loose = (tasks ?? []).filter((x) => !x.projectId && (x.status === "todo" || x.status === "doing" || x.status === "waiting"));

  const add = async () => {
    if (!title.trim()) return;
    await act(() => post("/api/projects", { title: title.trim(), area }));
    setTitle("");
    setAdding(false);
  };

  const addTask = async (projectId: string, a: string) => {
    if (!newTask.trim()) return;
    await act(() => post("/api/tasks", { title: newTask.trim(), projectId, area: a, estimateMinutes: 45 }));
    setNewTask("");
  };

  const projectActions = (p: Project): SheetAction[] => [
    ...(p.stages ?? []).map((s) => ({ label: `Stage: ${s}`, icon: "flag-outline" as const, onPress: () => act(() => patch(`/api/projects/${p.id}`, { stage: s })) })),
    { label: "Plan next steps with Life", icon: "sparkles-outline", onPress: () => act(() => post("/api/chat", { message: `Look at my project "${p.title}" [${p.id}] (stage: ${p.stage ?? "unknown"}). Propose and add the next 3 concrete steps as tasks in this project.` })) },
    p.status === "paused"
      ? { label: "Resume project", icon: "play-outline", onPress: () => act(() => patch(`/api/projects/${p.id}`, { status: "active" })) }
      : { label: "Pause project", icon: "pause-outline", onPress: () => act(() => patch(`/api/projects/${p.id}`, { status: "paused" })) },
    { label: "Mark project done", icon: "checkmark-done-outline", onPress: () => act(() => patch(`/api/projects/${p.id}`, { status: "done" })) },
  ];

  return (
    <Screen>
      <Title sub="Everything you're moving forward">Projects</Title>
      {adding ? (
        <Card style={{ marginBottom: space.md, gap: space.md }}>
          <TextInput
            autoFocus
            value={title}
            onChangeText={setTitle}
            placeholder="Project name, e.g. Robot arm, FIT2004, Job hunt"
            placeholderTextColor={t.faint}
            onSubmitEditing={add}
            style={{ fontSize: 16, color: t.text, padding: 4 }}
          />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {AREAS.map((a) => (
              <Chip key={a} label={a} active={area === a} onPress={() => setArea(a)} />
            ))}
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button label="Add project" onPress={add} small />
            <Button label="Cancel" kind="ghost" onPress={() => setAdding(false)} small />
          </View>
        </Card>
      ) : (
        <View style={{ flexDirection: "row", marginBottom: space.md }}>
          <Button label="New project" icon="add" kind="secondary" small onPress={() => setAdding(true)} />
        </View>
      )}

      {grouped.length === 0 ? <Empty icon="layers-outline" text="No projects yet. Add one, or tell Life about it in chat." /> : null}
      {grouped.map(({ p, tasks: pt, done, total }) => {
        const color = areaColor[p.area] ?? t.accent;
        const isOpen = open === p.id;
        const remaining = pt.filter((x) => x.status !== "done");
        return (
          <Card key={p.id} style={{ marginBottom: space.md }} onPress={() => setOpen(isOpen ? null : p.id)}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
              <Text style={{ flex: 1, fontSize: 17, fontWeight: "700", color: t.text }}>{p.title}</Text>
              <Pressable hitSlop={10} onPress={() => setMenu({ title: p.title, actions: projectActions(p) })}>
                <Text style={{ color: t.sub, fontSize: 20 }}>···</Text>
              </Pressable>
            </View>
            <Text style={{ color: t.sub, marginTop: 4, fontSize: 13 }}>
              {p.stage ? `${p.stage} · ` : ""}
              {total ? `${done}/${total} steps` : "No steps yet"}
              {p.status === "paused" ? " · paused" : ""}
            </Text>
            {total ? (
              <View style={{ marginTop: 8 }}>
                <ProgressBar value={done / total} color={color} />
              </View>
            ) : null}
            {isOpen ? (
              <View style={{ marginTop: space.md, gap: 6 }}>
                {remaining.map((x) => (
                  <View key={x.id} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                    <Pressable
                      onPress={() => act(() => post(`/api/tasks/${x.id}/done`))}
                      hitSlop={8}
                      style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: color }}
                    />
                    <Text style={{ flex: 1, color: t.text }}>{x.title}</Text>
                    <Text style={{ color: t.faint, fontSize: 12 }}>
                      {x.due ? fmtDay(x.due) : fmtMins(x.estimateMinutes)}
                    </Text>
                  </View>
                ))}
                <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
                  <TextInput
                    value={newTask}
                    onChangeText={setNewTask}
                    placeholder="Add a step…"
                    placeholderTextColor={t.faint}
                    onSubmitEditing={() => addTask(p.id, p.area)}
                    style={{ flex: 1, backgroundColor: t.cardAlt, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 8, color: t.text }}
                  />
                  <Button label="Add" small onPress={() => addTask(p.id, p.area)} />
                </View>
              </View>
            ) : null}
          </Card>
        );
      })}

      {loose.length ? (
        <>
          <SectionHeader title="Not in a project" count={loose.length} />
          {loose.map((x) => (
            <View key={x.id} style={{ flexDirection: "row", paddingVertical: 8, gap: 8, borderBottomWidth: 1, borderBottomColor: t.line }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, marginTop: 7, backgroundColor: areaColor[x.area] ?? t.faint }} />
              <Text style={{ flex: 1, color: t.text }}>{x.title}</Text>
              <Text style={{ color: t.faint, fontSize: 12 }}>{x.status === "waiting" ? "waiting" : x.due ? fmtDay(x.due) : ""}</Text>
            </View>
          ))}
        </>
      ) : null}
      <ActionSheet visible={!!menu} title={menu?.title} actions={menu?.actions ?? []} onClose={() => setMenu(null)} />
    </Screen>
  );
}
