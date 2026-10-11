import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { formatZoneFile } from '../src/commands/export.js';
import { EXIT } from '../src/errors.js';
import { loadZoneFile } from '../src/load.js';
import { main } from '../src/main.js';
import { agreedReadings, fakeContext, fakeHetzner, git, NAMESERVERS, providerGroups, rr, SERIAL, tempRepo, zoneFileText, type ApiGroup } from './helpers.js';

const ZONE = 'example.com';

/**
 * Build N A groups with distinct names.
 * @param count - How many
 * @returns The groups
 */
function manyGroups(count: number): ApiGroup[] {
  return Array.from({ length: count }, (_, index) => rr(`host${index}`, 'A', 300, [`192.0.2.${(index % 250) + 1}`]));
}

/**
 * A realistic small zone as Hetzner serves it.
 * @returns The groups, provider groups included
 */
function sampleZone(): ApiGroup[] {
  return [
    ...providerGroups(),
    rr('@', 'A', null, ['192.0.2.1']),
    rr('@', 'MX', 3600, ['10 mx.example.net.']),
    rr('*', 'MX', 600, ['10 mx.example.net.']),
    rr('_dmarc', 'TXT', 300, ['"v=DMARC1; p=reject"']),
    rr('sel._domainkey', 'TXT', 600, [`"v=DKIM1; k=rsa; p=${'A'.repeat(255 - 18)}" "${'B'.repeat(150)}"`]),
    rr('cdn', 'CNAME', null, ['edge.example.net.']),
  ];
}

/**
 * Commit a zone file into a repository.
 * @param repo - The repository
 * @param text - The file's text
 */
function commitZone(repo: string, text: string): void {
  writeFileSync(join(repo, `${ZONE}.ts`), text);
  git(repo, 'add', `${ZONE}.ts`);
  git(repo, 'commit', '-q', '-m', 'zone');
}

describe('export', () => {
  it('writes every group across two pages, then plan shows no changes', async () => {
    const repo = tempRepo();
    const groups = [...providerGroups(), ...manyGroups(128)];
    const { context, out } = fakeContext({ cwd: repo, fetch: fakeHetzner({ zone: ZONE, groups }) });

    expect(await main(['export', ZONE, '--project', 'example'], context)).toBe(EXIT.ok);
    expect(out).toContain("Read 130 groups (Hetzner reports 130); 2 are Hetzner's own SOA/NS and stay out of the file.");
    expect(out).toContain(`Serial ${SERIAL} on all 3 nameservers.`);
    const loaded = await loadZoneFile(repo, ZONE, { requireCommitted: false });
    expect(loaded.zone.groups).toHaveLength(128);
    expect(loaded.zone.serial).toBe(SERIAL);
    expect(loaded.zone.project).toBe('example');

    const plan = fakeContext({ cwd: repo, fetch: fakeHetzner({ zone: ZONE, groups }) });
    expect(await main(['plan', ZONE], plan.context)).toBe(EXIT.ok);
    expect(plan.out).toContain(`No changes: Hetzner matches ${ZONE}.ts (128 groups).`);
  });

  it('writes nothing and exits 3 when the second page is missing', async () => {
    const repo = tempRepo();
    const groups = [...providerGroups(), ...manyGroups(128)];
    const { context, err } = fakeContext({ cwd: repo, fetch: fakeHetzner({ zone: ZONE, groups, dropAfterFirstPage: true }) });
    expect(await main(['export', ZONE, '--project', 'example'], context)).toBe(EXIT.refused);
    expect(err).toEqual(['Read 100 groups but Hetzner reports 130. Nothing was written.']);
    expect(existsSync(join(repo, `${ZONE}.ts`))).toBe(false);
  });

  it('round-trips a TXT value with a quote, a backtick and ${ as data, never as code', async () => {
    const repo = tempRepo();
    const tricky = 'say "hi" `whoami` ${process.exit(9)} \\ end';
    const presentation = `"${tricky.replace(/[\\"]/g, '\\$&')}"`;
    const groups = [...providerGroups(), rr('note', 'TXT', 300, [presentation])];
    const { context } = fakeContext({ cwd: repo, fetch: fakeHetzner({ zone: ZONE, groups }) });
    expect(await main(['export', ZONE, '--project', 'example'], context)).toBe(EXIT.ok);

    const loaded = await loadZoneFile(repo, ZONE, { requireCommitted: false });
    expect(loaded.zone.groups[0]?.records).toEqual([tricky]);
  });

  it('writes the file in the documented shape, with the serial on a line of its own', async () => {
    const repo = tempRepo();
    const { context } = fakeContext({ cwd: repo, fetch: fakeHetzner({ zone: ZONE, groups: sampleZone() }) });
    expect(await main(['export', ZONE, '--project', 'example'], context)).toBe(EXIT.ok);
    const text = readFileSync(join(repo, `${ZONE}.ts`), 'utf8');
    expect(text).toMatch(/^import type \{ Zone \} from 'zone-keeper';\n/);
    expect(text.match(/^ {2}serial: \d+,$/gm)).toEqual([`  serial: ${SERIAL},`]);
    expect(text).toContain('      comment: "TODO: what is this for?",');
    expect(text).toContain('      ttl: "default",');
    expect(text).toMatch(/\} satisfies Zone;\n$/);
  });

  it('refuses an existing file before asking for a token', async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, `${ZONE}.ts`), 'existing');
    const { context, err } = fakeContext({ cwd: repo });
    expect(await main(['export', ZONE, '--project', 'example'], context)).toBe(EXIT.refused);
    expect(err[0]).toContain(`${ZONE}.ts exists`);
    expect(context.promptToken).not.toHaveBeenCalled();
    expect(readFileSync(join(repo, `${ZONE}.ts`), 'utf8')).toBe('existing');
  });

  it('requires --project', async () => {
    const { context, err } = fakeContext({ cwd: tempRepo() });
    expect(await main(['export', ZONE], context)).toBe(EXIT.refused);
    expect(err).toEqual([`Name the Hetzner project: export ${ZONE} --project <name>`]);
  });

  it('refuses while the zone is still publishing', async () => {
    const repo = tempRepo();
    const { context, err } = fakeContext({ cwd: repo, fetch: fakeHetzner({ zone: ZONE, groups: sampleZone(), status: 'updating' }) });
    expect(await main(['export', ZONE, '--project', 'example'], context)).toBe(EXIT.refused);
    expect(err[0]).toContain('"updating", not published');
    expect(existsSync(join(repo, `${ZONE}.ts`))).toBe(false);
  });

  it('refuses when a nameserver is unreachable (exit 2) or serves another serial (exit 1)', async () => {
    const unreachable = fakeContext({
      cwd: tempRepo(),
      fetch: fakeHetzner({ zone: ZONE, groups: sampleZone() }),
      readSerials: vi.fn(async () => [...agreedReadings().slice(0, 2), { nameserver: 'helium.ns.example.org', error: 'timeout' }]),
    });
    expect(await main(['export', ZONE, '--project', 'example'], unreachable.context)).toBe(EXIT.unreachable);
    expect(existsSync(join(unreachable.context.cwd, `${ZONE}.ts`))).toBe(false);

    const behind = fakeContext({
      cwd: tempRepo(),
      fetch: fakeHetzner({ zone: ZONE, groups: sampleZone() }),
      readSerials: vi.fn(async () => agreedReadings(SERIAL - 1)),
    });
    expect(await main(['export', ZONE, '--project', 'example'], behind.context)).toBe(EXIT.drift);
    expect(behind.err[0]).toContain(`haven't all published Hetzner's serial ${SERIAL}`);
    expect(existsSync(join(behind.context.cwd, `${ZONE}.ts`))).toBe(false);
  });

  it('asks the zone\'s assigned nameservers for the serial', async () => {
    const { context } = fakeContext({ cwd: tempRepo(), fetch: fakeHetzner({ zone: ZONE, groups: sampleZone() }) });
    await main(['export', ZONE, '--project', 'example'], context);
    expect(context.readSerials).toHaveBeenCalledWith(ZONE, NAMESERVERS.map((ns) => ns.replace(/\.$/, '')));
  });

  it('refuses a zone holding something a zone file cannot express, writing nothing', async () => {
    const repo = tempRepo();
    const groups = [...providerGroups(), rr('odd', 'TXT', 300, ['"caf\\233"'])];
    const { context, err } = fakeContext({ cwd: repo, fetch: fakeHetzner({ zone: ZONE, groups }) });
    expect(await main(['export', ZONE, '--project', 'example'], context)).toBe(EXIT.refused);
    expect(err[0]).toContain("holds something a zone file can't express");
    expect(existsSync(join(repo, `${ZONE}.ts`))).toBe(false);
  });
});

describe('formatZoneFile', () => {
  it('writes values as JSON string literals', () => {
    const text = formatZoneFile({
      zone: ZONE,
      project: 'ex"ample',
      serial: 1,
      defaultTtl: 3600,
      groups: [{ name: '@', type: 'TXT', ttl: 300, records: ['a "b" ${c}'], comment: 'x' }],
    });
    expect(text).toContain('  project: "ex\\"ample",');
    expect(text).toContain('      records: ["a \\"b\\" ${c}"],');
  });
});

describe('plan', () => {
  it('prints the header, the diff, the removals, warnings and totals, and writes nothing', async () => {
    const repo = tempRepo();
    commitZone(
      repo,
      zoneFileText(
        ZONE,
        `
    { name: "*", type: "MX", ttl: 600, records: ["10 mx.example.net."], comment: "Tenant mail" },
    { name: "_dmarc", type: "TXT", ttl: 300, records: ["v=DMARC1; p=quarantine"], comment: "DMARC" },
    { name: "help", type: "A", ttl: 600, records: ["192.0.2.9"], comment: "Help site" },`,
      ),
    );
    const live = [
      ...providerGroups(),
      rr('@', 'A', null, ['192.0.2.1']),
      rr('*', 'MX', 600, ['10 mx.example.net.']),
      rr('_dmarc', 'TXT', 300, ['"v=DMARC1; p=reject"']),
      rr('old', 'A', 300, ['192.0.2.7']),
    ];
    const fetch = fakeHetzner({ zone: ZONE, groups: live });
    const { context, out } = fakeContext({ cwd: repo, fetch });

    expect(await main(['plan', ZONE], context)).toBe(EXIT.ok);
    const commit = git(repo, 'rev-parse', '--short', 'HEAD');
    expect(out).toEqual([
      `zone-keeper 0.0.0-test · zone ${ZONE} · Hetzner project "example" · branch main @ ${commit}`,
      `Serial: file ${SERIAL}, live ${SERIAL} (in step)`,
      '',
      '  ~ change   _dmarc TXT 300',
      '      - "v=DMARC1; p=reject"',
      '      + "v=DMARC1; p=quarantine"',
      '  + add      help   A   600  192.0.2.9',
      '',
      '  In Hetzner but not in your file (apply will DELETE these):',
      '  - remove   old    A   300  192.0.2.7',
      '',
      '  ! Mail records change: _dmarc TXT',
      "  ! A removal: check it wasn't added on purpose outside the file",
      '  ! Adding "help" stops the wildcard "*" (MX) answering for "help" and every name under it',
      '',
      `2 changes, 1 removal. Nothing was changed. Run "apply ${ZONE}" to make these changes.`,
    ]);
    expect(context.promptToken).toHaveBeenCalledWith('Token for Hetzner project "example" (read-only is enough): ');
    expect(fetch.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('marks an uncommitted file in the header, and shows a TTL-only change as ttl', async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, `${ZONE}.ts`), zoneFileText().replace('ttl: "default"', 'ttl: 600'));
    const { context, out } = fakeContext({ cwd: repo, fetch: fakeHetzner({ zone: ZONE, groups: [...providerGroups(), rr('@', 'A', null, ['192.0.2.1'])] }) });
    expect(await main(['plan', ZONE], context)).toBe(EXIT.ok);
    expect(out[0]).toMatch(/ \(file not committed yet\)$/);
    expect(out).toContain('  ~ ttl      @ A default → 600');
  });

  it('says when the zone changed since the file was last applied', async () => {
    const repo = tempRepo();
    commitZone(repo, zoneFileText());
    const { context, out } = fakeContext({
      cwd: repo,
      fetch: fakeHetzner({ zone: ZONE, groups: [...providerGroups(SERIAL + 1), rr('@', 'A', null, ['192.0.2.1'])] }),
      readSerials: vi.fn(async () => agreedReadings(SERIAL + 1)),
    });
    expect(await main(['plan', ZONE], context)).toBe(EXIT.ok);
    expect(out[1]).toBe(`Serial: file ${SERIAL}, live ${SERIAL + 1}: the zone changed since this file was last applied.`);
    expect(out).toContain(`No changes: Hetzner matches ${ZONE}.ts (1 groups).`);
  });

  it('still shows the diff when the serial cannot be read', async () => {
    const repo = tempRepo();
    commitZone(repo, zoneFileText());
    const { context, out } = fakeContext({
      cwd: repo,
      fetch: fakeHetzner({ zone: ZONE, groups: [...providerGroups(), rr('@', 'A', null, ['192.0.2.1'])] }),
      readSerials: vi.fn(async () => [{ nameserver: 'hydrogen.ns.example.net', error: 'timeout' }]),
    });
    expect(await main(['plan', ZONE], context)).toBe(EXIT.ok);
    expect(out[1]).toContain("the live serial couldn't be read (hydrogen couldn't be read: timeout)");
    expect(out).toContain(`No changes: Hetzner matches ${ZONE}.ts (1 groups).`);
  });

  it("names the file's project when the token can't see the zone", async () => {
    const repo = tempRepo();
    commitZone(repo, zoneFileText());
    const { context, err } = fakeContext({ cwd: repo, fetch: fakeHetzner({ zone: 'other.com', groups: [] }) });
    expect(await main(['plan', ZONE], context)).toBe(EXIT.refused);
    expect(err).toEqual([`This token can't see ${ZONE}. It's probably for a different Hetzner project; ${ZONE}'s file says project "example".`]);
  });

  it('refuses before asking for a token when the file is invalid', async () => {
    const repo = tempRepo();
    commitZone(repo, zoneFileText().replace('ttl: "default"', 'ttl: "600"'));
    const { context } = fakeContext({ cwd: repo });
    expect(await main(['plan', ZONE], context)).toBe(EXIT.refused);
    expect(context.promptToken).not.toHaveBeenCalled();
  });
});

describe('main', () => {
  it('prints the version', async () => {
    const { context, out } = fakeContext();
    expect(await main(['--version'], context)).toBe(EXIT.ok);
    expect(out).toEqual(['0.0.0-test']);
  });

  it('refuses unknown commands and options, and --project outside export', async () => {
    for (const argv of [['launch', ZONE], ['plan', ZONE, '--force'], ['plan', ZONE, '--project', 'x'], ['plan'], []]) {
      const { context, err } = fakeContext();
      expect(await main(argv, context)).toBe(EXIT.refused);
      expect(err.join('\n')).not.toBe('');
    }
  });

  it('reports an unexpected error as a bug, without a stack trace', async () => {
    const { context, err } = fakeContext({
      cwd: tempRepo(),
      promptToken: vi.fn(async () => {
        throw new RangeError('boom');
      }),
    });
    commitZone(context.cwd, zoneFileText());
    expect(await main(['plan', ZONE], context)).toBe(EXIT.internal);
    expect(err).toEqual(['zone-keeper hit an unexpected error, which is a bug: boom']);
  });

describe('review fixes', () => {
  it('prints control characters in live values and names escaped', async () => {
    const repo = tempRepo();
    commitZone(repo, zoneFileText());
    const live = [...providerGroups(), rr('@', 'A', null, ['192.0.2.1']), rr('box', 'HINFO', 300, ['"PC\u001b[2K\u001b[1A" "x"'])];
    const { context, out } = fakeContext({ cwd: repo, fetch: fakeHetzner({ zone: ZONE, groups: live }) });
    expect(await main(['plan', ZONE], context)).toBe(EXIT.ok);
    expect(out.join('\n')).not.toContain('\u001b');
    expect(out).toContain('  - remove   box HINFO 300  "PC\\x1b[2K\\x1b[1A" "x"');
  });

  it('refuses a rejected token through plan with exit 3', async () => {
    const repo = tempRepo();
    commitZone(repo, zoneFileText());
    const { context, err } = fakeContext({ cwd: repo, fetch: fakeHetzner({ zone: ZONE, groups: [], failWith: { status: 401 } }) });
    expect(await main(['plan', ZONE], context)).toBe(EXIT.refused);
    expect(err[0]).toContain('refused the token (401)');
  });

  it('prints usage for --help, and refuses extra arguments', async () => {
    const help = fakeContext();
    expect(await main(['--help'], help.context)).toBe(EXIT.ok);
    expect(help.out[0]).toContain('Usage');
    const extra = fakeContext();
    expect(await main(['plan', ZONE, 'more'], extra.context)).toBe(EXIT.refused);
    expect(extra.err[0]).toContain('Usage');
  });
});
});
