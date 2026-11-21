import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useTheme } from "../lib/theme";

export default function RootLayout() {
  const t = useTheme();
  useEffect(() => {
    // Register the PWA service worker (offline + push). Native builds skip this.
    if (Platform.OS === "web" && typeof navigator !== "undefined" && "serviceWorker" in navigator && !__DEV__) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="review" options={{ presentation: "modal" }} />
        <Stack.Screen name="closeout" options={{ presentation: "modal" }} />
        <Stack.Screen name="task/[id]" options={{ presentation: "modal" }} />
        <Stack.Screen name="capture" />
      </Stack>
    </SafeAreaProvider>
  );
}
