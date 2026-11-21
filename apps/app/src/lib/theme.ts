import { useColorScheme } from "react-native";

const light = {
  bg: "#F6F5F2",
  card: "#FFFFFF",
  cardAlt: "#F0EEE9",
  text: "#1C1B19",
  sub: "#6B6862",
  faint: "#A29E96",
  line: "#E7E4DE",
  accent: "#4F46E5",
  accentSoft: "#EEF0FF",
  good: "#16A34A",
  goodSoft: "#E8F7EE",
  warn: "#D97706",
  warnSoft: "#FFF4E0",
  bad: "#DC2626",
  badSoft: "#FDECEC",
  shadow: "rgba(28,27,25,0.06)",
};

const dark: typeof light = {
  bg: "#111110",
  card: "#1C1B1A",
  cardAlt: "#262523",
  text: "#F3F2EF",
  sub: "#A8A49C",
  faint: "#6E6A63",
  line: "#2E2D2A",
  accent: "#8B85FF",
  accentSoft: "#24224A",
  good: "#4ADE80",
  goodSoft: "#163222",
  warn: "#FBBF24",
  warnSoft: "#3A2C10",
  bad: "#F87171",
  badSoft: "#3B1717",
  shadow: "rgba(0,0,0,0.3)",
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

export const areaColor: Record<string, string> = {
  uni: "#4F46E5",
  work: "#0EA5E9",
  social: "#EC4899",
  personal: "#16A34A",
  admin: "#A16207",
  health: "#DC2626",
};

export const sourceLabel: Record<string, string> = {
  you: "You",
  chat: "Chat",
  moodle: "Moodle",
  timetable: "Timetable",
  gmail: "Gmail",
  "uni-gmail": "Uni mail",
  gcal: "Calendar",
  notion: "Notion",
  discord: "Discord",
  screenshot: "Screenshot",
  telegram: "Telegram",
  claude: "Claude",
  system: "Life",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { sm: 8, md: 14, lg: 20, pill: 999 };
