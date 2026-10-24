import { createAuthClient } from 'better-auth/react'
import { twoFactorClient } from 'better-auth/client/plugins'

// Same origin as the app, so no baseURL: requests go to /api/auth/* (the route in src/routes/api/auth/$.ts).
export const authClient = createAuthClient({ plugins: [twoFactorClient()] })
