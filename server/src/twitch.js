// Minimal Twitch chat bot over IRC/TLS: no dependencies. Replies are rate limited per user.
import tls from "node:tls";
import { config } from "./config.js";
import { SPECIES, findSpecies } from "./state.js";

const COOLDOWN_MS = 10_000;

export function startTwitch(hub, store) {
  const t = config.twitch;
  if (!t.channel || !t.botName || !t.botToken) {
    console.log("Twitch bot disabled (set TWITCH_CHANNEL, TWITCH_BOT_NAME, TWITCH_BOT_TOKEN to enable)");
    return null;
  }
  const channel = "#" + t.channel.toLowerCase().replace(/^#/, "");
  const cooldowns = new Map();
  let sock, closed = false, retry = 1000;

  const say = (msg) => sock?.writable && sock.write(`PRIVMSG ${channel} :${msg.slice(0, 480)}\r\n`);
  const label = (id) => config.players[id]?.label ?? id;
  const isPrivileged = (user, tags) =>
    ["zoe", "clara"].includes(user) || (tags.badges ?? "").match(/(moderator|broadcaster)\//);

  function onCommand(user, tags, text) {
    const [cmdRaw, ...rest] = text.trim().split(/\s+/);
    const cmd = cmdRaw.toLowerCase();
    const arg = rest.join(" ");
    const priv = isPrivileged(user, tags);
    const v = hub.view();
    const cd = `${user}:${cmd}`;
    if (!priv && Date.now() - (cooldowns.get(cd) ?? 0) < COOLDOWN_MS) return;
    cooldowns.set(cd, Date.now());

    switch (cmd) {
      case "!need": {
        const left = SPECIES.filter((s) => v.dex[s.slot]?.state !== "caught");
        const pick = left.sort(() => Math.random() - 0.5).slice(0, 5).map((s) => s.name);
        say(`${left.length} to go! Some we still need: ${pick.join(", ")}`);
        hub.push({ type: "flash", panel: "need" });
        break;
      }
      case "!dex": {
        const sp = findSpecies(arg);
        if (!sp) return say(`Hmm, I don't know "${arg}". Try a name or a number!`);
        const d = v.dex[sp.slot];
        const n = v.times?.[sp.slot];
        if (d?.state === "caught") say(`${sp.name} is CAUGHT! First by ${label(d.firstBy)}.${n > 1 ? ` Caught ${n} times so far!` : ""}`);
        else if (d?.state === "seen") say(`${sp.name} has been seen but not caught yet. (${sp.field} table)`);
        else say(`${sp.name} is still missing (${sp.field === "either" ? "either table" : sp.field + " table"}).`);
        hub.push({ type: "flash", panel: "slot", slot: sp.slot });
        break;
      }
      case "!top":
      case "!most": {
        const top = store.top(5);
        if (!top.length) return say("No catches counted yet!");
        say("Most caught: " + top.map((t) => `${SPECIES[t.slot].name} x${t.n}`).join(", "));
        hub.push({ type: "flash", panel: "slot", slot: top[0].slot });
        break;
      }
      case "!score":
        say(`Zoe ${v.tally.zoe} - Clara ${v.tally.clara} | ${v.caught} / ${v.total} caught!`);
        break;
      case "!vote": {
        const sp = findSpecies(arg);
        if (!sp) return;
        if (v.dex[sp.slot]?.state === "caught") return say(`${sp.name} is already caught!`);
        hub.castVote(user, sp.slot);
        break;
      }
      case "!bounty":
        if (!priv) return;
        if (arg === "open") hub.openVote(60) ? say("Bounty vote open for 60s! Type !vote <name>") : say("A vote is already open.");
        else if (arg === "close") hub.closeVote();
        break;
      case "!testcatch":
        if (user === "zoe" || user === t.channel.toLowerCase()) hub.fakeCatch("zoe");
        break;
    }
  }

  function connect() {
    sock = tls.connect(6697, "irc.chat.twitch.tv", () => {
      sock.write(`PASS ${t.botToken}\r\nNICK ${t.botName}\r\nCAP REQ :twitch.tv/tags\r\nJOIN ${channel}\r\n`);
      retry = 1000;
      console.log(`Twitch bot joined ${channel}`);
    });
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (line.startsWith("PING")) { sock.write("PONG :tmi.twitch.tv\r\n"); continue; }
        const m = line.match(/^(?:@(\S+) )?:(\w+)!\S+ PRIVMSG #\S+ :(.*)$/);
        if (!m) continue;
        const tags = Object.fromEntries((m[1] ?? "").split(";").map((kv) => kv.split("=")));
        if (m[3].startsWith("!")) onCommand(m[2].toLowerCase(), tags, m[3]);
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => { if (!closed) setTimeout(connect, (retry = Math.min(retry * 2, 30_000))); });
  }
  connect();

  hub.on("catch", (e) => {
    if (e.test) return;
    if (e.state === "caught") say(`${label(e.by)} caught ${e.name}! ${e.caught} / ${e.total}`);
  });
  hub.on("milestone", (m) => say(`MILESTONE! ${m.pct}% of the Pokédex!`));
  hub.on("voteClosed", (w) => say(w ? `Tonight's bounty: ${w.name}!` : "No votes - no bounty."));
  return { close() { closed = true; sock?.destroy(); } };
}
