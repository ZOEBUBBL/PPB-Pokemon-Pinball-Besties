-- Pinball Pals tracker for mGBA (0.10+)
-- Watches the Pokédex in Pokémon Pinball: Ruby & Sapphire (US) and reports new entries.
-- Load via Tools -> Scripting -> File -> Load script, after loading the ROM.

---------------------------------------------------------------------------
-- CONFIG  (the /setup page fills this block in for you)
---------------------------------------------------------------------------
local CONFIG = {
  PLAYER      = "zoe",             -- "zoe" or "clara"
  FIELD       = "ruby",            -- "ruby" or "sapphire" (the table this player plays)
  SERVER_HOST = "localhost",                -- e.g. "something.proxy.rlwy.net". Empty = console-only mode.
  SERVER_PORT = 9000,                 -- e.g. 15140
  TOKEN       = "1982f0a9657efa88bb",       -- this player's secret
  POLL_FRAMES = 15,                -- how often to look at the dex (60 frames = 1 second)
  DEBUG       = false,              -- dump the raw dex bytes to the console once at load
}
---------------------------------------------------------------------------

local VERSION      = "0.1.0"
local GAME_CODE    = "BPPE"        -- US Pokémon Pinball: Ruby & Sapphire
local DEX_ADDR     = 0x0200B134    -- gMain.saveData.pokedexFlags (see docs/dex-memory.md)
local DEX_SIZE     = 205
-- Per-game catch counter (repeat catches). gCurrentPinballGame is a pointer; see docs/dex-memory.md.
local GAME_PTR_ADDR  = 0x020314E0
local OFF_SPECIES    = 0x598          -- u16 currentSpecies
local OFF_CAUGHT_CNT = 0x5F0          -- u16 caughtMonCount
local WARMUP       = 180           -- frames to ignore after start/reset while the save loads
local BULK_LIMIT   = 3             -- more changes than this in one poll => treat as a bulk load
local PING_FRAMES  = 600           -- 10 s
local DEAD_FRAMES  = 1500          -- 25 s of silence => reconnect
local BACKOFF      = { 60, 120, 300, 600 }  -- 1 s, 2 s, 5 s, then every 10 s
local MAX_BUFFER   = 500

-- Species names in the game's own slot order (slot 0..204). Console output only.
local NAMES = {
  "Treecko","Grovyle","Sceptile","Torchic","Combusken","Blaziken","Mudkip","Marshtomp","Swampert","Poochyena",
  "Mightyena","Zigzagoon","Linoone","Wurmple","Silcoon","Beautifly","Cascoon","Dustox","Lotad","Lombre",
  "Ludicolo","Seedot","Nuzleaf","Shiftry","Taillow","Swellow","Wingull","Pelipper","Ralts","Kirlia",
  "Gardevoir","Surskit","Masquerain","Shroomish","Breloom","Slakoth","Vigoroth","Slaking","Abra","Kadabra",
  "Alakazam","Nincada","Ninjask","Shedinja","Whismur","Loudred","Exploud","Makuhita","Hariyama","Goldeen",
  "Seaking","Magikarp","Gyarados","Azurill","Marill","Azumarill","Geodude","Graveler","Golem","Nosepass",
  "Skitty","Delcatty","Zubat","Golbat","Crobat","Tentacool","Tentacruel","Sableye","Mawile","Aron",
  "Lairon","Aggron","Machop","Machoke","Machamp","Meditite","Medicham","Electrike","Manectric","Plusle",
  "Minun","Magnemite","Magneton","Voltorb","Electrode","Volbeat","Illumise","Oddish","Gloom","Vileplume",
  "Bellossom","Doduo","Dodrio","Roselia","Gulpin","Swalot","Carvanha","Sharpedo","Wailmer","Wailord",
  "Numel","Camerupt","Slugma","Magcargo","Torkoal","Grimer","Muk","Koffing","Weezing","Spoink",
  "Grumpig","Sandshrew","Sandslash","Spinda","Skarmory","Trapinch","Vibrava","Flygon","Cacnea","Cacturne",
  "Swablu","Altaria","Zangoose","Seviper","Lunatone","Solrock","Barboach","Whiscash","Corphish","Crawdaunt",
  "Baltoy","Claydol","Lileep","Cradily","Anorith","Armaldo","Igglybuff","Jigglypuff","Wigglytuff","Feebas",
  "Milotic","Castform","Staryu","Starmie","Kecleon","Shuppet","Banette","Duskull","Dusclops","Tropius",
  "Chimecho","Absol","Vulpix","Ninetales","Pichu","Pikachu","Raichu","Psyduck","Golduck","Wynaut",
  "Wobbuffet","Natu","Xatu","Girafarig","Phanpy","Donphan","Pinsir","Heracross","Rhyhorn","Rhydon",
  "Snorunt","Glalie","Spheal","Sealeo","Walrein","Clamperl","Huntail","Gorebyss","Relicanth","Corsola",
  "Chinchou","Lanturn","Luvdisc","Horsea","Seadra","Kingdra","Bagon","Shelgon","Salamence","Beldum",
  "Metang","Metagross","Regirock","Regice","Registeel","Latias","Latios","Kyogre","Groudon","Rayquaza",
  "Jirachi","Chikorita","Cyndaquil","Totodile","Aerodactyl",
}

local STATE_WORD = { [0] = "unseen", [1] = "seen", [2] = "caught" }

---------------------------------------------------------------------------
-- tiny JSON encoder (we only ever send flat objects, numbers, strings, arrays)
---------------------------------------------------------------------------
local function jstr(s)
  return '"' .. tostring(s):gsub('[%c"\\]', function(c)
    return string.format("\\u%04x", string.byte(c))
  end) .. '"'
end

local function jenc(v)
  local t = type(v)
  if t == "number" or t == "boolean" then return tostring(v) end
  if t == "string" then return jstr(v) end
  if t == "table" then
    if #v > 0 then
      local out = {}
      for i = 1, #v do out[i] = jenc(v[i]) end
      return "[" .. table.concat(out, ",") .. "]"
    end
    local out = {}
    for k, val in pairs(v) do out[#out + 1] = jstr(k) .. ":" .. jenc(val) end
    return "{" .. table.concat(out, ",") .. "}"
  end
  return "null"
end

---------------------------------------------------------------------------
-- logging
---------------------------------------------------------------------------
local function log(msg) console:log("[Pinball Pals] " .. msg) end

---------------------------------------------------------------------------
-- dex reading
---------------------------------------------------------------------------
-- raw game value -> our state: 0 unseen, 1 seen, 2 caught
local function convert(raw)
  if raw >= 4 then return 2 end
  if raw >= 1 then return 1 end
  return 0
end

local function readDex()
  -- readRange is reliable inside frame callbacks; single-value reads are not
  local bytes = emu:readRange(DEX_ADDR, DEX_SIZE)
  if not bytes or #bytes < DEX_SIZE then return nil end
  local out = {}
  for i = 1, DEX_SIZE do out[i] = convert(bytes:byte(i)) end
  return out
end

-- returns the current game's caught counter and species, or nil when no game is running
local function readCatchCounter()
  local p = emu:readRange(GAME_PTR_ADDR, 4)
  if not p or #p < 4 then return nil end
  local ptr = p:byte(1) | (p:byte(2) << 8) | (p:byte(3) << 16) | (p:byte(4) << 24)
  if ptr < 0x02000000 or ptr > 0x0203F000 then return nil end      -- not a valid EWRAM pointer yet
  local sp = emu:readRange(ptr + OFF_SPECIES, 2)
  local cn = emu:readRange(ptr + OFF_CAUGHT_CNT, 2)
  if not sp or not cn or #sp < 2 or #cn < 2 then return nil end
  return ptr, cn:byte(1) | (cn:byte(2) << 8), sp:byte(1) | (sp:byte(2) << 8)
end

---------------------------------------------------------------------------
-- networking
---------------------------------------------------------------------------
local net = {
  sock = nil, connected = false, buf = "", outbox = {},
  retryAt = 0, attempt = 0, lastRx = 0, lastPing = 0,
}
local NETWORK_ON = CONFIG.SERVER_HOST ~= "" and CONFIG.SERVER_PORT > 0
local frameNo = 0
local dexNow            -- latest dex we read (1-based array of states)

local function queue(msg)
  if #net.outbox >= MAX_BUFFER then table.remove(net.outbox, 1) end
  net.outbox[#net.outbox + 1] = jenc(msg) .. "\n"
end

local function flush()
  if not net.connected or not net.sock then return end
  while #net.outbox > 0 do
    local ok, err = pcall(function() net.sock:send(net.outbox[1]) end)
    if not ok then net.disconnect("send failed: " .. tostring(err)) return end
    table.remove(net.outbox, 1)
  end
end

function net.disconnect(why)
  if net.sock then pcall(function() net.sock:close() end) end
  if net.connected then log("Disconnected (" .. tostring(why) .. "). Will retry.") end
  net.sock, net.connected, net.buf = nil, false, ""
  net.attempt = net.attempt + 1
  net.retryAt = frameNo + BACKOFF[math.min(net.attempt, #BACKOFF)]
end

local function handleLine(line)
  net.lastRx = frameNo
  if line:find('"ping"', 1, true) then queue({ t = "pong" }) end
  if line:find('"welcome"', 1, true) then
    log("Connected as " .. CONFIG.PLAYER:gsub("^%l", string.upper) .. "!")
  end
  if line:find('"error"', 1, true) then
    log("Server said: " .. line)
  end
end

local function onReceived()
  local ok, data = pcall(function() return net.sock:receive(4096) end)
  if not ok then net.disconnect("receive failed") return end
  if data and #data > 0 then
    net.buf = net.buf .. data
    while true do
      local nl = net.buf:find("\n", 1, true)
      if not nl then break end
      handleLine(net.buf:sub(1, nl - 1))
      net.buf = net.buf:sub(nl + 1)
    end
  end
end

local function sendSnapshot()
  if dexNow then queue({ t = "snapshot", dex = dexNow }) end
end

local function tryConnect()
  local sock, err = socket.tcp()
  if not sock then net.disconnect("no socket: " .. tostring(err)) return end
  local ok, cerr = pcall(function() return sock:connect(CONFIG.SERVER_HOST, CONFIG.SERVER_PORT) end)
  if not ok or cerr == false then net.disconnect("connect failed") return end
  sock:add("received", onReceived)
  sock:add("error", function() net.disconnect("socket error") end)
  net.sock, net.connected = sock, true
  net.attempt, net.lastRx, net.lastPing = 0, frameNo, frameNo
  -- hello must be the first line, then a full snapshot so earlier progress counts
  table.insert(net.outbox, 1, jenc({
    t = "hello", token = CONFIG.TOKEN, player = CONFIG.PLAYER,
    field = CONFIG.FIELD, gameCode = GAME_CODE, v = VERSION,
  }) .. "\n")
  sendSnapshot()
end

local function netTick()
  if not NETWORK_ON then return end
  if not net.connected then
    if frameNo >= net.retryAt then tryConnect() end
    if not net.connected then return end
  end
  -- mGBA sockets only deliver callbacks if polled from the frame callback
  if net.sock.poll then pcall(function() net.sock:poll() end) end
  flush()
  if frameNo - net.lastPing >= PING_FRAMES then
    net.lastPing = frameNo
    queue({ t = "ping" })
  end
  if frameNo - net.lastRx > DEAD_FRAMES then net.disconnect("server silent") end
end

---------------------------------------------------------------------------
-- main loop
---------------------------------------------------------------------------
local running = false
local last                 -- last accepted dex snapshot
local warmupUntil = 0
local lastPtr, lastCount = nil, nil

local function checkGame()
  local code = emu:getGameCode() or ""
  if not code:find(GAME_CODE, 1, true) then
    log("Oops! This isn't the US version of Pokemon Pinball: Ruby & Sapphire (found '" .. code
        .. "'). Please load the US ROM, then load this script again.")
    return false
  end
  return true
end

local function onStart()
  if not checkGame() then running = false return end
  running = true
  last, lastPtr, lastCount = nil, nil, nil
  warmupUntil = frameNo + WARMUP
  log("Pinball Pals ready (" .. CONFIG.PLAYER .. ", " .. CONFIG.FIELD .. " table)"
      .. (NETWORK_ON and "" or " - console-only mode"))
end

local function onFrame()
  frameNo = frameNo + 1
  if not running then return end
  netTick()
  if frameNo % CONFIG.POLL_FRAMES ~= 0 then return end

  local cur = readDex()
  if not cur then return end
  dexNow = cur

  if frameNo < warmupUntil then return end    -- the save may still be loading
  local catchEvents = {}
  -- sent after any dex messages so a first catch is celebrated before it is counted
  local function sendCatches()
    for _, sp in ipairs(catchEvents) do
      log(string.format("CATCH: %s", NAMES[sp + 1] or ("#" .. sp)))
      queue({ t = "catch", slot = sp })
    end
    if #catchEvents > 0 then flush() end
  end
  local ptr, count, species = readCatchCounter()
  if ptr and count < 1000 then
    if ptr == lastPtr and lastCount and count > lastCount and count - lastCount <= 2 and species < DEX_SIZE then
      for _ = 1, count - lastCount do catchEvents[#catchEvents + 1] = species end
    end
    lastPtr, lastCount = ptr, count
  end

  if not last then
    last = cur
    local s, c = 0, 0
    for i = 1, DEX_SIZE do
      if cur[i] == 1 then s = s + 1 elseif cur[i] == 2 then c = c + 1 end
    end
    log(string.format("Loaded dex: %d seen, %d caught", s, c))
    if CONFIG.DEBUG then
      local raw = emu:readRange(DEX_ADDR, DEX_SIZE)
      local hex, hist = {}, {}
      for i = 1, DEX_SIZE do
        local b = raw:byte(i)
        hex[#hex + 1] = string.format("%02x", b)
        hist[b] = (hist[b] or 0) + 1
      end
      for i = 1, DEX_SIZE, 32 do
        log(string.format("raw[%3d]: %s", i - 1, table.concat(hex, " ", i, math.min(i + 31, DEX_SIZE))))
      end
      local parts = {}
      for b, n in pairs(hist) do parts[#parts + 1] = string.format("%02x x%d", b, n) end
      table.sort(parts)
      log("value counts: " .. table.concat(parts, ", "))
    end
    sendSnapshot()
    return
  end

  -- only upgrades count; downgrades (save wipe, title-screen reset) are ignored
  local changes = {}
  for i = 1, DEX_SIZE do
    if cur[i] > last[i] then changes[#changes + 1] = i end
  end
  if #changes == 0 then sendCatches() return end

  if #changes > BULK_LIMIT then
    -- e.g. a save loaded late or the dex was copied via link: no fireworks, just resync
    log(string.format("%d dex entries changed at once - syncing quietly.", #changes))
    for _, i in ipairs(changes) do last[i] = cur[i] end
    sendSnapshot()
    sendCatches()
    return
  end

  for _, i in ipairs(changes) do
    log(string.format("NEW: %s (%s)", NAMES[i] or ("#" .. (i - 1)), STATE_WORD[cur[i]]))
    queue({ t = "dex", slot = i - 1, state = STATE_WORD[cur[i]] })
    last[i] = cur[i]
  end
  flush()
  sendCatches()
end

local function onReset()
  last, lastPtr, lastCount = nil, nil, nil
  warmupUntil = frameNo + WARMUP
end

-- Loading the script twice would stack a second copy of every callback (duplicate NEW lines),
-- so remember our callback ids and drop the previous copy's before registering ours.
if _G.PINBALL_PALS_CB then
  for _, id in ipairs(_G.PINBALL_PALS_CB) do pcall(function() callbacks:remove(id) end) end
end
_G.PINBALL_PALS_CB = {
  callbacks:add("start", onStart),
  callbacks:add("frame", onFrame),
  callbacks:add("reset", onReset),
  callbacks:add("shutdown", function() net.disconnect("shutdown") end),
}

-- if the ROM is already running when the script is loaded, start right away
if emu then onStart() end
