import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultNotFoundComponent: () => (
      <main>
        <h1>Page not found</h1>
        <p>
          <a href="/">Back to Zenlo Admin</a>
        </p>
      </main>
    ),
  })
}
