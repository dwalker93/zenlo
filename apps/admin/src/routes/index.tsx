import { createFileRoute, redirect } from '@tanstack/react-router'
import { getAdminSession } from '../lib/session.functions'

// Decides where a visitor belongs: signed out -> login, no second factor yet -> enroll, otherwise the dashboard.
export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const s = await getAdminSession()
    if (!s) throw redirect({ to: '/login' })
    throw redirect({ to: s.mfaVerified ? '/dashboard' : '/enroll' })
  },
})
