import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { getAdminAuth, getAdminPrincipal } from './auth.server'

export type AdminSession = {
  user: { id: string; name: string; email: string }
  roles: string[]
  mfaVerified: boolean
}

/** The signed-in staff member, or null. Staff with no second factor enrolled come back with mfaVerified=false. */
export const getAdminSession = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AdminSession | null> => {
    const req = getRequest()
    const principal = await getAdminPrincipal(req)
    if (!principal || principal.roles.length === 0) return null
    const s = await getAdminAuth().api.getSession({ headers: req.headers })
    if (!s) return null
    return {
      user: { id: s.user.id, name: s.user.name, email: s.user.email },
      roles: [...principal.roles],
      mfaVerified: principal.mfaVerified === true,
    }
  }
)
