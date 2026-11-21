export function fmtMins(m?: number): string {
  if (m === undefined || m === null) return "";
  if (m < 60) return `${Math.round(m)}m`;
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return r ? `${h}h ${r}m` : `${h}h`;
}

export function fmtTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(" ", "").toLowerCase();
}

export function fmtDay(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const diff = Math.round((new Date(d.toDateString()).getTime() - new Date(today.toDateString()).getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
