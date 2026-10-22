import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: [
    "@workspace/ui",
    "@workspace/db",
    "@workspace/domain",
    "@workspace/auth",
    "@workspace/api",
  ],
}

export default nextConfig
