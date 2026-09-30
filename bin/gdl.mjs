#!/usr/bin/env node
// Thin launcher: runs the TypeScript CLI through tsx so no build step is required.
import { register } from "tsx/esm/api";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

register();
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = pathToFileURL(path.join(here, "..", "src", "cli", "index.ts")).href;
const { main } = await import(entry);
process.exitCode = await main(process.argv.slice(2));
