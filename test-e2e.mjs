// Ende-til-ende-test: spawner serveren og kaller begge verktøy via stdio JSON-RPC
import { spawn } from "node:child_process";

const proc = spawn("node", ["dist/index.js"], { cwd: import.meta.dirname, stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 45000);
  });
}

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "e2e-test", version: "0.0.1" },
});
console.log("INIT OK:", init.result.serverInfo.name, init.result.serverInfo.version);
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const tools = await rpc("tools/list", {});
console.log("TOOLS:", tools.result.tools.map((t) => t.name).join(", "));

const cases = [
  ["hent_kollektivdekning", { lat: 59.9302917, lon: 10.7606645 }, "Thorvald Meyers gate 2C (forventet: flere holdeplasser, buss+trikk)"],
  ["hent_kollektivdekning", { lat: 69.1438892, lon: 18.1394969, maksAvstandMeter: 2000 }, "Ytterholtet 1, Sørreisa @2km (rural)"],
  ["hent_stoysone", { lat: 59.9302917, lon: 10.7606645 }, "Thorvald Meyers gate 2C (forventet: Lden/Lnight-treff)"],
  ["hent_stoysone", { lat: 69.1438892, lon: 18.1394969 }, "Ytterholtet 1, Sørreisa (forventet: ingen treff, ærlig omfangstekst)"],
  ["hent_stoysone", { lat: 59.89, lon: 10.525 }, "E18 Sandvika (positiv kontroll: rød/gul varselsone)"],
];

for (const [tool, args, label] of cases) {
  const res = await rpc("tools/call", { name: tool, arguments: args });
  if (res.error) { console.log(`FAIL ${label}: ${JSON.stringify(res.error)}`); continue; }
  const data = JSON.parse(res.result.content[0].text);
  const sammendrag =
    tool === "hent_kollektivdekning"
      ? data.sammendrag
      : `varsel=${data.stoyvarselkart.sone ?? "ingen"}, Lden=${data.strategiskStoykart.lden.treff ? data.strategiskStoykart.lden.nivaa : "ingen"}, Lnight=${data.strategiskStoykart.lnight.treff ? data.strategiskStoykart.lnight.nivaa : "ingen"}`;
  console.log(`OK  ${label}\n    -> ${sammendrag}`);
}

proc.kill();
process.exit(0);
