import type { Group, RecordType, Ttl } from './zone.js';

/** The longest piece of a TXT value DNS allows in one string. */
const TXT_PIECE_LENGTH = 255;

/** A group as the provider reports it, in DNS presentation form. Provider-neutral; each client maps its API onto this. */
export interface LiveGroup {
  /** Relative to the zone, `@` for the apex. */
  name: string;
  type: string;
  /** Null when the group uses the zone's default TTL. */
  ttl: number | null;
  /** Values in presentation form: TXT quoted and possibly split, hostnames absolute. */
  records: string[];
}

/** A group in the one form both sides are compared in. */
export interface CanonicalGroup {
  name: string;
  type: string;
  ttl: Ttl;
  /** Canonical values, sorted, so order never counts as a difference. */
  records: string[];
}

/**
 * Read a TXT value in presentation form (`"v=DKIM1; p=…" "…"`) and return the text it carries, its pieces joined.
 * Handles `\"`, `\\` and `\DDD` escapes, and unquoted words.
 * @param presentation - The value as the provider returned it
 * @returns The joined text
 * @throws Error when a quoted string isn't closed or an escape is malformed
 */
export function parseTxt(presentation: string): string {
  let text = '';
  let index = 0;
  const length = presentation.length;

  /**
   * Read one escape starting just after a backslash.
   * @returns The character it stands for
   */
  const readEscape = (): string => {
    const digits = presentation.slice(index, index + 3);
    if (/^\d{3}$/.test(digits)) {
      const code = Number(digits);
      if (code > 255) throw new Error(`Malformed TXT escape "\\${digits}" in ${presentation}`);
      index += 3;
      return String.fromCharCode(code);
    }
    const next = presentation[index];
    if (next === undefined) throw new Error(`TXT value ends in a lone backslash: ${presentation}`);
    index += 1;
    return next;
  };

  while (index < length) {
    const char = presentation[index];
    if (char === ' ' || char === '\t') {
      index += 1;
    } else if (char === '"') {
      index += 1;
      let closed = false;
      while (index < length) {
        const inner = presentation[index];
        index += 1;
        if (inner === '"') {
          closed = true;
          break;
        }
        text += inner === '\\' ? readEscape() : inner;
      }
      if (!closed) throw new Error(`Unclosed quote in TXT value: ${presentation}`);
    } else {
      while (index < length && presentation[index] !== ' ' && presentation[index] !== '\t') {
        const inner = presentation[index];
        index += 1;
        text += inner === '\\' ? readEscape() : inner;
      }
    }
  }
  return text;
}

/**
 * Write text as a TXT value in presentation form: quoted, escaped, and split into pieces of at most 255 characters.
 * @param text - The whole TXT value, printable ASCII, as written in a zone file
 * @returns The presentation form, such as `"first 255 characters" "the rest"`
 */
export function formatTxt(text: string): string {
  const pieces: string[] = [];
  for (let start = 0; start < text.length; start += TXT_PIECE_LENGTH) {
    pieces.push(text.slice(start, start + TXT_PIECE_LENGTH));
  }
  if (pieces.length === 0) pieces.push('');
  return pieces.map((piece) => `"${piece.replace(/[\\"]/g, '\\$&')}"`).join(' ');
}

/**
 * Put an IPv6 address in its RFC 5952 form: lowercase, leading zeros dropped, the longest zero run as `::`.
 * @param address - A valid IPv6 address
 * @returns The canonical form
 */
function canonicalIpv6(address: string): string {
  return new URL(`http://[${address}]/`).hostname.slice(1, -1);
}

/**
 * Split a value into whitespace-separated tokens, keeping quoted spans (and the escapes in them) intact, so
 * whitespace inside quotes, which is data, is never collapsed. A quote may open mid-token, as in `alpn="h2 h3"`.
 * @param value - A record value in presentation form
 * @returns The tokens, quotes included
 */
function tokens(value: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? '';
    if (inQuotes && char === '\\') {
      current += char + (value[index + 1] ?? '');
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (!inQuotes && /\s/.test(char)) {
      if (current !== '') result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current !== '') result.push(current);
  return result;
}

/**
 * Write a decimal field without leading zeros, leaving anything that isn't a plain number as it is.
 * @param field - One token of a record value
 * @returns The canonical number, or the token unchanged
 */
function decimal(field: string): string {
  return /^\d+$/.test(field) ? String(Number(field)) : field;
}

/**
 * Put a record value in canonical form, the form every comparison uses.
 * @param type - The record type
 * @param value - The value
 * @param source - `file` for a zone file's value (TXT written whole), `live` for presentation form (TXT quoted)
 * @returns The canonical value
 */
export function canonicalValue(type: string, value: string, source: 'file' | 'live'): string {
  switch (type) {
    case 'TXT':
      return source === 'file' ? value : parseTxt(value);
    case 'AAAA':
      return canonicalIpv6(value.trim());
    case 'CNAME':
    case 'NS':
    case 'PTR':
      return value.trim().toLowerCase();
    case 'MX': {
      const [priority = '', host = ''] = value.trim().split(/\s+/);
      return `${Number(priority)} ${host.toLowerCase()}`;
    }
    case 'SRV': {
      const [priority = '', weight = '', port = '', target = '', ...rest] = tokens(value);
      return [decimal(priority), decimal(weight), decimal(port), target.toLowerCase(), ...rest].join(' ');
    }
    case 'HTTPS':
    case 'SVCB': {
      const [priority = '', target = '', ...params] = tokens(value);
      return [decimal(priority), target.toLowerCase(), ...params].join(' ');
    }
    case 'RP':
      return tokens(value)
        .map((field) => field.toLowerCase())
        .join(' ');
    case 'DS':
    case 'TLSA': {
      const [first = '', second = '', third = '', ...digest] = tokens(value);
      return [decimal(first), decimal(second), decimal(third), digest.join('').toLowerCase()].join(' ');
    }
    case 'CAA': {
      const [flags = '', tag = '', ...rest] = tokens(value);
      const text = parseTxt(rest.join(' '));
      return `${decimal(flags)} ${tag.toLowerCase()} "${text.replace(/[\\"]/g, '\\$&')}"`;
    }
    default:
      return tokens(value).join(' ');
  }
}

/**
 * Turn a zone file's value into the presentation form a provider is sent.
 * @param type - The record type
 * @param value - The value as written in the zone file
 * @returns The value to write
 */
export function presentationValue(type: RecordType, value: string): string {
  return type === 'TXT' ? formatTxt(value) : canonicalValue(type, value, 'file');
}

/**
 * Sort canonical values so two groups compare equal regardless of order.
 * @param values - Canonical values
 * @returns A sorted copy
 */
function sorted(values: string[]): string[] {
  return [...values].sort();
}

/**
 * Put a zone file's group in canonical form.
 * @param group - A validated group from a zone file
 * @returns The canonical group
 */
export function canonicalFileGroup(group: Group): CanonicalGroup {
  return {
    name: group.name,
    type: group.type,
    ttl: group.ttl,
    records: sorted(group.records.map((value) => canonicalValue(group.type, value, 'file'))),
  };
}

/**
 * Put a live group in canonical form.
 * @param group - A group as the provider reported it
 * @returns The canonical group
 */
export function canonicalLiveGroup(group: LiveGroup): CanonicalGroup {
  return {
    name: group.name.toLowerCase(),
    type: group.type,
    ttl: group.ttl ?? 'default',
    records: sorted(group.records.map((value) => canonicalValue(group.type, value, 'live'))),
  };
}

/**
 * Tell whether two canonical record lists hold the same values.
 * @param a - Sorted canonical values
 * @param b - Sorted canonical values
 * @returns True when they're the same set
 */
export function sameRecords(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
