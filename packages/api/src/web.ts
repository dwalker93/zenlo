import { Hono } from 'hono';
import type { Db } from '@workspace/domain';
import type { Authenticate, Env } from './auth';
import type { MachineConfigSource, PublicConfig } from './config';
import type { CourierAdapter } from './courier';
import { onError } from './http';
import { createMachineApp } from './machine';
import { createPublicApp } from './public';

export interface WebAppDeps {
  db: Db;
  authenticate: Authenticate;
  publicConfig: PublicConfig;
  /** Pass `loadMachineConfig` itself (lazy): missing machine secrets then only break machine routes. */
  machineConfig: MachineConfigSource;
  courier?: CourierAdapter;
  /** Where the Next.js catch-all route lives. Default '/api'. */
  basePath?: string;
}

/**
 * Everything the public Next.js project serves under /api: customer + seller routes (cookie sessions, CSRF-guarded)
 * and the machine routes (PayHere and courier webhooks, cron). The admin app is NOT here: it is its own project.
 * Machine routes are mounted first so the public app's origin guard never sits in front of a webhook.
 */
export function createWebApp(d: WebAppDeps) {
  const app = new Hono<Env>().basePath(d.basePath ?? '/api');
  app.onError(onError);
  app.route('/', createMachineApp({ db: d.db, config: d.machineConfig, courier: d.courier }));
  app.route('/', createPublicApp({ db: d.db, authenticate: d.authenticate, config: d.publicConfig }));
  return app;
}
