import type { ReactNode } from 'react'
import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'

const css = `
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f7f5;color:#1c211c}
main{max-width:30rem;margin:4rem auto;padding:0 1rem}
h1{font-size:1.4rem;margin:0 0 1rem}
form{display:grid;gap:.75rem;background:#fff;border:1px solid #dfe3dc;border-radius:.5rem;padding:1.25rem}
label{display:grid;gap:.25rem;font-size:.9rem}
input{font:inherit;padding:.55rem .65rem;border:1px solid #b9c0b4;border-radius:.375rem}
button{font:inherit;padding:.6rem .9rem;border:0;border-radius:.375rem;background:#2f6b3b;color:#fff;cursor:pointer}
button.link{background:none;color:#2f6b3b;padding:0;text-decoration:underline}
button:disabled{opacity:.6;cursor:default}
.err{color:#a3261c;font-size:.9rem}.muted{color:#5a6357;font-size:.9rem}
code{display:block;word-break:break-all;background:#eef1ec;padding:.5rem;border-radius:.375rem;font-size:.85rem}
`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Zenlo Admin' },
    ],
  }),
  component: () => (
    <Document>
      <Outlet />
    </Document>
  ),
})

function Document({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
