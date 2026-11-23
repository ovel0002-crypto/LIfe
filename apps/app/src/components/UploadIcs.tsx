import * as DocumentPicker from "expo-document-picker";
import { useState } from "react";
import { Platform, Text, View } from "react-native";
import { api } from "../lib/api";
import { invalidateAll } from "../lib/hooks";
import { space, useTheme } from "../lib/theme";
import { Button } from "./ui";

/** Upload a calendar file you downloaded (e.g. Humanforce "Roster download"). */
export function UploadIcs({ kind = "roster", name = "Humanforce", label = "Upload roster file (.ics)" }: { kind?: string; name?: string; label?: string }) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const pick = async () => {
    const r = await DocumentPicker.getDocumentAsync({ type: ["text/calendar", "*/*"], copyToCacheDirectory: true });
    if (r.canceled || !r.assets[0]) return;
    const a = r.assets[0];
    setBusy(true);
    try {
      const form = new FormData();
      form.append("kind", kind);
      form.append("name", name);
      if (Platform.OS === "web" && a.file) form.append("file", a.file, a.name);
      else form.append("file", { uri: a.uri, name: a.name, type: "text/calendar" } as unknown as Blob);
      const res = await api<{ error?: string; result?: { created: number; updated: number; proposedRemovals?: number } }>("/api/import/ics", { form });
      setMsg(res.error ?? `Imported: ${res.result?.created ?? 0} new, ${res.result?.updated ?? 0} changed${res.result?.proposedRemovals ? `, ${res.result.proposedRemovals} to review` : ""}.`);
      invalidateAll();
    } catch (e) {
      setMsg(`Couldn't import: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row" }}>
        <Button label={label} icon="document-attach-outline" kind="secondary" small onPress={pick} loading={busy} />
      </View>
      {msg ? <Text style={{ color: t.sub, fontSize: 13 }}>{msg}</Text> : null}
    </View>
  );
}
