import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dir, '../..');

describe('server-only boundary', () => {
  test('the real server-only package throws when resolved without the react-server condition', () => {
    const r = spawnSync('bun', ['-e', "import 'server-only'"], { cwd: resolve(import.meta.dir, '..') });
    expect(r.status).not.toBe(0);
    expect(r.stderr.toString()).toContain('Client Component');
  });

  test('the domain entry point and the DB client import server-only', () => {
    expect(readFileSync(resolve(root, 'domain/src/index.ts'), 'utf8')).toMatch(/^import\s+['"]server-only['"]/m);
    expect(readFileSync(resolve(root, 'db/src/client.ts'), 'utf8')).toMatch(/^import\s+['"]server-only['"]/m);
  });

  test('the browser-safe db entry points never import the client or server-only', () => {
    for (const f of ['db/src/index.ts', 'db/src/money.ts']) {
      const src = readFileSync(resolve(root, f), 'utf8');
      expect(src).not.toMatch(/from '\.\/client'|server-only/);
    }
  });
});
