import { Ionicons } from "@expo/vector-icons";
import { Pressable, Text, View } from "react-native";
import { fmtMins } from "../lib/format";
import { tap } from "../lib/haptics";
import { areaColor, radius, sourceLabel, space, useTheme } from "../lib/theme";
import type { TodayItem } from "../lib/types";
import { SwipeRow } from "./SwipeRow";
import { ProgressBar, Tag } from "./ui";

export function TaskItem({
  item,
  onDone,
  onDefer,
  onMenu,
  reorder,
  onMove,
}: {
  item: TodayItem;
  onDone?: () => void;
  onDefer?: () => void;
  onMenu?: () => void;
  reorder?: boolean;
  onMove?: (dir: -1 | 1) => void;
}) {
  const t = useTheme();
  const isTask = item.kind === "task";
  const accent = areaColor[item.area ?? ""] ?? t.faint;
  const body = (
    <Pressable
      onLongPress={() => {
        tap();
        onMenu?.();
      }}
      onPress={onMenu}
      delayLongPress={300}
      style={({ pressed }) => ({
        flexDirection: "row",
        gap: space.md,
        alignItems: "flex-start",
        backgroundColor: pressed ? t.cardAlt : t.card,
        padding: space.md + 2,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: item.tentative ? t.warnSoft : t.line,
        borderStyle: item.tentative ? "dashed" : "solid",
      })}
    >
      {isTask ? (
        <Pressable
          hitSlop={10}
          onPress={() => {
            tap();
            onDone?.();
          }}
          style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: accent, marginTop: 1, alignItems: "center", justifyContent: "center" }}
          accessibilityLabel="Mark done"
        />
      ) : (
        <View style={{ width: 24, alignItems: "center", marginTop: 1 }}>
          <Ionicons name={item.kind === "question" ? "help-circle-outline" : item.locked ? "lock-closed" : "calendar-outline"} size={20} color={item.locked ? t.text : t.sub} />
        </View>
      )}
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={{ fontSize: 16, color: t.text, fontWeight: "500", lineHeight: 21 }}>{item.title}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          {item.timeLabel ? <Text style={{ fontSize: 13, color: item.timeLabel === "overdue" ? t.bad : t.sub, fontWeight: "600" }}>{item.timeLabel}</Text> : null}
          {!item.timeLabel && item.minutes ? <Text style={{ fontSize: 13, color: t.sub }}>{fmtMins(item.minutes)}</Text> : null}
          <Tag label={sourceLabel[item.source] ?? item.source} />
          {item.project ? <Tag label={item.project} color={accent} /> : null}
        </View>
        {item.why ? (
          <Text style={{ fontSize: 13, color: t.faint, lineHeight: 18 }} numberOfLines={2}>
            {item.why}
          </Text>
        ) : null}
        {item.progress ? <View style={{ marginTop: 4 }}><ProgressBar value={item.progress} color={accent} /></View> : null}
      </View>
      {reorder ? (
        <View style={{ gap: 2 }}>
          <Pressable hitSlop={6} onPress={() => onMove?.(-1)}>
            <Ionicons name="chevron-up" size={20} color={t.sub} />
          </Pressable>
          <Pressable hitSlop={6} onPress={() => onMove?.(1)}>
            <Ionicons name="chevron-down" size={20} color={t.sub} />
          </Pressable>
        </View>
      ) : null}
    </Pressable>
  );
  if (!isTask || reorder) return <View style={{ marginBottom: 8 }}>{body}</View>;
  return (
    <SwipeRow onSwipeRight={onDone} onSwipeLeft={onDefer}>
      {body}
    </SwipeRow>
  );
}
