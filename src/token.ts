import { closeSync, openSync } from 'node:fs';
import { ReadStream, WriteStream } from 'node:tty';

import { CliError, EXIT } from './errors.js';

/** What the prompt reads keys from and writes to: the controlling terminal, never standard input. */
export interface Terminal {
  input: NodeJS.ReadableStream & { setRawMode(mode: boolean): unknown };
  output: { write(text: string): unknown };
  /** Release the terminal. */
  close(): void;
}

const NO_TERMINAL =
  'The token prompt needs a terminal. Run this in your own terminal, not through a script, CI or Claude Code.';
const HETZNER_TOKEN = /^[A-Za-z0-9]+$/;

/**
 * Open the controlling terminal directly, so the token never passes through standard input, the environment or argv.
 * @returns The terminal
 * @throws CliError when there's no terminal (exit 3)
 */
export function openTerminal(): Terminal {
  let inputFd: number;
  let outputFd: number;
  try {
    inputFd = openSync('/dev/tty', 'r');
  } catch {
    throw new CliError(NO_TERMINAL, EXIT.refused);
  }
  try {
    outputFd = openSync('/dev/tty', 'w');
  } catch {
    closeSync(inputFd);
    throw new CliError(NO_TERMINAL, EXIT.refused);
  }
  const input = new ReadStream(inputFd);
  const output = new WriteStream(outputFd);
  if (!input.isTTY) {
    input.destroy();
    output.destroy();
    throw new CliError(NO_TERMINAL, EXIT.refused);
  }
  return {
    input,
    output,
    /**
     * Release both ends of the terminal.
     */
    close: () => {
      input.destroy();
      output.destroy();
    },
  };
}

/**
 * Read one line from the terminal with nothing echoed but a dot per character. Raw mode is switched off again
 * on every way out: Enter, Ctrl-C, Ctrl-D, an error, or SIGTERM/SIGHUP while waiting.
 * @param terminal - Where to read and write
 * @param prompt - The prompt to show
 * @returns The line typed, without the newline
 * @throws CliError on Ctrl-C or Ctrl-D (exit 130)
 */
export function readHiddenLine(terminal: Terminal, prompt: string): Promise<string> {
  const { input, output } = terminal;
  return new Promise<string>((resolve, reject) => {
    let value = '';
    /** Where we are in a terminal escape sequence: none, just after ESC, inside CSI (`ESC [`), or after SS3 (`ESC O`). */
    let escape: 'none' | 'start' | 'csi' | 'ss3' = 'none';

    /**
     * Put the terminal back the way it was and stop listening.
     */
    const restore = (): void => {
      input.removeListener('data', onData);
      input.removeListener('error', onError);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGHUP', onSignal);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
    };

    /**
     * Leave on a signal, with the terminal restored.
     * @param signal - The signal received
     */
    const onSignal = (signal: NodeJS.Signals): void => {
      restore();
      process.kill(process.pid, signal);
    };

    /**
     * Fail with the terminal restored.
     * @param error - The stream's error
     */
    const onError = (error: Error): void => {
      restore();
      reject(error);
    };

    /**
     * Cancel when the input ends before Enter, so the prompt never hangs.
     */
    const onEnd = (): void => {
      restore();
      reject(new CliError('Canceled. Nothing was changed.', EXIT.canceled));
    };

    /**
     * Handle the keys in one chunk of input.
     * @param chunk - Raw input
     */
    const onData = (chunk: Buffer | string): void => {
      for (const char of chunk.toString()) {
        if (escape === 'start') {
          escape = char === '[' ? 'csi' : char === 'O' ? 'ss3' : 'none';
          continue;
        }
        if (escape === 'csi') {
          if (char >= '\u0040' && char <= '\u007e') escape = 'none';
          continue;
        }
        if (escape === 'ss3') {
          escape = 'none';
          continue;
        }
        if (char === '\r' || char === '\n') {
          restore();
          resolve(value);
          return;
        }
        if (char === '\u0003' || (char === '\u0004' && value === '')) {
          restore();
          reject(new CliError('Canceled. Nothing was changed.', EXIT.canceled));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value !== '') {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
        } else if (char === '\u0015') {
          output.write('\b \b'.repeat(value.length));
          value = '';
        } else if (char === '\u001b') {
          escape = 'start';
        } else if (char >= ' ' && char !== '\u007f') {
          value += char;
          output.write('•');
        }
      }
    };

    output.write(prompt);
    input.setRawMode(true);
    input.on('data', onData);
    input.on('error', onError);
    input.on('end', onEnd);
    input.on('close', onEnd);
    process.once('SIGTERM', onSignal);
    process.once('SIGHUP', onSignal);
    input.resume();
  });
}

/**
 * Ask for a Hetzner API token on the terminal, hidden. The token is returned and never stored or logged.
 * @param prompt - The prompt, naming the project and whether read-only is enough
 * @param open - Opens the terminal; tests pass a fake
 * @returns The token
 * @throws CliError when there's no terminal, on cancel, or when the input can't be a token
 */
export async function promptToken(prompt: string, open: () => Terminal = openTerminal): Promise<string> {
  const terminal = open();
  try {
    const token = (await readHiddenLine(terminal, prompt)).trim();
    if (token === '') throw new CliError('No token was entered. Nothing was changed.', EXIT.refused);
    if (!HETZNER_TOKEN.test(token)) {
      throw new CliError("That doesn't look like a Hetzner API token (letters and digits only). Nothing was changed.", EXIT.refused);
    }
    return token;
  } finally {
    terminal.close();
  }
}
