import { lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { diffZone } from '../diff.js';
import { CliError, EXIT } from '../errors.js';
import { HetznerClient } from '../hetzner.js';
import { checkZoneArgument } from '../load.js';
import { canonicalValue } from '../normalize.js';
import { describeSerials, summarizeSerials } from '../serial.js';
import { validateZone, ZoneFileError, type Group, type Zone } from '../zone.js';
import { printable } from '../text.js';
import type { Context } from './context.js';

const TODO_COMMENT = 'TODO: what is this for?';

/**
 * Write a zone as the text of a zone file. Every value is a JSON string literal, so nothing in a record can
 * become code; the `serial:` line stands alone, so `apply` can rewrite it.
 * @param zone - A validated zone
 * @returns The file's text
 */
export function formatZoneFile(zone: Zone): string {
  /**
   * Write a string as a JSON string literal, which is also a safe JavaScript one.
   * @param value - Any string
   * @returns The literal
   */
  const string = (value: string): string => JSON.stringify(value);
  /**
   * Write one group as an object literal.
   * @param g - The group
   * @returns Its lines
   */
  const group = (g: Group): string =>
    [
      '    {',
      `      name: ${string(g.name)},`,
      `      type: ${string(g.type)},`,
      `      ttl: ${typeof g.ttl === 'number' ? g.ttl : string(g.ttl)},`,
      `      records: [${g.records.map(string).join(', ')}],`,
      `      comment: ${string(g.comment)},`,
      '    },',
    ].join('\n');
  return [
    "import type { Zone } from 'zone-keeper';",
    '',
    'export default {',
    `  zone: ${string(zone.zone)},`,
    `  project: ${string(zone.project)},`,
    `  serial: ${zone.serial},`,
    `  defaultTtl: ${zone.defaultTtl},`,
    '  groups: [',
    ...zone.groups.map(group),
    '  ],',
    '} satisfies Zone;',
    '',
  ].join('\n');
}

/**
 * Bring a live zone into a new zone file, `<zone>.ts`, with a read-only token. Refuses rather than writing a file
 * that could be incomplete or wrong: on a short read, a zone still publishing, nameservers that disagree on the
 * serial, or a file that wouldn't diff as empty against the zone it came from.
 * @param args - The zone and the Hetzner project that holds it
 * @param context - The outside world
 * @returns The exit code
 */
export async function runExport(args: { zone: string; project: string | undefined }, context: Context): Promise<number> {
  const { zone: zoneName, project } = args;
  checkZoneArgument(zoneName);
  if (project === undefined || project.trim() === '') {
    throw new CliError(`Name the Hetzner project: export ${zoneName} --project <name>`, EXIT.refused);
  }
  const fileName = `${zoneName}.ts`;
  const path = join(context.cwd, fileName);
  const exists = await lstat(path).then(
    () => true,
    () => false,
  );
  if (exists) throw new CliError(`${fileName} exists. export only brings a new zone in; use plan to see differences.`, EXIT.refused);

  context.print(`zone-keeper ${context.version} · export ${zoneName} · Hetzner project ${JSON.stringify(project)}`);
  const token = await context.promptToken(`Token for Hetzner project ${JSON.stringify(project)} (read-only is enough): `);
  const snapshot = await new HetznerClient(token, context.fetch).readZone(zoneName, project);

  if (snapshot.zone.status !== 'ok') {
    throw new CliError(`Hetzner reports ${zoneName} as "${printable(snapshot.zone.status)}", not published. Run export again in a minute.`, EXIT.refused);
  }

  const providerGroups = snapshot.live.groups.filter((g) => g.type === 'SOA' || (g.type === 'NS' && g.name === '@'));
  context.print(
    `Read ${snapshot.live.groups.length} groups (Hetzner reports ${snapshot.total}); ${providerGroups.length} are Hetzner's own SOA/NS and stay out of the file.`,
  );

  const readings = await context.readSerials(zoneName, snapshot.zone.nameservers);
  const summary = summarizeSerials(readings);
  if (summary.kind === 'unreachable') {
    throw new CliError(`Couldn't read the serial from every nameserver: ${describeSerials(readings)}. Nothing was written.`, EXIT.unreachable);
  }
  if (summary.kind === 'disagree' || summary.serial !== snapshot.soaSerial) {
    throw new CliError(
      `The nameservers haven't all published Hetzner's serial ${snapshot.soaSerial} yet (${describeSerials(readings)}). Run export again in a minute. Nothing was written.`,
      EXIT.drift,
    );
  }
  context.print(`Serial ${summary.serial} on all ${readings.length} nameservers.`);

  const candidate = {
    zone: zoneName,
    project,
    serial: summary.serial,
    defaultTtl: snapshot.zone.ttl,
    groups: snapshot.live.groups
      .filter((g) => !providerGroups.includes(g))
      .map((g) => ({
        name: g.name.toLowerCase(),
        type: g.type,
        ttl: g.ttl ?? 'default',
        records: g.records.map((value) => canonicalValue(g.type, value, 'live')),
        comment: TODO_COMMENT,
      })),
  };

  let zone: Zone;
  try {
    zone = validateZone(candidate);
  } catch (error) {
    if (error instanceof ZoneFileError) {
      throw new CliError(`${zoneName} holds something a zone file can't express. Nothing was written.\n${error.message}`, EXIT.refused);
    }
    throw error;
  }
  if (!diffZone(zone, snapshot.live).empty) {
    throw new CliError(`The exported file wouldn't match ${zoneName} exactly; this is a bug in zone-keeper. Nothing was written.`, EXIT.internal);
  }

  try {
    await writeFile(path, formatZoneFile(zone), { flag: 'wx' });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(`Couldn't write ${fileName}: ${reason}`, EXIT.refused);
  }

  context.print(`Wrote ${fileName}. Before committing:`);
  context.print(`  - run "plan ${zoneName}"; it must show no changes`);
  context.print('  - compare each DKIM value with the system that holds its private key');
  context.print(`  - replace each "${TODO_COMMENT}" comment`);
  return EXIT.ok;
}
