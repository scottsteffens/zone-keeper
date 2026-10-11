import { describe, expect, it, vi } from 'vitest';

import { CliError, EXIT } from '../src/errors.js';
import { HetznerClient } from '../src/hetzner.js';
import { fakeHetzner, providerGroups, rr, SERIAL } from './helpers.js';

/**
 * Build N A groups with distinct names.
 * @param count - How many
 * @returns The groups
 */
function manyGroups(count: number) {
  return Array.from({ length: count }, (_, index) => rr(`host${index}`, 'A', 300, [`192.0.2.${(index % 250) + 1}`]));
}

/**
 * Run a promise expected to fail with a CliError and return it.
 * @param promise - The call
 * @returns The error
 */
async function cliError(promise: Promise<unknown>): Promise<CliError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CliError);
  return error as CliError;
}

describe('HetznerClient', () => {
  it('reads every page, 100 groups at a time, with the token as a bearer header', async () => {
    const groups = [...providerGroups(), ...manyGroups(128)];
    const fetch = fakeHetzner({ zone: 'example.com', groups });
    const snapshot = await new HetznerClient('TOKEN123', fetch).readZone('example.com', 'example');

    expect(snapshot.live.groups).toHaveLength(130);
    expect(snapshot.soaSerial).toBe(SERIAL);
    expect(snapshot.zone).toEqual({
      name: 'example.com',
      ttl: 3600,
      status: 'ok',
      nameservers: ['hydrogen.ns.example.net', 'oxygen.ns.example.net', 'helium.ns.example.org'],
    });
    expect(snapshot.total).toBe(130);
    const urls = fetch.mock.calls.map(([url]) => String(url));
    const pass = [
      'https://api.hetzner.cloud/v1/zones/example.com',
      'https://api.hetzner.cloud/v1/zones/example.com/rrsets?page=1&per_page=100',
      'https://api.hetzner.cloud/v1/zones/example.com/rrsets?page=2&per_page=100',
    ];
    expect(urls).toEqual([...pass, ...pass]);
    const headers = fetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer TOKEN123');
  });

  it('refuses a short read, naming both counts', async () => {
    const fetch = fakeHetzner({ zone: 'example.com', groups: [...providerGroups(), ...manyGroups(128)], dropAfterFirstPage: true });
    const error = await cliError(new HetznerClient('T', fetch).listGroups('example.com', 'example'));
    expect(error.exitCode).toBe(EXIT.refused);
    expect(error.message).toBe('Read 100 groups but Hetzner reports 130. Nothing was written.');
  });

  it('refuses when Hetzner gives no total', async () => {
    const fetch = fakeHetzner({ zone: 'example.com', groups: providerGroups(), total: null });
    const error = await cliError(new HetznerClient('T', fetch).listGroups('example.com', 'example'));
    expect(error.exitCode).toBe(EXIT.refused);
    expect(error.message).toContain("didn't say how many record groups");
  });

  it('refuses when the total changes between pages', async () => {
    const groups = [...providerGroups(), ...manyGroups(128)];
    const inner = fakeHetzner({ zone: 'example.com', groups });
    let page = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const response = await inner(input, init);
      if (!String(input).includes('rrsets')) return response;
      page += 1;
      const body = (await response.json()) as { meta: { pagination: { total_entries: number } } };
      if (page === 2) body.meta.pagination.total_entries = 131;
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const error = await cliError(new HetznerClient('T', fetch).listGroups('example.com', 'example'));
    expect(error.message).toContain('changed while it was being read (130 groups, then 131)');
  });

  it('refuses a group listed twice', async () => {
    const fetch = fakeHetzner({ zone: 'example.com', groups: [...providerGroups(), rr('www', 'A', 300, ['192.0.2.1']), rr('www', 'A', 300, ['192.0.2.2'])] });
    const error = await cliError(new HetznerClient('T', fetch).listGroups('example.com', 'example'));
    expect(error.message).toContain('listed www A twice');
  });

  it('turns a 404 into "this token can\'t see the zone", naming the project', async () => {
    const fetch = fakeHetzner({ zone: 'other.com', groups: [] });
    const error = await cliError(new HetznerClient('T', fetch).getZone('example.com', 'example'));
    expect(error.exitCode).toBe(EXIT.refused);
    expect(error.message).toBe(
      'This token can\'t see example.com. It\'s probably for a different Hetzner project; example.com\'s file says project "example".',
    );
  });

  it('turns a 401 into a bad-token message', async () => {
    const fetch = fakeHetzner({ zone: 'example.com', groups: [], failWith: { status: 401, code: 'unauthorized' } });
    const error = await cliError(new HetznerClient('T', fetch).getZone('example.com', 'example'));
    expect(error.exitCode).toBe(EXIT.refused);
    expect(error.message).toContain('refused the token (401)');
  });

  it("shows Hetzner's own message for other errors, but never the token", async () => {
    const fetch = fakeHetzner({ zone: 'example.com', groups: [], failWith: { status: 503, code: 'unavailable', message: 'try later' } });
    const error = await cliError(new HetznerClient('SECRETTOKEN', fetch).getZone('example.com', 'example'));
    expect(error.exitCode).toBe(EXIT.hetzner);
    expect(error.message).toBe('Hetzner returned 503 unavailable: try later. Nothing was changed.');
    expect(error.message).not.toContain('SECRETTOKEN');
  });

  it('reports a network failure without the request', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const error = await cliError(new HetznerClient('SECRETTOKEN', fetch).getZone('example.com', 'example'));
    expect(error.exitCode).toBe(EXIT.hetzner);
    expect(error.message).toBe("Couldn't reach Hetzner's API (fetch failed). Nothing was changed.");
  });

  it('refuses a response shaped unlike Hetzner documents', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ zone: { name: 'example.com' } }), { status: 200 }));
    const error = await cliError(new HetznerClient('T', fetch).getZone('example.com', 'example'));
    expect(error.exitCode).toBe(EXIT.hetzner);
    expect(error.message).toContain('unexpected zone');
  });

  it('refuses a zone with no SOA record', async () => {
    const fetch = fakeHetzner({ zone: 'example.com', groups: [rr('www', 'A', 300, ['192.0.2.1'])] });
    const error = await cliError(new HetznerClient('T', fetch).readZone('example.com', 'example'));
    expect(error.message).toContain('unexpected SOA record');
  });

  it('refuses a zone edited between page reads, even when the total stays the same', async () => {
    let groups = [...providerGroups(), ...manyGroups(128)];
    let edited = false;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (!edited && String(input).includes('page=2')) {
        edited = true;
        groups = [...groups.filter((g) => g.name !== 'host5'), rr('zzz', 'A', 300, ['192.0.2.9'])];
      }
      return fakeHetzner({ zone: 'example.com', groups })(input, init);
    });
    const error = await cliError(new HetznerClient('T', fetch).readZone('example.com', 'example'));
    expect(error.exitCode).toBe(EXIT.refused);
    expect(error.message).toBe('example.com changed while it was being read. Run the command again; nothing was written.');
  });

  it('treats a live value it cannot read as an unexpected response (exit 4), not a bug', async () => {
    for (const odd of [rr('odd', 'TXT', 300, ['"unclosed']), rr('odd', 'AAAA', 300, ['not-an-address'])]) {
      const fetch = fakeHetzner({ zone: 'example.com', groups: [...providerGroups(), odd] });
      const error = await cliError(new HetznerClient('T', fetch).readZone('example.com', 'example'));
      expect(error.exitCode).toBe(EXIT.hetzner);
      expect(error.message).toContain(`unexpected value in odd ${odd.type}`);
    }
  });

  it('refuses a page sequence that skips pages', async () => {
    const inner = fakeHetzner({ zone: 'example.com', groups: [...providerGroups(), ...manyGroups(128)] });
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const response = await inner(input, init);
      if (!String(input).includes('rrsets')) return response;
      const body = (await response.json()) as { meta: { pagination: { next_page: number | null } } };
      if (body.meta.pagination.next_page === 2) body.meta.pagination.next_page = 5;
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const error = await cliError(new HetznerClient('T', fetch).listGroups('example.com', 'example'));
    expect(error.message).toContain('unexpected page sequence');
  });

  it('refuses a zone with no assigned nameservers', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ zone: { name: 'example.com', ttl: 3600, status: 'ok', authoritative_nameservers: { assigned: [] } } }), { status: 200 }));
    const error = await cliError(new HetznerClient('T', fetch).getZone('example.com', 'example'));
    expect(error.message).toContain('unexpected list of assigned nameservers');
  });

  it("shows control characters in Hetzner's messages escaped, so they can't drive the terminal", async () => {
    const fetch = fakeHetzner({ zone: 'example.com', groups: [], failWith: { status: 422, code: 'invalid', message: 'bad\u001b[2Kvalue' } });
    const error = await cliError(new HetznerClient('T', fetch).getZone('example.com', 'example'));
    expect(error.message).toContain('bad\\x1b[2Kvalue');
    expect(error.message).not.toContain('\u001b');
  });
});
