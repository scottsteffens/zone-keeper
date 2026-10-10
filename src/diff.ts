import {
  canonicalFileGroup,
  canonicalLiveGroup,
  sameRecords,
  type CanonicalGroup,
  type LiveGroup,
} from './normalize.js';
import { isWildcard, unmanagedMatcher, type RecordType, type Ttl, type Zone } from './zone.js';

/** A zone as the provider reports it. */
export interface LiveZone {
  defaultTtl: number;
  groups: LiveGroup[];
}

/** One side of a group's difference. */
export interface GroupState {
  ttl: Ttl;
  /** Canonical values, sorted. */
  records: string[];
}

/** One group that differs. An addition has no `before`, a removal no `after`. */
export interface GroupDiff {
  name: string;
  type: string;
  before?: GroupState;
  after?: GroupState;
}

/** Something `plan` must point out before anything is written. */
export type Warning =
  | { kind: 'mail'; name: string; type: string; record: 'DKIM' | 'DMARC' | 'SPF' | 'MX' }
  | {
      kind: 'wildcard';
      /** The added name. */
      name: string;
      /** The name that newly exists: the added name, or its highest ancestor that didn't exist yet. */
      shadowed: string;
      /** The wildcard that answers for `shadowed` today. */
      wildcard: string;
      /** The types that wildcard serves. */
      types: string[];
    };

/** One write, in the order `apply` performs them. Values are as written in the zone file. */
export type Operation =
  | { op: 'setDefaultTtl'; ttl: number }
  | { op: 'create'; name: string; type: RecordType; ttl: Ttl; records: string[] }
  | { op: 'setRecords'; name: string; type: RecordType; records: string[] }
  | { op: 'setTtl'; name: string; type: RecordType; ttl: Ttl }
  | { op: 'delete'; name: string; type: string };

/** Everything that differs between a zone file and the live zone, and the writes that would fix it. */
export interface ZoneDiff {
  defaultTtl: { before: number; after: number } | null;
  additions: GroupDiff[];
  changes: GroupDiff[];
  removals: GroupDiff[];
  /** Live groups skipped because their names are unmanaged, as `name type`. */
  unmanaged: string[];
  warnings: Warning[];
  operations: Operation[];
  /** True when the provider already matches the file. */
  empty: boolean;
}

/**
 * Tell whether a live group belongs to the provider rather than the file: the SOA record and the apex NS records.
 * @param group - A live group
 * @returns True when the tool never touches it
 */
function isProviderGroup(group: CanonicalGroup): boolean {
  return group.type === 'SOA' || (group.type === 'NS' && group.name === '@');
}

/**
 * Name the kind of mail record a group is, if any: DKIM (a `_domainkey` label), DMARC (a `_dmarc` label), SPF or MX.
 * @param name - The group's name
 * @param type - The group's type
 * @param texts - The TXT texts on either side of the change
 * @returns The kind, or null when it isn't a mail record
 */
function mailRecord(name: string, type: string, texts: readonly string[]): 'DKIM' | 'DMARC' | 'SPF' | 'MX' | null {
  if (type === 'MX') return 'MX';
  const labels = name.split('.');
  if (labels.includes('_domainkey')) return 'DKIM';
  if (labels.includes('_dmarc')) return 'DMARC';
  if (type === 'TXT' && texts.some((text) => /^v=spf1(\s|$)/i.test(text.trim()))) return 'SPF';
  return null;
}

/**
 * Split a relative name into labels, the apex being no labels.
 * @param name - A relative name, `@` for the apex
 * @returns Its labels, leftmost first
 */
function labelsOf(name: string): string[] {
  return name === '@' ? [] : name.split('.');
}

/**
 * Join labels back into a relative name.
 * @param labels - Labels, leftmost first
 * @returns The name, `@` for none
 */
function nameOf(labels: readonly string[]): string {
  return labels.length === 0 ? '@' : labels.join('.');
}

/**
 * Find the wildcard an added name would stop answering for it, following RFC 4592.
 *
 * Adding a name makes it exist, along with any of its ancestors that didn't (empty non-terminals). The highest
 * of those, H, was answered until now by the wildcard at its closest encloser, H's parent, if one exists there.
 * Once H exists, that wildcard no longer answers for H or any name under it.
 * @param name - The added name
 * @param existing - Every name that exists in the live zone, ancestors included
 * @param wildcardTypes - The live wildcard names, each with the types it serves
 * @returns The shadowed name and the wildcard, or null when no wildcard is shadowed
 */
function shadowedWildcard(
  name: string,
  existing: ReadonlySet<string>,
  wildcardTypes: ReadonlyMap<string, string[]>,
): { shadowed: string; wildcard: string; types: string[] } | null {
  const labels = labelsOf(name);
  for (let depth = 1; depth <= labels.length; depth += 1) {
    const candidate = nameOf(labels.slice(labels.length - depth));
    if (existing.has(candidate)) continue;
    const encloser = labels.slice(labels.length - depth + 1);
    const wildcard = nameOf(['*', ...encloser]);
    const types = wildcardTypes.get(wildcard);
    return types ? { shadowed: candidate, wildcard, types } : null;
  }
  return null;
}

/**
 * Compare a zone file with the live zone, and work out the writes that make the live zone match it.
 *
 * Writes come in this order: the default TTL, then each file group's changes and additions in file order, then
 * removals. Where a name changes to or from a CNAME, the live groups in the way are deleted immediately before
 * the replacement is created, the only deletes that come early.
 * @param file - A validated zone file
 * @param live - The zone as the provider reports it
 * @returns The differences, warnings and ordered writes
 */
export function diffZone(file: Zone, live: LiveZone): ZoneDiff {
  const isUnmanaged = unmanagedMatcher(file.unmanaged ?? []);
  /**
   * Identify a group by its name and type.
   * @param name - The group's name
   * @param type - The group's type
   * @returns `name type`
   */
  const key = (name: string, type: string): string => `${name} ${type}`;

  const liveGroups = live.groups.map(canonicalLiveGroup);

  const existing = new Set<string>(['@']);
  const wildcardTypes = new Map<string, string[]>();
  for (const group of liveGroups) {
    const labels = labelsOf(group.name);
    for (let depth = 1; depth <= labels.length; depth += 1) existing.add(nameOf(labels.slice(labels.length - depth)));
    if (isWildcard(group.name)) wildcardTypes.set(group.name, [...(wildcardTypes.get(group.name) ?? []), group.type]);
  }

  const unmanaged: string[] = [];
  const managedLive = new Map<string, CanonicalGroup>();
  for (const group of liveGroups) {
    if (isProviderGroup(group)) continue;
    if (isUnmanaged(group.name)) {
      unmanaged.push(key(group.name, group.type));
      continue;
    }
    managedLive.set(key(group.name, group.type), group);
  }

  const additions: GroupDiff[] = [];
  const changes: GroupDiff[] = [];
  const removals: GroupDiff[] = [];
  const warnings: Warning[] = [];
  const operations: Operation[] = [];
  const deleted = new Set<string>();
  const shadowWarnings = new Set<string>();

  const defaultTtl = file.defaultTtl === live.defaultTtl ? null : { before: live.defaultTtl, after: file.defaultTtl };
  if (defaultTtl) operations.push({ op: 'setDefaultTtl', ttl: file.defaultTtl });

  const fileKeys = new Set(file.groups.map((group) => key(group.name, group.type)));

  /**
   * Add a mail warning when the group is a DKIM, DMARC, SPF or MX record.
   * @param name - The group's name
   * @param type - The group's type
   * @param before - The live state, for a change or removal
   * @param after - The file's state, for an addition or change
   */
  const warnMail = (name: string, type: string, before?: GroupState, after?: GroupState): void => {
    const texts = type === 'TXT' ? [...(before?.records ?? []), ...(after?.records ?? [])] : [];
    const record = mailRecord(name, type, texts);
    if (record) warnings.push({ kind: 'mail', name, type, record });
  };

  for (const group of file.groups) {
    const wanted = canonicalFileGroup(group);
    const after: GroupState = { ttl: wanted.ttl, records: wanted.records };
    const current = managedLive.get(key(group.name, group.type));

    if (!current) {
      additions.push({ name: group.name, type: group.type, after });
      warnMail(group.name, group.type, undefined, after);

      if (!existing.has(group.name)) {
        const shadow = shadowedWildcard(group.name, existing, wildcardTypes);
        if (shadow && !shadowWarnings.has(key(shadow.shadowed, shadow.wildcard))) {
          shadowWarnings.add(key(shadow.shadowed, shadow.wildcard));
          warnings.push({ kind: 'wildcard', name: group.name, ...shadow });
        }
      }

      for (const blocking of managedLive.values()) {
        const inTheWay =
          blocking.name === group.name &&
          (blocking.type === 'CNAME') !== (group.type === 'CNAME') &&
          !fileKeys.has(key(blocking.name, blocking.type));
        if (inTheWay && !deleted.has(key(blocking.name, blocking.type))) {
          deleted.add(key(blocking.name, blocking.type));
          operations.push({ op: 'delete', name: blocking.name, type: blocking.type });
        }
      }
      operations.push({ op: 'create', name: group.name, type: group.type, ttl: group.ttl, records: group.records });
      continue;
    }

    const recordsChanged = !sameRecords(current.records, wanted.records);
    const ttlChanged = current.ttl !== wanted.ttl;
    if (!recordsChanged && !ttlChanged) continue;

    const before: GroupState = { ttl: current.ttl, records: current.records };
    changes.push({ name: group.name, type: group.type, before, after });
    warnMail(group.name, group.type, before, after);
    if (recordsChanged) operations.push({ op: 'setRecords', name: group.name, type: group.type, records: group.records });
    if (ttlChanged) operations.push({ op: 'setTtl', name: group.name, type: group.type, ttl: group.ttl });
  }

  for (const [groupKey, group] of managedLive) {
    if (fileKeys.has(groupKey)) continue;
    const before: GroupState = { ttl: group.ttl, records: group.records };
    removals.push({ name: group.name, type: group.type, before });
    warnMail(group.name, group.type, before, undefined);
    if (!deleted.has(groupKey)) operations.push({ op: 'delete', name: group.name, type: group.type });
  }

  return {
    defaultTtl,
    additions,
    changes,
    removals,
    unmanaged,
    warnings,
    operations,
    empty: defaultTtl === null && additions.length === 0 && changes.length === 0 && removals.length === 0,
  };
}
