import { Ionicons } from "@expo/vector-icons";
import { useRef, type ReactNode } from "react";
import { Animated, PanResponder, Platform, Text, View } from "react-native";
import { success, tap } from "../lib/haptics";
import { radius, useTheme } from "../lib/theme";
import type { IconName } from "./ui";

const THRESHOLD = 90;

/**
 * Swipe right = primary action (done), swipe left = secondary (not today).
 * Horizontal-only so vertical scrolling stays smooth; works with touch and mouse.
 */
export function SwipeRow({
  children,
  onSwipeRight,
  onSwipeLeft,
  rightLabel = "Done",
  leftLabel = "Tomorrow",
  rightIcon = "checkmark",
  leftIcon = "arrow-forward",
}: {
  children: ReactNode;
  onSwipeRight?: () => void;
  onSwipeLeft?: () => void;
  rightLabel?: string;
  leftLabel?: string;
  rightIcon?: IconName;
  leftIcon?: IconName;
}) {
  const t = useTheme();
  const x = useRef(new Animated.Value(0)).current;
  const crossed = useRef(false);
  // Keep latest callbacks without re-creating the responder.
  const cb = useRef({ onSwipeRight, onSwipeLeft });
  cb.current = { onSwipeRight, onSwipeLeft };

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_e, g) => {
        const dx = (g.dx > 0 && !cb.current.onSwipeRight) || (g.dx < 0 && !cb.current.onSwipeLeft) ? g.dx * 0.15 : g.dx;
        x.setValue(dx);
        const over = Math.abs(dx) > THRESHOLD;
        if (over !== crossed.current) {
          crossed.current = over;
          if (over) tap();
        }
      },
      onPanResponderRelease: (_e, g) => {
        crossed.current = false;
        const go = (dir: 1 | -1, fn?: () => void) => {
          success();
          Animated.timing(x, { toValue: dir * 500, duration: 180, useNativeDriver: Platform.OS !== "web" }).start(() => {
            fn?.();
            x.setValue(0);
          });
        };
        const { onSwipeRight: r, onSwipeLeft: l } = cb.current;
        if (g.dx > THRESHOLD && r) return go(1, r);
        if (g.dx < -THRESHOLD && l) return go(-1, l);
        Animated.spring(x, { toValue: 0, useNativeDriver: Platform.OS !== "web", bounciness: 6 }).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(x, { toValue: 0, useNativeDriver: Platform.OS !== "web" }).start();
      },
    }),
  ).current;

  const rightOpacity = x.interpolate({ inputRange: [0, 40, THRESHOLD], outputRange: [0, 0.6, 1], extrapolate: "clamp" });
  const leftOpacity = x.interpolate({ inputRange: [-THRESHOLD, -40, 0], outputRange: [1, 0.6, 0], extrapolate: "clamp" });

  return (
    <View style={{ borderRadius: radius.md, overflow: "hidden", marginBottom: 8 }}>
      <View style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, flexDirection: "row" }}>
        <Animated.View style={{ flex: 1, backgroundColor: t.good, opacity: rightOpacity, justifyContent: "center", paddingLeft: 20, flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Ionicons name={rightIcon} size={20} color="#fff" />
          <Text style={{ color: "#fff", fontWeight: "700", flex: 1 }}>{rightLabel}</Text>
        </Animated.View>
        <Animated.View
          style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: t.warn, opacity: leftOpacity, justifyContent: "flex-end", paddingRight: 20, flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          <Text style={{ color: "#fff", fontWeight: "700" }}>{leftLabel}</Text>
          <Ionicons name={leftIcon} size={20} color="#fff" />
        </Animated.View>
      </View>
      <Animated.View style={{ transform: [{ translateX: x }] }} {...pan.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}
