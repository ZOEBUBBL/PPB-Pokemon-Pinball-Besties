import { config, generated } from "./config.js";
import { Store } from "./state.js";
import { Hub } from "./hub.js";
import { createHttp } from "./http.js";
import { startTwitch } from "./twitch.js";

const store = new Store();
const hub = new Hub(store);
const server = createHttp(hub, store);

hub.listenTcp();
server.listen(config.httpPort, () => {
  console.log(`HTTP listening on :${config.httpPort}`);
  if (generated.length) {
    console.log("\nNo value set for: " + generated.join(", ") + ". Random ones were made for this run:");
    console.log(`  ADMIN_PASSWORD=${config.adminPassword}`);
    console.log(`  OVERLAY_KEY=${config.overlayKey}`);
    console.log(`  ZOE_TOKEN=${config.players.zoe.token}`);
    console.log(`  CLARA_TOKEN=${config.players.clara.token}`);
    console.log("Put these in .env (or Railway variables) so they survive restarts.\n");
  }
  const b = config.publicUrl || `http://localhost:${config.httpPort}`;
  console.log(`Admin:        ${b}/admin/`);
  console.log(`Overlay (OBS): ${b}/overlay/?key=${config.overlayKey}`);
  console.log(`Zoe setup:    ${b}/s/${config.players.zoe.token}`);
  console.log(`Clara setup:  ${b}/s/${config.players.clara.token}`);
});
startTwitch(hub, store);

process.on("SIGTERM", () => { hub.close(); server.close(); process.exit(0); });
