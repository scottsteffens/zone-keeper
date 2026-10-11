import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { EXIT } from '../src/errors.js';
import { main } from '../src/main.js';
import { fakeContext, fakeHetzner, providerGroups, rr, tempRepo } from './helpers.js';

vi.mock('../src/diff.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/diff.js')>();
  return { ...original, diffZone: (...args: Parameters<typeof original.diffZone>) => ({ ...original.diffZone(...args), empty: false }) };
});

describe('export self-check', () => {
  it('exits 5 and writes nothing when the file it built would not match the live zone', async () => {
    const repo = tempRepo();
    const groups = [...providerGroups(), rr('@', 'A', null, ['192.0.2.1'])];
    const { context, err } = fakeContext({ cwd: repo, fetch: fakeHetzner({ zone: 'example.com', groups }) });
    expect(await main(['export', 'example.com', '--project', 'example'], context)).toBe(EXIT.internal);
    expect(err[0]).toContain('this is a bug in zone-keeper');
    expect(existsSync(join(repo, 'example.com.ts'))).toBe(false);
  });
});
