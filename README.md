# Pinball Pals

A co-op Pokédex stream overlay for **Pokémon Pinball: Ruby & Sapphire**. Zoe and Clara each play their own table
and fill one shared dex live. Full design: [`PINBALL_PALS_GDD.md`](PINBALL_PALS_GDD.md).

Everything lives in this one folder, so it moves with a plain copy or `git mv`.

```
pinball-pals/
  lua/pinball-pals.lua   tracker that runs inside mGBA (config block at the top)
  server/                Node 22: TCP (from mGBA) + HTTP + websocket + Twitch bot, SQLite
  overlay/index.html     the OBS browser source (single file)
  admin/index.html       admin page (password)
  setup/index.html       Clara's illustrated setup page (served per player)
  data/species.json      205 slots in the game's own order, national numbers, table availability
  docs/dex-memory.md     where the dex lives in RAM, with decomp file/line references
  tools/                 gen_species.py (rebuilds species.json), fetch-vendor.sh
```

## Status

| Milestone | State |
| --- | --- |
| **M1 find the dex** | Address, encoding and write timing found from the decomp: [`docs/dex-memory.md`](docs/dex-memory.md). **Confirmed live in mGBA (seen and caught both fire).** |
| M2 server | Done and tested (`npm test`). |
| M3 connect | Lua script speaks the protocol. Tested against the real server with a mocked mGBA API, **not yet in real mGBA**. |
| M4 overlay | Built. Previewed in Chromium at 1920×1080. **Not yet checked inside OBS.** |
| M5 chat and polish | Twitch commands, bounty vote, recap card and setup page are built. **Twitch not yet tested against real Twitch.** |

## Try it locally (5 minutes)

Needs Node 22.13 or newer (the server uses Node's built-in SQLite, so the only dependency is `ws`).

```sh
cd server
npm install
npm start
```

With no `.env`, random secrets are generated and printed (copy `.env.example` to `.env` to pin them). The console prints
four links: **admin**, **overlay**, and a **setup page for each player**.

- Preview the overlay with no server and no game: `http://localhost:8080/overlay/?demo=1`
- Fire a fake catch from the admin page ("Test catch") with the overlay open.

### M1 check (do this first, with your ROM)

1. Open mGBA 0.10+, load the **US** ROM (SHA1 `9fec81ce2c5df589e0371a0bf2f92a5fe8db730b`).
2. Tools → Scripting → File → Load script → `lua/pinball-pals.lua` (it is in console-only mode until you fill in `SERVER_HOST`).
3. Catch something new. The console should print `NEW: <Name> (caught)`. Hatch an egg and expect `(seen)`.
4. If not, see the last section of `docs/dex-memory.md` and tell Momo what the memory viewer shows at `0x0200B134`.

## Hosting it on your PC

Zoe's PC runs the server, her game, and OBS. Clara's script needs to reach the server's **TCP port** (mGBA can't do HTTPS),
so that port has to be reachable from her network. Options, easiest first:

1. **A tunnel** (no router changes): run the server, then expose `TCP_PORT` (9000) and `PORT` (8080), for example with
   [playit.gg](https://playit.gg) (free TCP tunnels) or Tailscale (both of you on one tailnet, then use Zoe's tailnet name
   as `PUBLIC_TCP_HOST`). Put the tunnel host and port in `.env` as `PUBLIC_TCP_HOST` / `PUBLIC_TCP_PORT`.
2. **Port forwarding**: forward TCP 9000 on your router to your PC and use your public IP or a DDNS name as `PUBLIC_TCP_HOST`.
3. **Railway** (the GDD plan): the included `Dockerfile` and `railway.json` work. Mount a volume at `/data`, add a TCP proxy
   to port 9000, and set the variables from `.env.example`.

Only Clara needs to reach the server from outside. Zoe's OBS and overlay can use `http://localhost:8080`.
The overlay is read-only (it needs `OVERLAY_KEY`); only the scripts (per-player token) and admin (password) can write.

Then send Clara the **Clara setup page** link from the admin page. It hands her a ready-made script.

### OBS

1. Add a **Browser source**: the overlay URL from the admin page, **1920×1080**, tick "Shutdown source when not visible" **off**.
   Custom CSS can stay empty (the page is transparent).
2. Put your mGBA window capture under the left frame (720×480 hole), and Clara's VDO.Ninja view under the right.
3. Volume: the overlay's chimes come through the browser source's audio. Set levels from the admin page.

## Protocol (mGBA script ↔ server)

Newline-delimited JSON over TCP.

| Message | From | Payload |
| --- | --- | --- |
| `hello` | script | `token`, `player`, `field`, `gameCode`. Wrong token or game code gets an `error` and a disconnect |
| `welcome` | server | `player`, `field` |
| `snapshot` | script | `dex`: 205 numbers (0 unseen, 1 seen, 2 caught). Sent after hello and on reconnect. Counts, but is quiet (no celebration) |
| `dex` | script | `slot` (0 to 204), `state` (`seen` or `caught`). Upgrades only |
| `ping` / `pong` | both | every 10 s |

Merge is a union: a slot only goes up, and `firstBy` (who first *caught* it) is set once and never changes.

## Chat commands

`!need`, `!dex <name or national number>`, `!score`, `!vote <name>`, `!bounty open|close` (mods, Zoe, Clara), `!testcatch` (Zoe).
10 s cooldown per command per user. Set `TWITCH_*` variables to enable; the bot token never goes in the repo.

## Known gaps and decisions

- **Repeat catches ("+1" bubble)** are not shown. The game's dex only records seen/caught, so a repeat catch changes nothing in RAM.
  Detecting it needs another RAM signal (the board's catch state machine).
- **Existing save progress counts** toward the shared dex by default, credited quietly to whoever's save it came from
  (`COUNT_EXISTING_PROGRESS=false` to start from zero instead).
- **Table availability** (`field` in `species.json`) is derived from the decomp's encounter and egg tables plus evolutions.
  Treat it as a good guide and patch the JSON if play shows otherwise.
- **Twitch only.** YouTube would need its own adapter.
- The overlay loads fonts from Google Fonts and Pokémon art through the server's `/sprite/<national>.png` cache
  (fetched once from PokéAPI's sprite repo, kept in `data/sprites/`).
