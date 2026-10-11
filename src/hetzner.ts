import type { LiveZone } from './diff.js';
import { CliError, EXIT } from './errors.js';
import { canonicalValue, type LiveGroup } from './normalize.js';
import { printable } from './text.js';

const BASE_URL = 'https://api.hetzner.cloud/v1';
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_LENGTH = 300;

/** A zone as Hetzner describes it. */
export interface HetznerZone {
  name: string;
  /** The zone's default TTL. */
  ttl: number;
  /** `ok` once published; `updating` while a change is being published; `error`. */
  status: string;
  /** The nameservers Hetzner assigned to the zone, without trailing dots. */
  nameservers: string[];
}

/** One complete, checked read of a zone. */
export interface ZoneSnapshot {
  zone: HetznerZone;
  live: LiveZone;
  /** The serial in Hetzner's SOA record. */
  soaSerial: number;
  /** How many groups Hetzner said the zone has; equal to `live.groups.length`, or the read was refused. */
  total: number;
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
 * Fail on a response that isn't shaped as Hetzner documents it.
 * @param what - What was being read
 * @returns Never; always throws
 */
function unexpected(what: string): never {
  throw new CliError(`Hetzner's API returned an unexpected ${what}. Nothing was changed.`, EXIT.hetzner);
}

/**
 * Check one record group from the listing and turn it into a provider-neutral live group.
 * @param value - One item of `rrsets`
 * @returns The live group
 */
function toLiveGroup(value: unknown): LiveGroup {
  if (!isObject(value) || typeof value.name !== 'string' || typeof value.type !== 'string') unexpected('record group');
  const ttl = value.ttl;
  if (ttl !== null && typeof ttl !== 'number') unexpected(`TTL for ${value.name} ${value.type}`);
  if (!Array.isArray(value.records)) unexpected(`record list for ${value.name} ${value.type}`);
  const where = `${printable(value.name)} ${printable(value.type)}`;
  const records = value.records.map((record: unknown) => {
    if (!isObject(record) || typeof record.value !== 'string') unexpected(`record in ${where}`);
    try {
      canonicalValue(value.type as string, record.value, 'live');
    } catch {
      unexpected(`value in ${where}`);
    }
    return record.value;
  });
  return { name: value.name, type: value.type, ttl, records };
}

/**
 * Reduce a snapshot to a string that two reads of an unchanged zone always share: the zone's details and every
 * group, in a fixed order.
 * @param snapshot - One read of a zone
 * @returns The comparison key
 */
function snapshotKey(snapshot: ZoneSnapshot): string {
  const groups = snapshot.live.groups
    .map((group) => ({ ...group, records: [...group.records].sort() }))
    .sort((a, b) => `${a.name} ${a.type}`.localeCompare(`${b.name} ${b.type}`));
  return JSON.stringify([snapshot.zone, snapshot.soaSerial, groups]);
}

/** A read-only view of the Hetzner Cloud DNS API for one token. */
export class HetznerClient {
  readonly #token: string;
  readonly #fetch: typeof fetch;

  /**
   * @param token - An API token, as typed at the prompt; never logged
   * @param fetchImpl - The fetch to use; tests pass a mock
   */
  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  /**
   * GET a path and return its JSON body, turning failures into operator messages.
   * @param path - The path under the API's base URL
   * @param project - The Hetzner project the zone file names, for the wrong-project message
   * @param zone - The zone being read, for the not-found message
   * @returns The parsed body
   */
  async #get(path: string, project: string, zone: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CliError(`Couldn't reach Hetzner's API (${reason}). Nothing was changed.`, EXIT.hetzner);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    if (response.ok) {
      if (!isObject(body)) unexpected('response');
      return body;
    }

    if (response.status === 401) {
      throw new CliError(
        `Hetzner refused the token (401). Check that you pasted the whole token for project "${project}".`,
        EXIT.refused,
      );
    }
    if (response.status === 404) {
      throw new CliError(
        `This token can't see ${zone}. It's probably for a different Hetzner project; ${zone}'s file says project "${project}".`,
        EXIT.refused,
      );
    }
    const error = isObject(body) && isObject(body.error) ? body.error : {};
    const code = typeof error.code === 'string' ? error.code : 'unknown';
    const message = typeof error.message === 'string' ? error.message.slice(0, MAX_MESSAGE_LENGTH) : '';
    throw new CliError(
      `Hetzner returned ${response.status} ${printable(code)}${message ? `: ${printable(message)}` : ''}. Nothing was changed.`,
      EXIT.hetzner,
    );
  }

  /**
   * Get a zone's details.
   * @param zone - The zone's name
   * @param project - The Hetzner project the zone file names
   * @returns The zone, with its status and assigned nameservers
   */
  async getZone(zone: string, project: string): Promise<HetznerZone> {
    const body = await this.#get(`/zones/${encodeURIComponent(zone)}`, project, zone);
    const value = body.zone;
    if (!isObject(value) || value.name !== zone || typeof value.ttl !== 'number' || typeof value.status !== 'string') {
      unexpected('zone');
    }
    const authoritative = value.authoritative_nameservers;
    const assigned = isObject(authoritative) ? authoritative.assigned : undefined;
    if (!Array.isArray(assigned) || assigned.length === 0 || !assigned.every((ns) => typeof ns === 'string')) {
      unexpected('list of assigned nameservers');
    }
    return {
      name: value.name,
      ttl: value.ttl,
      status: value.status,
      nameservers: (assigned as string[]).map((ns) => ns.replace(/\.$/, '')),
    };
  }

  /**
   * List every record group in a zone, page by page, and refuse unless the count matches Hetzner's own total.
   * @param zone - The zone's name
   * @param project - The Hetzner project the zone file names
   * @returns Every group, in presentation form, and Hetzner's own count of them
   */
  async listGroups(zone: string, project: string): Promise<{ groups: LiveGroup[]; total: number }> {
    const groups: LiveGroup[] = [];
    let total: number | undefined;
    for (let page = 1; ; page += 1) {
      const body = await this.#get(`/zones/${encodeURIComponent(zone)}/rrsets?page=${page}&per_page=${PAGE_SIZE}`, project, zone);
      if (!Array.isArray(body.rrsets)) unexpected('record listing');
      const pagination = isObject(body.meta) && isObject(body.meta.pagination) ? body.meta.pagination : undefined;
      if (!pagination) unexpected('record listing (no pagination)');

      const pageTotal = pagination.total_entries;
      if (typeof pageTotal !== 'number') {
        throw new CliError(
          `Hetzner didn't say how many record groups ${zone} has, so a complete read can't be confirmed. Nothing was written.`,
          EXIT.refused,
        );
      }
      if (total !== undefined && pageTotal !== total) {
        throw new CliError(`${zone} changed while it was being read (${total} groups, then ${pageTotal}). Run the command again.`, EXIT.refused);
      }
      total = pageTotal;
      groups.push(...body.rrsets.map(toLiveGroup));

      const next = pagination.next_page;
      if (next === null || next === undefined || body.rrsets.length === 0 || page >= Math.ceil(total / PAGE_SIZE) + 1) break;
      if (next !== page + 1) unexpected('page sequence');
    }

    if (total === undefined || groups.length !== total) {
      throw new CliError(`Read ${groups.length} groups but Hetzner reports ${total}. Nothing was written.`, EXIT.refused);
    }
    const seen = new Set<string>();
    for (const group of groups) {
      const key = `${group.name} ${group.type}`;
      if (seen.has(key)) {
        throw new CliError(`${zone} listed ${printable(key)} twice; it may have changed while being read. Run the command again.`, EXIT.refused);
      }
      seen.add(key);
    }
    return { groups, total };
  }

  /**
   * Read a whole zone once: its details, every group, and the serial in its SOA record.
   * @param zone - The zone's name
   * @param project - The Hetzner project the zone file names
   * @returns The snapshot
   */
  async #readOnce(zone: string, project: string): Promise<ZoneSnapshot> {
    const details = await this.getZone(zone, project);
    const { groups, total } = await this.listGroups(zone, project);
    const soa = groups.find((group) => group.type === 'SOA' && group.name === '@');
    const serial = Number(soa?.records[0]?.split(/\s+/)[2]);
    if (!soa || !Number.isInteger(serial)) unexpected('SOA record');
    return { zone: details, live: { defaultTtl: details.ttl, groups }, soaSerial: serial, total };
  }

  /**
   * Read a whole zone twice and refuse unless both reads are identical. A change landing between two page reads
   * can leave the count unchanged while one group is never read and a deleted one is kept; reading twice catches
   * it, because the second read sees the change complete.
   * @param zone - The zone's name
   * @param project - The Hetzner project the zone file names
   * @returns The checked snapshot
   */
  async readZone(zone: string, project: string): Promise<ZoneSnapshot> {
    const first = await this.#readOnce(zone, project);
    const second = await this.#readOnce(zone, project);
    if (snapshotKey(first) !== snapshotKey(second)) {
      throw new CliError(`${zone} changed while it was being read. Run the command again; nothing was written.`, EXIT.refused);
    }
    return second;
  }
}
