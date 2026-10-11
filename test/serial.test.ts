import { describe, expect, it } from 'vitest';

import { describeSerials, readSerials, summarizeSerials, type SerialLookup } from '../src/serial.js';

const NS = ['hydrogen.ns.example.net', 'oxygen.ns.example.net', 'helium.ns.example.org'];

/**
 * Build a fake lookup from per-host addresses and per-address serials. A missing entry fails.
 * @param addresses - Each host's IPv4 addresses
 * @param serials - Each address's serial
 * @returns The lookup
 */
function lookup(addresses: Record<string, string[]>, serials: Record<string, number>): SerialLookup {
  return {
    resolve4: async (host) => {
      const found = addresses[host];
      if (!found) throw new Error('ENOTFOUND');
      return found;
    },
    soaSerial: async (address) => {
      const serial = serials[address];
      if (serial === undefined) throw new Error('ETIMEOUT');
      return serial;
    },
  };
}

const ADDRESSES = { [NS[0] as string]: ['192.0.2.1'], [NS[1] as string]: ['192.0.2.2'], [NS[2] as string]: ['192.0.2.3', '192.0.2.4'] };

describe('readSerials', () => {
  it('asks each nameserver at its IPv4 address', async () => {
    const readings = await readSerials('example.com', NS, lookup(ADDRESSES, { '192.0.2.1': 7, '192.0.2.2': 7, '192.0.2.3': 7 }));
    expect(readings).toEqual(NS.map((nameserver) => ({ nameserver, serial: 7 })));
    expect(summarizeSerials(readings)).toEqual({ kind: 'agreed', serial: 7 });
  });

  it("tries a nameserver's next address when one doesn't answer", async () => {
    const readings = await readSerials('example.com', NS, lookup(ADDRESSES, { '192.0.2.1': 7, '192.0.2.2': 7, '192.0.2.4': 7 }));
    expect(summarizeSerials(readings)).toEqual({ kind: 'agreed', serial: 7 });
  });

  it('reports a nameserver that never answers, and never counts it as agreeing', async () => {
    const readings = await readSerials('example.com', NS, lookup(ADDRESSES, { '192.0.2.1': 7, '192.0.2.2': 7 }));
    expect(readings[2]).toEqual({ nameserver: NS[2], error: expect.stringContaining('no answer over IPv4') });
    expect(summarizeSerials(readings)).toEqual({ kind: 'unreachable' });
    expect(describeSerials(readings)).toMatch(/^hydrogen 7, oxygen 7, helium couldn't be read: /);
  });

  it('reports a nameserver with no IPv4 address', async () => {
    const readings = await readSerials('example.com', ['nowhere.example.net'], lookup({}, {}));
    expect(readings).toEqual([{ nameserver: 'nowhere.example.net', error: expect.stringContaining('no IPv4 address') }]);
  });

  it('tells disagreement apart from agreement', async () => {
    const readings = await readSerials('example.com', NS, lookup(ADDRESSES, { '192.0.2.1': 8, '192.0.2.2': 7, '192.0.2.3': 7 }));
    expect(summarizeSerials(readings)).toEqual({ kind: 'disagree' });
    expect(describeSerials(readings)).toBe('hydrogen 8, oxygen 7, helium 7');
  });
});
