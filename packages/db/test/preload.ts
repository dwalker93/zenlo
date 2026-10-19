import { mock } from 'bun:test';
// 'server-only' deliberately throws outside the react-server condition (that is how Next.js blocks client
// bundles). Under `bun test` there is no bundler, so neutralise it here; test/server-only.test.ts proves
// the real package still throws.
mock.module('server-only', () => ({}));
