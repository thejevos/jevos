// Railway entrypoint. One repo, two services: ACP_SERVICE=api runs the decision API,
// anything else serves the information site.
import { spawn } from "node:child_process";

const api = process.env.ACP_SERVICE === "api";
const cmd = api ? ["npx", "tsx", "packages/server/src/main.ts"] : ["node", "packages/site/serve.mjs"];
console.log(`starting ${api ? "decision API" : "site"}: ${cmd.join(" ")}`);
const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code) => process.exit(code ?? 1));
