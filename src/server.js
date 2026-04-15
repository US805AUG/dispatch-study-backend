import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { router } from "./routes.js";
import { query } from "./db.js";

// Prevent any unhandled Promise rejection from crashing the process
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use("/api", router);

// Log any request that didn't match a route so we can see what the iOS app is calling
app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});

// Global Express error handler
app.use((err, req, res, next) => {
  console.error(`[unhandled error] ${req.method} ${req.path}`, err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// Run idempotent migrations on startup
async function runMigrations() {
  await query("ALTER TABLE study_question ADD COLUMN IF NOT EXISTS source_origin text DEFAULT ''");
  console.log("Migrations complete.");
}

app.listen(config.port, async () => {
  console.log(`Backend listening on ${config.port}`);
  await runMigrations().catch((e) => console.error("Migration error:", e.message));
});
