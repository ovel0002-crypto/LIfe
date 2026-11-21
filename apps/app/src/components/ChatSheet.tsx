import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View, type ScrollViewInstance, type TextInputInstance } from "react-native";
import { api, post } from "../lib/api";
import { invalidateAll } from "../lib/hooks";
import { tap } from "../lib/haptics";
import { radius, space, useTheme } from "../lib/theme";

interface Msg {
  id: string;
  role: "user" | "assistant";
  text: string;
  batchId?: string | null;
}

const QUICK = ["Focus on…", "Plans changed:", "I'm tired today", "Add: ", "What should I do now?"];

/**
 * Chat lives on the Today screen as a bottom bar that expands. Telling it things
 * ("focus on the robot project", "dinner moved to 8") visibly reshuffles the list.
 */
export function ChatSheet({ prefill, onPrefillUsed }: { prefill?: string; onPrefillUsed?: () => void }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const scroll = useRef<ScrollViewInstance>(null);
  const input = useRef<TextInputInstance>(null);

  useEffect(() => {
    if (open && msgs.length === 0) api<Msg[]>("/api/chat").then(setMsgs).catch(() => {});
  }, [open, msgs.length]);

  useEffect(() => {
    if (prefill) {
      setText(prefill);
      setOpen(true);
      onPrefillUsed?.();
      setTimeout(() => input.current?.focus(), 50);
    }
  }, [prefill, onPrefillUsed]);

  const send = async (override?: string) => {
    const message = (override ?? text).trim();
    if (!message || busy) return;
    tap();
    setText("");
    setOpen(true);
    setMsgs((m) => [...m, { id: `local${Date.now()}`, role: "user", text: message }]);
    setBusy(true);
    try {
      const r = await post<{ reply: string; batchId?: string; changed?: boolean }>("/api/chat", { message });
      setMsgs((m) => [...m, { id: `r${Date.now()}`, role: "assistant", text: r.reply, batchId: r.changed ? r.batchId : null }]);
      if (r.changed) invalidateAll();
    } catch (e) {
      setMsgs((m) => [...m, { id: `e${Date.now()}`, role: "assistant", text: `Couldn't reach Life: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
      setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
    }
  };

  const undo = async (batchId: string) => {
    await post(`/api/batches/${batchId}/revert`);
    setMsgs((m) => [...m.map((x) => (x.batchId === batchId ? { ...x, batchId: null } : x)), { id: `u${Date.now()}`, role: "assistant", text: "Undone." }]);
    invalidateAll();
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
      pointerEvents="box-none"
    >
      <View
        style={{
          backgroundColor: t.card,
          borderTopLeftRadius: radius.lg,
          borderTopRightRadius: radius.lg,
          borderWidth: 1,
          borderColor: t.line,
          paddingBottom: space.sm,
          shadowColor: "#000",
          shadowOpacity: 0.08,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: -4 },
          maxWidth: 720,
          width: "100%",
          alignSelf: "center",
        }}
      >
        {open ? (
          <View style={{ height: 380 }}>
            <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingTop: space.md }}>
              <Text style={{ flex: 1, fontWeight: "700", color: t.text, fontSize: 15 }}>Talk to Life</Text>
              <Pressable onPress={() => setOpen(false)} hitSlop={10}>
                <Ionicons name="chevron-down" size={22} color={t.sub} />
              </Pressable>
            </View>
            <ScrollView ref={scroll} contentContainerStyle={{ padding: space.lg, gap: 10 }} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
              {msgs.length === 0 ? (
                <Text style={{ color: t.faint, fontSize: 14 }}>
                  Tell me what's going on — "focus on uni today", "dinner with Sam moved to 8", "I did 30 min of the essay", "I'm sick". I'll re-plan.
                </Text>
              ) : null}
              {msgs.map((m) => (
                <View key={m.id} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%" }}>
                  <View style={{ backgroundColor: m.role === "user" ? t.accent : t.cardAlt, borderRadius: 16, paddingVertical: 9, paddingHorizontal: 13 }}>
                    <Text style={{ color: m.role === "user" ? "#fff" : t.text, fontSize: 15, lineHeight: 21 }}>{m.text}</Text>
                  </View>
                  {m.batchId ? (
                    <Pressable onPress={() => undo(m.batchId!)} style={{ marginTop: 4 }}>
                      <Text style={{ color: t.accent, fontSize: 13, fontWeight: "600" }}>Undo that</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
              {busy ? <ActivityIndicator color={t.sub} style={{ alignSelf: "flex-start" }} /> : null}
            </ScrollView>
          </View>
        ) : null}
        {open ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingHorizontal: space.lg, paddingBottom: 6 }}>
            {QUICK.map((q) => (
              <Pressable
                key={q}
                onPress={() => {
                  if (q.endsWith("?")) send(q);
                  else {
                    setText(q + (q.endsWith(":") ? " " : ""));
                    input.current?.focus();
                  }
                }}
                style={{ paddingHorizontal: 10, paddingVertical: 6, backgroundColor: t.cardAlt, borderRadius: radius.pill }}
              >
                <Text style={{ color: t.sub, fontSize: 13 }}>{q}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: space.md, paddingTop: open ? 4 : space.md }}>
          <TextInput
            ref={input}
            value={text}
            onChangeText={setText}
            onFocus={() => setOpen(true)}
            onSubmitEditing={() => send()}
            placeholder="Tell Life anything…"
            placeholderTextColor={t.faint}
            returnKeyType="send"
            style={{ flex: 1, backgroundColor: t.cardAlt, borderRadius: radius.pill, paddingHorizontal: 16, paddingVertical: 11, fontSize: 16, color: t.text }}
          />
          <Pressable
            onPress={() => send()}
            disabled={!text.trim() || busy}
            style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: text.trim() ? t.accent : t.cardAlt, alignItems: "center", justifyContent: "center" }}
            accessibilityLabel="Send"
          >
            <Ionicons name="arrow-up" size={20} color={text.trim() ? "#fff" : t.faint} />
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
