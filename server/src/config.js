// All configuration comes from environment variables so nothing secret lives in the repo.
// Copy ../.env.example to .env for local use (loaded below with no dependency).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");   // pinball-pals/

// tiny .env loader: KEY=value lines, no quoting rules beyond stripping quotes
for (const p of [path.join(ROOT, ".env"), path.join(here, "..", ".env")]) {
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const env = (k, d = "") => process.env[k] ?? d;

export const config = {
  run: env("RUN_NAME", "pinball-pals-2026"),
  httpPort: Number(env("PORT", env("HTTP_PORT", "8080"))),
  tcpPort: Number(env("TCP_PORT", "9000")),
  dbPath: env("DB_PATH", path.join(ROOT, "data", "pinball-pals.sqlite")),
  adminPassword: env("ADMIN_PASSWORD", ""),
  overlayKey: env("OVERLAY_KEY", ""),
  // what Clara's setup page writes into her script
  publicTcpHost: env("PUBLIC_TCP_HOST", "localhost"),
  publicTcpPort: Number(env("PUBLIC_TCP_PORT", env("TCP_PORT", "9000"))),
  publicUrl: env("PUBLIC_URL", ""),
  // Should progress already in each save count toward the shared dex? (open question in the GDD)
  countExistingProgress: env("COUNT_EXISTING_PROGRESS", "true") !== "false",
  players: {
    zoe:   { field: "ruby",     color: env("ZOE_COLOR", "#ff8fb1"),   token: env("ZOE_TOKEN", ""),   label: "Zoe" },
    clara: { field: "sapphire", color: env("CLARA_COLOR", "#8fc7ff"), token: env("CLARA_TOKEN", ""), label: "Clara" },
  },
  twitch: {
    channel: env("TWITCH_CHANNEL", ""),
    botName: env("TWITCH_BOT_NAME", ""),
    botToken: env("TWITCH_BOT_TOKEN", ""),   // "oauth:xxxx"
  },
};

// Refuse to run wide open: missing secrets get a random value printed once at startup.
import crypto from "node:crypto";
const gen = () => crypto.randomBytes(9).toString("base64url");
export const generated = [];
for (const [k, obj, prop] of [
  ["ADMIN_PASSWORD", config, "adminPassword"],
  ["OVERLAY_KEY", config, "overlayKey"],
  ["ZOE_TOKEN", config.players.zoe, "token"],
  ["CLARA_TOKEN", config.players.clara, "token"],
]) {
  if (!obj[prop]) { obj[prop] = gen(); generated.push(k); }
}
