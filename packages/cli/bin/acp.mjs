#!/usr/bin/env node
import { existsSync } from "node:fs";
import { register } from "tsx/esm/api";

// Pick up TYPESAFE_API_KEY / JEV_MODEL / ANTHROPIC_API_KEY from a local .env (gitignored) if there is one.
if (existsSync(".env")) process.loadEnvFile(".env");

// tsx stays registered even for the compiled CLI: the user's agent file is usually TypeScript.
register();
const built = new URL("../dist/main.js", import.meta.url);
const { main } = await import(existsSync(built) ? built.href : new URL("../src/main.ts", import.meta.url).href);
process.exitCode = await main(process.argv.slice(2));
