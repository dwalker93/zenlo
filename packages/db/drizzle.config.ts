import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    // Use Neon's DIRECT (non-pooled) connection string for migrations
    url: process.env.DATABASE_URL_DIRECT!,
  },
})
