// HTTP: static pages, admin API, personalized setup pages, sprite cache, and the websocket.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { ROOT, config } from "./config.js";
import { SPECIES } from "./state.js";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".lua": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".woff2": "font/woff2",
};

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function createHttp(hub, store) {
  const adminOk = (pw) => !!pw && safeEq(pw, config.adminPassword);
  const keyOk = (k) => !!k && safeEq(k, config.overlayKey);

  const sendFile = (res, file, extra = {}) => {
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", ...extra });
      res.end(buf);
    });
  };
  const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const body = (req) => new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 100_000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });

  // map a static prefix onto a directory, refusing path escapes
  const statics = {
    "/overlay": path.join(ROOT, "overlay"),
    "/admin": path.join(ROOT, "admin"),
    "/assets": path.join(ROOT, "overlay", "assets"),
    "/data": path.join(ROOT, "data"),
  };
  function serveStatic(res, prefix, urlPath) {
    const dir = statics[prefix];
    let rel = urlPath.slice(prefix.length) || "/";
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(dir)) { res.writeHead(403); return res.end(); }
    if (prefix === "/data" && !file.endsWith("species.json")) { res.writeHead(404); return res.end(); }
    sendFile(res, file);
  }

  // ---- setup pages (personal link: /s/<token>)
  function playerByToken(t) {
    return Object.entries(config.players).find(([, p]) => p.token && safeEq(p.token, t))?.[0] ?? null;
  }
  function luaFor(id) {
    let lua = fs.readFileSync(path.join(ROOT, "lua", "pinball-pals.lua"), "utf8");
    const p = config.players[id];
    const set = (k, v) => { lua = lua.replace(new RegExp(`(^\\s*${k}\\s*=\\s*)[^,]*(,)`, "m"), `$1${v}$2`); };
    set("PLAYER", JSON.stringify(id));
    set("FIELD", JSON.stringify(p.field));
    set("SERVER_HOST", JSON.stringify(config.publicTcpHost));
    set("SERVER_PORT", String(config.publicTcpPort));
    set("TOKEN", JSON.stringify(p.token));
    return lua;
  }

  // ---- sprite cache: official art is fetched once per Pokemon and kept on disk
  const spriteDir = path.join(path.dirname(config.dbPath), "sprites");
  async function sprite(res, n) {
    if (!SPECIES.some((s) => s.national === n)) { res.writeHead(404); return res.end(); }
    const file = path.join(spriteDir, `${n}.png`);
    if (!fs.existsSync(file)) {
      try {
        const r = await fetch(`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${n}.png`);
        if (!r.ok) throw new Error(String(r.status));
        fs.mkdirSync(spriteDir, { recursive: true });
        fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      } catch { res.writeHead(404); return res.end(); }
    }
    sendFile(res, file, { "cache-control": "public, max-age=604800" });
  }

  // ---- admin API
  async function admin(req, res, route) {
    const pw = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!adminOk(pw)) return json(res, 401, { error: "bad password" });
    const b = req.method === "POST" ? await body(req) : {};
    switch (route) {
      case "state": return json(res, 200, { state: hub.view(), species: SPECIES.length, links: links() });
      case "testcatch": return json(res, 200, hub.fakeCatch(b.by === "clara" ? "clara" : "zoe", Number.isInteger(b.slot) ? b.slot : null));
      case "testrepeat": return json(res, 200, hub.fakeRepeat(b.by === "clara" ? "clara" : "zoe", Number.isInteger(b.slot) ? b.slot : 0));
      case "setslot": {
        const slot = Number(b.slot);
        if (!Number.isInteger(slot) || slot < 0 || slot >= SPECIES.length || !["unseen", "seen", "caught"].includes(b.state)) return json(res, 400, { error: "bad slot/state" });
        store.setSlot(slot, b.state, b.by in config.players ? b.by : null);
        hub.note(`admin set ${SPECIES[slot].name} to ${b.state}`);
        hub.pushState();
        return json(res, 200, { ok: true });
      }
      case "bounty": {
        const slot = b.slot == null ? null : Number(b.slot);
        store.setBounty(Number.isInteger(slot) ? slot : null);
        hub.pushState();
        return json(res, 200, { ok: true });
      }
      case "resetsession": store.resetSession(); hub.note("admin reset the session"); hub.pushState(); return json(res, 200, { ok: true });
      case "resetall":
        if (b.confirm !== "RESET") return json(res, 400, { error: "type RESET to confirm" });
        store.resetAll(); hub.note("admin reset EVERYTHING"); hub.pushState(); return json(res, 200, { ok: true });
      case "settings": store.setSettings(b); hub.pushState(); return json(res, 200, store.meta.settings);
      case "recap": { const r = store.recap(); hub.push({ type: "recap", recap: recapView(r) }); return json(res, 200, recapView(r)); }
      case "votes": {
        if (b.action === "open") hub.openVote(Number(b.seconds) || 60);
        else if (b.action === "close") hub.closeVote();
        return json(res, 200, { vote: hub.voteView() });
      }
      default: return json(res, 404, { error: "unknown route" });
    }
  }

  function recapView(r) {
    const rare = r.catches.map((c) => SPECIES[c.slot]).filter(Boolean);
    return { ...r, names: rare.map((s) => s.name), rarest: rare.find((s) => s.special) ?? rare[0] ?? null };
  }

  const base = (req) => config.publicUrl || `http://${req.headers.host}`;
  function links(req) {
    const b = config.publicUrl || "";
    return {
      overlay: `${b}/overlay/?key=${config.overlayKey}`,
      zoeSetup: `${b}/s/${config.players.zoe.token}`,
      claraSetup: `${b}/s/${config.players.clara.token}`,
    };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    try {
      if (p === "/healthz") return json(res, 200, { ok: true });
      if (p === "/") { res.writeHead(302, { location: "/admin/" }); return res.end(); }
      if (p.startsWith("/api/admin/")) return await admin(req, res, p.slice("/api/admin/".length));
      if (p === "/api/dex") {                                  // read-only JSON for tools
        if (!keyOk(url.searchParams.get("key"))) return json(res, 401, { error: "bad key" });
        return json(res, 200, hub.view());
      }
      const sp = p.match(/^\/sprite\/(\d+)\.png$/);
      if (sp) return await sprite(res, Number(sp[1]));
      const setup = p.match(/^\/s\/([^/]+)(\/pinball-pals\.lua)?$/);
      if (setup) {
        const id = playerByToken(setup[1]);
        if (!id) { res.writeHead(404); return res.end("not found"); }
        if (setup[2]) return (res.writeHead(200, { "content-type": TYPES[".lua"], "content-disposition": 'attachment; filename="pinball-pals.lua"' }), res.end(luaFor(id)));
        let html = fs.readFileSync(path.join(ROOT, "setup", "index.html"), "utf8");
        const info = {
          player: id, label: config.players[id].label, field: config.players[id].field, color: config.players[id].color,
          script: `/s/${setup[1]}/pinball-pals.lua`,
          vdoStream: `pinballpals-${id}`,
          host: config.publicTcpHost, port: config.publicTcpPort,
        };
        html = html.replace("/*__SETUP__*/null", JSON.stringify(info));
        res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
        return res.end(html);
      }
      for (const prefix of Object.keys(statics)) {
        if (p === prefix) { res.writeHead(302, { location: prefix + "/" + url.search }); return res.end(); }
        if (p.startsWith(prefix + "/")) return serveStatic(res, prefix, p);
      }
      res.writeHead(404); res.end("not found");
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: "server error" });
    }
  });

  // ---- websocket: /ws?key=<overlay key>  (read-only)   /ws?pw=<admin password>  (read + log)
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/ws") return socket.destroy();
    const role = adminOk(url.searchParams.get("pw")) ? "admin" : keyOk(url.searchParams.get("key")) ? "overlay" : null;
    if (!role) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = { ws, role };
      hub.addClient(client);
      ws.on("close", () => hub.removeClient(client));
      ws.on("error", () => {});
      // clients never write; the only inbound message is a keepalive
      ws.on("message", () => {});
    });
  });

  return server;
}
