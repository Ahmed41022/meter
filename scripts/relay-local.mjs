#!/usr/bin/env node
/**
 * `npm run relay:local`: the real relay code on http://127.0.0.1:8788, for trying
 * Meter Sync in a browser with no Cloudflare account and no network. Development
 * only; never part of a build or a deploy. See scripts/lib/localRelay.mjs.
 *
 *   npm run relay:local
 *
 * Accounts and secrets are kept in the temp directory, so a restart keeps them
 * (delete the directory to start over). Each start prints a fresh invite.
 * Stop it with Ctrl+C.
 */
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalRelay, DEV_ORIGINS, nodeHandler } from "./lib/localRelay.mjs";

const say = (line) => process.stdout.write(`${line}
`);
const HOST = "127.0.0.1";
const PORT = Number(process.env.METER_RELAY_LOCAL_PORT ?? 8788);
const DIR = process.env.METER_RELAY_LOCAL_DIR ?? join(tmpdir(), "meter-relay-local");

const local = await createLocalRelay({ dir: DIR });
const relayUrl = `http://${HOST}:${PORT}`;
const server = createServer(nodeHandler(local, { origin: relayUrl }));
// A socket upgrade is refused with 426 by the handler; this only keeps Node from
// closing the connection silently before it can say so.
server.on("upgrade", (req, socket) => {
  socket.end("HTTP/1.1 426 Upgrade Required\r\ncontent-type: application/json\r\naccess-control-allow-origin: *\r\nconnection: close\r\n\r\n{\"code\":\"upgrade_required\"}");
});

server.listen(PORT, HOST, async () => {
  const code = await local.invite();
  const link = (origin) => `${origin}/#invite=${code}&relay=${encodeURIComponent(relayUrl)}`;
  say(`Meter relay (local, development only) on ${relayUrl}`);
  say(`  data: ${DIR}`);
  if (local.secrets.created) say("  secrets: made just now (local test values, kept in that directory)");
  say(`  ROUTE_KEY   ${local.secrets.ROUTE_KEY}`);
  say(`  ADMIN_TOKEN ${local.secrets.ADMIN_TOKEN}`);
  say("");
  say(`  Invite (one account, valid 1 day): ${code}`);
  for (const origin of DEV_ORIGINS) say(`    link for ${origin}  ${link(origin)}`);
  say("");
  say("  WebSockets are refused (426) on purpose: the app falls back to syncing on open,");
  say("  after edits and on its poll. Press Ctrl+C to stop.");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref(); });
}
