import { describe, expect, it } from 'vitest';

import { diffZone, type LiveZone, type Operation } from '../src/diff.js';
import type { LiveGroup } from '../src/normalize.js';
import type { Group, Zone } from '../src/zone.js';

const SOA: LiveGroup = {
  name: '@',
  type: 'SOA',
  ttl: null,
  records: ['ns1.example.net. hostmaster.example.net. 2026100800 86400 10800 3600000 3600'],
};
const APEX_NS: LiveGroup = { name: '@', type: 'NS', ttl: null, records: ['ns1.example.net.', 'ns2.example.net.'] };

/**
 * Build a file group with a comment.
 * @param name - Relative name
 * @param type - Record type
 * @param ttl - TTL or "default"
 * @param records - Values as a zone file writes them
 * @returns The group
 */
function g(name: string, type: Group['type'], ttl: Group['ttl'], records: string[]): Group {
  return { name, type, ttl, records, comment: 'test' };
}

/**
 * Build a live group in presentation form.
 * @param name - Relative name
 * @param type - Record type
 * @param ttl - TTL, or null for the zone default
 * @param records - Presentation-form values
 * @returns The live group
 */
function l(name: string, type: string, ttl: number | null, records: string[]): LiveGroup {
  return { name, type, ttl, records };
}

/**
 * Build a zone file around the given groups.
 * @param groups - The file's groups
 * @param extra - Other zone fields
 * @returns The zone
 */
function zone(groups: Group[], extra: Partial<Zone> = {}): Zone {
  return { zone: 'example.com', project: 'example', serial: 1, defaultTtl: 3600, groups, ...extra };
}

/**
 * Build a live zone, adding the provider's SOA and apex NS groups.
 * @param groups - The live groups
 * @param defaultTtl - The zone's default TTL
 * @returns The live zone
 */
function live(groups: LiveGroup[], defaultTtl = 3600): LiveZone {
  return { defaultTtl, groups: [SOA, APEX_NS, ...groups] };
}

const SITE = g('@', 'A', 'default', ['192.0.2.1']);
const SITE_LIVE = l('@', 'A', null, ['192.0.2.1']);

describe('diffZone', () => {
  it('is empty when the provider matches, ignoring the SOA and apex NS records', () => {
    const result = diffZone(zone([SITE]), live([SITE_LIVE]));
    expect(result.empty).toBe(true);
    expect(result.operations).toEqual([]);
  });

  it('treats the same records in a different order as equal', () => {
    const result = diffZone(
      zone([g('www', 'A', 300, ['192.0.2.1', '192.0.2.2'])]),
      live([l('www', 'A', 300, ['192.0.2.2', '192.0.2.1'])]),
    );
    expect(result.empty).toBe(true);
  });

  it('counts a changed TTL alone as a change', () => {
    const result = diffZone(zone([g('www', 'A', 600, ['192.0.2.1'])]), live([l('www', 'A', 300, ['192.0.2.1'])]));
    expect(result.changes).toEqual([
      { name: 'www', type: 'A', before: { ttl: 300, records: ['192.0.2.1'] }, after: { ttl: 600, records: ['192.0.2.1'] } },
    ]);
    expect(result.operations).toEqual([{ op: 'setTtl', name: 'www', type: 'A', ttl: 600 }]);
  });

  it('tells an explicit TTL from the zone default, even when the numbers match', () => {
    const result = diffZone(zone([g('www', 'A', 3600, ['192.0.2.1'])]), live([l('www', 'A', null, ['192.0.2.1'])]));
    expect(result.operations).toEqual([{ op: 'setTtl', name: 'www', type: 'A', ttl: 3600 }]);
  });

  it('finds additions, changes, removals and the default TTL, in write order', () => {
    const result = diffZone(
      zone([SITE, g('www', 'A', 300, ['192.0.2.9']), g('new', 'A', 'default', ['192.0.2.3'])], { defaultTtl: 600 }),
      live([SITE_LIVE, l('www', 'A', 300, ['192.0.2.1']), l('old', 'A', null, ['192.0.2.4'])]),
    );
    expect(result.defaultTtl).toEqual({ before: 3600, after: 600 });
    expect(result.additions.map((d) => d.name)).toEqual(['new']);
    expect(result.changes.map((d) => d.name)).toEqual(['www']);
    expect(result.removals).toEqual([{ name: 'old', type: 'A', before: { ttl: 'default', records: ['192.0.2.4'] } }]);
    expect(result.operations).toEqual<Operation[]>([
      { op: 'setDefaultTtl', ttl: 600 },
      { op: 'setRecords', name: 'www', type: 'A', records: ['192.0.2.9'] },
      { op: 'create', name: 'new', type: 'A', ttl: 'default', records: ['192.0.2.3'] },
      { op: 'delete', name: 'old', type: 'A' },
    ]);
    expect(result.empty).toBe(false);
  });

  it('writes records then TTL when both change', () => {
    const result = diffZone(zone([g('www', 'A', 600, ['192.0.2.9'])]), live([l('www', 'A', 300, ['192.0.2.1'])]));
    expect(result.operations.map((o) => o.op)).toEqual(['setRecords', 'setTtl']);
  });

  it('compares a DKIM value the provider split differently as equal', () => {
    const dkim = `v=DKIM1; k=rsa; p=${'A'.repeat(380)}`;
    const result = diffZone(
      zone([g('sel._domainkey', 'TXT', 600, [dkim])]),
      live([l('sel._domainkey', 'TXT', 600, [`"${dkim.slice(0, 100)}" "${dkim.slice(100)}"`])]),
    );
    expect(result.empty).toBe(true);
  });

  it('never shows unmanaged names, at the exact name or under it', () => {
    const result = diffZone(
      zone([SITE], { unmanaged: ['_acme-challenge', '_acme-challenge.*'] }),
      live([SITE_LIVE, l('_acme-challenge', 'TXT', 60, ['"token1"']), l('_acme-challenge.app', 'TXT', 60, ['"token2"'])]),
    );
    expect(result.empty).toBe(true);
    expect(result.operations).toEqual([]);
    expect(result.unmanaged).toEqual(['_acme-challenge TXT', '_acme-challenge.app TXT']);
  });

  describe('mail warnings', () => {
    it('flag DKIM, DMARC, SPF and MX changes, additions and removals', () => {
      const result = diffZone(
        zone([
          g('@', 'TXT', 'default', ['v=spf1 include:spf.example.net -all']),
          g('_dmarc', 'TXT', 'default', ['v=DMARC1; p=reject']),
          g('new._domainkey', 'TXT', 'default', ['v=DKIM1; p=KEY']),
          g('@', 'MX', 'default', ['10 mx2.example.net.']),
        ]),
        live([
          l('@', 'TXT', null, ['"v=spf1 -all"']),
          l('_dmarc', 'TXT', null, ['"v=DMARC1; p=reject"']),
          l('@', 'MX', null, ['10 mx.example.net.']),
          l('old._domainkey', 'TXT', null, ['"v=DKIM1; p=OLD"']),
        ]),
      );
      expect(result.warnings).toEqual([
        { kind: 'mail', name: '@', type: 'TXT', record: 'SPF' },
        { kind: 'mail', name: 'new._domainkey', type: 'TXT', record: 'DKIM' },
        { kind: 'mail', name: '@', type: 'MX', record: 'MX' },
        { kind: 'mail', name: 'old._domainkey', type: 'TXT', record: 'DKIM' },
      ]);
    });

    it('flag a change to *._report._dmarc.reports, which has a _dmarc label', () => {
      const result = diffZone(
        zone([g('*._report._dmarc.reports', 'TXT', 600, ['v=DMARC1; x'])]),
        live([l('*._report._dmarc.reports', 'TXT', 600, ['"v=DMARC1"'])]),
      );
      expect(result.warnings).toEqual([{ kind: 'mail', name: '*._report._dmarc.reports', type: 'TXT', record: 'DMARC' }]);
    });

    it('flag SPF removed, or replaced by a TXT that is not SPF', () => {
      const removed = diffZone(zone([SITE]), live([SITE_LIVE, l('@', 'TXT', null, ['"v=spf1 -all"'])]));
      expect(removed.warnings).toEqual([{ kind: 'mail', name: '@', type: 'TXT', record: 'SPF' }]);
      const replaced = diffZone(zone([g('@', 'TXT', 'default', ['site-verify=x'])]), live([l('@', 'TXT', null, ['"v=spf1 -all"'])]));
      expect(replaced.warnings).toEqual([{ kind: 'mail', name: '@', type: 'TXT', record: 'SPF' }]);
    });

    it('do not flag text that only looks like SPF', () => {
      const result = diffZone(zone([g('@', 'TXT', 'default', ['v=spf10 x']), g('a', 'TXT', 'default', ['note v=spf1 here'])]), live([]));
      expect(result.warnings).toEqual([]);
    });

    it('do not flag an ordinary TXT record', () => {
      const result = diffZone(zone([g('@', 'TXT', 'default', ['site-verify=abc'])]), live([]));
      expect(result.warnings).toEqual([]);
    });
  });

  describe('wildcard warnings, by RFC 4592 closest encloser', () => {
    const tenantMx = l('*', 'MX', 600, ['10 mx.example.net.']);
    const dkim = l('bigsend._domainkey', 'TXT', null, ['"v=DKIM1; p=KEY"']);

    it('flag an added name that the bare "*" wildcard answers for today', () => {
      const result = diffZone(
        zone([g('*', 'MX', 600, ['10 mx.example.net.']), g('help', 'A', 'default', ['192.0.2.5'])]),
        live([tenantMx]),
      );
      expect(result.warnings).toEqual([{ kind: 'wildcard', name: 'help', shadowed: 'help', wildcard: '*', types: ['MX'] }]);
    });

    it('do not flag a new DKIM selector under an existing _domainkey', () => {
      const result = diffZone(
        zone([
          g('*', 'MX', 600, ['10 mx.example.net.']),
          g('bigsend._domainkey', 'TXT', 'default', ['v=DKIM1; p=KEY']),
          g('x._domainkey', 'TXT', 'default', ['v=DKIM1; p=NEW']),
        ]),
        live([tenantMx, dkim]),
      );
      expect(result.warnings.filter((w) => w.kind === 'wildcard')).toEqual([]);
    });

    it('flag the highest new ancestor when an added name creates an empty non-terminal', () => {
      const result = diffZone(
        zone([g('*', 'MX', 600, ['10 mx.example.net.']), g('a.b', 'A', 'default', ['192.0.2.5'])]),
        live([tenantMx]),
      );
      expect(result.warnings).toEqual([{ kind: 'wildcard', name: 'a.b', shadowed: 'b', wildcard: '*', types: ['MX'] }]);
    });

    it('find the wildcard at the closest encloser, not only at the apex', () => {
      const result = diffZone(
        zone([g('*.rp', 'MX', 'default', ['10 mx.example.net.']), g('rp', 'MX', 'default', ['10 mx.example.net.']), g('org1.rp', 'A', 'default', ['192.0.2.5'])]),
        live([l('*.rp', 'MX', null, ['10 mx.example.net.']), l('rp', 'MX', null, ['10 mx.example.net.'])]),
      );
      expect(result.warnings.filter((w) => w.kind === 'wildcard')).toEqual([
        { kind: 'wildcard', name: 'org1.rp', shadowed: 'org1.rp', wildcard: '*.rp', types: ['MX'] },
      ]);
    });

    it('do not flag a new type at a name that already exists, or a name no wildcard covers', () => {
      const result = diffZone(
        zone([g('*', 'MX', 600, ['10 mx.example.net.']), SITE, g('@', 'AAAA', 'default', ['2001:db8::1']), g('x.sub', 'A', 'default', ['192.0.2.6'])]),
        live([tenantMx, SITE_LIVE, l('y.sub', 'A', null, ['192.0.2.7'])]),
      );
      expect(result.warnings.filter((w) => w.kind === 'wildcard')).toEqual([]);
    });

    it('warn once when several added groups shadow the same name', () => {
      const result = diffZone(
        zone([g('*', 'MX', 600, ['10 mx.example.net.']), g('help', 'A', 'default', ['192.0.2.5']), g('help', 'AAAA', 'default', ['2001:db8::5'])]),
        live([tenantMx]),
      );
      expect(result.warnings.filter((w) => w.kind === 'wildcard')).toHaveLength(1);
    });
  });

  describe('CNAME write order', () => {
    it('deletes the A immediately before creating the CNAME that replaces it', () => {
      const result = diffZone(
        zone([g('new', 'A', 'default', ['192.0.2.3']), g('www', 'CNAME', 'default', ['edge.example.net.'])]),
        live([l('www', 'A', null, ['192.0.2.1']), l('www', 'AAAA', null, ['2001:db8::1']), l('gone', 'A', null, ['192.0.2.9'])]),
      );
      expect(result.operations).toEqual<Operation[]>([
        { op: 'create', name: 'new', type: 'A', ttl: 'default', records: ['192.0.2.3'] },
        { op: 'delete', name: 'www', type: 'A' },
        { op: 'delete', name: 'www', type: 'AAAA' },
        { op: 'create', name: 'www', type: 'CNAME', ttl: 'default', records: ['edge.example.net.'] },
        { op: 'delete', name: 'gone', type: 'A' },
      ]);
      expect(result.removals.map((r) => `${r.name} ${r.type}`)).toEqual(['www A', 'www AAAA', 'gone A']);
    });

    it('deletes the CNAME immediately before creating the A that replaces it, once', () => {
      const result = diffZone(
        zone([g('www', 'A', 'default', ['192.0.2.1']), g('www', 'AAAA', 'default', ['2001:db8::1'])]),
        live([l('www', 'CNAME', null, ['edge.example.net.'])]),
      );
      expect(result.operations).toEqual<Operation[]>([
        { op: 'delete', name: 'www', type: 'CNAME' },
        { op: 'create', name: 'www', type: 'A', ttl: 'default', records: ['192.0.2.1'] },
        { op: 'create', name: 'www', type: 'AAAA', ttl: 'default', records: ['2001:db8::1'] },
      ]);
    });
  });
});
