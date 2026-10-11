#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import type { Context } from './commands/context.js';
import { main } from './main.js';
import { readSerials } from './serial.js';
import { promptToken } from './token.js';

/**
 * Read the package's version from its package.json, one folder above this file in both src/ and dist/.
 * @returns The version
 */
function readVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string') throw new Error("zone-keeper's package.json has no version");
  return manifest.version;
}

const context: Context = {
  cwd: process.cwd(),
  version: readVersion(),
  print: (line) => console.log(line),
  printError: (line) => console.error(line),
  promptToken: (prompt) => promptToken(prompt),
  fetch,
  readSerials: (zone, nameservers) => readSerials(zone, nameservers),
};

process.exitCode = await main(process.argv.slice(2), context);
