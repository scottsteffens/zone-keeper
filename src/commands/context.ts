import type { SerialReading } from '../serial.js';

/** What a command needs from the outside world. The CLI passes the real ones; tests pass fakes. */
export interface Context {
  /** The folder holding zone files, normally the repository's dns/. */
  cwd: string;
  /** The package's version, shown in every header. */
  version: string;
  /** Prints one line of output. */
  print(line: string): void;
  /** Prints one line to standard error. */
  printError(line: string): void;
  /** Asks for a token on the terminal, hidden. */
  promptToken(prompt: string): Promise<string>;
  /** The fetch the Hetzner client uses. */
  fetch: typeof fetch;
  /** Reads a zone's SOA serial from each of its nameservers. */
  readSerials(zone: string, nameservers: readonly string[]): Promise<SerialReading[]>;
}
