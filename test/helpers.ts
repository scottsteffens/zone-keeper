import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi } from 'vitest';

import type { Context } from '../src/commands/context.js';
import type { SerialReading } from '../src/serial.js';

/** A record group as Hetzner's API returns it. */
export interface ApiGroup {
  name: string;
  type: string;
  ttl: number | null;
  records: { value: string; comment: string }[];
}

/**
 * Build a record group as Hetzner returns it.
 * @param name - Relative name
 * @param type - Record type
 * @param ttl - TTL, or null for the zone default
 * @param values - Presentation-form values
 * @returns The API group
 */
export function rr(name: string, type: string, ttl: number | null, values: string[]): ApiGroup {
  return { name, type, ttl, records: values.map((value) => ({ value, comment: '' })) };
}

export const NAMESERVERS = ['hydrogen.ns.example.net.', 'oxygen.ns.example.net.', 'helium.ns.example.org.'];
export const SERIAL = 2026101001;

/**
 * The SOA and apex NS groups Hetzner keeps in every zone.
 * @param serial - The SOA serial
 * @returns The two provider groups
 */
export function providerGroups(serial = SERIAL): ApiGroup[] {
  return [
    rr('@', 'SOA', null, [`hydrogen.ns.example.net. dns.example.net. ${serial} 86400 10800 3600000 3600`]),
    rr('@', 'NS', null, NAMESERVERS),
  ];
}

/** How the fake API should behave. */
export interface FakeApiOptions {
  zone: string;
  groups: ApiGroup[];
  defaultTtl?: number;
  status?: string;
  /** Report this total instead of the real count; null reports none. */
  total?: number | null;
  /** Serve no pages after the first, as if the listing stopped early. */
  dropAfterFirstPage?: boolean;
  /** Answer every request with this status and error body. */
  failWith?: { status: number; code?: string; message?: string };
}

/**
 * Build a fetch that serves one zone the way Hetzner's API does, 100 groups a page.
 * @param options - The zone and how to behave
 * @returns The mock fetch; its calls record each URL and init
 */
export function fakeHetzner(options: FakeApiOptions) {
  const { zone, groups } = options;
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    /**
     * Answer with a JSON body.
     * @param status - The HTTP status
     * @param body - The body
     * @returns The response
     */
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    if (options.failWith) {
      const { status, code = 'error', message = 'failed' } = options.failWith;
      return json(status, { error: { code, message } });
    }
    if (url.pathname === `/v1/zones/${zone}`) {
      return json(200, {
        zone: {
          id: 1,
          name: zone,
          ttl: options.defaultTtl ?? 3600,
          status: options.status ?? 'ok',
          authoritative_nameservers: { assigned: NAMESERVERS, delegated: NAMESERVERS, delegation_status: 'valid' },
        },
      });
    }
    if (url.pathname === `/v1/zones/${zone}/rrsets`) {
      const page = Number(url.searchParams.get('page'));
      const perPage = Number(url.searchParams.get('per_page'));
      const lastPage = Math.max(1, Math.ceil(groups.length / perPage));
      const served = options.dropAfterFirstPage && page > 1 ? [] : groups.slice((page - 1) * perPage, page * perPage);
      const next = options.dropAfterFirstPage || page >= lastPage ? null : page + 1;
      return json(200, {
        meta: {
          pagination: {
            page,
            per_page: perPage,
            previous_page: page > 1 ? page - 1 : null,
            next_page: next,
            last_page: lastPage,
            total_entries: options.total === undefined ? groups.length : options.total,
          },
        },
        rrsets: served.map((g) => ({ id: `${g.name}/${g.type}`, labels: {}, protection: { change: false }, zone: 1, ...g })),
      });
    }
    return json(404, { error: { code: 'not_found', message: 'Zone not found' } });
  });
}

/**
 * Readings where every nameserver serves one serial.
 * @param serial - The serial
 * @returns One reading per nameserver
 */
export function agreedReadings(serial = SERIAL): SerialReading[] {
  return NAMESERVERS.map((ns) => ({ nameserver: ns.replace(/\.$/, ''), serial }));
}

/**
 * Build a command context with fakes, capturing what's printed.
 * @param overrides - Fields to replace
 * @returns The context, and the printed lines
 */
export function fakeContext(overrides: Partial<Context> = {}): { context: Context; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const context: Context = {
    cwd: process.cwd(),
    version: '0.0.0-test',
    print: (line) => out.push(line),
    printError: (line) => err.push(line),
    promptToken: vi.fn(async () => 'TOKEN123'),
    fetch: fakeHetzner({ zone: 'example.com', groups: providerGroups() }),
    readSerials: vi.fn(async () => agreedReadings()),
    ...overrides,
  };
  return { context, out, err };
}

/**
 * Run git in a directory, failing the test on error.
 * @param cwd - The repository
 * @param args - git's arguments
 * @returns Standard output
 */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Make a temporary git repository with one commit and a package.json marking it as ES modules, as a domain
 * repository's dns/ folder has.
 * @returns The repository's path
 */
export function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zone-keeper-test-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'package.json'), '{ "private": true, "type": "module" }\n');
  git(dir, 'add', 'package.json');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/**
 * The text of a small valid zone file.
 * @param zone - The zone's name
 * @param extra - Extra group lines to add
 * @returns The file's text
 */
export function zoneFileText(zone = 'example.com', extra = ''): string {
  return `import type { Zone } from 'zone-keeper';

export default {
  zone: ${JSON.stringify(zone)},
  project: "example",
  serial: ${SERIAL},
  defaultTtl: 3600,
  groups: [
    { name: "@", type: "A", ttl: "default", records: ["192.0.2.1"], comment: "Website" },${extra}
  ],
} satisfies Zone;
`;
}
