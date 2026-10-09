// The hub: TCP from emulator scripts, websocket fan-out to overlays, chat bounty votes.
import net from "node:net";
import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { NUM_SPECIES, SPECIES } from "./state.js";

const PING_MS = 10_000;
const DEAD_MS = 30_000;
const MILESTONES = [0.25, 0.5, 0.75, 1];

export class Hub extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.clients = new Set();        // overlay / admin websocket clients: { ws, role }
    this.players = {};               // id -> { socket, lastRx }
    this.vote = null;                // { endsAt, votes: Map<user, slot>, timer }
    this.log = [];                   // recent server log lines for the admin page
  }

  // ---- logging
  note(msg) {
    const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
    this.log.push(line); if (this.log.length > 200) this.log.shift();
    console.log(msg);
    this.push({ type: "log", line });
  }

  // ---- websocket side
  online() {
    return Object.fromEntries(Object.keys(config.players).map((id) => [id, !!this.players[id]]));
  }
  view() { return this.store.view(this.online()); }
  addClient(c) {
    this.clients.add(c);
    this.send(c, { type: "state", state: this.view(), vote: this.voteView() });
    if (c.role === "admin") this.send(c, { type: "logs", lines: this.log });
  }
  removeClient(c) { this.clients.delete(c); }
  send(c, msg) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); }
  push(msg, adminOnly = false) {
    for (const c of this.clients) if (!adminOnly || c.role === "admin") this.send(c, msg);
  }
  pushState() { this.push({ type: "state", state: this.view(), vote: this.voteView() }); }

  // ---- catches
  /** Handle one or many store changes: events for the overlay, chat line, milestones. */
  announce(changes) {
    const prevCaught = this.view().caught - changes.filter((c) => c.upgraded && c.state === "caught").length;
    for (const ch of changes) {
      if (!ch.upgraded || ch.quiet) continue;
      const sp = SPECIES[ch.slot];
      const view = this.view();
      const evt = {
        type: "catch", slot: ch.slot, state: ch.state, by: ch.player,
        first: ch.first, name: sp.name, national: sp.national,
        isBounty: ch.state === "caught" && this.store.meta.bounty === ch.slot,
        caught: view.caught, total: NUM_SPECIES, at: new Date().toISOString(),
      };
      this.push(evt);
      this.emit("catch", evt);
      this.note(`${config.players[ch.player].label} ${ch.state === "caught" ? "caught" : "saw"} ${sp.name} (${view.caught}/${NUM_SPECIES})`);
      if (evt.isBounty) { this.store.setBounty(null); this.emit("bountyHit", evt); }
    }
    const now = this.view().caught;
    for (const m of changes.some((c) => !c.quiet) ? MILESTONES : []) {
      const need = Math.ceil(NUM_SPECIES * m);
      if (prevCaught < need && now >= need) {
        this.push({ type: "milestone", pct: Math.round(m * 100), caught: now, total: NUM_SPECIES });
        this.emit("milestone", { pct: Math.round(m * 100) });
      }
    }
    this.pushState();
  }

  fakeRepeat(by = "zoe", slot = 0) {
    const sp = SPECIES[slot] ?? SPECIES[0];
    const evt = { type: "repeat", test: true, slot: sp.slot, by, name: sp.name, count: (this.store.times()[sp.slot] ?? 0) + 1, at: new Date().toISOString() };
    this.push(evt);
    return evt;
  }
  fakeCatch(by = "zoe", slot = null) {
    const open = SPECIES.filter((s) => (this.store.row(s.slot)?.state ?? "unseen") !== "caught");
    const sp = slot != null ? SPECIES[slot] : (open[Math.floor(Math.random() * open.length)] ?? SPECIES[0]);
    const evt = {
      type: "catch", test: true, slot: sp.slot, state: "caught", by, first: true,
      name: sp.name, national: sp.national, isBounty: false,
      caught: this.view().caught, total: NUM_SPECIES, at: new Date().toISOString(),
    };
    this.push(evt);
    this.note(`TEST catch: ${sp.name} for ${by}`);
    return evt;
  }

  // ---- bounty votes
  voteView() {
    if (!this.vote) return null;
    const tally = {};
    for (const slot of this.vote.votes.values()) tally[slot] = (tally[slot] ?? 0) + 1;
    return {
      endsAt: this.vote.endsAt,
      tally: Object.entries(tally).map(([slot, n]) => ({ slot: Number(slot), name: SPECIES[slot].name, n })).sort((a, b) => b.n - a.n),
    };
  }
  openVote(seconds = 60) {
    if (this.vote) return false;
    this.vote = { endsAt: Date.now() + seconds * 1000, votes: new Map(), timer: setTimeout(() => this.closeVote(), seconds * 1000) };
    this.pushState();
    this.emit("voteOpen", seconds);
    return true;
  }
  castVote(user, slot) {
    if (!this.vote) return false;
    this.vote.votes.set(user, slot);
    this.pushState();
    return true;
  }
  closeVote() {
    if (!this.vote) return null;
    clearTimeout(this.vote.timer);
    const view = this.voteView();
    this.vote = null;
    const winner = view.tally[0] ?? null;
    if (winner) this.store.setBounty(winner.slot);
    this.pushState();
    this.emit("voteClosed", winner);
    return winner;
  }

  // ---- TCP side (emulator scripts)
  listenTcp(port = config.tcpPort) {
    this.tcp = net.createServer((sock) => this.onSocket(sock));
    this.tcp.listen(port, () => this.note(`TCP listening on :${this.tcp.address().port}`));
    this.timer = setInterval(() => this.sweep(), PING_MS);
    return this.tcp;
  }

  sweep() {
    for (const [id, p] of Object.entries(this.players)) {
      if (Date.now() - p.lastRx > DEAD_MS) { p.socket.destroy(); continue; }
      this.write(p.socket, { t: "ping" });
    }
  }

  write(sock, msg) { if (!sock.destroyed) sock.write(JSON.stringify(msg) + "\n"); }

  onSocket(sock) {
    sock.setEncoding("utf8");
    sock.setNoDelay(true);
    let buf = "";
    let player = null;
    const helloTimer = setTimeout(() => { if (!player) sock.destroy(); }, 10_000);
    sock.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > 200_000) return sock.destroy();       // nobody legit sends this much
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        player = this.onMessage(sock, player, msg);
        if (player === false) return;                       // rejected; socket already destroyed
      }
    });
    const gone = () => {
      clearTimeout(helloTimer);
      if (player && this.players[player]?.socket === sock) {
        delete this.players[player];
        this.note(`${config.players[player].label} disconnected`);
        this.pushState();
      }
    };
    sock.on("close", gone);
    sock.on("error", () => {});
  }

  onMessage(sock, player, msg) {
    if (!player) {
      if (msg.t !== "hello") { sock.destroy(); return false; }
      const id = Object.keys(config.players).find((k) => config.players[k].token === msg.token && msg.token);
      if (!id) { this.write(sock, { t: "error", msg: "bad token" }); sock.destroy(); return false; }
      if (msg.gameCode && msg.gameCode !== "BPPE") {
        this.write(sock, { t: "error", msg: "wrong game" }); sock.destroy(); return false;
      }
      this.players[id]?.socket.destroy();                   // a reconnect replaces the old socket
      this.players[id] = { socket: sock, lastRx: Date.now() };
      this.write(sock, { t: "welcome", player: id, field: config.players[id].field });
      this.note(`${config.players[id].label} connected`);
      this.pushState();
      return id;
    }
    const p = this.players[player];
    if (p) p.lastRx = Date.now();
    switch (msg.t) {
      case "ping": this.write(sock, { t: "pong" }); break;
      case "pong": break;
      case "snapshot": {
        if (!config.countExistingProgress) break;
        const changes = this.store.applySnapshot(player, msg.dex);
        if (changes.length) { this.note(`${config.players[player].label} snapshot added ${changes.length} entries`); this.announce(changes); }
        break;
      }
      case "catch": {
        // the script saw the game's per-game catch counter go up: count it, and bubble repeats
        const slot = Number(msg.slot);
        if (!Number.isInteger(slot) || slot < 0 || slot >= NUM_SPECIES) break;
        const c = this.store.addCatch(player, slot);
        if (c && c.total > 1) {
          const evt = { type: "repeat", slot, by: player, name: SPECIES[slot].name, count: c.total, at: new Date().toISOString() };
          this.push(evt);
          this.emit("repeat", evt);
        }
        this.pushState();
        break;
      }
      case "dex": {
        const state = msg.state === "caught" ? "caught" : msg.state === "seen" ? "seen" : null;
        const slot = Number(msg.slot);
        if (!state || !Number.isInteger(slot)) break;
        const ch = this.store.apply(player, slot, state);
        if (ch) this.announce([ch]);
        break;
      }
    }
    return player;
  }

  close() {
    clearInterval(this.timer);
    this.tcp?.close();
    for (const p of Object.values(this.players)) p.socket.destroy();
  }
}
