import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { git, tempRepo, zoneFileText } from './helpers.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

/**
 * Run the built command as its own process in a new session, so it has no controlling terminal, as under CI or a
 * script. `detached` is what starts the new session; only the asynchronous spawn supports it.
 * @param cwd - Where to run it
 * @param args - The command line
 * @param stdin - What to offer on standard input
 * @returns The exit code and output
 */
function run(cwd: string, args: string[], stdin = ''): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('the command did not finish; is it waiting for a terminal?'));
    }, 20_000);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

describe('the built command', () => {
  it('prints its version', async () => {
    const result = await run(process.cwd(), ['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('loads a real .ts zone file, then refuses without a terminal even with a token on standard input', async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, 'example.com.ts'), zoneFileText());
    git(repo, 'add', 'example.com.ts');
    git(repo, 'commit', '-q', '-m', 'zone');

    const result = await run(repo, ['plan', 'example.com'], 'TOKENFROMSTDIN\n');
    expect(result.stdout).toMatch(/^zone-keeper \S+ · zone example\.com · Hetzner project "example" · branch main @ \w+\n$/);
    expect(result.stderr.trim()).toBe(
      'The token prompt needs a terminal. Run this in your own terminal, not through a script, CI or Claude Code.',
    );
    expect(result.status).toBe(3);
  });
});
