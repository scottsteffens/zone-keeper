import { describe, expect, it } from 'vitest';

import {
  canonicalFileGroup,
  canonicalLiveGroup,
  canonicalValue,
  formatTxt,
  parseTxt,
  presentationValue,
  sameRecords,
} from '../src/normalize.js';

const KEY = `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA${'x'.repeat(340)}IDAQAB`;
const DKIM = `v=DKIM1; k=rsa; p=${KEY}`;

describe('parseTxt', () => {
  it('joins quoted pieces wherever they were split', () => {
    expect(parseTxt(`"${DKIM.slice(0, 255)}" "${DKIM.slice(255)}"`)).toBe(DKIM);
    expect(parseTxt(`"${DKIM.slice(0, 100)}" "${DKIM.slice(100, 300)}"  "${DKIM.slice(300)}"`)).toBe(DKIM);
  });

  it('reads escapes and unquoted words', () => {
    expect(parseTxt('"say \\"hi\\" \\\\ there"')).toBe('say "hi" \\ there');
    expect(parseTxt('"a\\059b"')).toBe('a;b');
    expect(parseTxt('plain')).toBe('plain');
    expect(parseTxt('""')).toBe('');
  });

  it('refuses malformed values rather than guessing', () => {
    expect(() => parseTxt('"unclosed')).toThrow(/Unclosed quote/);
    expect(() => parseTxt('"bad \\999"')).toThrow(/Malformed TXT escape/);
    expect(() => parseTxt('ends\\')).toThrow(/lone backslash/);
  });
});

describe('formatTxt', () => {
  it('splits at 255 characters and round-trips through parseTxt', () => {
    const formatted = formatTxt(DKIM);
    const pieces = formatted.split('" "');
    expect(pieces).toHaveLength(2);
    expect(pieces[0]).toBe(`"${DKIM.slice(0, 255)}`);
    expect(parseTxt(formatted)).toBe(DKIM);
  });

  it('escapes quotes and backslashes, and writes an empty value as ""', () => {
    expect(formatTxt('say "hi" \\')).toBe('"say \\"hi\\" \\\\"');
    expect(parseTxt(formatTxt('say "hi" \\'))).toBe('say "hi" \\');
    expect(formatTxt('')).toBe('""');
  });

  it('keeps a value of exactly 255 characters in one piece', () => {
    expect(formatTxt('a'.repeat(255))).toBe(`"${'a'.repeat(255)}"`);
    expect(formatTxt('a'.repeat(256))).toBe(`"${'a'.repeat(255)}" "a"`);
  });
});

describe('canonicalValue', () => {
  it('puts hostnames in lowercase and MX in "priority host" form', () => {
    expect(canonicalValue('CNAME', 'Edge.Example.NET.', 'live')).toBe('edge.example.net.');
    expect(canonicalValue('MX', '010   MX.Example.net.', 'live')).toBe('10 mx.example.net.');
    expect(canonicalValue('MX', '0 .', 'file')).toBe('0 .');
  });

  it('puts IPv6 addresses in RFC 5952 form', () => {
    expect(canonicalValue('AAAA', '2001:DB8:0:0:0:0:0:1', 'live')).toBe('2001:db8::1');
    expect(canonicalValue('AAAA', '2001:db8::1', 'file')).toBe('2001:db8::1');
  });

  it('reads live TXT as presentation form and file TXT as whole text', () => {
    expect(canonicalValue('TXT', '"v=spf1 -all"', 'live')).toBe('v=spf1 -all');
    expect(canonicalValue('TXT', '"v=spf1 -all"', 'file')).toBe('"v=spf1 -all"');
  });

  it('collapses whitespace in other types', () => {
    expect(canonicalValue('CAA', ' 0  issue   "letsencrypt.org" ', 'live')).toBe('0 issue "letsencrypt.org"');
  });

  it('keeps whitespace inside quotes, where it is data', () => {
    expect(canonicalValue('CAA', '0 issue "ca  x"', 'file')).not.toBe(canonicalValue('CAA', '0 issue "ca x"', 'live'));
    expect(canonicalValue('HINFO', '"Intel  CPU"   "Linux"', 'live')).toBe('"Intel  CPU" "Linux"');
  });

  it('compares SRV, HTTPS and SVCB targets regardless of case', () => {
    expect(canonicalValue('SRV', '0 5 443 X.Example.net.', 'file')).toBe(canonicalValue('SRV', '0  5 443 x.example.net.', 'live'));
    expect(canonicalValue('HTTPS', '1 Svc.Example.net. alpn="h2"', 'file')).toBe('1 svc.example.net. alpn="h2"');
    expect(canonicalValue('SVCB', '1 . alpn=h3', 'live')).toBe('1 . alpn=h3');
  });

  it('compares DS and TLSA digests regardless of case and spacing', () => {
    expect(canonicalValue('DS', '12345 13 2 ABCD EF01', 'file')).toBe(canonicalValue('DS', '12345 13 2 abcdef01', 'live'));
    expect(canonicalValue('TLSA', '3 1 1 AB CD', 'file')).toBe(canonicalValue('TLSA', '3 1 1 abcd', 'live'));
  });

  it('compares CAA values quoted or not, and tags regardless of case', () => {
    expect(canonicalValue('CAA', '0 issue letsencrypt.org', 'file')).toBe(canonicalValue('CAA', '0 issue "letsencrypt.org"', 'live'));
    expect(canonicalValue('CAA', '0 ISSUE "letsencrypt.org"', 'file')).toBe('0 issue "letsencrypt.org"');
    expect(canonicalValue('CAA', '128 iodef "mailto:a@example.com"', 'live')).toBe('128 iodef "mailto:a@example.com"');
  });
});

describe('presentationValue', () => {
  it('quotes and splits TXT, and canonicalizes the rest', () => {
    expect(presentationValue('TXT', DKIM)).toBe(formatTxt(DKIM));
    expect(presentationValue('MX', '10 MX.example.net.')).toBe('10 mx.example.net.');
    expect(presentationValue('HINFO', '"Intel  CPU" "Linux"')).toBe('"Intel  CPU" "Linux"');
  });
});

describe('canonical groups', () => {
  it('compare a DKIM value split differently by the file and the provider as equal', () => {
    const file = canonicalFileGroup({ name: 'sel._domainkey', type: 'TXT', ttl: 600, records: [DKIM], comment: 'DKIM' });
    const live = canonicalLiveGroup({
      name: 'sel._domainkey',
      type: 'TXT',
      ttl: 600,
      records: [`"${DKIM.slice(0, 200)}" "${DKIM.slice(200)}"`],
    });
    expect(live).toEqual(file);
  });

  it('read a null TTL as "default", and sort records', () => {
    const live = canonicalLiveGroup({ name: 'WWW', type: 'A', ttl: null, records: ['192.0.2.2', '192.0.2.1'] });
    expect(live).toEqual({ name: 'www', type: 'A', ttl: 'default', records: ['192.0.2.1', '192.0.2.2'] });
  });
});

describe('sameRecords', () => {
  it('compares sorted lists by value and length', () => {
    expect(sameRecords(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameRecords(['a', 'b'], ['a'])).toBe(false);
    expect(sameRecords(['a', 'b'], ['a', 'c'])).toBe(false);
  });
});
