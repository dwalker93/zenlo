import { useState } from 'react'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { authClient } from '../lib/auth-client'
import { getAdminSession } from '../lib/session.functions'

// Staff without a second factor can sign in only to get here; the admin API refuses them until they finish.
export const Route = createFileRoute('/enroll')({
  beforeLoad: async () => {
    const s = await getAdminSession()
    if (!s) throw redirect({ to: '/login' })
    if (s.mfaVerified) throw redirect({ to: '/dashboard' })
  },
  component: Enroll,
})

function Enroll() {
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [setup, setSetup] = useState<{ uri: string; secret: string; backupCodes: string[] } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function start(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { data, error } = await authClient.twoFactor.enable({ password })
    setBusy(false)
    if (error || !data || data.method !== 'totp') return setError('Could not start setup. Check your password.')
    setSetup({ uri: data.totpURI, secret: new URL(data.totpURI).searchParams.get('secret') ?? '', backupCodes: data.backupCodes })
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = await authClient.twoFactor.verifyTotp({ code })
    setBusy(false)
    if (error) return setError(error.status === 429 ? 'Too many attempts. Wait a few minutes and try again.' : 'That code was not accepted.')
    window.location.assign('/') // other sessions of this account were just revoked; this one continues
  }

  return (
    <main>
      <h1>Set up two-factor sign-in</h1>
      {!setup ? (
        <form onSubmit={start}>
          <p className="muted">Staff accounts need an authenticator app. Confirm your password to begin.</p>
          <label>
            Password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && <p className="err">{error}</p>}
          <button disabled={busy}>Continue</button>
        </form>
      ) : (
        <form onSubmit={confirm}>
          <p className="muted">Add this key to your authenticator app (enter it manually, or open the link on your phone):</p>
          <code>{setup.secret}</code>
          <a href={setup.uri}>Open in authenticator app</a>
          <p className="muted">Backup codes, shown once. Store them somewhere safe:</p>
          <code>{setup.backupCodes.join('  ')}</code>
          <label>
            Then enter the 6-digit code it shows
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
          </label>
          {error && <p className="err">{error}</p>}
          <button disabled={busy}>Finish setup</button>
        </form>
      )}
    </main>
  )
}
