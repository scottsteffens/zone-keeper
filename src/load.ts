import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CliError, EXIT } from './errors.js';
import { repoState, type RepoState } from './git.js';
import { isZoneName, validateZone, ZoneFileError, type Zone } from './zone.js';

/** A zone file, loaded and checked. */
export interface LoadedZone {
  zone: Zone;
  /** The file's absolute path. */
  path: string;
  git: RepoState;
}

/** The one import a zone file may have; it's erased with the types, so it loads nothing. */
const TYPE_IMPORT = /^import\s+type\s+\{\s*Zone\s*\}\s+from\s+(['"])zone-keeper\1\s*;?[ \t]*$/gm;

/**
 * Find why a zone file's source isn't self-contained data, if it isn't. A zone file is imported as code, so a file
 * that imported another one would bring in something the commit check never looked at. Comments and quoted
 * strings are skipped, so the words "import" or "from" in a value or a comment are fine. Template literals are
 * refused outright, because code can hide inside `${…}`.
 * @param source - The zone file's text
 * @returns The reason, or null when it only holds data
 */
export function importProblem(source: string): string | null {
  const text = source.replace(TYPE_IMPORT, '');
  let code = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      code += ' ';
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 1;
      code += ' ';
    } else if (char === '"' || char === "'") {
      index += 1;
      while (index < text.length && text[index] !== char && text[index] !== '\n') index += text[index] === '\\' ? 2 : 1;
      code += ' "" ';
    } else if (char === '`') {
      return 'uses a template literal (backticks); write values in double quotes';
    } else {
      code += char;
    }
  }
  return /\b(import|require|from)\b/.test(code) ? 'imports from another file; a zone file must hold only its own data' : null;
}

/**
 * Check a zone argument before it's used to build a path.
 * @param zone - The argument as typed
 * @throws CliError unless it's a plain lowercase hostname
 */
export function checkZoneArgument(zone: string): void {
  if (!isZoneName(zone)) throw new CliError(`${JSON.stringify(zone)} isn't a zone name, such as example.com.`, EXIT.refused);
}

/**
 * Load `<zone>.ts` from a folder. Every check that doesn't need to run the file comes before it's imported: the
 * argument is a hostname, the file is a regular file (not a symlink), when asked git tracks it and it's unchanged
 * from the current commit, and its source imports nothing. After import, the contents are validated and the
 * `zone` field must equal the argument.
 * @param cwd - The folder holding zone files, normally the repository's dns/
 * @param zoneName - The zone argument
 * @param options - `requireCommitted` for commands that write
 * @returns The loaded zone and where it stands in git
 * @throws CliError (exit 3) on any failed check
 */
export async function loadZoneFile(cwd: string, zoneName: string, options: { requireCommitted: boolean }): Promise<LoadedZone> {
  checkZoneArgument(zoneName);
  const fileName = `${zoneName}.ts`;
  const path = join(cwd, fileName);

  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw new CliError(`There's no ${fileName} in ${cwd}. Run commands from the repository's dns/ folder.`, EXIT.refused);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new CliError(`${fileName} must be a regular file, not a symlink or anything else.`, EXIT.refused);
  }

  const git = await repoState(cwd, fileName);
  if (options.requireCommitted && !(git.tracked && git.matchesCommit)) {
    throw new CliError(
      `${fileName} ${git.tracked ? "has changes that aren't committed" : "isn't tracked by git"}. Commit it, so what's applied is a commit.`,
      EXIT.refused,
    );
  }

  const problem = importProblem(await readFile(path, 'utf8'));
  if (problem) throw new CliError(`${fileName} ${problem}.`, EXIT.refused);

  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(path).href)) as { default?: unknown };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(`${fileName} couldn't be loaded: ${reason}`, EXIT.refused);
  }

  let zone: Zone;
  try {
    zone = validateZone(module.default);
  } catch (error) {
    if (error instanceof ZoneFileError) throw new CliError(`${fileName}: ${error.message}`, EXIT.refused);
    throw error;
  }

  if (zone.zone !== zoneName) {
    throw new CliError(
      `${fileName} says zone: ${JSON.stringify(zone.zone)}. The file name, its zone and the argument must all match.`,
      EXIT.refused,
    );
  }
  return { zone, path, git };
}
