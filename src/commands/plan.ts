import { diffZone, type GroupDiff, type GroupState, type Warning, type ZoneDiff } from '../diff.js';
import { EXIT } from '../errors.js';
import { HetznerClient } from '../hetzner.js';
import { loadZoneFile } from '../load.js';
import { describeSerials, summarizeSerials, type SerialReading } from '../serial.js';
import { printable } from '../text.js';
import type { Context } from './context.js';

/**
 * Show one value the way an operator reads it: TXT as a quoted string, everything else as is.
 * @param type - The record type
 * @param value - A canonical value
 * @returns The value for display
 */
function showValue(type: string, value: string): string {
  return type === 'TXT' ? JSON.stringify(value) : printable(value);
}

/**
 * Show a TTL.
 * @param ttl - Seconds, or `default`
 * @returns The TTL for display
 */
function showTtl(ttl: GroupState['ttl']): string {
  return String(ttl);
}

/**
 * Describe one warning in a line.
 * @param warning - A wildcard warning
 * @returns The line, starting with `!`
 */
function wildcardLine(warning: Extract<Warning, { kind: 'wildcard' }>): string {
  const types = printable(warning.types.join(', '));
  const shadowed = printable(warning.shadowed);
  const creates = warning.shadowed === warning.name ? '' : ` creates "${shadowed}", which`;
  return `  ! Adding "${printable(warning.name)}"${creates} stops the wildcard "${printable(warning.wildcard)}" (${types}) answering for "${shadowed}" and every name under it`;
}

/**
 * Lay out a diff as `plan` prints it: changes and additions, then removals under their own heading, then warnings.
 * @param diff - The diff between the zone file and the live zone
 * @returns The lines to print
 */
export function formatDiff(diff: ZoneDiff): string[] {
  const rows = [...diff.changes, ...diff.additions, ...diff.removals];
  const nameWidth = Math.max(0, ...rows.map((row) => printable(row.name).length));
  const typeWidth = Math.max(0, ...rows.map((row) => printable(row.type).length));

  /**
   * Lay out one group's line, with its values below it.
   * @param mark - `~`, `+` or `-`
   * @param label - What happens to the group
   * @param row - The group's difference
   * @returns The lines
   */
  const groupLines = (mark: string, label: string, row: GroupDiff): string[] => {
    const before = row.before;
    const after = row.after;
    const head = `  ${mark} ${label.padEnd(8)} ${printable(row.name).padEnd(nameWidth)} ${printable(row.type).padEnd(typeWidth)}`;
    if (before && after) {
      const ttl = before.ttl === after.ttl ? showTtl(after.ttl) : `${showTtl(before.ttl)} → ${showTtl(after.ttl)}`;
      const removed = before.records.filter((value) => !after.records.includes(value));
      const added = after.records.filter((value) => !before.records.includes(value));
      return [
        `${head} ${ttl}`,
        ...removed.map((value) => `      - ${showValue(row.type, value)}`),
        ...added.map((value) => `      + ${showValue(row.type, value)}`),
      ];
    }
    const state = (after ?? before) as GroupState;
    if (state.records.length === 1) return [`${head} ${showTtl(state.ttl)}  ${showValue(row.type, state.records[0] ?? '')}`];
    return [`${head} ${showTtl(state.ttl)}`, ...state.records.map((value) => `      ${mark} ${showValue(row.type, value)}`)];
  };

  const lines: string[] = [];
  if (diff.defaultTtl) lines.push(`  ~ default TTL ${diff.defaultTtl.before} → ${diff.defaultTtl.after}`);
  for (const row of diff.changes) {
    const recordsChanged = row.before?.records.join('\n') !== row.after?.records.join('\n');
    lines.push(...groupLines('~', recordsChanged ? 'change' : 'ttl', row));
  }
  for (const row of diff.additions) lines.push(...groupLines('+', 'add', row));
  if (diff.removals.length > 0) {
    lines.push('', '  In Hetzner but not in your file (apply will DELETE these):');
    for (const row of diff.removals) lines.push(...groupLines('-', 'remove', row));
  }

  const mail = [...new Set(diff.warnings.filter((w) => w.kind === 'mail').map((w) => printable(`${w.name} ${w.type}`)))];
  const wildcards = diff.warnings.filter((w): w is Extract<Warning, { kind: 'wildcard' }> => w.kind === 'wildcard');
  if (mail.length > 0 || wildcards.length > 0 || diff.removals.length > 0) lines.push('');
  if (mail.length > 0) lines.push(`  ! Mail records change: ${mail.join(', ')}`);
  if (diff.removals.length === 1) lines.push("  ! A removal: check it wasn't added on purpose outside the file");
  if (diff.removals.length > 1) lines.push(`  ! ${diff.removals.length} removals: check they weren't added on purpose outside the file`);
  lines.push(...wildcards.map(wildcardLine));
  if (diff.unmanaged.length > 0) lines.push('', `  Not compared (unmanaged): ${printable(diff.unmanaged.join(', '))}`);
  return lines;
}

/**
 * Describe the file's serial against the live one.
 * @param fileSerial - The serial recorded in the zone file
 * @param readings - What each nameserver serves
 * @returns The lines to print
 */
export function serialLines(fileSerial: number, readings: readonly SerialReading[]): string[] {
  const summary = summarizeSerials(readings);
  if (summary.kind === 'unreachable') {
    return [`Serial: file ${fileSerial}; the live serial couldn't be read (${describeSerials(readings)}). The diff below is still complete.`];
  }
  if (summary.kind === 'disagree') {
    return [`Serial: file ${fileSerial}; the nameservers disagree (${describeSerials(readings)}), so a change is still publishing.`];
  }
  if (summary.serial === fileSerial) return [`Serial: file ${fileSerial}, live ${summary.serial} (in step)`];
  if (summary.serial > fileSerial) {
    return [
      `Serial: file ${fileSerial}, live ${summary.serial}: the zone changed since this file was last applied.`,
      '  Another branch may have been applied but not merged, this branch may be behind main,',
      '  or the console was used. The diff below shows every difference.',
    ];
  }
  return [`Serial: file ${fileSerial}, live ${summary.serial}: the file is ahead of what the nameservers serve. Is this branch's serial from an apply that didn't finish publishing?`];
}

/**
 * Show what `apply` would change, with a read-only token. Writes nothing.
 * @param args - The zone
 * @param context - The outside world
 * @returns The exit code
 */
export async function runPlan(args: { zone: string }, context: Context): Promise<number> {
  const loaded = await loadZoneFile(context.cwd, args.zone, { requireCommitted: false });
  const { zone, git } = loaded;
  const fileState = !git.tracked ? ' (file not committed yet)' : git.matchesCommit ? '' : ' (file has uncommitted changes)';
  context.print(
    `zone-keeper ${context.version} · zone ${zone.zone} · Hetzner project ${JSON.stringify(zone.project)} · branch ${git.branch} @ ${git.commit}${fileState}`,
  );

  const token = await context.promptToken(`Token for Hetzner project ${JSON.stringify(zone.project)} (read-only is enough): `);
  const snapshot = await new HetznerClient(token, context.fetch).readZone(zone.zone, zone.project);
  for (const line of serialLines(zone.serial, await context.readSerials(zone.zone, snapshot.zone.nameservers))) context.print(line);
  if (snapshot.zone.status !== 'ok') {
    context.print(`Hetzner reports the zone as "${printable(snapshot.zone.status)}": a change is still being published.`);
  }

  const diff = diffZone(zone, snapshot.live);
  context.print('');
  if (diff.empty) {
    context.print(`No changes: Hetzner matches ${zone.zone}.ts (${zone.groups.length} groups).`);
    for (const line of formatDiff(diff)) context.print(line);
    return EXIT.ok;
  }

  for (const line of formatDiff(diff)) context.print(line);
  const changes = diff.additions.length + diff.changes.length + (diff.defaultTtl ? 1 : 0);
  const removals = diff.removals.length;
  context.print('');
  context.print(
    `${changes} ${changes === 1 ? 'change' : 'changes'}, ${removals} ${removals === 1 ? 'removal' : 'removals'}. Nothing was changed. Run "apply ${zone.zone}" to make these changes.`,
  );
  return EXIT.ok;
}
