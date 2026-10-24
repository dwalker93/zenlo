import { createFileRoute } from '@tanstack/react-router'
import { getAdminAuth } from '../../../lib/auth.server'

// Better Auth owns everything under /api/auth: sign-in, sign-out, two-factor enable and verify.
export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => getAdminAuth().handler(request),
      POST: ({ request }: { request: Request }) => getAdminAuth().handler(request),
    },
  },
})
