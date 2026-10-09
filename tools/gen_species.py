#!/usr/bin/env python3
"""Generate data/species.json from the pokepinballrs decomp (vendor/) + PokeAPI species csv.

Usage: python3 tools/gen_species.py   (needs vendor/pokepinballrs, see tools/fetch-vendor.sh)
"""
import csv, json, re, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
dec = root / "vendor" / "pokepinballrs"

# slot index -> constant name, in the game's own dex order
consts = {}
for m in re.finditer(r"#define SPECIES_(\w+)\s+(\d+)", (dec / "include/constants/species.h").read_text()):
    consts[m.group(1)] = int(m.group(2))
NUM = consts["NONE"]
by_slot = {v: k for k, v in consts.items() if k not in ("NONE",) and v < NUM}

# species info: name, internal RS id, evolution target
info = {}
text = (dec / "src/data/species.h").read_text()
for m in re.finditer(r"\[SPECIES_(\w+)\]\s*=\s*\{(.*?)\n    \}", text, re.S):
    body = m.group(2)
    rs = int(re.search(r"\.speciesIdRS\s*=\s*(\d+)", body).group(1))
    name = re.search(r'\.name\s*=\s*"([^"]*)"', body).group(1).strip()
    evo = re.search(r"\.evolutionTarget\s*=\s*SPECIES_(\w+)", body)
    info[m.group(1)] = dict(rs=rs, name=name, evo=evo.group(1) if evo else None)

# national numbers via PokeAPI csv, matched by identifier (name)
csv_path = sys.argv[1] if len(sys.argv) > 1 else str(root / "tools" / "pokemon_species.csv")
nat = {}
for row in csv.DictReader(open(csv_path)):
    if int(row["id"]) <= 386:
        nat[re.sub(r"[^a-z]", "", row["identifier"])] = int(row["id"])
def natnum(c):
    return nat[re.sub(r"[^a-z]", "", c.lower())]

# where each species shows up
ruby, sapph = set(), set()
loc = (dec / "data/mon_locations.inc").read_text()
field = None
for line in loc.splitlines():
    h = re.match(r"\s*@ (.+?) \| (Ruby|Sapphire) \|", line)
    if h:
        field = h.group(2); continue
    s = re.match(r"\s*\.2byte SPECIES_(\w+)", line)
    if s and field and s.group(1) != "NONE":
        (ruby if field == "Ruby" else sapph).add(s.group(1))
egg = (dec / "src/data/egg_locations.h").read_text()
parts = egg.split("// FIELD_SAPPHIRE")
for f, chunk in (("Ruby", parts[0]), ("Sapphire", parts[1])):
    for s in re.findall(r"SPECIES_(\w+)", chunk):
        if s != "NONE":
            (ruby if f == "Ruby" else sapph).add(s)
# special encounters
ruby.add("LATIOS"); sapph.add("LATIAS")
bonus = {"CHIKORITA", "CYNDAQUIL", "TOTODILE", "AERODACTYL"}

# propagate through evolutions (an evolved form is reachable from any ancestor's table)
evo_edges = {k: v["evo"] for k, v in info.items() if v["evo"] and v["evo"] != "NONE"}
evo_edges.setdefault("NINCADA", "NINJASK")
def propagate(s):
    changed = True
    while changed:
        changed = False
        for a, b in evo_edges.items():
            if a in s and b not in s:
                s.add(b); changed = True
    # Shedinja comes free with Nincada's evolution
    if "NINJASK" in s: s.add("SHEDINJA")
propagate(ruby); propagate(sapph)

# evolution stage -> ball icon. Poke = unevolved (or no evolutions), Great = middle of a chain,
# Ultra = final form of a 2-stage chain, Master = final form of a 3-stage chain.
branch = dict(evo_edges)
prev = {}
for a, b in list(evo_edges.items()) + [("WURMPLE", "CASCOON"), ("NINCADA", "SHEDINJA"), ("GLOOM", "BELLOSSOM"), ("CLAMPERL", "GOREBYSS")]:
    prev[b] = a
def depth(c):
    d = 0
    while c in prev:
        c = prev[c]; d += 1
    return d
has_next = {a for a in list(evo_edges) + ["WURMPLE", "NINCADA"]}
def ball_for(c):
    d = depth(c)
    if d == 0: return "poke"
    if c in has_next: return "great"
    return "ultra" if d == 1 else "master"

out = []
for slot in range(NUM):
    c = by_slot[slot]
    r, s = c in ruby, c in sapph
    if c in bonus: avail = "either"
    elif r and s: avail = "either"
    elif r: avail = "ruby"
    elif s: avail = "sapphire"
    else: avail = "either"   # Jirachi etc: unlocked by progress, not table
    out.append(dict(slot=slot, national=natnum(c), name=info[c]["name"].title(), key=c.lower(), field=avail, ball=ball_for(c),
                    special=c in bonus or c in ("JIRACHI",)))
(root / "data").mkdir(exist_ok=True)
(root / "data/species.json").write_text(json.dumps(out, indent=1))
from collections import Counter
print(len(out), Counter(x["field"] for x in out))
