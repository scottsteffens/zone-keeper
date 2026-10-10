import { describe, expect, it } from 'vitest';

import { isWildcard, isZoneName, unmanagedMatcher, validateZone, ZoneFileError, type Problem } from '../src/zone.js';

/**
 * Build a valid zone file export, with overrides.
 * @param overrides - Fields to replace
 * @returns A plain object as a zone file would export it
 */
function zoneFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    zone: 'example.com',
    project: 'example',
    serial: 2026100800,
    defaultTtl: 3600,
    groups: [
      { name: '@', type: 'A', ttl: 'default', records: ['192.0.2.1'], comment: 'Website' },
      { name: '@', type: 'MX', ttl: 600, records: ['10 mx.example.net.'], comment: 'Mail' },
    ],
    ...overrides,
  };
}

/**
 * Build a zone file holding the given groups.
 * @param groups - The groups
 * @param overrides - Other fields to replace
 * @returns A plain object as a zone file would export it
 */
function withGroups(groups: Record<string, unknown>[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return zoneFile({ ...overrides, groups });
}

/**
 * Build one group, with overrides.
 * @param overrides - Fields to replace
 * @returns A plain group object
 */
function group(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'www', type: 'A', ttl: 'default', records: ['192.0.2.1'], comment: 'Website', ...overrides };
}

/**
 * Validate and return the problems found, failing the test when the file is valid.
 * @param input - A zone file export
 * @returns The problems
 */
function problemsOf(input: unknown): Problem[] {
  try {
    validateZone(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ZoneFileError);
    return (error as ZoneFileError).problems;
  }
  throw new Error('expected the zone file to be rejected');
}

describe('validateZone', () => {
  it('accepts a valid zone file and returns it', () => {
    const input = zoneFile();
    expect(validateZone(input)).toBe(input);
  });

  it('accepts unmanaged patterns, checkSerial and the record shapes zone files use', () => {
    const input = withGroups(
      [
        group({ name: '*', type: 'MX', records: ['10 mx.example.net.'] }),
        group({ name: '_dmarc', type: 'TXT', records: ['v=DMARC1; p=quarantine; rua=mailto:d@example.com'] }),
        group({ name: 'sel._domainkey', type: 'TXT', records: [`v=DKIM1; k=rsa; p=${'A'.repeat(400)}`] }),
        group({ name: 'cdn', type: 'CNAME', records: ['edge.example.net.'] }),
        group({ name: 'v6', type: 'AAAA', records: ['2001:db8::1'] }),
        group({ name: 'sub', type: 'NS', records: ['ns1.example.net.', 'ns2.example.net.'] }),
        group({ name: 'nomail', type: 'MX', records: ['0 .'] }),
        group({ name: '@', type: 'CAA', records: ['0 issue "letsencrypt.org"'] }),
      ],
      { unmanaged: ['_acme-challenge', '_acme-challenge.*'], checkSerial: { off: 'certbot writes here' } },
    );
    expect(validateZone(input)).toBe(input);
  });

  it('rejects a TTL written as a string, naming the field and the value given', () => {
    expect(problemsOf(withGroups([group({ ttl: '600' })]))).toEqual([
      { path: 'groups[0].ttl', reason: expect.stringMatching(/whole number of seconds.*, got "600"$/) },
    ]);
  });

  it('rejects TTLs out of range and a non-integer default TTL', () => {
    expect(problemsOf(withGroups([group({ ttl: 59 }), group({ name: 'b', ttl: 2_147_483_648 })])).map((p) => p.path)).toEqual([
      'groups[0].ttl',
      'groups[1].ttl',
    ]);
    expect(problemsOf(zoneFile({ defaultTtl: 'default' })).map((p) => p.path)).toEqual(['defaultTtl']);
    expect(problemsOf(zoneFile({ defaultTtl: 3600.5 })).map((p) => p.path)).toEqual(['defaultTtl']);
  });

  it('rejects a CNAME beside an A at one name', () => {
    const problems = problemsOf(
      withGroups([group({ name: 'www', type: 'A' }), group({ name: 'www', type: 'CNAME', records: ['host.example.net.'] })]),
    );
    expect(problems).toEqual([{ path: 'groups', reason: expect.stringContaining('"www" has a CNAME beside A') }]);
  });

  it('rejects a CNAME at the apex, a CNAME with two values, apex NS and SOA', () => {
    expect(problemsOf(withGroups([group({ name: '@', type: 'CNAME', records: ['host.example.net.'] })]))).toEqual([
      { path: 'groups[0].type', reason: expect.stringContaining('apex') },
    ]);
    expect(
      problemsOf(withGroups([group({ type: 'CNAME', records: ['a.example.net.', 'b.example.net.'] })])).map((p) => p.path),
    ).toEqual(['groups[0].records']);
    expect(problemsOf(withGroups([group({ name: '@', type: 'NS', records: ['ns.example.net.'] })]))).toEqual([
      { path: 'groups[0].type', reason: expect.stringContaining('apex NS') },
    ]);
    expect(problemsOf(withGroups([group({ name: '@', type: 'SOA', records: ['x'] })]))).toEqual([
      { path: 'groups[0].type', reason: expect.stringContaining('SOA is managed by Hetzner') },
    ]);
  });

  it('rejects an unknown type', () => {
    expect(problemsOf(withGroups([group({ type: 'NAPTR' })])).map((p) => p.path)).toEqual(['groups[0].type']);
  });

  it('rejects a group matching an unmanaged pattern', () => {
    const problems = problemsOf(
      withGroups([group(), group({ name: '_acme-challenge.app', type: 'TXT', records: ['token'] })], {
        unmanaged: ['_acme-challenge.*'],
      }),
    );
    expect(problems).toEqual([{ path: 'groups[1].name', reason: expect.stringContaining('unmanaged') }]);
  });

  it('rejects names that are written in full, uppercase, absolute, or malformed', () => {
    const names = ['www.example.com', 'example.com', 'WWW', 'www.', 'a.*', 'bad..name', '-x', 'x'.repeat(64)];
    const problems = problemsOf(withGroups(names.map((name, index) => group({ name, records: [`192.0.2.${index + 1}`] }))));
    expect(problems.map((p) => p.path)).toEqual(names.map((_, index) => `groups[${index}].name`));
    expect(problems[0]?.reason).toContain('write "www"');
    expect(problems[1]?.reason).toContain('write "@"');
  });

  it('rejects record values that do not fit their type', () => {
    const problems = problemsOf(
      withGroups([
        group({ type: 'A', records: ['2001:db8::1'] }),
        group({ name: 'b', type: 'AAAA', records: ['192.0.2.1'] }),
        group({ name: 'c', type: 'CNAME', records: ['host.example.net'] }),
        group({ name: 'd', type: 'MX', records: ['mx.example.net.'] }),
        group({ name: 'e', type: 'MX', records: ['70000 mx.example.net.'] }),
        group({ name: 'f', type: 'TXT', records: ['café'] }),
        group({ name: 'g', type: 'TXT', records: ['line\nbreak'] }),
        group({ name: 'h', type: 'HINFO', records: ['"cpu" "os\u0000"'] }),
        group({ name: 'i', type: 'MX', records: ['10 mx.example.net'] }),
        group({ name: 'j', type: 'AAAA', records: ['fe80::1%eth0'] }),
        group({ name: 'k', type: 'TXT', records: ['"v=spf1 -all"'] }),
        group({ name: '_sip._tcp', type: 'SRV', records: ['0 5 5060 sip'] }),
        group({ name: '_x._tcp', type: 'SRV', records: ['0 5 sip.example.net.'] }),
        group({ name: 'svc', type: 'HTTPS', records: ['1 svc alpn=h2'] }),
        group({ name: 'rp', type: 'RP', records: ['admin.example.com. info'] }),
      ]),
    );
    expect(problems.map((p) => p.path)).toEqual(Array.from({ length: 15 }, (_, index) => `groups[${index}].records[0]`));
    expect(problems[2]?.reason).toContain('ending with a dot');
    expect(problems[8]?.reason).toContain('ending with a dot');
    expect(problems[10]?.reason).toContain('without quotes');
    expect(problems[11]?.reason).toContain('ending with a dot');
    expect(problems[12]?.reason).toContain('<priority> <weight> <port> <target>');
  });

  it('rejects malformed CAA, DS and TLSA values without crashing', () => {
    const problems = problemsOf(
      withGroups([
        group({ name: '@', type: 'CAA', records: ['0 issue "unclosed'] }),
        group({ name: 'b', type: 'CAA', records: ['issue "x"'] }),
        group({ name: 'c', type: 'DS', records: ['12345 13 2 not-hex'] }),
        group({ name: 'd', type: 'TLSA', records: ['3 1'] }),
      ]),
    );
    expect(problems.map((p) => p.path)).toEqual(Array.from({ length: 4 }, (_, index) => `groups[${index}].records[0]`));
    expect(problems[0]?.reason).toContain('malformed quoted value');
  });

  it('accepts uppercase hostnames, the "." target, and SRV, HTTPS and RP values written in full', () => {
    const input = withGroups([
      group({ name: 'cdn', type: 'CNAME', records: ['Edge.Example.NET.'] }),
      group({ name: '_sip._tcp', type: 'SRV', records: ['0 5 5060 sip.example.net.'] }),
      group({ name: '_none._tcp', type: 'SRV', records: ['0 0 0 .'] }),
      group({ name: 'svc', type: 'HTTPS', records: ['1 . alpn="h2,h3"'] }),
      group({ name: 'rp', type: 'RP', records: ['admin.example.com. .'] }),
      group({ name: 'ds', type: 'DS', records: ['12345 13 2 ABCDEF01 2345'] }),
      group({ name: '_443._tcp', type: 'TLSA', records: ['3 1 1 abcdef'] }),
    ]);
    expect(validateZone(input)).toBe(input);
  });

  it('rejects empty and repeated values, including the same address written two ways', () => {
    expect(problemsOf(withGroups([group({ records: [] })])).map((p) => p.path)).toEqual(['groups[0].records']);
    expect(problemsOf(withGroups([group({ records: [''] })])).map((p) => p.path)).toEqual(['groups[0].records[0]']);
    expect(
      problemsOf(withGroups([group({ type: 'AAAA', records: ['2001:db8::1', '2001:DB8:0::1'] })])).map((p) => p.path),
    ).toEqual(['groups[0].records[1]']);
  });

  it('rejects a repeated group, a missing comment and unknown fields', () => {
    const problems = problemsOf(
      withGroups([group(), group({ records: ['192.0.2.2'] }), group({ name: 'b', comment: ' ' }), group({ name: 'c', tll: 60 })]),
    );
    expect(problems.map((p) => p.path)).toEqual(['groups[1]', 'groups[2].comment', 'groups[3].tll']);
  });

  it('rejects zone-level mistakes, listing every one', () => {
    const problems = problemsOf({
      zone: 'Example.com',
      project: '',
      serial: -1,
      defaultTtl: 3600,
      unmanaged: ['ok', 'BAD'],
      checkSerial: { off: '' },
      groups: [],
      extra: true,
    });
    expect(problems.map((p) => p.path)).toEqual([
      'extra',
      'zone',
      'project',
      'serial',
      'unmanaged[1]',
      'checkSerial',
      'groups',
    ]);
  });

  it('rejects checkSerial with anything beside "off"', () => {
    expect(problemsOf(zoneFile({ checkSerial: { off: 'certbot', extra: 1 } })).map((p) => p.path)).toEqual(['checkSerial']);
  });

  it('rejects a file without a default export object', () => {
    expect(problemsOf(undefined)).toEqual([{ path: 'default export', reason: expect.stringContaining('export default') }]);
  });

  it('formats every problem into the error message', () => {
    expect(() => validateZone(withGroups([group({ ttl: '600' })]))).toThrow(/groups\[0\]\.ttl: must be a whole number/);
  });
});

describe('isZoneName', () => {
  it('accepts lowercase domain names and refuses everything else', () => {
    expect(isZoneName('example.com')).toBe(true);
    expect(isZoneName('a-b.example.co.uk')).toBe(true);
    for (const bad of ['com', 'Example.com', 'example.com.', '../etc/passwd', 'ex ample.com', '_x.example.com', '']) {
      expect(isZoneName(bad)).toBe(false);
    }
  });
});

describe('isWildcard', () => {
  it('is true only when the first label is "*"', () => {
    expect(isWildcard('*')).toBe(true);
    expect(isWildcard('*.rp')).toBe(true);
    expect(isWildcard('*._report._dmarc.reports')).toBe(true);
    expect(isWildcard('www')).toBe(false);
    expect(isWildcard('@')).toBe(false);
  });
});

describe('unmanagedMatcher', () => {
  it('matches an exact name, and "*" across labels', () => {
    const matches = unmanagedMatcher(['_acme-challenge', '_acme-challenge.*']);
    expect(matches('_acme-challenge')).toBe(true);
    expect(matches('_acme-challenge.app')).toBe(true);
    expect(matches('_acme-challenge.help.demo')).toBe(true);
    expect(matches('_acme-challengex')).toBe(false);
    expect(matches('_acme-challengeXapp')).toBe(false);
    expect(matches('_acme-challengexapp')).toBe(false);
    expect(matches('x._acme-challenge')).toBe(false);
    expect(matches('www')).toBe(false);
  });

  it('matches nothing when there are no patterns', () => {
    expect(unmanagedMatcher([])('anything')).toBe(false);
  });
});
