import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { router } from "./routes.js";
import { query } from "./db.js";
import { deploymentInfo } from "./deploymentInfo.js";

// Prevent any unhandled Promise rejection from crashing the process
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

const app = express();

app.use(cors());
app.use((req, res, next) => {
  if (req.method === "POST" && req.path === "/api/submissions/new-card") {
    console.log("[new-card] request received before body parsing", {
      commitSha: deploymentInfo.commitSha,
      deploymentTimestamp: deploymentInfo.deploymentTimestamp,
      environment: deploymentInfo.environment,
      contentType: req.headers["content-type"] ?? null,
      contentLength: req.headers["content-length"] ?? null,
      hasAuthorization: Boolean(req.headers.authorization),
    });
  }
  next();
});
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
    if (err instanceof SyntaxError && "body" in err) {
      return res.status(400).json({ error: "Malformed JSON request body" });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// Run idempotent migrations on startup
async function runMigrations() {
  await query("ALTER TABLE study_question ADD COLUMN IF NOT EXISTS source_origin text DEFAULT ''");
  await query("ALTER TABLE study_submission ADD COLUMN IF NOT EXISTS proposed_cloze_variants_json jsonb");
  await query("ALTER TABLE study_submission DROP CONSTRAINT IF EXISTS study_submission_question_id_fkey");
  await query("ALTER TABLE study_submission ALTER COLUMN question_id DROP NOT NULL");
  await query("ALTER TABLE study_submission ADD COLUMN IF NOT EXISTS stable_id text");
  await query("ALTER TABLE study_submission ADD COLUMN IF NOT EXISTS content_pack_id text");
  await query("ALTER TABLE study_submission ADD COLUMN IF NOT EXISTS topic text");
  await query("ALTER TABLE study_submission ADD COLUMN IF NOT EXISTS tags text[]");
  await query("ALTER TABLE study_submission ADD COLUMN IF NOT EXISTS prompt_text text");
  await query("ALTER TABLE study_submission ADD COLUMN IF NOT EXISTS answer_text text");
  await query("ALTER TABLE study_submission ADD COLUMN IF NOT EXISTS truth_statement_text text");
  await query("ALTER TABLE study_submission ADD COLUMN IF NOT EXISTS authored_text text");
  await query("ALTER TABLE study_submission ADD COLUMN IF NOT EXISTS cloze_variants_json jsonb");
  await query("ALTER TABLE study_submission ADD COLUMN IF NOT EXISTS content_hash text");
  await query("ALTER TABLE study_submission ADD COLUMN IF NOT EXISTS canonical_stable_id text");
  await query("ALTER TABLE study_submission ADD COLUMN IF NOT EXISTS based_on_question_id text");
  await query("ALTER TABLE study_question ADD COLUMN IF NOT EXISTS created_by_user_id uuid references app_user(id)");
  await query("ALTER TABLE study_question ADD COLUMN IF NOT EXISTS canonical_stable_id text");
  await query("ALTER TABLE study_question ADD COLUMN IF NOT EXISTS based_on_question_id text");
  await query("ALTER TABLE study_question ADD COLUMN IF NOT EXISTS moderation_status text");
  await query("ALTER TABLE study_question ADD COLUMN IF NOT EXISTS content_hash text");
  await query("ALTER TABLE study_question ADD COLUMN IF NOT EXISTS is_local_only boolean DEFAULT false");
  await query("ALTER TABLE study_question ADD COLUMN IF NOT EXISTS is_community_question boolean DEFAULT true");
  await query("ALTER TABLE study_question ADD COLUMN IF NOT EXISTS submitted_to_community_at timestamptz");
  await query("CREATE INDEX IF NOT EXISTS idx_submission_question_id ON study_submission(question_id)");
  await query("CREATE INDEX IF NOT EXISTS idx_submission_stable_id ON study_submission(stable_id)");
  await query("CREATE INDEX IF NOT EXISTS idx_submission_content_hash ON study_submission(content_hash)");
  await query("CREATE INDEX IF NOT EXISTS idx_question_content_hash ON study_question(content_hash)");
  await query(`CREATE TABLE IF NOT EXISTS app_event (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    platform text,
    app_version text,
    build_number text,
    device_family text,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await query("CREATE INDEX IF NOT EXISTS idx_app_event_name_created ON app_event(name, created_at)");
  console.log("Migrations complete.");
}

app.listen(config.port, async () => {
  console.log(`Backend listening on ${config.port}`);
  console.log("[deployment]", deploymentInfo);
  await runMigrations().catch((e) => console.error("Migration error:", e.message));
});
