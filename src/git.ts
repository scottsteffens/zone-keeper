import { execFile } from 'node:child_process';

import { CliError, EXIT } from './errors.js';

/** Where the zone file stands in git. */
export interface RepoState {
  /** The branch name, or `detached`. */
  branch: string;
  /** The current commit, abbreviated. */
  commit: string;
  /** Whether git tracks the file. */
  tracked: boolean;
  /** Whether the file on disk is exactly the current commit's version, whatever git's staging area holds. */
  matchesCommit: boolean;
}

/**
 * Run git with an argument array (no shell) and report its exit code and output.
 * @param cwd - The directory to run in
 * @param args - git's arguments
 * @returns The exit code and standard output
 */
function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout) => {
      if (error && typeof error.code !== 'number') {
        reject(new CliError(`Couldn't run git (${error.message}).`, EXIT.refused));
        return;
      }
      resolve({ code: error ? Number(error.code) : 0, stdout: stdout.trim() });
    });
  });
}

/**
 * Find the branch and commit, and whether a file is tracked and unchanged from the current commit.
 *
 * "Unchanged" compares the bytes on disk with the commit's copy of the file, by hash. It never consults git's
 * staging area, so a commit hook that reformats a file after committing (leaving the staging area stale while the
 * file still matches the commit) is accepted, and an assume-unchanged or skip-worktree flag can't hide an edit.
 * @param cwd - The directory holding the file
 * @param file - The file's name, relative to `cwd`
 * @returns The repository state
 * @throws CliError when `cwd` isn't in a git repository with at least one commit
 */
export async function repoState(cwd: string, file: string): Promise<RepoState> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) throw new CliError(`${cwd} isn't in a git repository. Zone files live in a repository's dns/ folder.`, EXIT.refused);

  const commit = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  if (commit.code !== 0) throw new CliError('This repository has no commits yet.', EXIT.refused);

  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const tracked = (await git(cwd, ['ls-files', '--error-unmatch', '--', file])).code === 0;
  let matchesCommit = false;
  if (tracked) {
    const onDisk = await git(cwd, ['hash-object', '--no-filters', '--', file]);
    const committed = await git(cwd, ['rev-parse', '--verify', '--quiet', `HEAD:./${file}`]);
    matchesCommit = onDisk.code === 0 && committed.code === 0 && onDisk.stdout === committed.stdout;
  }

  return {
    branch: branch.code === 0 && branch.stdout !== 'HEAD' ? branch.stdout : 'detached',
    commit: commit.stdout,
    tracked,
    matchesCommit,
  };
}
