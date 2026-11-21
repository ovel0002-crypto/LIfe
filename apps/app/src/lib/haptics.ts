import { Platform } from "react-native";
import * as Haptics from "expo-haptics";

export function tap() {
  if (Platform.OS === "web") {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(8);
    return;
  }
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

export function success() {
  if (Platform.OS === "web") {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.([10, 40, 10]);
    return;
  }
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}
