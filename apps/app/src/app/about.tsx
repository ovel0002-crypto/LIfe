import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Button, Card, Empty, Screen, SectionHeader, Title } from "../components/ui";
import { api, post } from "../lib/api";
import { fmtDay } from "../lib/format";
import { act, useApi } from "../lib/hooks";
import { radius, space, useTheme } from "../lib/theme";
import type { Preferences } from "../lib/types";

/** Everything Life believes about you, with edit and forget. */
export default function AboutMe() {
  const t = useTheme();
  const { data: prefs } = useApi<Preferences>("/api/prefs");
  const { data: mem } = useApi<{ source: string; items: { id: string; subject?: string; text: string; at?: string }[] }>("/api/memory");
  const [fact, setFact] = useState("");
  const best = prefs ? (["morning", "afternoon", "evening"] as const).find((k) => prefs.energyByHour[k] === "high") : undefined;

  return (
    <Screen>
      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel="Close">
          <Ionicons name="close" size={26} color={t.sub} />
        </Pressable>
      </View>
      <Title sub="What Life believes about you. Change anything">About me</Title>

      {prefs ? (
        <Card style={{ gap: 6 }}>
          <Text style={{ color: t.text }}>Day: {prefs.dayStart}–{prefs.dayEnd} · quiet from {prefs.quietStart}</Text>
          <Text style={{ color: t.text }}>Best focus: {best ?? "not set"} · plans {Math.round(prefs.capacityRatio * 100)}% of free time</Text>
          <Text style={{ color: t.text }}>Check-ins: {prefs.checkinStyle ?? "gentle"}</Text>
          {Object.keys(prefs.focus).length ? <Text style={{ color: t.text }}>Focus: {Object.entries(prefs.focus).map(([k, v]) => `${k} ${v > 0 ? "more" : "less"}`).join(", ")}</Text> : null}
          <View style={{ flexDirection: "row", gap: 8, marginTop: space.sm, flexWrap: "wrap" }}>
            <Button label="Re-run setup" icon="refresh" small kind="secondary" onPress={() => act(() => post("/api/onboarding/restart")).then(() => router.push("/onboarding"))} />
            <Button label="Edit in Settings" small kind="ghost" onPress={() => router.push("/settings")} />
          </View>
        </Card>
      ) : null}

      <SectionHeader title="Things I remember" count={mem?.items.length} hint={mem?.source === "eunomia" ? "From your Eunomia memory" : undefined} />
      <Card style={{ gap: 8, marginBottom: space.md }}>
        <TextInput
          value={fact}
          onChangeText={setFact}
          placeholder="Tell me something to remember, e.g. 'I don't work Thursdays'"
          placeholderTextColor={t.faint}
          style={{ backgroundColor: t.cardAlt, borderRadius: radius.sm, padding: 10, color: t.text }}
        />
        <View style={{ flexDirection: "row" }}>
          <Button
            label="Remember"
            small
            disabled={!fact.trim()}
            onPress={() => act(() => post("/api/memory", { text: fact.trim() })).then(() => setFact(""))}
          />
        </View>
      </Card>
      {mem && !mem.items.length ? <Empty icon="bulb-outline" text="Nothing yet. I'll learn as we go." /> : null}
      {(mem?.items ?? []).map((m) => (
        <View key={m.id} style={{ flexDirection: "row", gap: 8, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: t.line, alignItems: "flex-start" }}>
          <View style={{ flex: 1 }}>
            {m.subject ? <Text style={{ color: t.faint, fontSize: 12, fontWeight: "700" }}>{m.subject}</Text> : null}
            <Text style={{ color: t.text }}>{m.text}</Text>
            {m.at ? <Text style={{ color: t.faint, fontSize: 11 }}>{fmtDay(m.at)}</Text> : null}
          </View>
          {mem?.source === "local" ? (
            <Pressable hitSlop={8} onPress={() => act(() => api(`/api/memory/${m.id}`, { method: "DELETE" }))} accessibilityLabel="Forget">
              <Text style={{ color: t.bad, fontWeight: "600" }}>Forget</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </Screen>
  );
}
