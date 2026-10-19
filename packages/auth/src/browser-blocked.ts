// Resolved INSTEAD of the real entry point only when a bundler builds for the browser (the "browser" export condition).
// The import below makes Next.js fail the client build with its "server-only" error, and anything else (Vite, webpack)
// throws on load, so server code can never ship to a browser. Node, Bun and server builds never resolve this file.
import 'server-only';
export {};
