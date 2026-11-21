import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { api, ApiError } from "./api";

type Listener = () => void;
const listeners = new Set<Listener>();
/** Tell every screen to refetch (after any change — the plan re-flows server-side). */
export function invalidateAll() {
  listeners.forEach((l) => l());
}

/** Tiny SWR: fetch, refetch on focus/foreground, refetch on invalidate, keep last data offline. */
export function useApi<T>(path: string | null, opts: { refreshMs?: number } = {}) {
  const [data, setData] = useState<T | undefined>(() => (path ? readCache<T>(path) : undefined));
  const [error, setError] = useState<ApiError | Error | undefined>();
  const [loading, setLoading] = useState(!data);
  const pathRef = useRef(path);
  pathRef.current = path;

  const load = useCallback(async () => {
    const p = pathRef.current;
    if (!p) return;
    try {
      const d = await api<T>(p);
      setData(d);
      writeCache(p, d);
      setError(undefined);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    listeners.add(load);
    const sub = AppState.addEventListener("change", (s) => s === "active" && load());
    const onFocus = () => load();
    if (Platform.OS === "web" && typeof window !== "undefined") window.addEventListener("focus", onFocus);
    const t = opts.refreshMs ? setInterval(load, opts.refreshMs) : undefined;
    return () => {
      listeners.delete(load);
      sub.remove();
      if (Platform.OS === "web" && typeof window !== "undefined") window.removeEventListener("focus", onFocus);
      if (t) clearInterval(t);
    };
  }, [path, load, opts.refreshMs]);

  return { data, error, loading, reload: load, setData };
}

function readCache<T>(key: string): T | undefined {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return undefined;
  try {
    const v = localStorage.getItem(`life.cache:${key}`);
    return v ? (JSON.parse(v) as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeCache(key: string, v: unknown) {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(`life.cache:${key}`, JSON.stringify(v));
  } catch {}
}

/** Run a mutation, then refresh everything. Errors surface via the returned promise. */
export async function act<T>(fn: () => Promise<T>): Promise<T> {
  const r = await fn();
  invalidateAll();
  return r;
}
