import express from "express";
import crypto from "crypto";
import {
  verifyAppleIdentityToken,
  upsertUserFromApplePayload,
  issueJwt,
  requireAuth,
  requireRole,
} from "./auth.js";
import { query } from "./db.js";
import { deploymentInfo } from "./deploymentInfo.js";

export const router = express.Router();

function parseJSONValue(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  }
  if (typeof value === "object") return value;
  throw new Error("Invalid JSON value");
}

function previewValue(value) {
  if (value == null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 600 ? `${text.slice(0, 600)}...<truncated>` : text;
}

function normalizeJSONForPostgres(value, fieldName) {
  const inputType = value == null ? "null" : typeof value;
  const inputIsArray = Array.isArray(value);
  const diagnostics = {
    field: fieldName,
    inputType,
    inputIsArray,
    parseAttempted: typeof value === "string",
    parseSucceeded: value == null || typeof value !== "string",
    finalType: "null",
    finalIsArray: false,
    finalValue: null,
  };

  let parsed = null;
  if (value != null) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        try {
          parsed = JSON.parse(trimmed);
        } catch (err) {
          diagnostics.parseSucceeded = false;
          diagnostics.parseError = err.message;
          return { ok: false, value: null, diagnostics };
        }
      }
    } else if (typeof value === "object") {
      parsed = value;
    } else {
      diagnostics.parseSucceeded = false;
      diagnostics.parseError = `Expected JSON string/object/array, received ${typeof value}`;
      return { ok: false, value: null, diagnostics };
    }
  }

  const pgValue = parsed == null ? null : JSON.stringify(parsed);
  diagnostics.finalType = pgValue == null ? "null" : typeof pgValue;
  diagnostics.finalIsArray = Array.isArray(parsed);
  diagnostics.finalValue = previewValue(pgValue);
  return { ok: true, value: pgValue, parsed, diagnostics };
}

function normalizeTagsForPostgres(value) {
  const diagnostics = {
    field: "tags",
    inputType: value == null ? "null" : typeof value,
    inputIsArray: Array.isArray(value),
    parseAttempted: typeof value === "string",
    parseSucceeded: value == null || typeof value !== "string",
    finalType: "object",
    finalIsArray: true,
    finalValue: [],
  };

  let tags = [];
  if (Array.isArray(value)) {
    tags = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          tags = parsed;
        } else {
          diagnostics.parseSucceeded = false;
          diagnostics.parseError = "Parsed tags value was not an array.";
          return { ok: false, value: [], diagnostics };
        }
      } catch (err) {
        diagnostics.parseSucceeded = false;
        diagnostics.parseError = err.message;
        return { ok: false, value: [], diagnostics };
      }
    }
  } else if (value != null) {
    diagnostics.parseSucceeded = false;
    diagnostics.parseError = `Expected tags array or JSON string, received ${typeof value}`;
    return { ok: false, value: [], diagnostics };
  }

  const normalized = tags.map((tag) => String(tag));
  diagnostics.finalValue = normalized;
  return { ok: true, value: normalized, diagnostics };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isUUID(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateClozeVariants(variants) {
  if (!Array.isArray(variants) || variants.length === 0) {
    return { ok: false, error: "cloze_variants_json must be a non-empty array." };
  }

  const difficulties = new Set();
  for (const variant of variants) {
    if (typeof variant !== "object" || variant == null) {
      return { ok: false, error: "Each cloze variant must be an object." };
    }
    if (!isNonEmptyString(variant.baseText) || !isNonEmptyString(variant.maskedText)) {
      return { ok: false, error: "Each cloze variant needs non-empty baseText and maskedText." };
    }
    if (!isNonEmptyString(variant.difficulty)) {
      return { ok: false, error: "Each cloze variant needs difficulty." };
    }
    difficulties.add(String(variant.difficulty).toLowerCase());
  }

  const hasStandard = difficulties.has("easy") || difficulties.has("medium");
  const hasDeep = difficulties.has("hard");
  if (!hasStandard || !hasDeep) {
    return { ok: false, error: "Cloze variants must include standard (easy/medium) and deep (hard)." };
  }
  return { ok: true };
}

function compactPayloadForLog(body) {
  return {
    stableId: body?.stableId ?? body?.stable_id ?? null,
    questionId: body?.questionId ?? body?.question_id ?? null,
    contentPackId: body?.contentPackId ?? body?.content_pack_id ?? null,
    topic: body?.topic ?? null,
    tagsCount: Array.isArray(body?.tags) ? body.tags.length : 0,
    hasPromptText: isNonEmptyString(body?.promptText ?? body?.prompt_text),
    hasAnswerText: isNonEmptyString(body?.answerText ?? body?.answer_text),
    hasTruthStatementText: isNonEmptyString(body?.truthStatementText ?? body?.truth_statement_text),
    hasClozeVariantsJson:
      body?.clozeVariantsJson != null ||
      body?.cloze_variants_json != null ||
      body?.proposedClozeVariantsJson != null ||
      body?.proposed_cloze_variants_json != null,
  };
}

function serializeQuestionRow(row) {
  return {
    ...row,
    cloze_variants_json: row.cloze_variants_json ? JSON.stringify(row.cloze_variants_json) : null,
  };
}

function normalizeIncomingQuestion(input) {
  const stableId = input.stable_id ?? input.stableId ?? null;
  const truthStatementText = input.truth_statement_text ?? input.truthStatementText ?? "";
  const promptText = input.prompt_text ?? input.promptText ?? "";
  const answerText = input.answer_text ?? input.answerText ?? "";
  const clozeRaw = input.cloze_variants_json ?? input.clozeVariantsJson ?? null;
  const clozeVariants = parseJSONValue(clozeRaw);

  return {
    id: input.id ?? crypto.randomUUID(),
    stableId,
    contentPackId: input.content_pack_id ?? input.contentPackId ?? null,
    topic: input.topic ?? "",
    tags: Array.isArray(input.tags) ? input.tags : [],
    promptText,
    answerText,
    truthStatementText,
    clozeVariants,
    sourceOrigin: input.source_origin ?? input.sourceOrigin ?? "",
    status: input.status ?? "published",
    createdAt: input.created_at ?? input.createdAt ?? new Date().toISOString(),
    updatedAt: input.updated_at ?? input.updatedAt ?? new Date().toISOString(),
  };
}

function parseOptionalClozeForResponse(value, res) {
  const normalized = normalizeJSONForPostgres(value, "cloze_variants_json");
  if (!normalized.ok) {
    res.status(400).json({ error: "clozeVariantsJson must be valid JSON." });
    return { ok: false, value: null, parsed: null, diagnostics: normalized.diagnostics };
  }
  if (normalized.parsed == null) return { ok: true, value: null, parsed: null, diagnostics: normalized.diagnostics };
  const validation = validateClozeVariants(normalized.parsed);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return { ok: false, value: null, parsed: null, diagnostics: normalized.diagnostics };
  }
  return normalized;
}

router.get("/health", (req, res) => {
  res.json({ ok: true });
});

router.get("/health/version", (req, res) => {
  res.json(deploymentInfo);
});

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

router.get("/questions", async (req, res) => {
  try {
    const { since } = req.query;
    const params = [];
    let sql = `
      select *
      from study_question
      where status = 'published'
        and truth_statement_text is not null
        and truth_statement_text <> ''
    `;
    if (since) {
      params.push(new Date(since));
      sql += ` and updated_at > $${params.length}`;
    }
    sql += " order by updated_at desc limit 2000";
    const { rows } = await query(sql, params);
    res.json({
      questions: rows.map(serializeQuestionRow),
      synced_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/packs/:packId/cards", requireAuth, async (req, res) => {
  try {
    const { packId } = req.params;
    const { rows } = await query(
      `select *
       from study_question
       where status = 'published'
         and content_pack_id = $1
         and truth_statement_text is not null
         and truth_statement_text <> ''
       order by updated_at desc
       limit 500`,
      [packId]
    );
    res.json({ cards: rows.map(serializeQuestionRow) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/seed", requireAuth, requireRole("owner"), async (req, res) => {
  console.warn("[seed] rejected direct canonical seed attempt; submissions/moderation is the only creation path");
  res.status(410).json({
    error: "Direct canonical seeding is disabled. Create study_submission rows and approve them through moderation.",
  });
});

router.post("/admin/questions/delete", requireAuth, requireRole("owner"), async (req, res) => {
  try {
    const stableId = req.body?.stableId ?? req.body?.stable_id;
    if (!isNonEmptyString(stableId)) {
      return res.status(400).json({ error: "stableId is required" });
    }

    const { rowCount } = await query(
      `update study_question
       set status = 'archived', updated_at = now()
       where stable_id = $1`,
      [stableId]
    );
    if (rowCount === 0) return res.status(404).json({ error: "Question not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin/questions/delete]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

function logNewCardRouteEntry(req, res, next) {
  console.log("[new-card] route entry", {
    commitSha: deploymentInfo.commitSha,
    deploymentTimestamp: deploymentInfo.deploymentTimestamp,
    environment: deploymentInfo.environment,
    contentType: req.headers["content-type"] ?? null,
    contentLength: req.headers["content-length"] ?? null,
    hasAuthorization: isNonEmptyString(req.headers.authorization),
    bodyType: req.body == null ? "null" : typeof req.body,
    bodyKeys: req.body && typeof req.body === "object" ? Object.keys(req.body) : [],
  });
  next();
}

router.post("/submissions/new-card", logNewCardRouteEntry, requireAuth, async (req, res) => {
  try {
    const {
      stableId,
      contentPackId,
      promptText,
      answerText,
      truthStatementText,
      authoredText,
      clozeVariantsJson,
      proposedClozeVariantsJson,
      topic,
      tags,
      submitterAlias,
    } = req.body;
    const incomingQuestionId = req.body?.questionId ?? req.body?.question_id ?? null;
    console.log("[new-card] incoming payload", compactPayloadForLog(req.body));
    console.log("[new-card] question_id presence", {
      hasQuestionId: isNonEmptyString(incomingQuestionId),
      mode: "new-card",
    });
    if (!isNonEmptyString(truthStatementText) && !isNonEmptyString(promptText)) {
      return res.status(400).json({ error: "truthStatementText or promptText required" });
    }

    const clozeRaw =
      clozeVariantsJson ??
      req.body?.cloze_variants_json ??
      proposedClozeVariantsJson ??
      req.body?.proposed_cloze_variants_json;
    const parsedCloze = parseOptionalClozeForResponse(clozeRaw, res);
    if (!parsedCloze.ok) return;
    const parsedProposedCloze = normalizeJSONForPostgres(
      req.body?.proposedClozeVariantsJson ?? req.body?.proposed_cloze_variants_json ?? null,
      "proposed_cloze_variants_json"
    );
    if (!parsedProposedCloze.ok) {
      console.warn("[new-card] proposed cloze normalization failed", parsedProposedCloze.diagnostics);
      return res.status(400).json({ error: "proposedClozeVariantsJson must be valid JSON." });
    }
    const normalizedTags = normalizeTagsForPostgres(tags);
    if (!normalizedTags.ok) {
      console.warn("[new-card] tags normalization failed", normalizedTags.diagnostics);
      return res.status(400).json({ error: "tags must be an array or valid JSON array string." });
    }

    const usedStableId = isNonEmptyString(stableId) ? stableId.trim() : crypto.randomUUID();
    console.log("[new-card] treating submission as brand-new card", {
      stableId: usedStableId,
      questionId: null,
    });
    console.log("[new-card] JSON field diagnostics", {
      cloze_variants_json: parsedCloze.diagnostics,
      proposed_cloze_variants_json: parsedProposedCloze.diagnostics,
      tags: normalizedTags.diagnostics,
    });

    const existingSubmission = await query(
      `select id
       from study_submission
       where stable_id = $1
         and submitter_id = $2
         and reason = 'new-card'
         and status = 'pending'
       order by created_at desc
       limit 1`,
      [usedStableId, req.user.sub]
    );
    if (existingSubmission.rows.length > 0) {
      return res.json({ id: existingSubmission.rows[0].id, duplicate: true });
    }

    const submissionId = crypto.randomUUID();
    const insertValues = [
      submissionId,
      usedStableId,
      contentPackId ?? null,
      topic ?? "",
      normalizedTags.value,
      promptText ?? "",
      answerText ?? "",
      truthStatementText ?? "",
      authoredText ?? null,
      null,
      parsedProposedCloze.value,
      req.user.sub,
      submitterAlias ?? "anonymous",
      `New card: ${(truthStatementText ?? promptText ?? "").substring(0, 120)}`,
    ];
    console.log("[new-card] final pg insert values", {
      id: insertValues[0],
      stable_id: insertValues[1],
      content_pack_id: insertValues[2],
      topic: insertValues[3],
      tags: insertValues[4],
      prompt_text_type: typeof insertValues[5],
      answer_text_type: typeof insertValues[6],
      truth_statement_text_type: typeof insertValues[7],
      authored_text_type: insertValues[8] == null ? "null" : typeof insertValues[8],
      cloze_variants_json: previewValue(insertValues[9]),
      proposed_cloze_variants_json: previewValue(insertValues[10]),
      submitter_id: insertValues[11],
      submitter_alias: insertValues[12],
      note: insertValues[13],
    });
    await query(
      `insert into study_submission
         (id, question_id, stable_id, content_pack_id, topic, tags, prompt_text, answer_text,
          truth_statement_text, authored_text, cloze_variants_json, proposed_cloze_variants_json,
          submitter_id, submitter_alias, reason, note, status)
       values ($1,null,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'new-card',$14,'pending')`,
      insertValues
    );
    console.log("[new-card] created study_submission only", {
      submissionId,
      stableId: usedStableId,
      origin: "local pending submission",
    });

    res.json({ id: submissionId });
  } catch (err) {
    console.error("[new-card]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/submissions", requireAuth, async (req, res) => {
  try {
    const { reason, note, proposedClozeVariantsJson } = req.body;
    const questionId = req.body?.questionId ?? req.body?.question_id;
    console.log("[submissions] incoming payload", compactPayloadForLog(req.body));
    console.log("[submissions] question_id presence", {
      hasQuestionId: isNonEmptyString(questionId),
      mode: "existing-question-edit",
    });
    if (!isNonEmptyString(questionId)) {
      return res.status(400).json({ error: "questionId is required for existing-question submissions." });
    }
    if (!isUUID(questionId)) {
      return res.status(400).json({ error: "questionId must be a valid UUID." });
    }
    const proposedCloze = parseOptionalClozeForResponse(
      proposedClozeVariantsJson ?? req.body?.proposed_cloze_variants_json,
      res
    );
    if (!proposedCloze.ok) return;

    const existingQuestion = await query("select id from study_question where id = $1 limit 1", [questionId]);
    if (existingQuestion.rows.length === 0) {
      return res.status(404).json({ error: "Question not found" });
    }
    const submissionId = crypto.randomUUID();
    await query(
      `insert into study_submission
         (id, question_id, submitter_id, submitter_alias, reason, note, proposed_cloze_variants_json, status)
       values ($1,$2,$3,'anonymous',$4,$5,$6,'pending')`,
      [submissionId, questionId, req.user.sub, reason ?? "", note ?? "", proposedCloze.value]
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
      `select
         study_submission.*,
         coalesce(study_submission.prompt_text, study_question.prompt_text) as prompt_text,
         study_submission.authored_text as authored_text,
         coalesce(study_submission.truth_statement_text, study_question.truth_statement_text) as truth_statement_text,
         coalesce(
           study_submission.proposed_cloze_variants_json,
           study_submission.cloze_variants_json,
           study_question.cloze_variants_json
         ) as cloze_variants_json,
         coalesce(study_submission.stable_id, study_question.stable_id) as stable_id
       from study_submission
       left join study_question on study_question.id = study_submission.question_id
       where study_submission.status = 'pending'
       order by study_submission.created_at desc
       limit 200`
    );
    res.json({
      queue: rows.map((row) => ({
        ...row,
        cloze_variants_json: row.cloze_variants_json ? JSON.stringify(row.cloze_variants_json) : null,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/moderation/:id/approve", requireAuth, requireRole("owner", "moderator"), async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await query(
      `select
         study_submission.question_id,
         coalesce(study_submission.stable_id, study_question.stable_id) as stable_id,
         coalesce(study_submission.content_pack_id, study_question.content_pack_id) as content_pack_id,
         coalesce(study_submission.topic, study_question.topic) as topic,
         coalesce(study_submission.tags, study_question.tags) as tags,
         coalesce(study_submission.prompt_text, study_question.prompt_text) as prompt_text,
         coalesce(study_submission.answer_text, study_question.answer_text) as answer_text,
         coalesce(study_submission.truth_statement_text, study_question.truth_statement_text) as truth_statement_text,
         coalesce(
           study_submission.proposed_cloze_variants_json,
           study_submission.cloze_variants_json,
           study_question.cloze_variants_json
         ) as cloze_variants_json
       from study_submission
       left join study_question on study_question.id = study_submission.question_id
       where study_submission.id = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Submission not found" });
    const question = rows[0];

    if (!isNonEmptyString(question.truth_statement_text)) {
      return res.status(400).json({ error: "Cannot approve without truth_statement_text." });
    }
    if (question.cloze_variants_json != null) {
      const clozeValidation = validateClozeVariants(question.cloze_variants_json);
      if (!clozeValidation.ok) {
        return res.status(400).json({ error: "Cannot approve: " + clozeValidation.error });
      }
    }
    const approvedCloze = normalizeJSONForPostgres(question.cloze_variants_json, "approval.cloze_variants_json");
    if (!approvedCloze.ok) {
      console.warn("[approve] cloze normalization failed", approvedCloze.diagnostics);
      return res.status(400).json({ error: "Cannot approve: cloze_variants_json must be valid JSON." });
    }

    if (!question.question_id) {
      const questionId = crypto.randomUUID();
      const stableId = isNonEmptyString(question.stable_id) ? question.stable_id : crypto.randomUUID();
      console.log("[approve] creating canonical study_question from moderation approval", {
        submissionId: id,
        questionId,
        stableId,
        origin: "moderation approval",
      });
      const insertedQuestion = await query(
        `insert into study_question
           (id, stable_id, content_pack_id, topic, tags, prompt_text, answer_text, truth_statement_text,
            cloze_variants_json, source_origin, status, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'user-submission','published',now(),now())
         on conflict (stable_id) do update set
           content_pack_id       = coalesce(excluded.content_pack_id, study_question.content_pack_id),
           topic                 = excluded.topic,
           tags                  = excluded.tags,
           prompt_text           = excluded.prompt_text,
           answer_text           = excluded.answer_text,
           truth_statement_text  = excluded.truth_statement_text,
           cloze_variants_json   = coalesce(excluded.cloze_variants_json, study_question.cloze_variants_json),
           source_origin         = excluded.source_origin,
           status                = 'published',
           updated_at            = now()
         returning id`,
        [
          questionId,
          stableId,
          question.content_pack_id ?? null,
          question.topic ?? "",
          Array.isArray(question.tags) ? question.tags : [],
          question.prompt_text ?? "",
          question.answer_text ?? "",
          question.truth_statement_text ?? "",
          approvedCloze.value,
        ]
      );
      await query("update study_submission set question_id = $1, updated_at = now() where id = $2", [
        insertedQuestion.rows[0].id,
        id,
      ]);
    } else {
      console.log("[approve] publishing existing canonical question from moderation approval", {
        submissionId: id,
        questionId: question.question_id,
        stableId: question.stable_id,
        origin: "moderation approval",
      });
    }

    await query(
      `update study_question
       set cloze_variants_json = coalesce($2, cloze_variants_json),
           status = 'published',
           updated_at = now()
       where id = (select question_id from study_submission where id = $1)`,
      [id, approvedCloze.value]
    );
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
    const truthStatementText = req.body?.truthStatementText ?? req.body?.truth_statement_text;
    const clozeVariantsJson = req.body?.clozeVariantsJson ?? req.body?.cloze_variants_json;

    const clozePayload = parseOptionalClozeForResponse(clozeVariantsJson, res);
    if (!clozePayload.ok) return;

    await query(
      `update study_question
       set truth_statement_text = coalesce($1, truth_statement_text),
           cloze_variants_json  = coalesce($2, cloze_variants_json),
           updated_at = now()
       where id = (select question_id from study_submission where id = $3)`,
      [truthStatementText ?? null, clozePayload.value, id]
    );
    await query(
      `update study_submission
       set truth_statement_text = coalesce($1, truth_statement_text),
           cloze_variants_json  = coalesce($2, cloze_variants_json),
           updated_at = now()
       where id = $3
         and question_id is null`,
      [truthStatementText ?? null, clozePayload.value, id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

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
