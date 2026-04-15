import express from "express";
import crypto from "crypto";
import { verifyAppleIdentityToken, upsertUserFromApplePayload, issueJwt, requireAuth, requireRole } from "./auth.js";
import { query } from "./db.js";

export const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Normalise a cloze value from a request body to a valid JSON string or null.
// Accepts an already-parsed object (Express did the work) or a raw JSON string.
// Returns null if the value is absent or invalid so we never send bad data to Postgres.
function parseClozeJson(value) {
  if (value === undefined || value === null) return null;
  const str = typeof value === "string" ? value : JSON.stringify(value);
  try {
    JSON.parse(str);
    return str;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public / unauthenticated
// ---------------------------------------------------------------------------

router.get("/health", (req, res) => {
  res.json({ ok: true });
});

// App version gating — bump minRequiredVersion to force updates
router.get("/config", (req, res) => {
  res.json({
    minRequiredVersion: process.env.MIN_REQUIRED_VERSION ?? "1.0.0",
    latestVersion: process.env.LATEST_VERSION ?? "1.0.0",
    appStoreUrl: process.env.APP_STORE_URL ?? "",
  });
});

router.post("/auth/apple", async (req, res) => {
  try {
    const { identityToken } = req.body;
    const payload = await verifyAppleIdentityToken(identityToken);
    const user = await upsertUserFromApplePayload(payload);
    const token = await issueJwt(user);
    res.json({ token, role: user.role, userId: user.id });
  } catch {
    res.status(401).json({ error: "Apple authentication failed." });
  }
});

// ---------------------------------------------------------------------------
// Question sync
// ---------------------------------------------------------------------------

// Incremental sync — iOS passes ?since=<ISO date> to fetch only updates.
// cloze_variants_json is re-serialised from JSONB → string so Swift always gets a string.
router.get("/questions", async (req, res) => {
  try {
    const { since } = req.query;
    const params = [];
    let sql = "select * from study_question where status = 'published'";
    if (since) {
      params.push(new Date(since));
      sql += ` and updated_at > $${params.length}`;
    }
    sql += " order by updated_at desc limit 2000";
    const { rows } = await query(sql, params);
    const questions = rows.map((r) => ({
      ...r,
      cloze_variants_json: r.cloze_variants_json ? JSON.stringify(r.cloze_variants_json) : null,
    }));
    res.json({ questions, synced_at: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
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

// ---------------------------------------------------------------------------
// Owner: seed
// ---------------------------------------------------------------------------

// Bulk upsert of an authored question bank.
// cloze_variants_json contains the owner-curated easy/hard variants and IS stored
// on the server so all clients receive the same curated variants on sync.
// Invalid cloze JSON is skipped (set to null) rather than failing the whole seed.
router.post("/admin/seed", requireAuth, requireRole("owner"), async (req, res) => {
  try {
    const { questions } = req.body;
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: "questions array required" });
    }

    let upserted = 0;
    let failed = 0;
    const skippedCloze = [];

    for (const q of questions) {
      try {
        const clozeJson = parseClozeJson(q.clozeVariantsJson ?? q.cloze_variants_json);
        if ((q.clozeVariantsJson ?? q.cloze_variants_json) && clozeJson === null) {
          skippedCloze.push(q.stableId ?? q.stable_id);
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
            crypto.randomUUID(),
            q.stableId ?? q.stable_id,
            q.contentPackId ?? q.content_pack_id ?? null,
            q.topic ?? "",
            q.tags ?? [],
            q.promptText ?? q.prompt_text ?? "",
            q.answerText ?? q.answer_text ?? "",
            q.truthStatementText ?? q.truth_statement_text ?? "",
            clozeJson,
            q.sourceOrigin ?? q.source_origin ?? "",
            q.status ?? "published",
            q.createdAt ?? q.created_at ?? new Date(),
            q.updatedAt ?? q.updated_at ?? new Date(),
          ]
        );
        upserted++;
      } catch (err) {
        console.error(`[seed] failed on stableId=${q.stableId ?? q.stable_id}:`, err.message);
        failed++;
      }
    }

    res.json({ upserted, failed, skippedCloze });
  } catch (err) {
    console.error("[seed]", err);
    res.status(500).json({ error: "Seed failed", detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// User submissions (crowdsourced edits and new cards)
// ---------------------------------------------------------------------------

// User proposes a cloze edit to an existing published question.
// proposedClozeVariantsJson is stored on the submission for owner review.
// Nothing on study_question changes until the owner approves.
router.post("/submissions", requireAuth, async (req, res) => {
  try {
    const { questionId, reason, note, proposedClozeVariantsJson } = req.body;
    const clozeJson = parseClozeJson(proposedClozeVariantsJson);
    const submissionId = crypto.randomUUID();
    await query(
      `insert into study_submission
         (id, question_id, submitter_id, submitter_alias, reason, note, proposed_cloze_variants_json, status)
       values ($1,$2,$3,'anonymous',$4,$5,$6,'pending')`,
      [submissionId, questionId, req.user.sub, reason ?? "", note ?? "", clozeJson]
    );
    res.json({ id: submissionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// User submits a brand-new card for owner review.
// The question is inserted as pending (hidden from sync) until approved.
router.post("/submissions/new-card", requireAuth, async (req, res) => {
  try {
    const { stableId, promptText, answerText, truthStatementText, topic, tags, submitterAlias, proposedClozeVariantsJson } = req.body;
    if (!truthStatementText && !promptText) {
      return res.status(400).json({ error: "truthStatementText or promptText required" });
    }

    const questionId = crypto.randomUUID();
    const usedStableId = stableId ?? crypto.randomUUID();
    const clozeJson = parseClozeJson(proposedClozeVariantsJson);

    await query(
      `insert into study_question
         (id, stable_id, topic, tags, prompt_text, answer_text,
          truth_statement_text, source_origin, status, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,'user-submission','pending',now(),now())
       on conflict (stable_id) do update set
         topic                = excluded.topic,
         prompt_text          = excluded.prompt_text,
         answer_text          = excluded.answer_text,
         truth_statement_text = excluded.truth_statement_text,
         updated_at           = now()`,
      [questionId, usedStableId, topic ?? "", tags ?? [], promptText ?? "", answerText ?? "", truthStatementText ?? ""]
    );

    const submissionId = crypto.randomUUID();
    await query(
      `insert into study_submission
         (id, question_id, submitter_id, submitter_alias, reason, note, proposed_cloze_variants_json, status)
       values ($1,$2,$3,$4,'new-card',$5,$6,'pending')`,
      [
        submissionId,
        questionId,
        req.user.sub,
        submitterAlias ?? "anonymous",
        `New card: ${(truthStatementText ?? promptText ?? "").substring(0, 120)}`,
        clozeJson,
      ]
    );

    res.json({ id: submissionId });
  } catch (err) {
    console.error("[new-card]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

router.get("/moderation/queue", requireAuth, requireRole("owner", "moderator"), async (req, res) => {
  try {
    const { rows } = await query(
      `select ss.*, sq.prompt_text, sq.truth_statement_text, sq.cloze_variants_json
       from study_submission ss
       join study_question sq on sq.id = ss.question_id
       where ss.status = 'pending'
       order by ss.created_at desc limit 200`
    );
    res.json({ queue: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Approve a submission:
// - Applies proposed_cloze_variants_json to the question (if present)
// - Publishes the question if it was pending (new card flow)
// - Marks the submission approved
router.post("/moderation/:id/approve", requireAuth, requireRole("owner", "moderator"), async (req, res) => {
  try {
    const { id } = req.params;

    await query(
      `update study_question set
         cloze_variants_json = coalesce(
           (select proposed_cloze_variants_json from study_submission where id = $1),
           cloze_variants_json
         ),
         status = case when status = 'pending' then 'published' else status end,
         updated_at = now()
       where id = (select question_id from study_submission where id = $1)`,
      [id]
    );

    await query(
      "update study_submission set status = 'approved', updated_at = now() where id = $1",
      [id]
    );

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

// Owner manually edits question content before approving.
router.post("/moderation/:id/edit", requireAuth, requireRole("owner", "moderator"), async (req, res) => {
  try {
    const { id } = req.params;
    const { truthStatementText, clozeVariantsJson } = req.body;
    const clozeJson = parseClozeJson(clozeVariantsJson);
    if (clozeVariantsJson != null && clozeJson === null) {
      return res.status(400).json({ error: "clozeVariantsJson is not valid JSON" });
    }
    await query(
      `update study_question set
         truth_statement_text = coalesce($1, truth_statement_text),
         cloze_variants_json  = coalesce($2, cloze_variants_json),
         updated_at           = now()
       where id = (select question_id from study_submission where id = $3)`,
      [truthStatementText ?? null, clozeJson, id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Owner: user management
// ---------------------------------------------------------------------------

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
