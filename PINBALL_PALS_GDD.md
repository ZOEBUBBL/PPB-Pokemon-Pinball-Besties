# Pinball Pals — Co-op Pokédex Stream Overlay

Oct 7, 2026 · @Zoe

## Overview

Zoe and Clara each play Pokémon Pinball: Ruby & Sapphire on their own computers, one on the Ruby table and one on the Sapphire table, and fill ONE shared Pokédex live on stream. The game has 205 Pokémon, and some appear only on the Ruby or only on the Sapphire Field, so with each player locked to one table, neither can finish the dex alone. That split is the hook: every catch matters, and the two tables need each other.

**What we're building**

- An emulator script on each player's machine that detects new Pokédex entries and reports them.
- A hosted server (Zoe hosts it) that merges both players' catches into one shared dex.
- A cute browser-source overlay for OBS: both gameplay feeds side by side, the shared dex grid, a "still need" list, and catch celebrations.
- Light Twitch chat integration so viewers can poke at the dex.

**Success criteria**

- Clara's setup takes under 15 minutes: install mGBA, load her own ROM, load one script, paste one link.
- A catch on either machine appears on the overlay within 2 seconds.
- Zoe streams one combined layout; Clara never has to touch OBS.
- Progress survives crashes and multiple sessions. The dex lives on the server, not in either save file.

## Core loop and engagement

The loop is: play, catch, celebrate, check what's left, pick a target, repeat. Every feature below either makes a catch feel bigger or gives chat a reason to talk.

**Core loop**

1. Both players play their own table at the same time.
2. A catch on either machine fires a celebration on the overlay, credited to that player.
3. The shared counter ticks up (for example, 87 / 205), and the "still need" list shrinks.
4. Chat reacts, votes on targets, or predicts the next catch.

**Features, in priority order**

- **Catch pop-up (must have):** a big chibi card with sparkles, the Pokémon name and number, and "Caught by Clara!" in her color. New-to-the-dex catches get the full show; repeat catches get a small "+1" bubble only.
- **First-catch credit (must have):** every dex slot remembers who caught it first. A running "Zoe 41 · Clara 46" tally keeps a friendly rivalry going.
- **Still-need list (must have):** grouped by Ruby-only, Sapphire-only, and either table, so each player sees their own homework.
- **Seen vs caught (should have):** the game also tracks "seen" (hatching eggs count as seen). Show seen slots as silhouettes, which is great tension for chat.
- **Milestones (should have):** confetti and a jingle at 25%, 50%, 75%, and 205.
- **Chat commands (should have):** `!need`, `!dex <name or number>`, `!score`.
- **Bounty of the night (nice to have):** chat votes a target from the still-need list. Catching it triggers an extra-special celebration.
- **Session recap (nice to have):** an end-of-stream card with catches tonight, per-player counts, and the rarest catch.

## System architecture

Data and video take separate paths. Catches travel from each emulator script to the server, which merges them and pushes one shared dex to the overlay. Clara's video goes peer-to-peer through VDO.Ninja straight into Zoe's OBS, so the server never handles video.

&#91;embedded content: system architecture · 2 players, 1 server\]

Zoe's PC does double duty: it runs her game and tracker, and it composites everything in OBS for the single stream.

## Memory reading: finding the Pokédex in RAM

The hardest unknown is solved by someone else: [pret/pokepinballrs](https://github.com/pret/pokepinballrs) is an active decompilation of the US ROM, so the Pokédex flag layout can be read from source instead of reverse-engineered. Its last commits are from early 2026. Claude Code's first job is to pin down the exact address and format.

**Research tasks for Claude Code (do these before writing the tracker)**

1. Clone pokepinballrs and search for the Pokédex storage: the save-data struct and anything named like `pokedex`, `caught`, `seen`, or `dex`. Record the struct, its address (EWRAM or IWRAM, via the build's `.map` or `.sym` file), and how one species is stored (bit flags, byte per species, or a caught/seen enum).
2. Find the species order the game uses for dex slots 1 to 205, and build a static `species.json` (slot, national number, name, field availability). The game's own order is the source of truth, not the national dex.
3. Confirm the ROM: the decomp builds the US ROM with SHA1 `9fec81ce2c5df589e0371a0bf2f92a5fe8db730b`. Both players need that same US ROM for the addresses to match. The script checks `emu:getGameCode()` at startup and refuses to run on anything else, with a friendly message.
4. Verify live with mGBA's memory viewer before trusting the address. Snapshot the dex region, catch one Pokémon, and diff. Do the same for an egg hatch to confirm the "seen" state.
5. Check when the game writes the dex: instantly on catch, or only at end of ball or game. If it's delayed, find a better signal (for example, the catch-complete state in the board state machine) and use that as the trigger.

**Tracker logic (Lua, inside mGBA)**

- Each frame (throttle to every \~15 frames), read the dex region with `emu:readRange`. The single-value `read8/16/32` calls are reported to be flaky inside frame callbacks.
- Diff against the last snapshot and emit only state upgrades (none → seen → caught). Ignore any downgrade, which protects against save resets and resets on the title screen.
- On connect, send the full dex once, so progress from before the stream still counts.
- `emu` only exists once a ROM is loaded, so register on the `start` callback and handle resets cleanly.

Known mGBA scripting gotchas are documented in the [mcp-mgba notes](https://cdn.jsdelivr.net/npm/mcp-mgba@0.3.3/docs/BLOG-POST-DRAFT.md): `socket` is mGBA's own API, not LuaSocket, and sockets must be `poll()`ed from the frame callback or they never fire.

## Server and data model

One Node.js service on Railway does everything: it accepts raw TCP from the two emulator scripts, serves the overlay over HTTPS, and pushes live updates to the overlay over a websocket. mGBA's socket library is plain TCP with no TLS, so it can't call an HTTPS endpoint. Railway's [TCP Proxy](https://docs.railway.com/networking/tcp-proxy) exposes a raw port, for example `something.proxy.rlwy.net:15140`, and Railway allows HTTP and TCP together in a single service.

**Emulator protocol (newline-delimited JSON over TCP)**

| Message | Direction | Payload | Notes |
| --- | --- | --- | --- |
| `hello` | script → server | `token`, `player`, `field`, `gameCode` | Token is a per-player secret in the script's config. Wrong token = disconnect. |
| `snapshot` | script → server | full dex state for all 205 slots | Sent once after `hello`, and on any reconnect. |
| `dex` | script → server | `slot`, `state` (seen or caught) | Only upgrades are sent. |
| `ping` / `pong` | both | none | Every 10 s, so dead connections are noticed. The overlay shows a "Clara disconnected" chip. |

The script reconnects automatically with backoff (1 s, 2 s, 5 s, then every 10 s) and buffers events while offline.

**Shared state**

```json
{
  "run": "pinball-pals-2026",
  "players": {
    "zoe":   { "field": "ruby",     "color": "#ff8fb1", "online": true },
    "clara": { "field": "sapphire", "color": "#8fc7ff", "online": true }
  },
  "dex": {
    "25": { "state": "caught", "firstBy": "clara", "at": "2026-10-10T20:14:03Z", "catches": { "zoe": 1, "clara": 3 } }
  },
  "bounty": 151,
  "session": { "startedAt": "…", "newThisSession": [25, 72] }
}
```

**Rules**

- Merge is a union: a slot's state only ever goes up, and `firstBy` is set once and never changed.
- Store state in SQLite on a Railway volume, so restarts and redeploys lose nothing.
- An admin page behind a password lets Zoe fix mistakes, reset a session, set the bounty, and fire a test catch.
- The overlay connects with a read-only key in its URL. Only the scripts and the admin page can write.

## Overlay UI and visual design

The overlay is one self-contained HTML page at 1920×1080, added to OBS as a browser source with a transparent background. The two gameplay feeds are OBS sources placed inside frames the overlay draws, so the page never handles video.

**Layout**

- **Top 70%:** two GBA feeds side by side, each scaled 3× from 240×160 to 720×480 inside a rounded "handheld" frame. Each frame has a name tag (Zoe, Ruby Field / Clara, Sapphire Field), a connection dot, and a webcam bubble slot.
- **Center strip:** the shared counter ("87 / 205") as a fat progress bar that fills half pink, half blue in proportion to who caught what, with the rivalry tally under it.
- **Bottom:** a scrolling dex ribbon of all 205 slots. Caught slots show the sprite, seen slots a silhouette, and unseen slots a soft "?" bubble. A rotating panel cycles the still-need list by Ruby-only, Sapphire-only, and either table, every 12 seconds.
- **Celebration layer:** full-width, above everything, used only for catch pop-ups and milestones.

**Look and feel: soft, pastel, bouncy**

- Palette: cream background panels, strawberry pink for Zoe, sky blue for Clara, lilac and mint as accents. Every color is a CSS variable, so the players can pick their own.
- Shapes: big radius corners, chunky 3px outlines, a subtle drop shadow, star and sparkle decorations.
- Type: a rounded display font such as Fredoka or Baloo 2 for headings, and a pixel font for numbers so it nods to the GBA.
- Motion: everything squashes and stretches. The counter bounces when it ticks, sparkles burst from the slot that filled, and idle panels breathe gently. Respect a "reduce motion" toggle on the admin page.
- Sound: a short, cute chime for a new catch and a bigger fanfare for milestones, with a volume slider on the admin page. Original sounds only, never game audio.

**Catch pop-up sequence (about 4 seconds)**

1. A Poké Ball-style bubble drops in and wobbles three times.
2. It pops into a card with the sprite, name, and dex number.
3. A ribbon in the catcher's color reads "Caught by Clara!", plus "FIRST!" if it was new to the dex.
4. The card shrinks and flies into its slot on the dex ribbon, and the counter ticks.

Queue pop-ups when both players catch at once, so none overlap.

**Sprites:** fetch from [PokéAPI's sprite repo](https://github.com/PokeAPI/sprites) at runtime, or cache the 205 needed. Using official sprites on a fan stream is common but they are Nintendo's art, so keep them to the dex display and use original chibi art for the branding.

## Chat integration

The server joins Twitch chat as a small bot account. This assumes Twitch. YouTube would need its own adapter. Commands answer in chat, and some also nudge the overlay.

| Command | Who | What it does |
| --- | --- | --- |
| `!need` | anyone | Replies with the count left and 5 random still-needed names, and flashes the still-need panel. |
| `!dex <name or number>` | anyone | Says caught, seen, or missing, and who caught it first. Pulses that slot on the overlay. |
| `!score` | anyone | Replies with the rivalry tally and total progress. |
| `!vote <name>` | anyone | Votes for the bounty during an open vote. |
| `!bounty open` / `!bounty close` | mods, Zoe, Clara | Opens a 60-second vote and shows live results on the overlay. The winner becomes the bounty. |
| `!testcatch` | Zoe only | Fires a fake catch for checking the scene before going live. |

**Bot rules**

- Use a dedicated bot account with a token stored in Railway environment variables, never in the repo.
- Cooldown of 10 s per command per user, so chat can't spam the overlay.
- Every catch posts one line in chat, such as "Clara caught Wailmer! 88 / 205", so viewers who aren't watching the overlay still feel it.
- Optional later: a channel-point reward "Pick tonight's bounty" through Twitch EventSub.

## Clara's setup guide

Clara installs one emulator, drops in one script, and opens one link. Claude Code should turn this section into a cute, illustrated setup page hosted on the same server (for example `/setup`), with her personal script download already filled in.

**One-time setup (about 15 minutes)**

1. Install [mGBA](https://mgba.io/downloads.html) 0.10 or newer. Scripting has been built in since 0.10.
2. Get her own copy of the US Pokémon Pinball: Ruby & Sapphire ROM. The tracker only works with the US version.
3. Download `pinball-pals.lua` from her setup page. It already contains her player name, her table, the server address, and her secret token.
4. In mGBA: load the ROM, open Tools → Scripting, and load `pinball-pals.lua`. The console should print a happy "Connected as Clara!" line, and her dot on the overlay turns green.
5. Each session, she can use mGBA's recent-scripts list, so it's two clicks after the first time.

**Sharing her screen and camera**

1. Open the [VDO.Ninja](https://vdo.ninja) link from her setup page (the link has her stream ID built in).
2. Share the mGBA window, and optionally her webcam in a second tab.
3. Zoe adds the matching view links as browser sources in her OBS. Clara never touches OBS.

**Voice and audio**

- Talk over Discord. Zoe captures the call in OBS.
- Two pinball soundtracks at once is a lot. Default to Zoe's game audio only, with Clara's game muted on her end, and swap during her big moments.

**Troubleshooting (shown on the setup page)**

- "Wrong game" message: the ROM isn't the US version.
- Dot stays grey: the script isn't loaded, or her network blocks unusual ports. Try a phone hotspot to confirm.
- Nothing happens on a catch: reload the script. It resends the full dex on reconnect, so no catch is lost.

## Build plan for Claude Code

Build in five milestones, each playable on its own. Milestone 1 is the only real risk, so it comes first and gates everything else.

- [ ] **M1, find the dex (gate):** complete the research tasks in the memory-reading section. Done when a local Lua script prints "NEW: Wailmer (caught)" in the mGBA console on a real catch, and "seen" on an egg hatch.
- [ ] **M2, server:** Node service with the TCP listener, merge rules, SQLite, websocket, and admin page. Done when a fake TCP client can push catches and the admin page shows them.
- [ ] **M3, connect:** the Lua script talks to the server through Railway's TCP proxy with tokens, reconnects, and snapshots. Done when Zoe and Clara both show green and a real catch reaches the server in under 2 s.
- [ ] **M4, overlay:** layout, dex ribbon, still-need panel, catch pop-up, milestones, sounds. Done when `!testcatch` plays the full sequence in OBS at 1080p with no dropped frames.
- [ ] **M5, chat and polish:** Twitch bot commands, bounty vote, session recap card, Clara's setup page. Done when a full test stream with Clara runs 30 minutes with no manual fixes.

**Kickoff prompt to paste into Claude Code**

```markdown
Read PINBALL_PALS_GDD.md in this repo. It's the full design for a co-op
Pokédex stream overlay for Pokémon Pinball: Ruby & Sapphire.

Start with Milestone 1 only. Clone https://github.com/pret/pokepinballrs
into ./vendor, find where the Pokédex caught/seen data lives in RAM, and
write down the address, size, and encoding in docs/dex-memory.md with
file and line references. Then build species.json (205 slots in the
game's own order, with national dex numbers and field availability) and
a minimal mGBA Lua script that prints dex changes to the console.

Don't start the server or overlay until I confirm M1 works in mGBA.
I'll play-test and report back. Keep the overlay a single
self-contained HTML file when we get there.
```

**Repo layout**

```text
pinball-pals/
  lua/pinball-pals.lua      # tracker, config block at the top
  server/                   # Node: TCP + HTTP + websocket + Twitch bot
  overlay/index.html        # single self-contained file
  admin/index.html
  setup/index.html          # Clara's cute setup page
  data/species.json
  docs/dex-memory.md
  PINBALL_PALS_GDD.md       # this doc, exported to Markdown
```

To hand this doc to Claude Code, export it to Markdown and drop it into the repo as `PINBALL_PALS_GDD.md`.

## Risks and open questions

| Risk | Likelihood | Fallback |
| --- | --- | --- |
| Dex data isn't labeled in the decomp yet | Medium | Find it by diffing RAM in mGBA before and after a catch. This is slower but reliable. |
| The game only writes the dex at end of ball | Medium | Trigger on the catch-complete board state instead, and confirm with the dex write later. |
| Clara's network blocks the raw TCP port | Low | Ship a tiny local bridge app that relays from localhost to the server over HTTPS. |
| Clara and Zoe have different ROM regions | Low | The game-code check catches it at startup. Both use the US ROM. |
| mGBA scripting quirks (flaky reads, socket polling) | Known | Use `emu:readRange` and `poll()` every frame, as noted in the memory section. |

**Open questions for Zoe**

- [ ] Twitch, YouTube, or both?
- [ ] Should we count Pokémon already in each save's dex, or start the shared dex from zero?
- [ ] Is the run one long goal (all 205) or per-session races?
- [ ] Webcams on both, one, or neither?
