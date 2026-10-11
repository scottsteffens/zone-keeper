import { promises as dns } from 'node:dns';

/** What one nameserver said the zone's SOA serial is, or why it couldn't be asked. */
export type SerialReading = { nameserver: string; serial: number } | { nameserver: string; error: string };

/** The DNS lookups serial reading needs; tests pass a fake. */
export interface SerialLookup {
  /** The IPv4 addresses of a host. */
  resolve4(host: string): Promise<string[]>;
  /** The SOA serial of a zone, asked of the nameserver at one IPv4 address. */
  soaSerial(address: string, zone: string): Promise<number>;
}

const QUERY_TIMEOUT_MS = 3_000;
const QUERY_TRIES = 3;

/** Real lookups through node:dns: each SOA query goes straight to the nameserver's IPv4 address. */
export const dnsLookup: SerialLookup = {
  /**
   * @param host - A nameserver's hostname
   * @returns Its IPv4 addresses
   */
  resolve4: (host) => dns.resolve4(host),
  /**
   * @param address - A nameserver's IPv4 address
   * @param zone - The zone's name
   * @returns The SOA serial that nameserver serves
   */
  async soaSerial(address, zone) {
    const resolver = new dns.Resolver({ timeout: QUERY_TIMEOUT_MS, tries: QUERY_TRIES });
    resolver.setServers([address]);
    return (await resolver.resolveSoa(zone)).serial;
  },
};

/**
 * Ask each of a zone's nameservers, over IPv4, for the zone's SOA serial. A nameserver counts as answered when any
 * of its addresses answers.
 * @param zone - The zone's name
 * @param nameservers - The zone's assigned nameservers
 * @param lookup - The lookups to use
 * @returns One reading per nameserver, in the order given
 */
export async function readSerials(zone: string, nameservers: readonly string[], lookup: SerialLookup = dnsLookup): Promise<SerialReading[]> {
  return Promise.all(
    nameservers.map(async (nameserver): Promise<SerialReading> => {
      let addresses: string[];
      try {
        addresses = await lookup.resolve4(nameserver);
      } catch (error) {
        return { nameserver, error: `no IPv4 address (${error instanceof Error ? error.message : String(error)})` };
      }
      const failures: string[] = [];
      for (const address of addresses) {
        try {
          return { nameserver, serial: await lookup.soaSerial(address, zone) };
        } catch (error) {
          failures.push(`${address}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { nameserver, error: `no answer over IPv4 after ${QUERY_TRIES} tries (${failures.join('; ') || 'no addresses'})` };
    }),
  );
}

/**
 * Sum up readings: the one serial they all agree on, or why there isn't one.
 * @param readings - One reading per nameserver
 * @returns `agreed` with the serial, `unreachable` when any nameserver didn't answer, or `disagree`
 */
export function summarizeSerials(
  readings: readonly SerialReading[],
): { kind: 'agreed'; serial: number } | { kind: 'unreachable' } | { kind: 'disagree' } {
  if (readings.some((reading) => 'error' in reading)) return { kind: 'unreachable' };
  const serials = new Set(readings.map((reading) => ('serial' in reading ? reading.serial : -1)));
  const [serial] = serials;
  return serials.size === 1 && serial !== undefined ? { kind: 'agreed', serial } : { kind: 'disagree' };
}

/**
 * Describe readings in one line, such as `hydrogen 2026101001, helium 2026100800`.
 * @param readings - One reading per nameserver
 * @returns The description
 */
export function describeSerials(readings: readonly SerialReading[]): string {
  return readings
    .map((reading) => `${reading.nameserver.split('.')[0]} ${'serial' in reading ? reading.serial : `couldn't be read: ${reading.error}`}`)
    .join(', ');
}
