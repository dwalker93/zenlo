import { Hono } from 'hono';
import type { Authenticate, Env } from './auth';
import type { ApiConfig } from './config';
import type { Db } from '@workspace/domain';
import type { CourierAdapter } from './courier';
import { createAdminApp } from './admin';
import { createMachineApp } from './machine';
import { createPublicApp } from './public';

export interface AppDeps {
  db: Db;
  authenticate: Authenticate;
  config: ApiConfig;
  courier?: CourierAdapter;
}

/**
 * Dev/test composition only: mounts all three apps in one process at the paths the real deployment uses
 * (public at /, admin at /admin, machine at /). In production deploy createPublicApp, createAdminApp and
 * createMachineApp as separate projects.
 */
export function createApp(deps: AppDeps) {
  const { db, authenticate, config, courier } = deps;
  const app = new Hono<Env>();
  app.route('/admin', createAdminApp({ db, authenticate, config }));
  app.route('/', createMachineApp({ db, config, courier }));
  app.route('/', createPublicApp({ db, authenticate, config }));
  return app;
}
