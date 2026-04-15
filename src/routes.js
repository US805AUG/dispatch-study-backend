import express from "express";
import crypto from "crypto";
import { verifyAppleIdentityToken, upsertUserFromApplePayload, issueJwt, requireAuth, requireRole } from "./auth.js";
import { query } from "./db.js";

export const router = express.Router();

router.get("/health", (req, res) => {
  res.json({ ok: true });
});

// App version gating — bump minRequiredVersion to force updates
// Set APP_STORE_URL env var once the app is live on the App Store
router.get("/config", (req, res) => {
  res.json({
    minRequiredVersion: process.env.MIN_REQUIRED_VERSION ?? "1.0.0",
    latestVersion: process.env.LATEST_VERSION ?? "1.0.0",
    appStoreUrl: process.env.APP_STORE_URL ?? "",
  });
});

// Fetch published questions for daily user sync
router.get("/questions", async (req, res) => {
  const { since } = req.query;
  const params = [];
  let sql = "select * from study_question where status = 'published'";
  if (since) {
    params.push(new Date(since));
    sql += ` and updated_at > $${params.length}`;
  }
  sql += " order by updated_at desc limit 2000";
  const { rows } = await query(sql, params);
  // Re-serialize cloze_variants_json (JSONB → string) so Swift gets a consistent type
  const questions = rows.map((r) => ({
    ...r,
    cloze_variants_json: r.cloze_variants_json
      ? JSON.stringify(r.cloze_variants_json)
      : null,
  }));
  res.json({ questions, synced_at: new Date().toISOString() });
});

// Owner-only bulk upsert — seeds the question bank from the owner's iPhone
// Note: cloze_variants_json is intentionally NOT seeded — variants are generated
// per-device by ClozeGenerationEngine and don't need to live on the server.
router.post("/admin/seed", requireAuth, requireRole("owner"), async (req, res) => {
  const { questions } = req.body;
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: "questions array required" });
  }
  let upserted = 0;
  let failed = 0;
  for (const q of questions) {
    try {
      await query(
        `insert into study_question
           (id, stable_id, content_pack_id, topic, tags, prompt_text, answer_text,
            truth_statement_text, source_origin, status, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (stable_id) do update set
           topic               = excluded.topic,
           tags                = excluded.tags,
           prompt_text         = excluded.prompt_text,
           answer_text         = excluded.answer_text,
           truth_statement_text = excluded.truth_statement_text,
           source_origin       = excluded.source_origin,
           updated_at          = excluded.updated_at`,
        [
          crypto.randomUUID(),
          q.stableId,
          q.contentPackId ?? null,
          q.topic ?? "",
          q.tags ?? [],
          q.promptText,
          q.answerText ?? "",
          q.truthStatementText ?? "",
          q.sourceOrigin ?? "",
          q.status ?? "published",
          q.createdAt ? new Date(q.createdAt) : new Date(),
          q.updatedAt ? new Date(q.updatedAt) : new Date(),
        ]
      );
      upserted++;
    } catch (err) {
      console.error(`[seed] failed on stableId=${q.stableId}:`, err.message);
      failed++;
    }
  }
  res.json({ upserted, failed });
});

router.post("/auth/apple", async (req, res) => {
  try {
    const { identityToken } = req.body;
    const payload = await verifyAppleIdentityToken(identityToken);
    const user = await upsertUserFromApplePayload(payload);
    const token = await issueJwt(user);
    res.json({ token, role: user.role, userId: user.id });
  } catch (error) {
    res.status(401).json({ error: "Apple authentication failed." });
  }
});

router.get("/packs/:packId/cards", requireAuth, async (req, res) => {
  try {
    const { packId } = req.params;
    const { rows } = await query(
      "select * from study_question where status = 'published' and content_pack_id = $1 order by updated_at desc limit 500",
      [packId]
    );
    res.json({ cards: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/submissions", requireAuth, async (req, res) => {
  try {
    const { questionId, reason, note } = req.body;
    const submissionId = crypto.randomUUID();
    await query(
      "insert into study_submission (id, question_id, submitter_id, submitter_alias, reason, note, status) values ($1, $2, $3, $4, $5, $6, 'pending')",
      [submissionId, questionId, req.user.sub, "anonymous", reason ?? "", note ?? ""]
    );
    res.json({ id: submissionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/moderation/queue", requireAuth, requireRole("owner", "moderator"), async (req, res) => {
  try {
    const { rows } = await query(
      "select study_submission.*, study_question.prompt_text, study_question.truth_statement_text from study_submission join study_question on study_question.id = study_submission.question_id where study_submission.status = 'pending' order by study_submission.created_at desc limit 200"
    );
    res.json({ queue: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/moderation/:id/approve", requireAuth, requireRole("owner", "moderator"), async (req, res) => {
  try {
    const { id } = req.params;
    await query("update study_submission set status = 'approved', updated_at = now() where id = $1", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/moderation/:id/reject", requireAuth, requireRole("owner", "moderator"), async (req, res) => {
  try {
    const { id } = req.params;
    await query("update study_submission set status = 'rejected', updated_at = now() where id = $1", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/moderation/:id/edit", requireAuth, requireRole("owner", "moderator"), async (req, res) => {
  try {
    const { id } = req.params;
    const { truthStatementText, clozeVariantsJson } = req.body;
    if (clozeVariantsJson !== undefined && clozeVariantsJson !== null) {
      try {
        JSON.parse(typeof clozeVariantsJson === "string" ? clozeVariantsJson : JSON.stringify(clozeVariantsJson));
      } catch {
        return res.status(400).json({ error: "clozeVariantsJson is not valid JSON" });
      }
    }
    await query(
      "update study_question set truth_statement_text = coalesce($1, truth_statement_text), cloze_variants_json = coalesce($2, cloze_variants_json), updated_at = now() where id = (select question_id from study_submission where id = $3)",
      [truthStatementText ?? null, clozeVariantsJson ?? null, id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/seed", requireAuth, requireRole("owner"), async (req, res) => {
  try {
    const body = req.body;

    // Log the raw payload so we can inspect it in Railway logs
    console.log("[seed] payload keys:", Object.keys(body));
    const questions = Array.isArray(body) ? body : (body.questions ?? body.cards ?? []);
    console.log(`[seed] question count: ${questions.length}`);
    if (questions.length > 0) {
      console.log("[seed] first question sample:", JSON.stringify(questions[0]));
    }

    if (questions.length === 0) {
      return res.status(400).json({ error: "No questions found in payload" });
    }

    let inserted = 0;
    let failed = 0;
    const errors = [];

    for (const q of questions) {
      try {
        // Accept both snake_case and camelCase field names from the iOS app
        const stableId = q.stable_id ?? q.stableId;
        const contentPackId = q.content_pack_id ?? q.contentPackId ?? null;
        const promptText = q.prompt_text ?? q.promptText;
        const answerText = q.answer_text ?? q.answerText ?? null;
        const truthStatementText = q.truth_statement_text ?? q.truthStatementText ?? null;
        const sourceOrigin = q.source_origin ?? q.sourceOrigin ?? null;
        const createdAt = q.created_at ?? q.createdAt ?? new Date().toISOString();
        const updatedAt = q.updated_at ?? q.updatedAt ?? new Date().toISOString();

        // Validate cloze_variants_json — set to null rather than crashing on bad data
        let clozeJson = q.cloze_variants_json ?? q.clozeVariantsJson ?? null;
        if (clozeJson !== null) {
          try {
            if (typeof clozeJson !== "string") {
              clozeJson = JSON.stringify(clozeJson);
            }
            JSON.parse(clozeJson);
          } catch {
            console.warn(`[seed] invalid cloze_variants_json for stable_id=${stableId}, setting to null`);
            errors.push({ stable_id: stableId, warning: "cloze_variants_json was invalid JSON and was set to null" });
            clozeJson = null;
          }
        }

        await query(
          `insert into study_question
             (id, stable_id, content_pack_id, topic, tags, prompt_text, answer_text,
              truth_statement_text, cloze_variants_json, source_origin, status, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           on conflict (stable_id) do update set
             topic                = excluded.topic,
             tags                 = excluded.tags,
             prompt_text          = excluded.prompt_text,
             answer_text          = excluded.answer_text,
             truth_statement_text = excluded.truth_statement_text,
             cloze_variants_json  = excluded.cloze_variants_json,
             source_origin        = excluded.source_origin,
             updated_at           = excluded.updated_at`,
          [
            q.id,
            stableId,
            contentPackId,
            q.topic ?? null,
            q.tags ?? null,
            promptText,
            answerText,
            truthStatementText,
            clozeJson,
            sourceOrigin,
            q.status ?? "published",
            createdAt,
            updatedAt,
          ]
        );
        inserted++;
      } catch (err) {
        console.error(`[seed] failed for stable_id=${q.stable_id ?? q.stableId}:`, err.message);
        failed++;
        errors.push({ stable_id: q.stable_id ?? q.stableId, error: err.message });
      }
    }

    console.log(`[seed] complete — inserted: ${inserted}, failed: ${failed}`);
    res.json({ inserted, failed, errors });
  } catch (err) {
    console.error("[seed] top-level error:", err);
    res.status(500).json({ error: "Seed failed", detail: err.message });
  }
});

// MARK: - User Management (owner only)

router.get("/admin/users", requireAuth, requireRole("owner"), async (req, res) => {
  try {
    const { rows } = await query(
      "select id, email, display_name, role, created_at from app_user order by created_at asc"
    );
    res.json({ users: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/admin/users/:id/role", requireAuth, requireRole("owner"), async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    const validRoles = ["user", "moderator", "owner"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(", ")}` });
    }
    const { rowCount } = await query(
      "update app_user set role = $1, updated_at = now() where id = $2",
      [role, id]
    );
    if (rowCount === 0) return res.status(404).json({ error: "User not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});
