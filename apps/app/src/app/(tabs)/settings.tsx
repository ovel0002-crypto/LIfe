import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Linking, Platform, Text, TextInput, View } from "react-native";
import { Button, Card, Chip, Screen, SectionHeader, Title } from "../../components/ui";
import { api, getToken, patch, post, setToken } from "../../lib/api";
import { act, invalidateAll, useApi } from "../../lib/hooks";
import { radius, space, useTheme } from "../../lib/theme";
import type { Preferences } from "../../lib/types";

interface Connectors {
  google: string[];
  feeds: { id: string; name: string; kind: string; lock: string; lastSync?: string; lastError?: string }[];
  notion: Record<string, unknown> | null;
  discord: Record<string, unknown> | null;
  llm: { available: boolean; provider: string; models: Record<string, string> };
  memory: string;
  push: { webPush: boolean; telegram: boolean };
}

function Field({ label, value, onChange, placeholder, secure }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; secure?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: t.sub, fontSize: 13, fontWeight: "600" }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={t.faint}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        style={{ backgroundColor: t.cardAlt, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 10, color: t.text, fontSize: 15 }}
      />
    </View>
  );
}

function Status({ ok, label }: { ok: boolean; label: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 }}>
      <Ionicons name={ok ? "checkmark-circle" : "ellipse-outline"} size={18} color={ok ? t.good : t.faint} />
      <Text style={{ color: t.text, fontSize: 15 }}>{label}</Text>
    </View>
  );
}

export default function SettingsScreen() {
  const t = useTheme();
  const { data: c } = useApi<Connectors>("/api/connectors");
  const { data: prefs } = useApi<Preferences>("/api/prefs");
  const { data: usage } = useApi<{ month: { total: number; calls: number; byPurpose: Record<string, number> }; budgetUsd: number }>("/api/usage");
  const [token, setTok] = useState(getToken() ?? "");
  const [feed, setFeed] = useState({ name: "", url: "", kind: "moodle", lock: "soft" });
  const [notion, setNotion] = useState({ databaseId: "", me: "", titleProp: "Name", assigneeProp: "Assignee", statusProp: "Status", dueProp: "Due" });
  const [discord, setDiscord] = useState({ channels: "", myUserId: "", myNames: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [p, setP] = useState<Partial<Preferences>>({});

  useEffect(() => {
    if (prefs) setP({ dayStart: prefs.dayStart, dayEnd: prefs.dayEnd, quietStart: prefs.quietStart, quietEnd: prefs.quietEnd, capacityRatio: prefs.capacityRatio, timezone: prefs.timezone });
  }, [prefs]);

  const say = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 5000);
  };

  const addFeed = async () => {
    const r = await act(() => post<{ result: { created?: number; error?: string } }>("/api/connectors/feeds", feed));
    say(r.result?.error ? `Feed added but sync failed: ${r.result.error}` : `Imported ${r.result?.created ?? 0} items`);
    setFeed({ name: "", url: "", kind: "moodle", lock: "soft" });
  };

  const enablePush = async () => {
    if (Platform.OS !== "web" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      return say("On iPhone: add Life to your Home Screen first (Share → Add to Home Screen), then open it from there.");
    }
    const { publicKey } = await api<{ publicKey: string | null }>("/api/push/key");
    if (!publicKey) return say("The server has no VAPID keys yet — see README → Notifications.");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return say("Notifications weren't allowed.");
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(publicKey) });
    await post("/api/push/subscribe", sub.toJSON());
    say("Notifications on.");
  };

  const googleUrl = (account: string) => `/api/connect/google?account=${account}${getToken() ? `&token=${encodeURIComponent(getToken()!)}` : ""}`;

  return (
    <Screen>
      <Title>Settings</Title>
      {msg ? (
        <Card style={{ backgroundColor: t.accentSoft, borderColor: t.accentSoft, marginBottom: space.md }}>
          <Text style={{ color: t.text }}>{msg}</Text>
        </Card>
      ) : null}

      <SectionHeader title="Server" />
      <Card style={{ gap: space.md }}>
        <Field label="Access token" value={token} onChange={setTok} secure placeholder="LIFE_API_TOKEN from your server" />
        <View style={{ flexDirection: "row" }}>
          <Button
            label="Save"
            small
            onPress={() => {
              setToken(token);
              invalidateAll();
              say("Saved");
            }}
          />
        </View>
        {c ? (
          <View>
            <Status ok={c.llm.available} label={c.llm.available ? `AI on (${c.llm.provider})` : "AI off — set ANTHROPIC_API_KEY on the server"} />
            <Status ok label={`Memory: ${c.memory === "eunomia" ? "Eunomia" : "built-in"}`} />
          </View>
        ) : null}
      </Card>

      <SectionHeader title="Notifications" hint="Check-ins, morning brief, evening close-out" />
      <Card style={{ gap: space.sm }}>
        <Status ok={!!c?.push.webPush} label="Web push (home-screen app)" />
        <Status ok={!!c?.push.telegram} label="Telegram (reliable backup)" />
        <View style={{ flexDirection: "row", marginTop: 4 }}>
          <Button label="Turn on notifications here" icon="notifications-outline" small onPress={enablePush} />
        </View>
      </Card>

      <SectionHeader title="Calendars & uni" />
      <Card style={{ gap: space.md }}>
        <Status ok={!!c?.google.includes("personal")} label="Personal Google (Calendar + Gmail)" />
        <Status ok={!!c?.google.includes("uni")} label="Monash Google (signs in via Okta)" />
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Button label="Connect personal" small kind="secondary" onPress={() => Linking.openURL(googleUrl("personal"))} />
          <Button label="Connect Monash" small kind="secondary" onPress={() => Linking.openURL(googleUrl("uni"))} />
        </View>
        {(c?.feeds ?? []).map((f) => (
          <View key={f.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Ionicons name={f.lastError ? "warning-outline" : "link-outline"} size={16} color={f.lastError ? t.warn : t.sub} />
            <Text style={{ flex: 1, color: t.text }}>
              {f.name} <Text style={{ color: t.faint }}>({f.kind}, {f.lock})</Text>
            </Text>
            <Button label="Remove" kind="ghost" small onPress={() => act(() => api(`/api/connectors/feeds/${f.id}`, { method: "DELETE" }))} />
          </View>
        ))}
        <Text style={{ color: t.sub, fontSize: 13 }}>
          Add an iCal feed. Moodle: Calendar → Import or export calendars → Export → "All courses", "Recent and next 60 days" → Get calendar URL. Timetable: your timetable app's iCal/subscribe link.
        </Text>
        <Field label="Name" value={feed.name} onChange={(v) => setFeed({ ...feed, name: v })} placeholder="Moodle" />
        <Field label="iCal URL" value={feed.url} onChange={(v) => setFeed({ ...feed, url: v })} placeholder="https://learning.monash.edu/calendar/export_execute.php?..." />
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          {["moodle", "timetable", "calendar"].map((k) => (
            <Chip key={k} label={k} active={feed.kind === k} onPress={() => setFeed({ ...feed, kind: k })} />
          ))}
        </View>
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          {[
            ["hard", "Locked"],
            ["soft", "Ask first"],
            ["flexible", "Flexible"],
          ].map(([k, l]) => (
            <Chip key={k} label={l} active={feed.lock === k} onPress={() => setFeed({ ...feed, lock: k })} />
          ))}
        </View>
        <View style={{ flexDirection: "row" }}>
          <Button label="Add feed" small onPress={addFeed} disabled={!feed.url || !feed.name} />
        </View>
      </Card>

      <SectionHeader title="Team: Notion" hint="Action items assigned to you become tasks" />
      <Card style={{ gap: space.md }}>
        <Status ok={!!c?.notion} label={c?.notion ? "Connected" : "Not set up (needs NOTION_TOKEN on the server)"} />
        <Field label="Action items database ID" value={notion.databaseId} onChange={(v) => setNotion({ ...notion, databaseId: v })} placeholder="32-char id from the database URL" />
        <Field label="Your name in Notion" value={notion.me} onChange={(v) => setNotion({ ...notion, me: v })} placeholder="Oscar" />
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Field label="Assignee property" value={notion.assigneeProp} onChange={(v) => setNotion({ ...notion, assigneeProp: v })} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Due property" value={notion.dueProp} onChange={(v) => setNotion({ ...notion, dueProp: v })} />
          </View>
        </View>
        <View style={{ flexDirection: "row" }}>
          <Button
            label="Save & sync"
            small
            disabled={!notion.databaseId || !notion.me}
            onPress={() => act(() => api<{ created?: number; error?: string }>("/api/connectors/notion", { method: "PUT", body: notion })).then((r) => say(r.error ? `Notion: ${r.error}` : `Imported ${r.created ?? 0} action items`))}
          />
        </View>
      </Card>

      <SectionHeader title="Team: Discord" hint="A bot your server admin invites; reads only the channels you list" />
      <Card style={{ gap: space.md }}>
        <Status ok={!!c?.discord} label={c?.discord ? "Configured" : "Not set up (needs DISCORD_BOT_TOKEN on the server)"} />
        <Field label="Channel IDs (comma separated)" value={discord.channels} onChange={(v) => setDiscord({ ...discord, channels: v })} />
        <Field label="Your Discord user ID" value={discord.myUserId} onChange={(v) => setDiscord({ ...discord, myUserId: v })} />
        <Field label="Names people call you" value={discord.myNames} onChange={(v) => setDiscord({ ...discord, myNames: v })} placeholder="Oscar, Oz" />
        <View style={{ flexDirection: "row" }}>
          <Button
            label="Save"
            small
            onPress={() =>
              act(() =>
                api<{ note: string }>("/api/connectors/discord", {
                  method: "PUT",
                  body: { channels: split(discord.channels), myUserId: discord.myUserId.trim(), myNames: split(discord.myNames), digestMinutes: 30 },
                }),
              ).then((r) => say(r.note))
            }
          />
        </View>
      </Card>

      <SectionHeader title="Your day" />
      <Card style={{ gap: space.md }}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Field label="Day starts" value={p.dayStart ?? ""} onChange={(v) => setP({ ...p, dayStart: v })} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Day ends" value={p.dayEnd ?? ""} onChange={(v) => setP({ ...p, dayEnd: v })} />
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Field label="Quiet from" value={p.quietStart ?? ""} onChange={(v) => setP({ ...p, quietStart: v })} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Quiet until" value={p.quietEnd ?? ""} onChange={(v) => setP({ ...p, quietEnd: v })} />
          </View>
        </View>
        <Text style={{ color: t.sub, fontSize: 13, fontWeight: "600" }}>How full to plan your free time</Text>
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          {[0.5, 0.6, 0.65, 0.75, 0.85].map((r) => (
            <Chip key={r} label={`${Math.round(r * 100)}%`} active={p.capacityRatio === r} onPress={() => setP({ ...p, capacityRatio: r })} />
          ))}
        </View>
        <Field label="Timezone" value={p.timezone ?? ""} onChange={(v) => setP({ ...p, timezone: v })} />
        <View style={{ flexDirection: "row" }}>
          <Button label="Save" small onPress={() => act(() => patch("/api/prefs", p)).then(() => say("Saved — re-planned"))} />
        </View>
      </Card>

      <SectionHeader title="AI usage this month" />
      <Card>
        <Text style={{ color: t.text, fontSize: 22, fontWeight: "700" }}>
          ${usage?.month.total.toFixed(2) ?? "0.00"} <Text style={{ color: t.faint, fontSize: 15, fontWeight: "400" }}>of ${usage?.budgetUsd ?? 0} cap</Text>
        </Text>
        <Text style={{ color: t.sub, marginTop: 4 }}>{usage?.month.calls ?? 0} calls · planning itself never uses AI</Text>
        {Object.entries(usage?.month.byPurpose ?? {}).map(([k, v]) => (
          <Text key={k} style={{ color: t.faint, fontSize: 13 }}>
            {k}: ${v.toFixed(3)}
          </Text>
        ))}
      </Card>
    </Screen>
  );
}

function split(s: string) {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function urlB64(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
