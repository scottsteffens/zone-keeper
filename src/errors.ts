/** Exit codes, as documented in the README. */
export const EXIT = {
  ok: 0,
  /** Drift found, a read-back that still differs, or nameservers that disagree on the serial. */
  drift: 1,
  /** Couldn't check: a nameserver was unreachable. */
  unreachable: 2,
  /** Refused or misconfigured; nothing was changed. */
  refused: 3,
  /** Hetzner returned an error, or a job was still running when the wait ran out. */
  hetzner: 4,
  /** An unexpected error: a bug in the tool. */
  internal: 5,
  /** Canceled at the prompt with Ctrl-C. */
  canceled: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error meant for the operator: its message is printed as is, and the process exits with its code. */
export class CliError extends Error {
  readonly exitCode: ExitCode;

  /**
   * @param message - What went wrong and what to do, in plain words
   * @param exitCode - The exit code to leave with
   */
  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}
