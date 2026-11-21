import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router/js-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../lib/theme";
import { useApi } from "../../lib/hooks";
import type { Change } from "../../lib/types";

type IconName = React.ComponentProps<typeof Ionicons>["name"];
const icon = (name: IconName) =>
  function TabIcon({ color, size }: { color: unknown; size: number }) {
    return <Ionicons name={name} size={size - 2} color={String(color ?? "")} />;
  };

export default function TabsLayout() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { data: proposed } = useApi<Change[]>("/api/changes?status=proposed", { refreshMs: 120_000 });
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.faint,
        tabBarStyle: { backgroundColor: t.card, borderTopColor: t.line, height: 58 + insets.bottom, paddingTop: 6, paddingBottom: insets.bottom + 6 },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600", lineHeight: 14, height: 15, flexShrink: 0, overflow: "visible" },
        sceneStyle: { backgroundColor: t.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Today", tabBarIcon: icon("checkmark-done-circle-outline") }} />
      <Tabs.Screen name="week" options={{ title: "Week", tabBarIcon: icon("calendar-outline") }} />
      <Tabs.Screen name="projects" options={{ title: "Projects", tabBarIcon: icon("layers-outline") }} />
      <Tabs.Screen
        name="inbox"
        options={{ title: "Inbox", tabBarIcon: icon("file-tray-outline"), tabBarBadge: proposed?.length ? proposed.length : undefined }}
      />
      <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: icon("settings-outline") }} />
    </Tabs>
  );
}
