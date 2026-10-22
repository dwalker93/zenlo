import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dir, '../..');
const read = (f: string) => readFileSync(resolve(root, f), 'utf8');

// Server-only packages must not break standalone server targets (the TanStack Start admin app, scripts, tests),
// yet must never reach a browser bundle. The guard therefore lives behind the "browser" export condition.
const guarded = [
  { pkg: 'db', subpath: './client', entry: 'src/client.ts', specifier: '@workspace/db/client' },
  { pkg: 'domain', subpath: '.', entry: 'src/index.ts', specifier: '@workspace/domain' },
  { pkg: 'api', subpath: '.', entry: 'src/index.ts', specifier: '@workspace/api' },
  { pkg: 'auth', subpath: '.', entry: 'src/index.ts', specifier: '@workspace/auth' },
];

describe('server-only boundary', () => {
  test('the real server-only package throws when resolved without the react-server condition', () => {
    const r = spawnSync('bun', ['-e', "import 'server-only'"], { cwd: resolve(import.meta.dir, '..') });
    expect(r.status).not.toBe(0);
    expect(r.stderr.toString()).toContain('Client Component');
  });

  test('server entry points do NOT import server-only (it would throw in Vite/Node server builds)', () => {
    for (const g of guarded) expect(read(`${g.pkg}/${g.entry}`)).not.toMatch(/server-only/);
  });

  test('each guarded package maps the browser condition to a file that imports server-only', () => {
    for (const g of guarded) {
      const exp = JSON.parse(read(`${g.pkg}/package.json`)).exports[g.subpath];
      expect(Object.keys(exp)).toEqual(['browser', 'default']); // browser first, default last
      expect(exp.default).toBe(`./${g.entry}`);
      expect(exp.browser).toBe('./src/browser-blocked.ts');
      expect(read(`${g.pkg}/src/browser-blocked.ts`)).toMatch(/^import\s+['"]server-only['"]/m);
    }
  });

  test('a browser bundle resolves the blocked file; a server bundle resolves the real code', () => {
    let checked = 0;
    for (const g of guarded) {
      // bundle from any package that can resolve the specifier (root node_modules in a full install, else a dependent's links)
      const name = g.specifier.split('/')[1];
      const from = ['.', 'domain', 'api', 'auth', 'db'].find((d) => existsSync(resolve(root, d, 'node_modules/@workspace', name)));
      if (!from) continue;
      const dir = mkdtempSync(join(root, from === '.' ? 'domain' : from, 'test', '.bundle-'));
      try {
        const entry = join(dir, 'entry.ts');
        writeFileSync(entry, `import * as m from '${g.specifier}'; console.log(m);\n`);
        const browser = spawnSync('bun', ['build', entry, '--target=browser'], { cwd: dir });
        expect(browser.status).toBe(0);
        expect(browser.stdout.toString()).toContain('Client Component'); // server-only's throw is bundled in
        const server = spawnSync('bun', ['build', entry, '--target=bun'], { cwd: dir });
        expect(server.status).toBe(0); // an empty stdout from a failed build must not pass
        expect(server.stdout.toString()).not.toContain('Client Component');
        checked++;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  test('the browser-safe db entry points never import the client or server-only', () => {
    for (const f of ['db/src/index.ts', 'db/src/money.ts']) {
      expect(read(f)).not.toMatch(/from '\.\/client'|server-only/);
    }
  });

  test('the blocked files exist', () => {
    for (const g of guarded) expect(existsSync(resolve(root, g.pkg, 'src/browser-blocked.ts'))).toBe(true);
  });
});
