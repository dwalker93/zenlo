import { createFileRoute, redirect } from '@tanstack/react-router'
import { authClient } from '../lib/auth-client'
import { getAdminSession } from '../lib/session.functions'

// The one protected route. The API still enforces roles and MFA on its own; this gate is for navigation only.
export const Route = createFileRoute('/dashboard')({
  beforeLoad: async () => {
    const s = await getAdminSession()
    if (!s) throw redirect({ to: '/login' })
    if (!s.mfaVerified) throw redirect({ to: '/enroll' })
    return { session: s }
  },
  component: Dashboard,
})

function Dashboard() {
  const { session } = Route.useRouteContext()
  return (
    <main>
      <h1>Zenlo Admin</h1>
      <p>
        Signed in as <strong>{session.user.name}</strong> ({session.user.email})
      </p>
      <p className="muted">Roles: {session.roles.join(', ')} · two-factor verified</p>
      <button
        onClick={async () => {
          await authClient.signOut()
          window.location.assign('/login')
        }}
      >
        Sign out
      </button>
    </main>
  )
}
