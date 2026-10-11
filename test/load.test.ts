import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CliError, EXIT } from '../src/errors.js';
import { repoState } from '../src/git.js';
import { loadZoneFile } from '../src/load.js';
import { git, tempRepo, zoneFileText } from './helpers.js';

/** A zone file that throws if it's ever imported, proving a check ran first. */
const EXPLODES = "throw new Error('the zone file was imported');\n";

/**
 * Load expecting a refusal, and return its message.
 * @param promise - The load
 * @returns The CliError's message
 */
async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).exitCode).toBe(EXIT.refused);
  return (error as CliError).message;
}

/**
 * Write and commit a file.
 * @param repo - The repository
 * @param name - The file name
 * @param text - Its contents
 */
function commit(repo: string, name: string, text: string): void {
  writeFileSync(join(repo, name), text);
  git(repo, 'add', name);
  git(repo, 'commit', '-q', '-m', `add ${name}`);
}

describe('loadZoneFile', () => {
  it('loads and validates a committed zone file, with the branch and commit', async () => {
    const repo = tempRepo();
    commit(repo, 'example.com.ts', zoneFileText());
    const loaded = await loadZoneFile(repo, 'example.com', { requireCommitted: true });
    expect(loaded.zone.zone).toBe('example.com');
    expect(loaded.zone.groups).toHaveLength(1);
    expect(loaded.git).toEqual({ branch: 'main', commit: git(repo, 'rev-parse', '--short', 'HEAD'), tracked: true, matchesCommit: true });
  });

  it('refuses an untracked file before importing it, when a commit is required', async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, 'example.com.ts'), EXPLODES);
    expect(await refusal(loadZoneFile(repo, 'example.com', { requireCommitted: true }))).toContain("isn't tracked by git");
  });

  it('refuses an ignored file before importing it', async () => {
    const repo = tempRepo();
    commit(repo, '.gitignore', '*.com.ts\n');
    writeFileSync(join(repo, 'example.com.ts'), EXPLODES);
    expect(await refusal(loadZoneFile(repo, 'example.com', { requireCommitted: true }))).toContain("isn't tracked by git");
  });

  it('refuses a symlinked zone file before importing it, even for plan', async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, 'target.ts'), EXPLODES);
    symlinkSync(join(repo, 'target.ts'), join(repo, 'example.com.ts'));
    expect(await refusal(loadZoneFile(repo, 'example.com', { requireCommitted: false }))).toContain('must be a regular file');
  });

  it('refuses uncommitted changes when a commit is required, and allows them otherwise', async () => {
    const repo = tempRepo();
    commit(repo, 'example.com.ts', zoneFileText());
    writeFileSync(join(repo, 'example.com.ts'), zoneFileText('example.com', '\n    { name: "www", type: "A", ttl: 300, records: ["192.0.2.2"], comment: "x" },'));
    expect(await refusal(loadZoneFile(repo, 'example.com', { requireCommitted: true }))).toContain("has changes that aren't committed");
    const loaded = await loadZoneFile(repo, 'example.com', { requireCommitted: false });
    expect(loaded.git.matchesCommit).toBe(false);
    expect(loaded.zone.groups).toHaveLength(2);
  });

  it('accepts a file that matches the commit while git\'s staging area is stale', async () => {
    const repo = tempRepo();
    const committed = zoneFileText();
    commit(repo, 'example.com.ts', committed);
    writeFileSync(join(repo, 'example.com.ts'), `${committed}// reformatted\n`);
    git(repo, 'add', 'example.com.ts');
    writeFileSync(join(repo, 'example.com.ts'), committed);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('example.com.ts');

    const loaded = await loadZoneFile(repo, 'example.com', { requireCommitted: true });
    expect(loaded.git.matchesCommit).toBe(true);
  });

  it('refuses a zone argument that is not a hostname, before building a path', async () => {
    expect(await refusal(loadZoneFile(tmpdir(), '../etc/passwd', { requireCommitted: false }))).toContain("isn't a zone name");
  });

  it('refuses a missing file, naming the folder', async () => {
    const repo = tempRepo();
    expect(await refusal(loadZoneFile(repo, 'example.com', { requireCommitted: false }))).toContain(`There's no example.com.ts in ${repo}`);
  });

  it('refuses a file whose zone field disagrees with its name', async () => {
    const repo = tempRepo();
    commit(repo, 'example.com.ts', zoneFileText('example.org'));
    expect(await refusal(loadZoneFile(repo, 'example.com', { requireCommitted: true }))).toContain('says zone: "example.org"');
  });

  it('refuses an invalid zone file, naming the field', async () => {
    const repo = tempRepo();
    commit(repo, 'example.com.ts', zoneFileText().replace('ttl: "default"', 'ttl: "600"'));
    expect(await refusal(loadZoneFile(repo, 'example.com', { requireCommitted: true }))).toMatch(/^example\.com\.ts: .*groups\[0\]\.ttl/s);
  });

  it('refuses a file that fails to load', async () => {
    const repo = tempRepo();
    commit(repo, 'example.com.ts', EXPLODES);
    expect(await refusal(loadZoneFile(repo, 'example.com', { requireCommitted: true }))).toContain(
      "couldn't be loaded: the zone file was imported",
    );
  });
});

describe('repoState', () => {
  it('refuses a folder outside any git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zone-keeper-nogit-'));
    expect(await refusal(repoState(dir, 'example.com.ts'))).toContain("isn't in a git repository");
  });

  it('reports a detached HEAD', async () => {
    const repo = tempRepo();
    git(repo, 'checkout', '-q', '--detach');
    expect((await repoState(repo, 'example.com.ts')).branch).toBe('detached');
  });

  it('refuses a zone file that imports another module, before importing it', async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, 'ips.ts'), EXPLODES);
    commit(repo, 'example.com.ts', `import { ip } from './ips.ts';\n${EXPLODES}`);
    expect(await refusal(loadZoneFile(repo, 'example.com', { requireCommitted: true }))).toContain('imports from another file');
    commit(repo, 'example.com.ts', `${EXPLODES}export const x = await import('./ips.ts');\n`);
    expect(await refusal(loadZoneFile(repo, 'example.com', { requireCommitted: true }))).toContain('imports from another file');
  });

  it('refuses template literals, and allows the words import and from inside strings and comments', async () => {
    const repo = tempRepo();
    commit(repo, 'example.com.ts', zoneFileText().replace('"Website"', '`Website`'));
    expect(await refusal(loadZoneFile(repo, 'example.com', { requireCommitted: true }))).toContain('uses a template literal');

    const other = tempRepo();
    commit(other, 'example.com.ts', `// import nothing from here\n${zoneFileText().replace('"Website"', '"import from require"')}`);
    const loaded = await loadZoneFile(other, 'example.com', { requireCommitted: true });
    expect(loaded.zone.groups[0]?.comment).toBe('import from require');
  });

  it('sees an edit git was told to ignore (assume-unchanged) as uncommitted', async () => {
    const repo = tempRepo();
    commit(repo, 'example.com.ts', zoneFileText());
    git(repo, 'update-index', '--assume-unchanged', 'example.com.ts');
    writeFileSync(join(repo, 'example.com.ts'), zoneFileText().replace('192.0.2.1', '203.0.113.66'));
    expect(await refusal(loadZoneFile(repo, 'example.com', { requireCommitted: true }))).toContain("has changes that aren't committed");
  });
});
