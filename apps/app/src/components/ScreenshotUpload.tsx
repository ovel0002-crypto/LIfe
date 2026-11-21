import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { Platform, Text, View } from "react-native";
import { api } from "../lib/api";
import { invalidateAll } from "../lib/hooks";
import { space, useTheme } from "../lib/theme";
import { Button } from "./ui";

/** Pick several screenshots at once (chats, rosters, posters) → vision extraction → Review queue. */
export function ScreenshotUpload({ hint, label = "Choose screenshots", onDone }: { hint?: string; label?: string; onDone?: (summary: string, proposed: number) => void }) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const pick = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: 10, quality: 0.7 });
    if (res.canceled || !res.assets.length) return;
    setBusy(true);
    setResult(null);
    try {
      const form = new FormData();
      if (hint) form.append("hint", hint);
      for (const [i, a] of res.assets.entries()) {
        if (Platform.OS === "web") {
          const blob = await (await fetch(a.uri)).blob();
          form.append("files", blob, a.fileName ?? `shot${i}.jpg`);
        } else {
          form.append("files", { uri: a.uri, name: a.fileName ?? `shot${i}.jpg`, type: a.mimeType ?? "image/jpeg" } as unknown as Blob);
        }
      }
      const r = await api<{ summary: string; proposed: number }>("/api/capture/screenshots", { form });
      setResult(`${r.summary}${r.proposed ? ` — ${r.proposed} thing${r.proposed > 1 ? "s" : ""} to review` : ""}`);
      invalidateAll();
      onDone?.(r.summary, r.proposed);
    } catch (e) {
      setResult(`Couldn't read them: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row" }}>
        <Button label={busy ? "Reading…" : label} icon="images-outline" onPress={pick} loading={busy} />
      </View>
      {result ? <Text style={{ color: t.sub, fontSize: 14 }}>{result}</Text> : null}
    </View>
  );
}
