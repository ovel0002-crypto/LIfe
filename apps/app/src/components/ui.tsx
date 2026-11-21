import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps, ReactNode } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { tap } from "../lib/haptics";
import { radius, space, useTheme } from "../lib/theme";

export type IconName = ComponentProps<typeof Ionicons>["name"];

export function Screen({ children, refreshing, header }: { children: ReactNode; refreshing?: boolean; header?: ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + space.md, paddingBottom: 140, paddingHorizontal: space.lg, maxWidth: 720, width: "100%", alignSelf: "center" }}
        keyboardShouldPersistTaps="handled"
      >
        {header}
        {refreshing ? <ActivityIndicator style={{ marginVertical: space.md }} color={t.sub} /> : null}
        {children}
      </ScrollView>
    </View>
  );
}

export function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ marginBottom: space.lg }}>
      <Text style={{ fontSize: 30, fontWeight: "700", color: t.text, letterSpacing: -0.5 }}>{children}</Text>
      {sub ? <Text style={{ fontSize: 15, color: t.sub, marginTop: 2 }}>{sub}</Text> : null}
    </View>
  );
}

export function SectionHeader({ title, count, right, hint }: { title: string; count?: number; right?: ReactNode; hint?: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", marginTop: space.xl, marginBottom: space.sm }}>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 13, fontWeight: "700", color: t.sub, textTransform: "uppercase", letterSpacing: 0.8 }}>
          {title}
          {count !== undefined ? <Text style={{ color: t.faint }}>  {count}</Text> : null}
        </Text>
        {hint ? <Text style={{ fontSize: 12, color: t.faint, marginTop: 2 }}>{hint}</Text> : null}
      </View>
      {right}
    </View>
  );
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: ViewStyle; onPress?: () => void }) {
  const t = useTheme();
  const base: ViewStyle = {
    backgroundColor: t.card,
    borderRadius: radius.md,
    padding: space.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.line,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  };
  if (onPress)
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [base, style, pressed && { opacity: 0.85 }]}>
        {children}
      </Pressable>
    );
  return <View style={[base, style]}>{children}</View>;
}

export function Chip({ label, active, onPress, icon, tone }: { label: string; active?: boolean; onPress?: () => void; icon?: IconName; tone?: "accent" | "warn" | "good" | "bad" }) {
  const t = useTheme();
  const fg = active ? "#fff" : tone ? t[tone] : t.sub;
  const bg = active ? t.accent : tone ? t[`${tone}Soft` as const] : t.cardAlt;
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress?.();
      }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: radius.pill,
        backgroundColor: bg,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {icon ? <Ionicons name={icon} size={14} color={fg} /> : null}
      <Text style={{ color: fg, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

export function Tag({ label, color }: { label: string; color?: string }) {
  const t = useTheme();
  return (
    <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: t.cardAlt }}>
      <Text style={{ fontSize: 11, fontWeight: "600", color: color ?? t.sub }}>{label}</Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  kind = "primary",
  icon,
  disabled,
  loading,
  small,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "ghost" | "danger";
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  small?: boolean;
}) {
  const t = useTheme();
  const bg = kind === "primary" ? t.accent : kind === "danger" ? t.badSoft : kind === "secondary" ? t.cardAlt : "transparent";
  const fg = kind === "primary" ? "#fff" : kind === "danger" ? t.bad : kind === "secondary" ? t.text : t.accent;
  return (
    <Pressable
      disabled={disabled || loading}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingHorizontal: small ? 12 : 16,
        paddingVertical: small ? 8 : 12,
        borderRadius: radius.sm + 4,
        backgroundColor: bg,
        opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
      })}
    >
      {loading ? <ActivityIndicator size="small" color={fg} /> : icon ? <Ionicons name={icon} size={small ? 15 : 17} color={fg} /> : null}
      <Text style={{ color: fg, fontWeight: "600", fontSize: small ? 14 : 15 }}>{label}</Text>
    </Pressable>
  );
}

export function Empty({ icon, text }: { icon: IconName; text: string }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: "center", paddingVertical: space.lg, gap: 6 }}>
      <Ionicons name={icon} size={22} color={t.faint} />
      <Text style={{ color: t.faint, fontSize: 14, textAlign: "center" }}>{text}</Text>
    </View>
  );
}

export function ProgressBar({ value, color }: { value: number; color?: string }) {
  const t = useTheme();
  return (
    <View style={{ height: 4, borderRadius: 2, backgroundColor: t.cardAlt, overflow: "hidden" }}>
      <View style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`, height: 4, backgroundColor: color ?? t.good }} />
    </View>
  );
}

export interface SheetAction {
  label: string;
  icon: IconName;
  onPress: () => void;
  destructive?: boolean;
}

/** Bottom action sheet (long-press menu). */
export function ActionSheet({ visible, title, actions, onClose }: { visible: boolean; title?: string; actions: SheetAction[]; onClose: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" }} onPress={onClose}>
        <Pressable
          style={{
            backgroundColor: t.card,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            paddingBottom: insets.bottom + space.md,
            paddingTop: space.sm,
            maxWidth: 720,
            width: "100%",
            alignSelf: "center",
          }}
        >
          <View style={{ alignSelf: "center", width: 36, height: 5, borderRadius: 3, backgroundColor: t.line, marginBottom: space.sm }} />
          {title ? <Text style={{ color: t.sub, fontSize: 13, textAlign: "center", paddingHorizontal: space.lg, marginBottom: space.sm }} numberOfLines={2}>{title}</Text> : null}
          {actions.map((a) => (
            <Pressable
              key={a.label}
              onPress={() => {
                tap();
                onClose();
                a.onPress();
              }}
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 14, paddingHorizontal: space.xl, backgroundColor: pressed ? t.cardAlt : "transparent" })}
            >
              <Ionicons name={a.icon} size={20} color={a.destructive ? t.bad : t.text} />
              <Text style={{ fontSize: 16, color: a.destructive ? t.bad : t.text }}>{a.label}</Text>
            </Pressable>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** Small toast with optional Undo. */
export function Toast({ text, onUndo, onHide }: { text?: string; onUndo?: () => void; onHide: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  if (!text) return null;
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: insets.bottom + 140, alignItems: "center" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: t.text, paddingVertical: 10, paddingHorizontal: 16, borderRadius: radius.pill, maxWidth: 520 }}>
        <Text style={{ color: t.bg, fontSize: 14, flexShrink: 1 }} numberOfLines={2}>
          {text}
        </Text>
        {onUndo ? (
          <Pressable
            onPress={() => {
              onUndo();
              onHide();
            }}
          >
            <Text style={{ color: t.accentSoft, fontWeight: "700" }}>Undo</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
