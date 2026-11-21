import { Text, View } from "react-native";
import { fmtMins } from "../lib/format";
import { areaColor, radius, space, useTheme } from "../lib/theme";
import type { TodayItem } from "../lib/types";
import { Button, Tag } from "./ui";

/** The one thing to do right now — big, with Start / Done / Not now. */
export function NowCard({
  item,
  onStart,
  onDone,
  onNotNow,
  onStuck,
}: {
  item: TodayItem;
  onStart: () => void;
  onDone: () => void;
  onNotNow: () => void;
  onStuck: () => void;
}) {
  const t = useTheme();
  const accent = areaColor[item.area ?? ""] ?? t.accent;
  const isTask = item.kind === "task";
  return (
    <View style={{ backgroundColor: t.card, borderRadius: radius.lg, padding: space.xl - 4, borderWidth: 1, borderColor: t.line, overflow: "hidden" }}>
      <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 5, backgroundColor: accent }} />
      <Text style={{ fontSize: 12, fontWeight: "700", letterSpacing: 1, color: accent, textTransform: "uppercase" }}>{item.timeLabel?.startsWith("now") ? "Now" : "Up next"}</Text>
      <Text style={{ fontSize: 22, fontWeight: "700", color: t.text, marginTop: 6, lineHeight: 28, letterSpacing: -0.3 }}>{item.title}</Text>
      <View style={{ flexDirection: "row", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
        {item.timeLabel ? <Text style={{ color: t.sub, fontSize: 14 }}>{item.timeLabel}</Text> : null}
        {item.minutes ? <Text style={{ color: t.sub, fontSize: 14 }}>· {fmtMins(item.minutes)}</Text> : null}
        {item.project ? <Tag label={item.project} color={accent} /> : null}
      </View>
      {item.why ? <Text style={{ color: t.faint, fontSize: 13, marginTop: 6 }}>{item.why}</Text> : null}
      {isTask ? (
        <View style={{ marginTop: space.lg, gap: 4 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button label="Start" icon="play" onPress={onStart} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Done" icon="checkmark" kind="secondary" onPress={onDone} />
            </View>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "center", gap: 4 }}>
            <Button label="Not now" kind="ghost" small onPress={onNotNow} />
            <Button label="I'm stuck" kind="ghost" small onPress={onStuck} />
          </View>
        </View>
      ) : null}
    </View>
  );
}
