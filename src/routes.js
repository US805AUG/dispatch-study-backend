import express from "express";
import crypto from "crypto";
import { verifyAppleIdentityToken, upsertUserFromApplePayload, issueJwt, requireAuth, requireRole } from "./auth.js";
import { query } from "./db.js";

export const router = express.Router();

router.get("/health", (req, res) => {
  res.json({ ok: true });
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
