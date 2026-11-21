import { Platform } from "react-native";

/**
 * On the web/PWA the app is served by the Life server itself, so the API is same-origin.
 * For native builds set EXPO_PUBLIC_API_URL (e.g. https://life.example.com).
 */
const BASE = process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === "web" ? "" : "http://localhost:8787");

let memToken: string | undefined = process.env.EXPO_PUBLIC_API_TOKEN;

export function getToken(): string | undefined {
  if (Platform.OS === "web" && typeof localStorage !== "undefined") return localStorage.getItem("life.token") ?? memToken;
  return memToken;
}

export function setToken(t: string) {
  memToken = t;
  if (Platform.OS === "web" && typeof localStorage !== "undefined") localStorage.setItem("life.token", t);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body || opts.form ? "POST" : "GET"),
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {}
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export const post = <T = unknown>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body });
export const patch = <T = unknown>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body });
