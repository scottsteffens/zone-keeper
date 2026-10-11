import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { CliError, EXIT } from '../src/errors.js';
import { promptToken, readHiddenLine, type Terminal } from '../src/token.js';

/**
 * Build a fake terminal that records raw-mode changes and everything written.
 * @returns The terminal, what was written, and the raw-mode history
 */
function fakeTerminal() {
  const input = Object.assign(new PassThrough(), { rawModes: [] as boolean[] }) as PassThrough & {
    rawModes: boolean[];
    setRawMode(mode: boolean): unknown;
  };
  input.setRawMode = (mode: boolean) => input.rawModes.push(mode);
  let written = '';
  const terminal: Terminal = {
    input,
    output: { write: (text: string) => (written += text) },
    close: vi.fn(),
  };
  return { terminal, input, written: () => written };
}

describe('readHiddenLine', () => {
  it('returns what was typed, echoing a dot per character, and leaves raw mode', async () => {
    const { terminal, input, written } = fakeTerminal();
    const line = readHiddenLine(terminal, 'Token: ');
    input.write('abc');
    input.write('def\r');
    await expect(line).resolves.toBe('abcdef');
    expect(written()).toBe('Token: ••••••\n');
    expect(input.rawModes).toEqual([true, false]);
  });

  it('skips whole escape sequences: CSI with parameters, SS3 function keys, and Alt+key', async () => {
    const { terminal, input } = fakeTerminal();
    const line = readHiddenLine(terminal, '');
    input.write('a\u001bOPb\u001bOAc\u001b[1;5Cd\u001bxe\r');
    await expect(line).resolves.toBe('abcde');
  });

  it('cancels when the input ends without Enter, leaving raw mode and removing its listeners', async () => {
    const { terminal, input } = fakeTerminal();
    const line = readHiddenLine(terminal, '');
    input.end('abc');
    const error = (await line.catch((reason: unknown) => reason)) as CliError;
    expect(error.exitCode).toBe(EXIT.canceled);
    expect(input.rawModes).toEqual([true, false]);
    expect(input.listenerCount('data')).toBe(0);
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });

  it('leaves raw mode and re-raises SIGTERM received while waiting', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const { terminal, input } = fakeTerminal();
      void readHiddenLine(terminal, '');
      process.emit('SIGTERM', 'SIGTERM');
      expect(input.rawModes).toEqual([true, false]);
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      expect(input.listenerCount('data')).toBe(0);
      expect(process.listenerCount('SIGHUP')).toBe(0);
    } finally {
      kill.mockRestore();
    }
  });

  it('handles backspace and Ctrl-U, and ignores arrow keys', async () => {
    const { terminal, input } = fakeTerminal();
    const line = readHiddenLine(terminal, '');
    input.write('xy\u007fz\u0015ab\u001b[Dc\n');
    await expect(line).resolves.toBe('abc');
  });

  it('cancels on Ctrl-C with exit 130, leaving raw mode', async () => {
    const { terminal, input } = fakeTerminal();
    const line = readHiddenLine(terminal, '');
    input.write('ab\u0003');
    const error = await line.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(EXIT.canceled);
    expect(input.rawModes).toEqual([true, false]);
  });

  it('cancels on Ctrl-D at an empty prompt', async () => {
    const { terminal, input } = fakeTerminal();
    const line = readHiddenLine(terminal, '');
    input.write('\u0004');
    await expect(line).rejects.toThrow('Canceled');
  });

  it('leaves raw mode when the input fails', async () => {
    const { terminal, input } = fakeTerminal();
    const line = readHiddenLine(terminal, '');
    input.emit('error', new Error('EIO'));
    await expect(line).rejects.toThrow('EIO');
    expect(input.rawModes).toEqual([true, false]);
  });
});

describe('promptToken', () => {
  it('returns the token, trimmed, and closes the terminal', async () => {
    const { terminal, input } = fakeTerminal();
    const token = promptToken('Token: ', () => terminal);
    input.write(' ABCdef123 \r');
    await expect(token).resolves.toBe('ABCdef123');
    expect(terminal.close).toHaveBeenCalledOnce();
  });

  it('refuses an empty token and anything that cannot be a token, without echoing it', async () => {
    for (const typed of ['', 'abc def', 'abcé']) {
      const { terminal, input } = fakeTerminal();
      const token = promptToken('Token: ', () => terminal);
      input.write(`${typed}\r`);
      const error = (await token.catch((reason: unknown) => reason)) as CliError;
      expect(error.exitCode).toBe(EXIT.refused);
      if (typed !== '') expect(error.message).not.toContain(typed);
      expect(terminal.close).toHaveBeenCalledOnce();
    }
  });

  it('passes on the no-terminal refusal from opening the terminal', async () => {
    const refusal = new CliError('The token prompt needs a terminal.', EXIT.refused);
    await expect(
      promptToken('Token: ', () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
  });
});
