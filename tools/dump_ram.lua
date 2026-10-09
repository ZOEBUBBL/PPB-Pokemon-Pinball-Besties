-- One-shot helper: writes EWRAM and IWRAM to files next to this script so we can search them offline.
-- Tools -> Scripting -> File -> Load script, with the game running (sit on the title or in a menu).
local dir = "D:/Pokemon Pinball Besties/Project/tools/"
local function dump(name, region, size)
  local f = io.open(dir .. name, "wb")
  if not f then console:log("could not open " .. dir .. name) return end
  f:write(region:readRange(0, size))
  f:close()
  console:log("wrote " .. name .. " (" .. size .. " bytes)")
end
dump("ewram.bin",emu.memory.wram, 0x40000)
dump("iwram.bin", emu.memory.iwram, 0x8000)
console:log("code: " .. tostring(emu:getGameCode()) .. "  title: " .. tostring(emu:getGameTitle()))
