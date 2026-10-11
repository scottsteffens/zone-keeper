import { parseArgs } from 'node:util';

import type { Context } from './commands/context.js';
import { runExport } from './commands/export.js';
import { runPlan } from './commands/plan.js';
import { CliError, EXIT } from './errors.js';

const USAGE = `Usage, from a repository's dns/ folder:
  npx --no zone-keeper export <zone> --project <name>   bring a live zone into <zone>.ts (read-only token)
  npx --no zone-keeper plan <zone>                      show what apply would change (read-only token)
  npx --no zone-keeper --version`;

/**
 * Run one command line and return the exit code. Errors meant for the operator are printed as is; anything
 * else is printed as a bug, without a stack trace.
 * @param argv - The arguments after the program name
 * @param context - The outside world
 * @returns The exit code
 */
export async function main(argv: string[], context: Context): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: { project: { type: 'string' }, version: { type: 'boolean' }, help: { type: 'boolean' } },
    });
    if (values.version) {
      context.print(context.version);
      return EXIT.ok;
    }
    const [command, zone, ...extra] = positionals;
    if (values.help) {
      context.print(USAGE);
      return EXIT.ok;
    }
    if (command === undefined) throw new CliError(USAGE, EXIT.refused);
    if (zone === undefined || extra.length > 0) throw new CliError(USAGE, EXIT.refused);
    if (command === 'export') return await runExport({ zone, project: values.project }, context);
    if (values.project !== undefined) throw new CliError('--project is only for export; plan reads the project from the zone file.', EXIT.refused);
    if (command === 'plan') return await runPlan({ zone }, context);
    throw new CliError(`Unknown command ${JSON.stringify(command)}.\n${USAGE}`, EXIT.refused);
  } catch (error) {
    if (error instanceof CliError) {
      context.printError(error.message);
      return error.exitCode;
    }
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      context.printError(`${error.message}\n${USAGE}`);
      return EXIT.refused;
    }
    context.printError(`zone-keeper hit an unexpected error, which is a bug: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.internal;
  }
}
