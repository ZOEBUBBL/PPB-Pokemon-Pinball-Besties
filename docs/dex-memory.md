# Where the Pokédex lives in RAM (US ROM, `BPPE`)

Source: [pret/pokepinballrs](https://github.com/pret/pokepinballrs), cloned into `vendor/pokepinballrs`.
ROM SHA1 (from `pokepinballrs.sha1`): `9fec81ce2c5df589e0371a0bf2f92a5fe8db730b`. Game code: `BPPE` (Makefile `GAME_CODE`).

> **Status: derived from source, NOT yet verified in a live emulator.**
> Milestone 1's "diff it live in mGBA" step (see the end of this file) still needs a person with the ROM.

## The address

| What | Value |
| --- | --- |
| Live dex array | `gMain.saveData.pokedexFlags` |
| Address | **`0x0200B134`** (EWRAM; offset `0xB134` into `emu.memory.wram`) |
| Size | **205 bytes** (`NUM_SPECIES`), one `u8` per species |
| Index | the game's own species slot, 0 to 204 (see `data/species.json`), *not* the national dex |

How the address was derived:

- `sym_ewram.txt:101` puts `gMain` at `0x0200B0C0`.
- `include/main.h:120` has `saveData` at `gMain + 0x74`, and `include/main.h:28` has `pokedexFlags` as the first member: `u8 pokedexFlags[NUM_SPECIES]`.
- `0x0200B0C0 + 0x74 = 0x0200B134`.
- Cross-check: `sym_ewram.txt:106` lists `gMain_saveData_pokedexFlags_90` at `0x0200B18E`, which is `0x0200B134 + 0x5A`. ✓
- Cross-check: the next member, `rumbleEnabled`, is at `0x74 + 0xCD` per the offsets in `include/main.h:29`, and 205 = `0xCD`. ✓

There is a second copy, `gPokedexFlags` (`sym_ewram.txt:368`, `0x0202A1C0`, `s16[]`). That one only exists for the Pokédex *menu* and the link-cable exchange (`src/pokedex.c:214`, `:679`). **Do not read it.** It is only filled while the menu is open.

## Encoding of one species

`include/variables.h:12-16`:

| Value | Name | Meaning for us |
| --- | --- | --- |
| 0 | `SPECIES_DEX_UNSEEN` | unseen |
| 1 | `SPECIES_DEX_SEEN` | **seen** |
| 2 | `SPECIES_DEX_SHARED` | seen (received over link cable) |
| 3 | `SPECIES_DEX_SHARED_AND_SEEN` | seen |
| 4 | `SPECIES_DEX_CAUGHT` | **caught** |

The tracker maps `0 → unseen`, `1/2/3 → seen`, `4 → caught`.

## When the game writes it

Everything goes through one function, `SaveFile_SetPokedexFlags(species, flag)` (`src/save.c:98`). It only ever raises a value (`if (pokedexFlags[species] < flag)`, `src/save.c:104`), writes to the in-RAM struct *immediately*, then writes both SRAM copies. So the RAM value changes the instant the game decides, with no wait for end of ball or end of game.

Call sites:

| State | Where | When |
| --- | --- | --- |
| caught (4) | `src/main_board_catch_hatch_picker.c:23` | a ball catch, `RegisterCaptureOrEvolution(0)` |
| caught (4) | `src/main_board_catch_hatch_picker.c:98`, `:109` | evolution result, plus Shedinja as a free extra |
| seen (1) | `src/main_board_catch_normal_and_jirachi_modes.c:135` | a catch mode shows the Pokémon |
| seen (1) | `src/sapphire_seedot_egg_shop.c:116`, `src/main_board_to_be_split.c:1364` | egg hatch |

Every caught call is guarded by `gMain.mainState != STATE_GAME_IDLE`, so the attract-mode demo can't poison the dex.

Because writes are instant and monotonic, the tracker needs no board-state trigger. Polling the 205 bytes every ~15 frames is enough.

## Species order

`include/constants/species.h` (`SPECIES_TREECKO 0` … `SPECIES_AERODACTYL 204`, `SPECIES_NONE 205`). `tools/gen_species.py` turns this into `data/species.json`. National numbers come from the decomp's `speciesIdRS` joined to PokéAPI by name.

Field availability (`field` in the JSON) is computed from:

- `data/mon_locations.inc`: wild-mon lists per area, tagged Ruby or Sapphire. Ruby-only areas are Safari Zone and Volcano. Sapphire-only areas are Lake and Wilderness.
- `src/data/egg_locations.h`: hatchable eggs per table.
- Evolutions propagate. A Pokémon counts as reachable on every table where one of its pre-evolutions appears.
- Latios is Ruby-special and Latias is Sapphire-special (`src/main_board_catch_hatch_picker.c:312-326`).
- Chikorita, Cyndaquil, Totodile and Aerodactyl are special bonus encounters and count as `either`.
- Anything left unmatched (Jirachi, the boss Pokémon) is `either`, because it's unlocked by progress rather than by table.

Treat `field` as a guide for the "still need" grouping, not as a hard rule. The first real play session may show corrections, and the file is plain JSON so it's easy to patch.

## To verify live (the remaining half of M1)

1. Load the US ROM in mGBA and open **Tools → Scripting**. Load `lua/pinball-pals.lua` with `SERVER_HOST = ""`, which is console-only mode.
2. The console should print `Pinball Pals ready` and then `Loaded dex: N seen, M caught`.
3. Catch something new on the table, and the console should print `NEW: <Name> (caught)`. Hatch an egg and it should print `NEW: <Name> (seen)`.
4. If nothing prints, open **Tools → View memory**, go to `0x0200B134`, and check that 205 bytes of 00/01/04 are there. If they're not, tell Momo the bytes you see.

## Repeat catches (best effort, verify live)

The dex only records the first catch, so repeats are counted from the board's own counter instead:

- `gCurrentPinballGame` is a pointer at `0x020314E0` (`sym_ewram.txt:554`). Dereference it to get the struct.
- `caughtMonCount` (`u16`, struct offset `0x5F0`, `include/global.h:743`) goes up by one on every ball catch and every evolution
  (`src/main_board_center_capture_hole.c:1286`, `src/main_board_evolution_mode.c:311`). `currentSpecies` (`u16`, `0x598`) says which one.
- The script sends a `catch` message for each increase. The server tallies it, bubbles repeats on the overlay, and answers `!top`.
- Not yet checked live. Evolutions might report the pre-evolution species instead of the evolved one, and a Ninjask evolution counts twice (Ninjask and Shedinja).
