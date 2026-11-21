/** All configuration comes from environment variables (see .env.example at repo root). */
export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",
  /** Postgres URL. Unset = embedded PGlite in ./data (zero-setup dev). */
  databaseUrl: process.env.DATABASE_URL,
  dataDir: process.env.LIFE_DATA_DIR ?? "./data",
  /** Single-user bearer token for the API. Unset = no auth (local dev only). */
  apiToken: process.env.LIFE_API_TOKEN,
  /** Hard monthly cap for LLM spend in USD. */
  monthlyBudgetUsd: Number(process.env.LIFE_MONTHLY_BUDGET_USD ?? 10),
  /** "anthropic" (API key) or "claude-cli" (uses `claude -p` signed into your Claude plan). */
  llmProvider: (process.env.LIFE_LLM_PROVIDER ?? "anthropic") as "anthropic" | "claude-cli",
  models: {
    /** Cheap model: triage, extraction, check-in wording. */
    fast: process.env.LIFE_MODEL_FAST ?? "claude-haiku-5-5",
    /** Smarter model: chat, planning, breakdown. */
    smart: process.env.LIFE_MODEL_SMART ?? "claude-sonnet-5-5",
  },
  eunomia: {
    url: process.env.EUNOMIA_URL, // e.g. http://eunomia-backend:8001
    token: process.env.EUNOMIA_TOKEN,
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:8787/api/connect/google/callback",
  },
  notion: { token: process.env.NOTION_TOKEN },
  discord: { botToken: process.env.DISCORD_BOT_TOKEN },
  telegram: { botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID },
  webPush: {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT ?? "mailto:admin@localhost",
  },
  /** Serve the built PWA from here, if present. */
  appDir: process.env.LIFE_APP_DIR ?? "../app/dist",
};
