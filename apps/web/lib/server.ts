import {
  createWebApp,
  loadMachineConfig,
  loadPublicConfig,
} from "@workspace/api"
import { createPublicAuth, publicAuthenticate } from "@workspace/auth"
import { db } from "@workspace/db/client"

let auth: ReturnType<typeof createPublicAuth> | undefined
let api: ReturnType<typeof createWebApp> | undefined

export const getAuth = () =>
  (auth ??= createPublicAuth({
    db,
    secret: process.env.PUBLIC_AUTH_SECRET!,
    baseURL: process.env.PUBLIC_BASE_URL!,
  }))

export const getApi = () =>
  (api ??= createWebApp({
    db,
    authenticate: publicAuthenticate(getAuth(), db),
    publicConfig: loadPublicConfig(),
    machineConfig: loadMachineConfig(),
  }))
