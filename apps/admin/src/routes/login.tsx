import { useState } from "react"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { authClient } from "../lib/auth-client"
import { getAdminSession } from "../lib/session.functions"

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    const s = await getAdminSession()
    if (s) throw redirect({ to: s.mfaVerified ? "/dashboard" : "/enroll" })
  },
  component: Login,
})

function Login() {
  const [stage, setStage] = useState<"password" | "code">("password")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError("")
    try {
      if (stage === "password") {
        const { data, error } = await authClient.signIn.email({
          email,
          password,
        })
        if (error)
          return setError(
            error.status === 429
              ? "Too many attempts. Wait a few minutes and try again."
              : "Sign-in failed. Check your email and password."
          )
        if (data && "twoFactorRedirect" in data && data.twoFactorRedirect)
          return setStage("code")
      } else {
        const { error } = await authClient.twoFactor.verifyTotp({ code })
        if (error)
          return setError(
            error.status === 429
              ? "Too many attempts. Wait a few minutes and try again."
              : "That code was not accepted."
          )
      }
      window.location.assign("/") // full load: the server decides where this person goes next
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <h1>Zenlo Admin</h1>
      <form onSubmit={submit}>
        {stage === "password" ? (
          <>
            <label>
              Email
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
          </>
        ) : (
          <label>
            6-digit code from your authenticator app
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </label>
        )}
        {error && <p className="err">{error}</p>}
        <button disabled={busy}>
          {stage === "password" ? "Sign in" : "Verify"}
        </button>
      </form>
    </main>
  )
}
