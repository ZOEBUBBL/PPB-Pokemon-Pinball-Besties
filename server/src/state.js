// Shared dex state: SQLite-backed, union-merge, first-catch credit.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ROOT, config } from "./config.js";

export const SPECIES = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "species.json"), "utf8"));
export const NUM_SPECIES = SPECIES.length;               // 205
const RANK = { unseen: 0, seen: 1, caught: 2 };

export class Store {
  constructor(file = config.dbPath) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS dex (
        slot INTEGER PRIMARY KEY,
        state TEXT NOT NULL,
        first_by TEXT,            -- who first CAUGHT it
        first_at TEXT,
        seen_by TEXT,             -- who first SAW it
        seen_at TEXT,
        catches TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counts (
        slot INTEGER NOT NULL, player TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (slot, player)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL, player TEXT NOT NULL, slot INTEGER NOT NULL, state TEXT NOT NULL, quiet INTEGER NOT NULL
      );
    `);
    this.q = {
      get: this.db.prepare("SELECT * FROM dex WHERE slot = ?"),
      all: this.db.prepare("SELECT * FROM dex ORDER BY slot"),
      put: this.db.prepare(`INSERT INTO dex (slot,state,first_by,first_at,seen_by,seen_at,catches)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(slot) DO UPDATE SET state=excluded.state, first_by=excluded.first_by, first_at=excluded.first_at,
          seen_by=excluded.seen_by, seen_at=excluded.seen_at, catches=excluded.catches`),
      getMeta: this.db.prepare("SELECT v FROM meta WHERE k = ?"),
      putMeta: this.db.prepare("INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v"),
      addEvent: this.db.prepare("INSERT INTO events (at,player,slot,state,quiet) VALUES (?,?,?,?,?)"),
      bump: this.db.prepare(`INSERT INTO counts (slot,player,n) VALUES (?,?,1)
        ON CONFLICT(slot,player) DO UPDATE SET n = n + 1`),
      counts: this.db.prepare("SELECT slot, player, n FROM counts"),
      since: this.db.prepare("SELECT * FROM events WHERE at >= ? AND quiet = 0 ORDER BY id"),
    };
    this.meta = {
      bounty: this.getMeta("bounty", null),
      sessionStartedAt: this.getMeta("sessionStartedAt", new Date().toISOString()),
      newThisSession: this.getMeta("newThisSession", []),
      settings: { volume: 0.6, reduceMotion: false, soloMode: false, ...this.getMeta("settings", {}) },
    };
    this.putMeta("sessionStartedAt", this.meta.sessionStartedAt);
  }

  getMeta(k, d) {
    const r = this.q.getMeta.get(k);
    return r ? JSON.parse(r.v) : d;
  }
  putMeta(k, v) { this.q.putMeta.run(k, JSON.stringify(v)); }

  row(slot) {
    const r = this.q.get.get(slot);
    return r ? { ...r, catches: JSON.parse(r.catches) } : null;
  }

  /**
   * Apply one player's observation. Returns the change (or null if it was not an upgrade).
   * Merge rules: state only goes up; firstBy is set once and never changes.
   * quiet = progress that existed before the stream (snapshot): counts, but no celebration.
   */
  apply(player, slot, state, { quiet = false, at = new Date().toISOString() } = {}) {
    if (!(slot >= 0 && slot < NUM_SPECIES) || !(state in RANK) || state === "unseen") return null;
    const cur = this.row(slot) ?? { slot, state: "unseen", first_by: null, first_at: null, seen_by: null, seen_at: null, catches: {} };
    // per-player memory, even when the shared state doesn't move (e.g. the other player caught it first)
    const mine = cur.catches[player] ?? 0;
    const myRank = state === "caught" ? 2 : 1;
    let changed = false;
    if (myRank > mine) { cur.catches[player] = myRank; changed = true; }
    const before = cur.state;
    if (RANK[state] > RANK[cur.state]) {
      cur.state = state; changed = true;
      if (state === "caught") { cur.first_by = player; cur.first_at = at; }
    }
    if (state === "seen" || state === "caught") {
      if (!cur.seen_by) { cur.seen_by = player; cur.seen_at = at; changed = true; }
    }
    if (!changed) return null;
    this.q.put.run(slot, cur.state, cur.first_by, cur.first_at, cur.seen_by, cur.seen_at, JSON.stringify(cur.catches));
    const upgraded = RANK[cur.state] > RANK[before];
    if (upgraded) {
      this.q.addEvent.run(at, player, slot, cur.state, quiet ? 1 : 0);
      if (!quiet && cur.state === "caught") {
        this.meta.newThisSession.push(slot);
        this.putMeta("newThisSession", this.meta.newThisSession);
      }
    }
    return { slot, state: cur.state, before, player, upgraded, quiet, first: upgraded && cur.state === "caught" };
  }

  /** Full dex from one player. Returns the list of slots that moved the shared dex. */
  applySnapshot(player, states) {
    const out = [];
    if (!Array.isArray(states)) return out;
    states.slice(0, NUM_SPECIES).forEach((s, slot) => {
      const state = s === 2 || s === "caught" ? "caught" : s === 1 || s === "seen" ? "seen" : null;
      if (!state) return;
      const ch = this.apply(player, slot, state, { quiet: true });
      if (ch) out.push(ch);
    });
    return out;
  }

  // --- admin helpers
  setSlot(slot, state, player = null) {
    if (state === "unseen") {
      this.db.prepare("DELETE FROM dex WHERE slot = ?").run(slot);
      return;
    }
    const cur = this.row(slot);
    const at = new Date().toISOString();
    this.q.put.run(slot, state, state === "caught" ? (player ?? cur?.first_by ?? null) : null,
      state === "caught" ? (cur?.first_at ?? at) : null,
      cur?.seen_by ?? player, cur?.seen_at ?? at, JSON.stringify(cur?.catches ?? {}));
  }
  setSettings(patch) {
    const s = this.meta.settings;
    if (typeof patch.volume === "number") s.volume = Math.min(1, Math.max(0, patch.volume));
    if (typeof patch.reduceMotion === "boolean") s.reduceMotion = patch.reduceMotion;
    if (typeof patch.soloMode === "boolean") s.soloMode = patch.soloMode;
    this.putMeta("settings", s);
  }
  setBounty(slot) { this.meta.bounty = slot; this.putMeta("bounty", slot); }
  /** One more catch of this species by this player (every catch, not just the first). Returns the new totals. */
  addCatch(player, slot) {
    if (!(slot >= 0 && slot < NUM_SPECIES)) return null;
    this.q.bump.run(slot, player);
    const per = {};
    for (const r of this.q.counts.all()) if (r.slot === slot) per[r.player] = r.n;
    return { total: Object.values(per).reduce((a, b) => a + b, 0), per };
  }
  /** Times each species was caught: { slot: total }. */
  times() {
    const out = {};
    for (const r of this.q.counts.all()) out[r.slot] = (out[r.slot] ?? 0) + r.n;
    return out;
  }
  /** Most-caught species, highest first. */
  top(limit = 5) {
    return Object.entries(this.times()).map(([slot, n]) => ({ slot: Number(slot), n }))
      .sort((a, b) => b.n - a.n || a.slot - b.slot).slice(0, limit);
  }
  /** Wipe the shared dex, history, bounty and session. Players and settings are kept. */
  resetAll() {
    this.db.exec("DELETE FROM dex; DELETE FROM events; DELETE FROM counts;");
    this.setBounty(null);
    this.resetSession();
  }
  resetSession() {
    this.meta.sessionStartedAt = new Date().toISOString();
    this.meta.newThisSession = [];
    this.putMeta("sessionStartedAt", this.meta.sessionStartedAt);
    this.putMeta("newThisSession", []);
  }

  /** The object the overlay renders from. */
  view(online = {}) {
    const dex = {};
    let seen = 0, caught = 0;
    const tally = { zoe: 0, clara: 0 };
    for (const r of this.q.all.all()) {
      const catches = JSON.parse(r.catches);
      dex[r.slot] = {
        state: r.state, firstBy: r.first_by, at: r.first_at, seenBy: r.seen_by, catches,
      };
      if (r.state === "caught") { caught++; if (r.first_by in tally) tally[r.first_by]++; }
      else if (r.state === "seen") seen++;
    }
    const players = {};
    for (const [id, p] of Object.entries(config.players)) {
      players[id] = { label: p.label, field: p.field, color: p.color, online: !!online[id] };
    }
    return {
      run: config.run, total: NUM_SPECIES, caught, seen, tally, players, dex,
      times: this.times(), bounty: this.meta.bounty, settings: this.meta.settings,
      session: { startedAt: this.meta.sessionStartedAt, newThisSession: this.meta.newThisSession },
    };
  }

  recap() {
    const evs = this.q.since.all(this.meta.sessionStartedAt).filter((e) => e.state === "caught");
    const perPlayer = {};
    for (const e of evs) perPlayer[e.player] = (perPlayer[e.player] ?? 0) + 1;
    return { startedAt: this.meta.sessionStartedAt, catches: evs.map((e) => ({ slot: e.slot, by: e.player, at: e.at })), perPlayer };
  }
}

export function findSpecies(query) {
  const q = String(query).trim().toLowerCase();
  if (!q) return null;
  const num = Number(q.replace("#", ""));
  if (Number.isInteger(num) && num > 0) {
    // numbers typed by chat are national-dex numbers (what people know); fall back to game slot
    return SPECIES.find((s) => s.national === num) ?? null;
  }
  return SPECIES.find((s) => s.key === q || s.name.toLowerCase() === q) ??
    SPECIES.find((s) => s.name.toLowerCase().startsWith(q)) ?? null;
}
