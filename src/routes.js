import express from "express";
import crypto from "crypto";
import { verifyAppleIdentityToken, upsertUserFromApplePayload, issueJwt, requireAuth, requireRole } from "./auth.js";
import { query } from "./db.js";

export const router = express.Router();

router.get("/health", (req, res) => {
  res.json({ ok: true });
});

// App version gating — bump minRequiredVersion to force updates
router.get("/config", (req, res) => {
  res.json({
    minRequiredVersion: "1.0.0",
    latestVersion: "1.0.0",
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
router.post("/admin/seed", requireAuth, requireRole("owner"), async (req, res) => {
  const { questions } = req.body;
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: "questions array required" });
  }
  let upserted = 0;
  for (const q of questions) {
    let clozeJson = null;
    if (q.clozeVariantsJson) {
      try { clozeJson = JSON.parse(q.clozeVariantsJson); } catch { /* ignore */ }
    }
    await query(
      `insert into study_question
         (id, stable_id, content_pack_id, topic, tags, prompt_text, answer_text,
          truth_statement_text, cloze_variants_json, source_origin, status, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (stable_id) do update set
         topic               = excluded.topic,
         tags                = excluded.tags,
         prompt_text         = excluded.prompt_text,
         answer_text         = excluded.answer_text,
         truth_statement_text = excluded.truth_statement_text,
         cloze_variants_json = excluded.cloze_variants_json,
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
        clozeJson,
        q.sourceOrigin ?? "",
        q.status ?? "published",
        q.createdAt ? new Date(q.createdAt) : new Date(),
        q.updatedAt ? new Date(q.updatedAt) : new Date(),
      ]
    );
    upserted++;
  }
  res.json({ upserted });
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
  const { packId } = req.params;
  const { rows } = await query(
    "select * from study_question where status = 'published' and content_pack_id = $1 order by updated_at desc limit 500",
    [packId]
  );
  res.json({ cards: rows });
});

router.post("/submissions", requireAuth, async (req, res) => {
  const { questionId, reason, note } = req.body;
  const submissionId = crypto.randomUUID();
  await query(
    "insert into study_submission (id, question_id, submitter_id, submitter_alias, reason, note, status) values ($1, $2, $3, $4, $5, $6, 'pending')",
    [submissionId, questionId, req.user.sub, "anonymous", reason ?? "", note ?? ""]
  );
  res.json({ id: submissionId });
});

router.get("/moderation/queue", requireAuth, requireRole("owner", "moderator"), async (req, res) => {
  const { rows } = await query(
    "select study_submission.*, study_question.prompt_text, study_question.truth_statement_text from study_submission join study_question on study_question.id = study_submission.question_id where study_submission.status = 'pending' order by study_submission.created_at desc limit 200"
  );
  res.json({ queue: rows });
});

router.post("/moderation/:id/approve", requireAuth, requireRole("owner", "moderator"), async (req, res) => {
  const { id } = req.params;
  await query("update study_submission set status = 'approved', updated_at = now() where id = $1", [id]);
  res.json({ ok: true });
});

router.post("/moderation/:id/reject", requireAuth, requireRole("owner", "moderator"), async (req, res) => {
  const { id } = req.params;
  await query("update study_submission set status = 'rejected', updated_at = now() where id = $1", [id]);
  res.json({ ok: true });
});

router.post("/moderation/:id/edit", requireAuth, requireRole("owner", "moderator"), async (req, res) => {
  const { id } = req.params;
  const { truthStatementText, clozeVariantsJson } = req.body;
  await query(
    "update study_question set truth_statement_text = coalesce($1, truth_statement_text), cloze_variants_json = coalesce($2, cloze_variants_json), updated_at = now() where id = (select question_id from study_submission where id = $3)",
    [truthStatementText, clozeVariantsJson, id]
  );
  res.json({ ok: true });
});
