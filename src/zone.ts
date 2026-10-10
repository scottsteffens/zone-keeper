import { isIPv4, isIPv6 } from 'node:net';

import { canonicalValue, parseTxt } from './normalize.js';

/** Record types a zone file may hold: Hetzner Cloud DNS's types, minus SOA, which Hetzner manages. */
export const RECORD_TYPES = [
  'A',
  'AAAA',
  'CAA',
  'CNAME',
  'DS',
  'HINFO',
  'HTTPS',
  'MX',
  'NS',
  'PTR',
  'RP',
  'SRV',
  'SVCB',
  'TLSA',
  'TXT',
] as const;

/** One of the record types a zone file may hold. */
export type RecordType = (typeof RECORD_TYPES)[number];

/** A TTL in seconds, or `'default'` for the zone's default TTL. */
export type Ttl = number | 'default';

/** One group: every record of one type at one name. */
export interface Group {
  /** Relative to the zone: `@` for the apex, `www`, `*.rp`, `bigsend._domainkey`. */
  name: string;
  type: RecordType;
  ttl: Ttl;
  /** Values as they'd be published. TXT values are written whole; the tool splits them. Hostnames end with a dot. */
  records: string[];
  /** What the group is for. */
  comment: string;
}

/** A zone file's default export. */
export interface Zone {
  /** The zone's name, such as `example.com`. Must equal the file name. */
  zone: string;
  /** The Hetzner project that holds the zone; named in the token prompt. */
  project: string;
  /** The zone's SOA serial as of the last apply. */
  serial: number;
  /** The zone's default TTL in seconds. */
  defaultTtl: number;
  /** Glob patterns of names written by something else. `*` matches one or more characters, dots included. */
  unmanaged?: string[];
  /** Turns off check's serial comparison, with the reason. */
  checkSerial?: { off: string };
  groups: Group[];
}

/** One thing wrong with a zone file. */
export interface Problem {
  /** Where, such as `groups[3].ttl`. */
  path: string;
  reason: string;
}

/** Thrown when a zone file is malformed. Lists every problem found, not just the first. */
export class ZoneFileError extends Error {
  readonly problems: Problem[];

  /**
   * @param problems - Every problem found in the file
   */
  constructor(problems: Problem[]) {
    super(
      `The zone file is invalid:\n${problems.map((p) => `  ${p.path}: ${p.reason}`).join('\n')}`,
    );
    this.name = 'ZoneFileError';
    this.problems = problems;
  }
}

/** The shortest TTL a zone file may set, in seconds. */
export const MIN_TTL = 60;
/** The longest TTL a zone file may set, in seconds. */
export const MAX_TTL = 2_147_483_647;
const MAX_SERIAL = 4_294_967_295;
const MAX_NAME_LENGTH = 253;

const ZONE_KEYS = new Set(['zone', 'project', 'serial', 'defaultTtl', 'unmanaged', 'checkSerial', 'groups']);
const GROUP_KEYS = new Set(['name', 'type', 'ttl', 'records', 'comment']);

const HOST_LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
const ZONE_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UNMANAGED_PATTERN = /^[a-z0-9_.*-]+$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

/**
 * Tell whether a string is a plain lowercase hostname usable as a zone name: two or more labels, no trailing dot.
 * @param value - The candidate zone name
 * @returns True when it's a valid zone name
 */
export function isZoneName(value: string): boolean {
  if (value.length > MAX_NAME_LENGTH) return false;
  const labels = value.split('.');
  return labels.length >= 2 && labels.every((label) => ZONE_LABEL.test(label));
}

/**
 * Tell whether a group name's first label is `*`, which makes it a wildcard.
 * @param name - A relative group name
 * @returns True for `*`, `*.rp` and the like
 */
export function isWildcard(name: string): boolean {
  return name === '*' || name.startsWith('*.');
}

/**
 * Turn `unmanaged` glob patterns into one matcher. `*` matches one or more characters, dots included.
 * @param patterns - The zone file's `unmanaged` list
 * @returns A function telling whether a relative name is unmanaged
 */
export function unmanagedMatcher(patterns: readonly string[]): (name: string) => boolean {
  const expressions = patterns.map(
    (pattern) =>
      new RegExp(
        `^${pattern
          .split('*')
          .map((part) => part.replace(/[.\\^$+?()[\]{}|-]/g, '\\$&'))
          .join('.+')}$`,
      ),
  );
  return (name) => expressions.some((expression) => expression.test(name));
}

/**
 * Check a relative group name. Returns the reason it's invalid, or null.
 * @param name - The group name
 * @param zone - The zone's name, to catch names written in full
 * @returns The reason, or null when the name is valid
 */
function nameProblem(name: string, zone: string): string | null {
  if (name === '@') return null;
  if (name !== name.toLowerCase()) return 'must be lowercase';
  if (name.endsWith('.')) return 'must be relative to the zone, with no trailing dot';
  if (name === zone || name.endsWith(`.${zone}`)) {
    return `must be relative to the zone: write "${name === zone ? '@' : name.slice(0, -zone.length - 1)}", not "${name}"`;
  }
  if (name.length + 1 + zone.length > MAX_NAME_LENGTH) return `is longer than ${MAX_NAME_LENGTH} characters with the zone added`;
  const labels = name.split('.');
  for (const [index, label] of labels.entries()) {
    if (label === '*') {
      if (index !== 0) return '"*" may only be the first label';
      continue;
    }
    if (!HOST_LABEL.test(label)) return `has an invalid label "${label}"`;
  }
  return null;
}

/**
 * Check an absolute hostname, as used in CNAME, NS, PTR and MX values. Returns the reason it's invalid, or null.
 * @param host - The hostname
 * @returns The reason, or null when the hostname is valid
 */
function hostProblem(host: string): string | null {
  if (!host.endsWith('.')) return `"${host}" must be absolute, ending with a dot`;
  const bare = host.slice(0, -1);
  if (bare.length === 0 || bare.length > MAX_NAME_LENGTH) return `"${host}" isn't a valid hostname`;
  return bare
    .toLowerCase()
    .split('.')
    .every((label) => HOST_LABEL.test(label))
    ? null
    : `"${host}" isn't a valid hostname`;
}

/**
 * Check one record value for its type. Returns the reason it's invalid, or null.
 * @param type - The group's record type
 * @param value - The record value as written in the file
 * @returns The reason, or null when the value is valid
 */
function recordProblem(type: RecordType, value: string): string | null {
  if (CONTROL_CHARACTER.test(value)) return 'contains a control character';
  switch (type) {
    case 'A':
      return isIPv4(value) ? null : `"${value}" isn't an IPv4 address`;
    case 'AAAA':
      return isIPv6(value) && !value.includes('%') ? null : `"${value}" isn't an IPv6 address`;
    case 'CNAME':
    case 'NS':
    case 'PTR':
      return hostProblem(value);
    case 'MX': {
      const match = /^(\d{1,5}) (\S+)$/.exec(value);
      if (!match || Number(match[1]) > 65535) return `"${value}" must be "<priority> <host>.", such as "10 mx.example.com."`;
      return targetProblem(match[2] ?? '');
    }
    case 'SRV': {
      const match = /^(\d{1,5}) (\d{1,5}) (\d{1,5}) (\S+)$/.exec(value);
      if (!match || [match[1], match[2], match[3]].some((field) => Number(field) > 65535)) {
        return `"${value}" must be "<priority> <weight> <port> <target>.", such as "0 5 443 host.example.com."`;
      }
      return targetProblem(match[4] ?? '');
    }
    case 'HTTPS':
    case 'SVCB': {
      const match = /^(\d{1,5}) (\S+)(?: .*)?$/.exec(value);
      if (!match || Number(match[1]) > 65535) return `"${value}" must be "<priority> <target>. [<params>]", such as "1 . alpn=h2"`;
      return targetProblem(match[2] ?? '');
    }
    case 'RP': {
      const match = /^(\S+) (\S+)$/.exec(value);
      if (!match) return `"${value}" must be "<mailbox>. <txt-name>.", such as "admin.example.com. ."`;
      return targetProblem(match[1] ?? '') ?? targetProblem(match[2] ?? '');
    }
    case 'CAA': {
      const match = /^(\d{1,3}) ([a-zA-Z0-9]+) (.+)$/.exec(value);
      if (!match || Number(match[1]) > 255) return `"${value}" must be "<flags> <tag> <value>", such as '0 issue "letsencrypt.org"'`;
      try {
        parseTxt(match[3] ?? '');
      } catch {
        return `"${value}" has a malformed quoted value`;
      }
      return null;
    }
    case 'DS':
    case 'TLSA':
      return /^\d{1,5} \d{1,3} \d{1,3} [0-9a-fA-F ]+$/.test(value)
        ? null
        : `"${value}" must be three numbers and a hexadecimal digest, such as "12345 13 2 abcdef..."`;
    case 'TXT':
      if (!PRINTABLE_ASCII.test(value)) return 'TXT values may only hold printable ASCII characters';
      return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
        ? 'write the TXT value whole, without quotes; the tool adds them'
        : null;
    default:
      return null;
  }
}

/**
 * Check a target that may be a hostname or the root, `.`, as in SRV, HTTPS, SVCB, RP and MX values.
 * @param target - The target field
 * @returns The reason, or null when the target is valid
 */
function targetProblem(target: string): string | null {
  return target === '.' ? null : hostProblem(target);
}

/**
 * Check a TTL. Returns the reason it's invalid, or null.
 * @param ttl - The value given
 * @param allowDefault - Whether `'default'` is accepted
 * @returns The reason, or null when the TTL is valid
 */
function ttlProblem(ttl: unknown, allowDefault: boolean): string | null {
  if (allowDefault && ttl === 'default') return null;
  if (typeof ttl === 'number' && Number.isInteger(ttl) && ttl >= MIN_TTL && ttl <= MAX_TTL) return null;
  return `must be a whole number of seconds from ${MIN_TTL} to ${MAX_TTL}${allowDefault ? ', or "default"' : ''}, got ${JSON.stringify(ttl) ?? 'nothing'}`;
}

/**
 * Tell whether a value is a plain object.
 * @param value - Anything
 * @returns True for a non-null, non-array object
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a zone file's default export. Node strips types without checking them, so every file is checked at run time.
 * @param input - The zone file's default export
 * @returns The same value, typed as a Zone
 * @throws ZoneFileError listing every problem found
 */
export function validateZone(input: unknown): Zone {
  const problems: Problem[] = [];
  /**
   * Record one problem.
   * @param path - Where, such as `groups[3].ttl`
   * @param reason - What's wrong
   */
  const problem = (path: string, reason: string): void => {
    problems.push({ path, reason });
  };

  if (!isObject(input)) {
    throw new ZoneFileError([{ path: 'default export', reason: 'must be an object; is the file missing "export default"?' }]);
  }

  for (const key of Object.keys(input)) {
    if (!ZONE_KEYS.has(key)) problem(key, 'is not a zone field');
  }

  const zone = input.zone;
  const zoneIsValid = typeof zone === 'string' && isZoneName(zone);
  if (!zoneIsValid) problem('zone', 'must be a lowercase domain name with no trailing dot, such as "example.com"');

  if (typeof input.project !== 'string' || input.project.trim() === '' || CONTROL_CHARACTER.test(input.project)) {
    problem('project', 'must name the Hetzner project that holds the zone');
  }

  const serial = input.serial;
  if (typeof serial !== 'number' || !Number.isInteger(serial) || serial < 0 || serial > MAX_SERIAL) {
    problem('serial', `must be a whole number from 0 to ${MAX_SERIAL}`);
  }

  const defaultTtlProblem = ttlProblem(input.defaultTtl, false);
  if (defaultTtlProblem) problem('defaultTtl', defaultTtlProblem);

  let isUnmanaged: (name: string) => boolean = () => false;
  if (input.unmanaged !== undefined) {
    if (!Array.isArray(input.unmanaged)) {
      problem('unmanaged', 'must be a list of name patterns');
    } else {
      const patterns: string[] = [];
      for (const [index, pattern] of input.unmanaged.entries()) {
        if (typeof pattern !== 'string' || !UNMANAGED_PATTERN.test(pattern)) {
          problem(`unmanaged[${index}]`, 'must be a lowercase name pattern, such as "_acme-challenge" or "_acme-challenge.*"');
        } else {
          patterns.push(pattern);
        }
      }
      isUnmanaged = unmanagedMatcher(patterns);
    }
  }

  if (input.checkSerial !== undefined) {
    const checkSerial = input.checkSerial;
    if (
      !isObject(checkSerial) ||
      Object.keys(checkSerial).length !== 1 ||
      typeof checkSerial.off !== 'string' ||
      checkSerial.off.trim() === ''
    ) {
      problem('checkSerial', 'must be { off: "<why the serial comparison is off>" }');
    }
  }

  if (!Array.isArray(input.groups)) {
    problem('groups', 'must be a list of groups');
  } else if (input.groups.length === 0) {
    problem('groups', 'is empty; applying a zone file with no groups would delete every record');
  } else {
    const typesByName = new Map<string, Set<string>>();
    for (const [index, group] of input.groups.entries()) {
      const at = `groups[${index}]`;
      if (!isObject(group)) {
        problem(at, 'must be an object');
        continue;
      }
      for (const key of Object.keys(group)) {
        if (!GROUP_KEYS.has(key)) problem(`${at}.${key}`, 'is not a group field');
      }

      const { name, type, ttl, records, comment } = group;
      const nameIsString = typeof name === 'string';
      if (!nameIsString) {
        problem(`${at}.name`, 'must be a string, such as "@" or "www"');
      } else {
        const reason = nameProblem(name, zoneIsValid ? zone : '');
        if (reason) problem(`${at}.name`, `"${name}" ${reason}`);
        else if (isUnmanaged(name)) problem(`${at}.name`, `"${name}" matches an unmanaged pattern, so the tool would never write it`);
      }

      const typeIsValid = typeof type === 'string' && (RECORD_TYPES as readonly string[]).includes(type);
      if (!typeIsValid) {
        problem(
          `${at}.type`,
          type === 'SOA' ? 'SOA is managed by Hetzner and is left out of the file' : `must be one of ${RECORD_TYPES.join(', ')}`,
        );
      } else if (type === 'NS' && name === '@') {
        problem(`${at}.type`, "the apex NS records are Hetzner's and are left out of the file");
      } else if (type === 'CNAME' && name === '@') {
        problem(`${at}.type`, 'a CNAME cannot sit at the apex "@"');
      }

      const reason = ttlProblem(ttl, true);
      if (reason) problem(`${at}.ttl`, reason);

      if (!Array.isArray(records) || records.length === 0) {
        problem(`${at}.records`, 'must be a non-empty list of values');
      } else {
        const seen = new Set<string>();
        for (const [recordIndex, value] of records.entries()) {
          if (typeof value !== 'string' || value === '') {
            problem(`${at}.records[${recordIndex}]`, 'must be a non-empty string');
            continue;
          }
          if (!typeIsValid) continue;
          const valueReason = recordProblem(type as RecordType, value);
          if (valueReason) {
            problem(`${at}.records[${recordIndex}]`, valueReason);
            continue;
          }
          const key = canonicalValue(type, value, 'file');
          if (seen.has(key)) problem(`${at}.records[${recordIndex}]`, 'repeats an earlier value');
          seen.add(key);
        }
        if (type === 'CNAME' && records.length > 1) problem(`${at}.records`, 'a CNAME can only have one value');
      }

      if (typeof comment !== 'string' || comment.trim() === '') {
        problem(`${at}.comment`, 'must say what the group is for');
      }

      if (nameIsString && typeIsValid) {
        const types = typesByName.get(name) ?? new Set<string>();
        if (types.has(type)) problem(at, `repeats the group ${name} ${type}; put every ${type} value at "${name}" in one group`);
        types.add(type);
        typesByName.set(name, types);
      }
    }

    for (const [name, types] of typesByName) {
      if (types.has('CNAME') && types.size > 1) {
        problem('groups', `"${name}" has a CNAME beside ${[...types].filter((t) => t !== 'CNAME').join(', ')}; a CNAME must be alone at its name`);
      }
    }
  }

  if (problems.length > 0) throw new ZoneFileError(problems);
  return input as unknown as Zone;
}
