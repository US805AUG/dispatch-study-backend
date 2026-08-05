import express from "express";
import crypto from "crypto";
import {
  verifyAppleIdentityToken,
  upsertUserFromApplePayload,
  issueJwt,
  requireAuth,
  requireRole,
} from "./auth.js";
import { query, withTransaction } from "./db.js";
import { deploymentInfo } from "./deploymentInfo.js";
import { config } from "./config.js";
import {
  evaluateOwnerQuestionCSV,
  OWNER_IMPORT_PACK_ID,
} from "./ownerQuestionImport.js";

export const router = express.Router();

const TEMP_ANALYTICS_BOOTSTRAP_USER_ID = "c665ac91-d55b-47a7-a2df-76fe4bda5874";

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

function optionalShortText(value, maxLength) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function optionalDate(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function optionalJSONObject(value, maxKeys = 40) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return {};
  const blockedKeys = new Set([
    "answer",
    "answerText",
    "authoredText",
    "cardText",
    "email",
    "fullName",
    "name",
    "phone",
    "prompt",
    "promptText",
    "question",
    "questionText",
    "rawText",
    "searchText",
    "text",
    "truthStatementText",
  ]);
  const out = {};
  for (const [key, rawValue] of Object.entries(value).slice(0, maxKeys)) {
    if (blockedKeys.has(key)) continue;
    if (typeof rawValue === "string") {
      out[key] = rawValue.slice(0, 160);
    } else if (typeof rawValue === "number" || typeof rawValue === "boolean") {
      out[key] = rawValue;
    }
  }
  return out;
}

function coarseRegionFromRequest(req, event) {
  const header = (name) => optionalShortText(req.headers[name], 80);
  const country = header("cf-ipcountry") ?? header("x-vercel-ip-country") ?? null;
  const region = header("x-vercel-ip-country-region") ?? null;
  const city = header("x-vercel-ip-city") ?? null;
  return {
    country,
    region,
    city,
    source: country || region || city ? "proxy_header" : "unavailable",
  };
}

function likelySchoolRegion() {
  // Legacy column retained for compatibility. Do not infer school/region from
  // timezone or locale; those are device settings, not physical location.
  return "Unknown";
}

function geoHeaderDiagnostics(req) {
  const header = (name) => optionalShortText(req.headers[name], 80);
  return {
    requestGeo: coarseRegionFromRequest(req, {}),
    headers: {
      xForwardedForPresent: Boolean(req.headers["x-forwarded-for"]),
      cfIpCountry: header("cf-ipcountry"),
      vercelCountry: header("x-vercel-ip-country"),
      vercelRegion: header("x-vercel-ip-country-region"),
      vercelCity: header("x-vercel-ip-city"),
      railwayRegionPresent: Boolean(req.headers["x-railway-region"]),
    },
  };
}

function analyticsAlias(properties) {
  const value = properties?.anonymous_alias ?? properties?.public_alias;
  return optionalShortText(value, 80);
}

function analyticsDedupeKey({ installId, name, timestamp, properties }) {
  const sessionId = typeof properties?.anonymous_session_id === "string" ? properties.anonymous_session_id : "";
  const questionId = typeof properties?.question_id === "string"
    ? properties.question_id
    : typeof properties?.canonicalQuestionID === "string"
      ? properties.canonicalQuestionID
      : "";
  const result = typeof properties?.result === "string" ? properties.result : "";
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([installId, name, timestamp ?? "", sessionId, questionId, result, properties ?? {}]))
    .digest("hex");
}

export function feedbackNotificationPayload(feedback) {
  return {
    event: "feedback_received",
    feedback: {
      id: feedback.id,
      category: feedback.category,
      createdAt: feedback.createdAt,
      appVersion: feedback.appVersion || null,
      buildNumber: feedback.buildNumber || null,
      platform: feedback.platform || null,
      questionId: feedback.questionId || null,
    },
  };
}

export async function notifyFeedbackOwner(feedback, {
  webhookUrl = config.feedbackNotificationWebhookUrl,
  fetchImpl = fetch,
} = {}) {
  if (!webhookUrl) return { configured: false, delivered: false };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(feedbackNotificationPayload(feedback)),
      signal: controller.signal,
    });
    return { configured: true, delivered: response.ok };
  } catch (error) {
    console.error("[feedback] notification delivery failed", error?.name || "unknown_error");
    return { configured: true, delivered: false };
  } finally {
    clearTimeout(timeout);
  }
}

export const analyticsTestHooks = {
  analyticsDedupeKey,
  analyticsScope,
  requestedAnalyticsSegment,
  withScopedAppEvent,
  feedbackNotificationPayload,
  notifyFeedbackOwner,
};

function commaListEnv(name) {
  return String(process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function requestedAnalyticsSegment(value) {
  return ["all", "real", "internal"].includes(value) ? value : "all";
}

function analyticsScope(segment) {
  const internalInstallIds = commaListEnv("ANALYTICS_INTERNAL_INSTALL_IDS");
  const internalUserIds = commaListEnv("ANALYTICS_INTERNAL_USER_IDS");
  const internalPredicate = `(
    (array_length($1::text[], 1) is not null and install_id = any($1::text[]))
    or (array_length($2::text[], 1) is not null and properties->>'user_id' = any($2::text[]))
  )`;
  if (segment === "internal") {
    return internalInstallIds.length === 0 && internalUserIds.length === 0
      ? { params: [internalInstallIds, internalUserIds], cte: "select * from public.app_event where false", internalInstallIds, internalUserIds }
      : { params: [internalInstallIds, internalUserIds], cte: `select * from public.app_event where ${internalPredicate}`, internalInstallIds, internalUserIds };
  }
  if (segment === "real" && (internalInstallIds.length > 0 || internalUserIds.length > 0)) {
    return {
      params: [internalInstallIds, internalUserIds],
      cte: `select * from public.app_event where not ${internalPredicate}`,
      internalInstallIds,
      internalUserIds,
    };
  }
  return {
    params: [internalInstallIds, internalUserIds],
    cte: "select * from public.app_event where ($1::text[] is not null or true) and ($2::text[] is not null or true)",
    internalInstallIds,
    internalUserIds,
  };
}

function withScopedAppEvent(sql, scope) {
  const trimmed = sql.trimStart();
  if (/^with\b/i.test(trimmed)) {
    return trimmed.replace(/^with\b/i, `with app_event as (${scope.cte}),`);
  }
  return `with app_event as (${scope.cte}) ${trimmed}`;
}

function scopedQuery(scope, sql, params = []) {
  return query(withScopedAppEvent(sql, scope), [...scope.params, ...params]);
}

function sectionFallback(name) {
  if (name === "eventCounts") return { rows: [] };
  return { rows: [{}] };
}

async function summarySection(name, fn, diagnostics) {
  try {
    return await fn();
  } catch (error) {
    diagnostics.push({ section: name, message: error?.message ?? "Unknown analytics summary error" });
    return sectionFallback(name);
  }
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

function normalizedContentHash(promptText, answerText, truthStatementText) {
  const normalized = [promptText, answerText, truthStatementText]
    .map((value) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("|");
  return crypto.createHash("sha256").update(normalized).digest("hex");
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
    contentHash: body?.contentHash ?? body?.content_hash ?? null,
    canonicalStableId: body?.canonicalStableId ?? body?.canonical_stable_id ?? null,
    basedOnQuestionId: body?.basedOnQuestionId ?? body?.based_on_question_id ?? null,
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
    createdByUserId: input.created_by_user_id ?? input.createdByUserId ?? null,
    canonicalStableId: input.canonical_stable_id ?? input.canonicalStableId ?? null,
    basedOnQuestionId: input.based_on_question_id ?? input.basedOnQuestionId ?? null,
    moderationStatus: input.moderation_status ?? input.moderationStatus ?? null,
    contentHash: input.content_hash ?? input.contentHash ?? normalizedContentHash(promptText, answerText, truthStatementText),
    isLocalOnly: input.is_local_only ?? input.isLocalOnly ?? false,
    isCommunityQuestion: input.is_community_question ?? input.isCommunityQuestion ?? true,
    submittedToCommunityAt: input.submitted_to_community_at ?? input.submittedToCommunityAt ?? null,
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
    tvos_update_enforcer_enabled: process.env.TVOS_UPDATE_ENFORCER_ENABLED === "true",
    tvos_latest_version: process.env.TVOS_LATEST_VERSION ?? "1.0.0",
    tvos_min_supported_version: process.env.TVOS_MIN_SUPPORTED_VERSION ?? "1.0.0",
    tvos_latest_build: process.env.TVOS_LATEST_BUILD ?? "1",
    tvos_min_supported_build: process.env.TVOS_MIN_SUPPORTED_BUILD ?? "1",
  });
});

router.post("/analytics/events", async (req, res) => {
  try {
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (contentLength > 128 * 1024) {
      return res.status(413).json({ error: "Analytics payload too large." });
    }

    const installId = optionalShortText(req.body?.installId, 80) ?? optionalShortText(req.body?.anonymousInstallID, 80) ?? "legacy";
    const events = Array.isArray(req.body?.events)
      ? req.body.events
      : isNonEmptyString(req.body?.name)
        ? [{
            eventName: req.body.name,
            timestamp: req.body.timestamp,
            appVersion: req.body.appVersion,
            buildNumber: req.body.buildNumber,
            platform: req.body.platform,
            deviceFamily: req.body.deviceFamily,
            properties: req.body.properties,
          }]
        : null;
    if (!installId || !events || events.length === 0 || events.length > 50) {
      return res.status(400).json({ error: "installId and 1-50 events are required." });
    }

    const insertedIds = [];
    for (const event of events) {
      const name = typeof event?.eventName === "string" ? event.eventName.trim() : "";
      if (!name || name.length > 80) {
        return res.status(400).json({ error: "Each event needs a valid eventName." });
      }

      const platform = optionalShortText(event?.platform, 32);
      const appVersion = optionalShortText(event?.appVersion, 32);
      const buildNumber = optionalShortText(event?.buildNumber, 32);
      const deviceFamily = optionalShortText(event?.deviceFamily, 64);
      const osVersion = optionalShortText(event?.osVersion, 32);
      const locale = optionalShortText(event?.locale, 64);
      const localeRegion = optionalShortText(event?.localeRegion, 16);
      const timeZone = optionalShortText(event?.timeZone, 80);
      const timestamp = optionalDate(event?.timestamp);
      const properties = optionalJSONObject(event?.properties);
      const coarseRegion = coarseRegionFromRequest(req, { localeRegion });
      const schoolRegion = likelySchoolRegion();
      const anonymousAlias = analyticsAlias(properties);
      const dedupeKey = analyticsDedupeKey({ installId, name, timestamp, properties });

      const result = await query(
        `INSERT INTO app_event (
          id,
          install_id,
          name,
          platform,
          app_version,
          build_number,
          device_family,
          os_version,
          locale,
          locale_region,
          time_zone,
          properties,
          country,
          region,
          city,
          geolocation_source,
          anonymous_alias,
          event_dedupe_key,
          likely_school_region,
          occurred_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,COALESCE($20::timestamptz, now()))
        ON CONFLICT (event_dedupe_key) WHERE event_dedupe_key IS NOT NULL DO NOTHING
        RETURNING id`,
        [
          crypto.randomUUID(),
          installId,
          name,
          platform,
          appVersion,
          buildNumber,
          deviceFamily,
          osVersion,
          locale,
          localeRegion,
          timeZone,
          JSON.stringify(properties),
          coarseRegion.country,
          coarseRegion.region,
          coarseRegion.city,
          coarseRegion.source,
          anonymousAlias,
          dedupeKey,
          schoolRegion,
          timestamp,
        ]
      );
      if (result.rows[0]?.id) {
        insertedIds.push(result.rows[0].id);
      }
    }

    res.status(202).json({ ok: true, inserted: insertedIds.length, ids: insertedIds });
  } catch (error) {
    console.error("[analytics/events] insert failed", error);
    res.status(500).json({ error: "Unable to record event." });
  }
});

router.post("/feedback", async (req, res) => {
  try {
    const allowedCategories = new Set(["Bug", "Question", "Suggestion", "Other"]);
    const category = optionalShortText(req.body?.category, 24);
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!category || !allowedCategories.has(category) || !body || body.length > 4000) {
      return res.status(400).json({ error: "A valid category and feedback message are required." });
    }
    const questionId = optionalShortText(req.body?.questionId, 160);
    const includeAppDetails = req.body?.includeAppDetails === true;
    const appDetails = includeAppDetails ? {
      appVersion: optionalShortText(req.body?.appVersion, 32),
      buildNumber: optionalShortText(req.body?.buildNumber, 32),
      platform: optionalShortText(req.body?.platform, 32),
      deviceFamily: optionalShortText(req.body?.deviceFamily, 64),
      osVersion: optionalShortText(req.body?.osVersion, 32),
    } : {};
    const feedbackId = crypto.randomUUID();
    await query(
      `INSERT INTO app_feedback (id, category, body, question_id, app_details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [feedbackId, category, body, questionId, JSON.stringify(appDetails)]
    );
    void notifyFeedbackOwner({
      id: feedbackId,
      category,
      createdAt: new Date().toISOString(),
      questionId,
      ...appDetails,
    });
    res.status(202).json({ ok: true, id: feedbackId });
  } catch (error) {
    console.error("[feedback] insert failed", error);
    res.status(500).json({ error: "Unable to send feedback." });
  }
});

router.get("/admin/feedback", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const requestedLimit = Number.parseInt(req.query?.limit, 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 25;
    const before = req.query?.before ? new Date(req.query.before) : null;
    if (before && Number.isNaN(before.getTime())) return res.status(400).json({ error: "Invalid before cursor." });
    const result = await query(
      `select id, category, body, question_id, app_details, created_at
         from app_feedback
        where ($1::timestamptz is null or created_at < $1::timestamptz)
        order by created_at desc
        limit $2`,
      [before ? before.toISOString() : null, limit + 1]
    );
    const rows = result.rows.slice(0, limit).map((row) => {
      const details = row.app_details && typeof row.app_details === "object" ? row.app_details : {};
      return {
        id: row.id,
        category: row.category,
        message: row.body,
        timestamp: row.created_at,
        appVersion: details.appVersion || null,
        buildNumber: details.buildNumber || null,
        platform: details.platform || null,
        questionId: row.question_id || null,
      };
    });
    res.set("Cache-Control", "no-store");
    res.json({ feedback: rows, hasMore: result.rows.length > limit, nextBefore: rows.length ? rows.at(-1).timestamp : null });
  } catch (error) {
    console.error("[admin/feedback] list failed", error?.name || "unknown_error");
    res.status(500).json({ error: "Unable to load feedback." });
  }
});

router.get("/analytics/geo-diagnostics", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(geoHeaderDiagnostics(req));
});

router.get("/admin/analytics/summary", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const segment = requestedAnalyticsSegment(req.query?.segment);
    const scope = analyticsScope(segment);
    const summaryDiagnostics = [];
    if (segment !== req.query?.segment && req.query?.segment != null) {
      summaryDiagnostics.push({ section: "segment", message: "Unknown segment requested; defaulted to all activity." });
    }
    if (segment === "internal" && scope.internalInstallIds.length === 0 && scope.internalUserIds.length === 0) {
      summaryDiagnostics.push({ section: "segment", message: "No internal install IDs are configured." });
    }
    const safeAnalyticsQuery = async (sql) => {
      try {
        return await scopedQuery(scope, sql);
      } catch (error) {
        summaryDiagnostics.push({ section: "query", message: error?.message ?? "Analytics summary query failed." });
        return { rows: [] };
      }
    };

    const [
      lifecycle,
      appSessions,
      eventCounts,
      studyBehavior,
      platformBreakdown,
      appVersionBreakdown,
      installDiagnostics,
      mostStudiedPacks,
      leastStudiedPacks,
      topViewedQuestions,
      mostMissedQuestions,
      lowestCorrectRateQuestions,
      abandonedBeforeReveal,
      repeatedlyMissedQuestions,
      canonicalQuestionAnalytics,
      perUserStudyActivity,
      coarseGeography,
      recentStudyActivity,
      reliabilityFailures,
    ] = await Promise.all([
      safeAnalyticsQuery(`
        with first_seen as (
          select install_id, min(occurred_at) as first_seen_at
          from app_event
          where install_id is not null
          group by install_id
        )
        select
          (select count(*) from app_event)::int as total_events,
          count(*)::int as total_anonymous_installs,
          count(*) filter (where first_seen_at >= now() - interval '1 day')::int as new_1d,
          count(*) filter (where first_seen_at >= now() - interval '7 days')::int as new_7d,
          count(*) filter (where first_seen_at >= now() - interval '30 days')::int as new_30d,
          count(*) filter (
            where exists (
              select 1 from app_event e
              where e.install_id = first_seen.install_id
                and e.occurred_at >= now() - interval '1 day'
            )
          )::int as active_1d,
          count(*) filter (
            where exists (
              select 1 from app_event e
              where e.install_id = first_seen.install_id
                and e.occurred_at >= now() - interval '7 days'
            )
          )::int as active_7d,
          count(*) filter (
            where exists (
              select 1 from app_event e
              where e.install_id = first_seen.install_id
                and e.occurred_at >= now() - interval '30 days'
            )
          )::int as active_30d,
          count(*) filter (
            where first_seen_at < now() - interval '1 day'
              and exists (
                select 1 from app_event e
                where e.install_id = first_seen.install_id
                  and e.occurred_at >= now() - interval '1 day'
              )
          )::int as returning_1d,
          count(*) filter (
            where first_seen_at < now() - interval '7 days'
              and exists (
                select 1 from app_event e
                where e.install_id = first_seen.install_id
                  and e.occurred_at >= now() - interval '7 days'
              )
          )::int as returning_7d,
          count(*) filter (
            where first_seen_at < now() - interval '30 days'
              and exists (
                select 1 from app_event e
                where e.install_id = first_seen.install_id
                  and e.occurred_at >= now() - interval '30 days'
              )
          )::int as returning_30d
        from first_seen
      `),
      safeAnalyticsQuery(`
        select
          count(*) filter (where name = 'app_launch')::int as total,
          count(*) filter (where name = 'app_launch' and occurred_at >= now() - interval '1 day')::int as last_1_day,
          count(*) filter (where name = 'app_launch' and occurred_at >= now() - interval '7 days')::int as last_7_days,
          count(*) filter (where name = 'app_launch' and occurred_at >= now() - interval '30 days')::int as last_30_days
        from app_event
      `),
      safeAnalyticsQuery(`
        select name, count(*)::int as count
        from app_event
        group by name
        order by count desc, name asc
      `),
      safeAnalyticsQuery(`
        select
          count(*) filter (where name = 'study_session_started')::int as study_sessions_started,
          count(*) filter (where name = 'study_session_completed')::int as study_sessions_completed,
          count(*) filter (
            where name = 'study_session_started'
              and occurred_at < now() - interval '30 minutes'
              and not exists (
                select 1
                from app_event completed
                where completed.name = 'study_session_completed'
                  and completed.install_id = app_event.install_id
                  and coalesce(completed.properties->>'anonymous_session_id', '') = coalesce(app_event.properties->>'anonymous_session_id', '')
                  and completed.occurred_at >= app_event.occurred_at
                  and completed.occurred_at <= app_event.occurred_at + interval '6 hours'
              )
          )::int as study_sessions_abandoned,
          count(*) filter (where name = 'question_viewed')::int as questions_viewed,
          count(*) filter (where name = 'answer_revealed')::int as answers_revealed,
          count(*) filter (where name = 'answer_marked_correct')::int as correct_answers,
          count(*) filter (where name = 'answer_marked_incorrect')::int as incorrect_answers,
          count(*) filter (where name = 'pack_opened')::int as pack_opens,
          count(*) filter (where name = 'pack_completed')::int as pack_completions,
          count(*) filter (where name = 'library_opened')::int as library_opens,
          count(*) filter (where name = 'question_viewed' and properties->>'view_context' = 'library')::int as library_question_views,
          round(avg((properties->>'duration_ms')::numeric) filter (
            where name = 'study_session_completed'
              and properties->>'duration_ms' ~ '^[0-9]+(\\.[0-9]+)?$'
          ))::int as avg_session_duration_ms,
          round(avg((properties->>'completed_count')::numeric) filter (
            where name = 'study_session_completed'
              and properties->>'completed_count' ~ '^[0-9]+(\\.[0-9]+)?$'
          ), 1)::float as avg_questions_per_completed_session
        from app_event
      `),
      safeAnalyticsQuery(`
        select coalesce(platform, device_family, 'Unknown') as platform, count(*)::int as count
        from app_event
        group by coalesce(platform, device_family, 'Unknown')
        order by count desc
      `),
      safeAnalyticsQuery(`
        select coalesce(app_version, 'Unknown') as app_version,
               coalesce(build_number, 'Unknown') as build_number,
               count(distinct install_id)::int as installs,
               count(*)::int as events
        from app_event
        group by app_version, build_number
        order by events desc
        limit 20
      `),
      safeAnalyticsQuery(`
        select
          case
            when install_id is null then 'unknown'
            when length(install_id) <= 12 then install_id
            else left(install_id, 8) || '...' || right(install_id, 4)
          end as install_label,
          coalesce(max(anonymous_alias) filter (where anonymous_alias is not null), 'Unknown') as anonymous_alias,
          coalesce(max(platform) filter (where platform is not null), 'Unknown') as platform,
          coalesce(max(device_family) filter (where device_family is not null), 'Unknown') as device_family,
          coalesce(max(app_version) filter (where app_version is not null), 'Unknown') as app_version,
          coalesce(max(build_number) filter (where build_number is not null), 'Unknown') as build_number,
          coalesce(max(locale) filter (where locale is not null), 'Unknown') as locale,
          coalesce(max(time_zone) filter (where time_zone is not null), 'Unknown') as time_zone,
          coalesce(max(country) filter (where country is not null), 'Unknown') as country,
          coalesce(max(region) filter (where region is not null), 'Unknown') as region,
          coalesce(max(city) filter (where city is not null), 'Unknown') as city,
          coalesce(max(geolocation_source) filter (where geolocation_source is not null), 'unavailable') as geo_source,
          case
            when (
              (array_length($1::text[], 1) is not null and install_id = any($1::text[]))
              or (array_length($2::text[], 1) is not null and max(properties->>'user_id') = any($2::text[]))
            ) then 'internal/test'
            else 'real'
          end as likely_segment,
          min(occurred_at) as first_event_at,
          max(occurred_at) as last_event_at,
          count(*)::int as events
        from app_event
        where install_id is not null
        group by install_id
        order by last_event_at desc
        limit 100
      `),
      safeAnalyticsQuery(`
        select properties->>'pack_id' as pack_id, count(*)::int as count
        from app_event
        where name = 'question_viewed'
          and properties ? 'pack_id'
        group by pack_id
        order by count desc
        limit 25
      `),
      safeAnalyticsQuery(`
        select properties->>'pack_id' as pack_id, count(*)::int as count
        from app_event
        where name = 'question_viewed'
          and properties ? 'pack_id'
        group by pack_id
        order by count asc
        limit 25
      `),
      safeAnalyticsQuery(`
        with question_events as (
          select coalesce(properties->>'question_id', properties->>'canonicalQuestionID') as question_id,
                 count(*)::int as views,
                 max(properties->>'pack_id') as event_pack_id,
                 max(properties->>'topic') as event_topic,
                 max(properties->>'source') as event_source
          from app_event
          where name = 'question_viewed'
            and coalesce(properties->>'question_id', properties->>'canonicalQuestionID') is not null
            and coalesce(properties->>'is_private', 'false') <> 'true'
          group by question_id
        )
        select question_events.question_id,
               coalesce(nullif(left(coalesce(nullif(study_question.truth_statement_text, ''), study_question.prompt_text), 120), ''), question_events.question_id) as question_text,
               coalesce(study_question.content_pack_id, question_events.event_pack_id) as pack_id,
               coalesce(study_question.topic, question_events.event_topic) as topic,
               coalesce(study_question.source_origin, question_events.event_source) as source,
               study_question.status,
               question_events.views
        from question_events
        left join study_question
          on study_question.stable_id = question_events.question_id
          or study_question.canonical_stable_id = question_events.question_id
          or study_question.id::text = question_events.question_id
        order by question_events.views desc
        limit 25
      `),
      safeAnalyticsQuery(`
        with question_events as (
          select coalesce(properties->>'question_id', properties->>'canonicalQuestionID') as question_id,
                 count(*)::int as missed,
                 count(distinct install_id)::int as installs,
                 max(properties->>'pack_id') as event_pack_id,
                 max(properties->>'topic') as event_topic,
                 max(properties->>'source') as event_source
          from app_event
          where name in ('answer_marked_incorrect', 'study_card_marked_missed')
            and coalesce(properties->>'question_id', properties->>'canonicalQuestionID') is not null
            and coalesce(properties->>'is_private', 'false') <> 'true'
          group by question_id
        )
        select question_events.question_id,
               coalesce(nullif(left(coalesce(nullif(study_question.truth_statement_text, ''), study_question.prompt_text), 120), ''), question_events.question_id) as question_text,
               coalesce(study_question.content_pack_id, question_events.event_pack_id) as pack_id,
               coalesce(study_question.topic, question_events.event_topic) as topic,
               coalesce(study_question.source_origin, question_events.event_source) as source,
               study_question.status,
               question_events.missed,
               question_events.installs
        from question_events
        left join study_question
          on study_question.stable_id = question_events.question_id
          or study_question.canonical_stable_id = question_events.question_id
          or study_question.id::text = question_events.question_id
        order by question_events.missed desc
        limit 25
      `),
      safeAnalyticsQuery(`
        with rated as (
          select coalesce(properties->>'question_id', properties->>'canonicalQuestionID') as question_id,
                 count(*) filter (where name = 'answer_marked_correct')::int as correct,
                 count(*) filter (where name = 'answer_marked_incorrect')::int as incorrect,
                 count(*)::int as rated,
                 max(properties->>'pack_id') as pack_id,
                 max(properties->>'topic') as topic,
                 max(properties->>'source') as source
          from app_event
          where name in ('answer_marked_correct', 'answer_marked_incorrect')
            and coalesce(properties->>'question_id', properties->>'canonicalQuestionID') is not null
            and coalesce(properties->>'is_private', 'false') <> 'true'
          group by question_id
        )
        select rated.question_id,
               coalesce(nullif(left(coalesce(nullif(study_question.truth_statement_text, ''), study_question.prompt_text), 120), ''), rated.question_id) as question_text,
               rated.correct,
               rated.incorrect,
               rated.rated,
               round((rated.correct::numeric / nullif(rated.rated, 0)) * 100, 1)::float as correct_rate,
               coalesce(study_question.content_pack_id, rated.pack_id) as pack_id,
               coalesce(study_question.topic, rated.topic) as topic,
               coalesce(study_question.source_origin, rated.source) as source,
               study_question.status
        from rated
        left join study_question
          on study_question.stable_id = rated.question_id
          or study_question.canonical_stable_id = rated.question_id
          or study_question.id::text = rated.question_id
        where rated.rated > 0
        order by correct_rate asc, rated.rated desc
        limit 25
      `),
      safeAnalyticsQuery(`
        with viewed as (
          select coalesce(properties->>'question_id', properties->>'canonicalQuestionID') as question_id,
                 count(*)::int as views,
                 max(properties->>'pack_id') as pack_id,
                 max(properties->>'topic') as topic,
                 max(properties->>'source') as source
          from app_event
          where name = 'question_viewed'
            and coalesce(properties->>'question_id', properties->>'canonicalQuestionID') is not null
            and coalesce(properties->>'is_private', 'false') <> 'true'
          group by question_id
        ),
        reveal_or_answer as (
          select coalesce(properties->>'question_id', properties->>'canonicalQuestionID') as question_id,
                 count(*)::int as reveal_or_answer_count
          from app_event
          where name in ('answer_revealed', 'answer_marked_correct', 'answer_marked_incorrect')
            and coalesce(properties->>'question_id', properties->>'canonicalQuestionID') is not null
            and coalesce(properties->>'is_private', 'false') <> 'true'
          group by question_id
        ),
        abandoned_views as (
          select coalesce(viewed_event.properties->>'question_id', viewed_event.properties->>'canonicalQuestionID') as question_id,
                 count(*)::int as abandoned_before_reveal
          from app_event viewed_event
          where viewed_event.name = 'question_viewed'
            and viewed_event.occurred_at < now() - interval '30 minutes'
            and coalesce(viewed_event.properties->>'question_id', viewed_event.properties->>'canonicalQuestionID') is not null
            and coalesce(viewed_event.properties->>'is_private', 'false') <> 'true'
            and not exists (
              select 1
              from app_event next_event
              where next_event.install_id = viewed_event.install_id
                and coalesce(next_event.properties->>'anonymous_session_id', '') = coalesce(viewed_event.properties->>'anonymous_session_id', '')
                and coalesce(next_event.properties->>'question_id', next_event.properties->>'canonicalQuestionID') = coalesce(viewed_event.properties->>'question_id', viewed_event.properties->>'canonicalQuestionID')
                and next_event.name in ('answer_revealed', 'answer_marked_correct', 'answer_marked_incorrect')
                and next_event.occurred_at >= viewed_event.occurred_at
                and next_event.occurred_at <= viewed_event.occurred_at + interval '30 minutes'
            )
          group by question_id
        )
        select viewed.question_id,
               coalesce(nullif(left(coalesce(nullif(study_question.truth_statement_text, ''), study_question.prompt_text), 120), ''), viewed.question_id) as question_text,
               viewed.views,
               coalesce(reveal_or_answer.reveal_or_answer_count, 0)::int as reveal_or_answer_count,
               abandoned_views.abandoned_before_reveal,
               coalesce(study_question.content_pack_id, viewed.pack_id) as pack_id,
               coalesce(study_question.topic, viewed.topic) as topic,
               coalesce(study_question.source_origin, viewed.source) as source,
               study_question.status
        from viewed
        join abandoned_views on abandoned_views.question_id = viewed.question_id
        left join reveal_or_answer on reveal_or_answer.question_id = viewed.question_id
        left join study_question
          on study_question.stable_id = viewed.question_id
          or study_question.canonical_stable_id = viewed.question_id
          or study_question.id::text = viewed.question_id
        order by abandoned_views.abandoned_before_reveal desc, viewed.views desc
        limit 25
      `),
      safeAnalyticsQuery(`
        with question_events as (
          select coalesce(properties->>'question_id', properties->>'canonicalQuestionID') as question_id,
                 count(*)::int as missed,
                 count(distinct install_id)::int as installs,
                 max(properties->>'pack_id') as event_pack_id,
                 max(properties->>'topic') as event_topic,
                 max(properties->>'source') as event_source
          from app_event
          where name in ('answer_marked_incorrect', 'study_card_marked_missed')
            and coalesce(properties->>'question_id', properties->>'canonicalQuestionID') is not null
            and coalesce(properties->>'is_private', 'false') <> 'true'
          group by question_id
          having count(*) >= 2
        )
        select question_events.question_id,
               coalesce(nullif(left(coalesce(nullif(study_question.truth_statement_text, ''), study_question.prompt_text), 120), ''), question_events.question_id) as question_text,
               coalesce(study_question.content_pack_id, question_events.event_pack_id) as pack_id,
               coalesce(study_question.topic, question_events.event_topic) as topic,
               coalesce(study_question.source_origin, question_events.event_source) as source,
               study_question.status,
               question_events.missed,
               question_events.installs
        from question_events
        left join study_question
          on study_question.stable_id = question_events.question_id
          or study_question.canonical_stable_id = question_events.question_id
          or study_question.id::text = question_events.question_id
        order by question_events.missed desc, question_events.installs desc
        limit 25
      `),
      safeAnalyticsQuery(`
        with canonical_questions as (
          select stable_id as question_id,
                 left(coalesce(nullif(truth_statement_text, ''), prompt_text), 120) as question_text,
                 content_pack_id as pack_id,
                 topic,
                 source_origin as source,
                 status
          from study_question
          where status in ('published', 'approved')
        ),
        resolved_events as (
          select coalesce(study_question.stable_id, coalesce(app_event.properties->>'question_id', app_event.properties->>'canonicalQuestionID')) as question_id,
                 app_event.install_id,
                 app_event.name,
                 app_event.occurred_at,
                 coalesce(app_event.properties->>'anonymous_session_id', '') as anonymous_session_id
          from app_event
          left join study_question
            on study_question.stable_id = coalesce(app_event.properties->>'question_id', app_event.properties->>'canonicalQuestionID')
            or study_question.canonical_stable_id = coalesce(app_event.properties->>'question_id', app_event.properties->>'canonicalQuestionID')
            or study_question.id::text = coalesce(app_event.properties->>'question_id', app_event.properties->>'canonicalQuestionID')
          where app_event.name in ('question_viewed', 'answer_revealed', 'answer_marked_correct', 'answer_marked_incorrect')
            and coalesce(app_event.properties->>'question_id', app_event.properties->>'canonicalQuestionID') is not null
            and coalesce(app_event.properties->>'is_private', 'false') <> 'true'
        ),
        stats as (
          select question_id,
                 count(*) filter (where name = 'question_viewed')::int as views,
                 count(*) filter (where name = 'answer_revealed')::int as reveals,
                 count(*) filter (where name = 'answer_marked_correct')::int as correct,
                 count(*) filter (where name = 'answer_marked_incorrect')::int as incorrect,
                 count(*) filter (where name in ('answer_marked_correct', 'answer_marked_incorrect'))::int as rated,
                 count(distinct install_id) filter (where name in ('answer_marked_correct', 'answer_marked_incorrect'))::int as rated_installs
          from resolved_events
          group by question_id
        ),
        repeat_misses as (
          select question_id, count(*)::int as repeat_miss_installs
          from (
            select question_id, install_id, count(*)::int as misses
            from resolved_events
            where name = 'answer_marked_incorrect'
              and install_id is not null
            group by question_id, install_id
            having count(*) >= 2
          ) repeated
          group by question_id
        ),
        abandoned_views as (
          select viewed.question_id, count(*)::int as abandoned_before_reveal
          from resolved_events viewed
          where viewed.name = 'question_viewed'
            and viewed.occurred_at < now() - interval '30 minutes'
            and not exists (
              select 1
              from resolved_events next_event
              where next_event.install_id = viewed.install_id
                and next_event.anonymous_session_id = viewed.anonymous_session_id
                and next_event.question_id = viewed.question_id
                and next_event.name in ('answer_revealed', 'answer_marked_correct', 'answer_marked_incorrect')
                and next_event.occurred_at >= viewed.occurred_at
                and next_event.occurred_at <= viewed.occurred_at + interval '30 minutes'
            )
          group by viewed.question_id
        )
        select canonical_questions.question_id,
               canonical_questions.question_text,
               canonical_questions.pack_id,
               canonical_questions.topic,
               canonical_questions.source,
               canonical_questions.status,
               coalesce(stats.views, 0)::int as views,
               coalesce(stats.reveals, 0)::int as reveals,
               coalesce(stats.correct, 0)::int as correct,
               coalesce(stats.incorrect, 0)::int as incorrect,
               coalesce(stats.incorrect, 0)::int as missed_count,
               coalesce(abandoned_views.abandoned_before_reveal, 0)::int as abandoned_before_reveal,
               round((coalesce(stats.reveals, 0)::numeric / nullif(stats.views, 0)) * 100, 1)::float as reveal_rate,
               round((coalesce(stats.correct, 0)::numeric / nullif(stats.rated, 0)) * 100, 1)::float as correct_rate,
               round((coalesce(stats.incorrect, 0)::numeric / nullif(stats.rated, 0)) * 100, 1)::float as incorrect_rate,
               round((coalesce(stats.rated, 0)::numeric / nullif(stats.rated_installs, 0)), 2)::float as average_attempts,
               coalesce(repeat_misses.repeat_miss_installs, 0)::int as repeat_miss_installs
        from canonical_questions
        left join stats on stats.question_id = canonical_questions.question_id
        left join repeat_misses on repeat_misses.question_id = canonical_questions.question_id
        left join abandoned_views on abandoned_views.question_id = canonical_questions.question_id
        order by coalesce(stats.views, 0) desc, canonical_questions.question_id asc
      `),
      safeAnalyticsQuery(`
        with event_base as (
          select
            install_id,
            name,
            platform,
            device_family,
            app_version,
            build_number,
            anonymous_alias,
            properties,
            occurred_at,
            coalesce(properties->>'question_id', properties->>'canonicalQuestionID') as question_id,
            properties->>'view_context' as view_context
          from app_event
          where install_id is not null
        ),
        per_install as (
          select
            install_id,
            case
              when length(install_id) <= 12 then install_id
              else left(install_id, 8) || '...' || right(install_id, 4)
            end as install_label,
            coalesce(max(anonymous_alias) filter (where anonymous_alias is not null), 'Unknown') as anonymous_alias,
            coalesce(max(platform) filter (where platform is not null), max(device_family) filter (where device_family is not null), 'Unknown') as platform,
            coalesce(max(app_version) filter (where app_version is not null), 'Unknown') as app_version,
            coalesce(max(build_number) filter (where build_number is not null), 'Unknown') as build_number,
            min(occurred_at) as first_event_at,
            max(occurred_at) as last_event_at,
            count(*)::int as total_events,
            count(*) filter (where name = 'app_launch')::int as app_launches,
            count(*) filter (where name = 'study_session_started')::int as study_sessions_started,
            count(*) filter (where name = 'study_session_completed')::int as study_sessions_completed,
            count(*) filter (where name = 'question_viewed')::int as question_views,
            count(*) filter (where name = 'library_opened')::int as library_opens,
            count(*) filter (where name = 'question_viewed' and view_context = 'library')::int as library_question_views,
            count(*) filter (where name = 'answer_revealed')::int as answer_reveals,
            count(*) filter (where name = 'answer_marked_correct')::int as correct_marks,
            count(*) filter (where name = 'answer_marked_incorrect')::int as incorrect_marks,
            count(*) filter (where name = 'contribution_flow_opened')::int as contribution_opens,
            count(*) filter (where name = 'contribution_submitted')::int as contribution_submits,
            count(*) filter (where name = 'sign_in_with_apple_tapped')::int as sign_in_tapped,
            count(*) filter (where name = 'sign_in_with_apple_succeeded')::int as sign_in_succeeded,
            count(*) filter (where name = 'sign_in_with_apple_failed')::int as sign_in_failed,
            case
              when (
                (array_length($1::text[], 1) is not null and install_id = any($1::text[]))
                or (array_length($2::text[], 1) is not null and max(properties->>'user_id') = any($2::text[]))
              ) then 'internal/test'
              else 'real'
            end as segment_status
          from event_base
          group by install_id
        ),
        last_question as (
          select distinct on (install_id)
            install_id,
            question_id,
            name as last_question_event,
            occurred_at as last_question_at
          from event_base
          where question_id is not null
            and name in ('question_viewed', 'answer_revealed', 'answer_marked_correct', 'answer_marked_incorrect')
          order by install_id, occurred_at desc
        ),
        question_counts as (
          select
            install_id,
            question_id,
            count(*)::int as events
          from event_base
          where question_id is not null
            and name in ('question_viewed', 'answer_revealed', 'answer_marked_correct', 'answer_marked_incorrect')
          group by install_id, question_id
        ),
        top_question as (
          select install_id, question_id, events
          from (
            select
              question_counts.*,
              row_number() over (partition by install_id order by events desc, question_id asc) as rank
            from question_counts
          ) ranked
          where rank = 1
        )
        select
          per_install.install_label,
          per_install.anonymous_alias,
          per_install.platform,
          per_install.app_version,
          per_install.build_number,
          per_install.first_event_at,
          per_install.last_event_at,
          per_install.total_events,
          per_install.app_launches,
          per_install.study_sessions_started,
          per_install.study_sessions_completed,
          per_install.question_views,
          per_install.library_opens,
          per_install.library_question_views,
          (per_install.library_opens + per_install.library_question_views)::int as library_activity,
          per_install.answer_reveals,
          per_install.correct_marks,
          per_install.incorrect_marks,
          round((per_install.answer_reveals::numeric / nullif(per_install.question_views, 0)) * 100, 1)::float as reveal_rate,
          round((per_install.correct_marks::numeric / nullif(per_install.correct_marks + per_install.incorrect_marks, 0)) * 100, 1)::float as correct_rate,
          per_install.contribution_opens,
          per_install.contribution_submits,
          per_install.sign_in_tapped,
          per_install.sign_in_succeeded,
          per_install.sign_in_failed,
          last_question.question_id as last_question_id,
          coalesce(nullif(left(coalesce(nullif(last_study_question.truth_statement_text, ''), last_study_question.prompt_text), 120), ''), last_question.question_id) as last_question_text,
          last_question.last_question_event,
          last_question.last_question_at,
          top_question.question_id as top_question_id,
          coalesce(nullif(left(coalesce(nullif(top_study_question.truth_statement_text, ''), top_study_question.prompt_text), 120), ''), top_question.question_id) as top_question_text,
          top_question.events as top_question_events,
          per_install.segment_status
        from per_install
        left join last_question on last_question.install_id = per_install.install_id
        left join study_question last_study_question
          on last_study_question.stable_id = last_question.question_id
          or last_study_question.canonical_stable_id = last_question.question_id
          or last_study_question.id::text = last_question.question_id
        left join top_question on top_question.install_id = per_install.install_id
        left join study_question top_study_question
          on top_study_question.stable_id = top_question.question_id
          or top_study_question.canonical_stable_id = top_question.question_id
          or top_study_question.id::text = top_question.question_id
        order by per_install.last_event_at desc
        limit 100
      `),
      safeAnalyticsQuery(`
        select coalesce(country, 'Unknown') as server_country,
               coalesce(region, 'Unknown') as server_region,
               coalesce(city, 'Unknown') as server_city,
               coalesce(geolocation_source, 'unavailable') as geo_source,
               coalesce(time_zone, 'Unknown') as device_time_zone,
               coalesce(locale, 'Unknown') as device_locale,
               coalesce(platform, device_family, 'Unknown') as platform,
               count(distinct install_id)::int as installs,
               count(*)::int as events
        from app_event
        group by coalesce(country, 'Unknown'),
                 coalesce(region, 'Unknown'),
                 coalesce(city, 'Unknown'),
                 coalesce(geolocation_source, 'unavailable'),
                 coalesce(time_zone, 'Unknown'),
                 coalesce(locale, 'Unknown'),
                 coalesce(platform, device_family, 'Unknown')
        order by events desc
        limit 50
      `),
      safeAnalyticsQuery(`
        select occurred_at,
               coalesce(platform, device_family, 'Unknown') as platform,
               coalesce(app_version, 'Unknown') as app_version,
               coalesce(build_number, 'Unknown') as build_number,
               name,
               coalesce(properties->>'question_id', properties->>'canonicalQuestionID') as question_id,
               coalesce(nullif(left(coalesce(nullif(study_question.truth_statement_text, ''), study_question.prompt_text), 120), ''), coalesce(properties->>'question_id', properties->>'canonicalQuestionID')) as question_text,
               properties->>'result' as result,
               coalesce(study_question.source_origin, properties->>'source') as source,
               coalesce(study_question.topic, properties->>'topic') as topic,
               coalesce(study_question.content_pack_id, properties->>'pack_id') as pack_id,
               study_question.status
        from app_event
        left join study_question
          on study_question.stable_id = coalesce(properties->>'question_id', properties->>'canonicalQuestionID')
          or study_question.canonical_stable_id = coalesce(properties->>'question_id', properties->>'canonicalQuestionID')
          or study_question.id::text = coalesce(properties->>'question_id', properties->>'canonicalQuestionID')
        where name in (
          'question_viewed',
          'answer_revealed',
          'answer_marked_correct',
          'answer_marked_incorrect'
        )
        order by occurred_at desc
        limit 50
      `),
      safeAnalyticsQuery(`
        select name, count(*)::int as count
        from app_event
        where name in (
          'community_sync_failed',
          'sign_in_with_apple_failed',
          'purchase_failed',
          'restore_purchase_failed',
          'contribution_submit_failed',
          'question_bank_bootstrap_failed'
        )
        group by name
        order by count desc
      `),
    ]);

    const counts = Object.fromEntries(eventCounts.rows.map((row) => [row.name, Number(row.count)]));
    const study = studyBehavior.rows[0] ?? {};
    const studySessionsStarted = Number(study.study_sessions_started ?? 0);
    const studySessionsCompleted = Number(study.study_sessions_completed ?? 0);
    const questionsViewed = Number(study.questions_viewed ?? 0);
    const answersRevealed = Number(study.answers_revealed ?? 0);
    const correctAnswers = Number(study.correct_answers ?? 0);
    const incorrectAnswers = Number(study.incorrect_answers ?? 0);
    const totalRatedAnswers = correctAnswers + incorrectAnswers;
    const unansweredOrUnrated = Math.max(questionsViewed - totalRatedAnswers, 0);
    const studySessionsAbandoned = Number(study.study_sessions_abandoned ?? 0);
    const libraryOpens = Number(study.library_opens ?? 0);
    const libraryQuestionViews = Number(study.library_question_views ?? 0);
    let internalDiagnostics = { rows: [] };
    if (segment !== "real" && (scope.internalInstallIds.length > 0 || scope.internalUserIds.length > 0)) {
      try {
        internalDiagnostics = await query(`
          select
            case
              when install_id is null then 'unknown'
              when length(install_id) <= 12 then install_id
              else left(install_id, 8) || '...' || right(install_id, 4)
            end as install_label,
            coalesce(max(anonymous_alias) filter (where anonymous_alias is not null), 'Unknown') as anonymous_alias,
            coalesce(max(platform) filter (where platform is not null), 'Unknown') as platform,
            coalesce(max(app_version) filter (where app_version is not null), 'Unknown') as app_version,
            coalesce(max(build_number) filter (where build_number is not null), 'Unknown') as build_number,
            coalesce(max(locale) filter (where locale is not null), 'Unknown') as locale,
            coalesce(max(time_zone) filter (where time_zone is not null), 'Unknown') as time_zone,
            min(occurred_at) as first_event_at,
            max(occurred_at) as last_event_at,
            count(*)::int as events,
            case
              when install_id = any($1::text[]) then 'ANALYTICS_INTERNAL_INSTALL_IDS'
              else 'ANALYTICS_INTERNAL_USER_IDS'
            end as reason
          from app_event
          where install_id = any($1::text[])
             or properties->>'user_id' = any($2::text[])
          group by install_id
          order by last_event_at desc
          limit 100
        `, [scope.internalInstallIds, scope.internalUserIds]);
      } catch (error) {
        summaryDiagnostics.push({ section: "internalDiagnostics", message: error?.message ?? "Internal diagnostics query failed." });
      }
    }
    const lifecycleRow = lifecycle.rows[0] ?? {};
    const appSessionsRow = appSessions.rows[0] ?? {};
    const funnelCount = (name) => counts[name] ?? 0;
    const percent = (numerator, denominator) => {
      if (!denominator) return null;
      return Number(((numerator / denominator) * 100).toFixed(1));
    };

    res.json({
      segment,
      diagnostics: summaryDiagnostics,
      totalEvents: Number(lifecycleRow.total_events ?? 0),
      totalAnonymousInstalls: Number(lifecycleRow.total_anonymous_installs ?? 0),
      activeUsers: {
        dau: Number(lifecycleRow.active_1d ?? 0),
        wau: Number(lifecycleRow.active_7d ?? 0),
        mau: Number(lifecycleRow.active_30d ?? 0),
      },
      newUsers: {
        last1Day: Number(lifecycleRow.new_1d ?? 0),
        last7Days: Number(lifecycleRow.new_7d ?? 0),
        last30Days: Number(lifecycleRow.new_30d ?? 0),
      },
      returningUsers: {
        last1Day: Number(lifecycleRow.returning_1d ?? 0),
        last7Days: Number(lifecycleRow.returning_7d ?? 0),
        last30Days: Number(lifecycleRow.returning_30d ?? 0),
      },
      appSessions: {
        total: Number(appSessionsRow.total ?? 0),
        last1Day: Number(appSessionsRow.last_1_day ?? 0),
        last7Days: Number(appSessionsRow.last_7_days ?? 0),
        last30Days: Number(appSessionsRow.last_30_days ?? 0),
      },
      study: {
        sessionsStarted: studySessionsStarted,
        sessionsCompleted: studySessionsCompleted,
        sessionsAbandoned: studySessionsAbandoned,
        sessionAbandonmentRate: percent(studySessionsAbandoned, studySessionsStarted),
        averageSessionDurationMs: study.avg_session_duration_ms == null ? null : Number(study.avg_session_duration_ms),
        averageQuestionsPerCompletedSession: study.avg_questions_per_completed_session == null ? null : Number(study.avg_questions_per_completed_session),
        averageStudySessionsPerDay: Number((studySessionsStarted / 30).toFixed(2)),
        questionsViewed,
        answersRevealed,
        revealRate: percent(answersRevealed, questionsViewed),
        correctAnswers,
        incorrectAnswers,
        unansweredOrUnrated,
        correctPercentage: percent(correctAnswers, totalRatedAnswers),
        incorrectPercentage: percent(incorrectAnswers, totalRatedAnswers),
        libraryOpens,
        libraryQuestionViews,
        libraryActivity: libraryOpens + libraryQuestionViews,
        studyToLibraryRatio: (libraryOpens + libraryQuestionViews) === 0 ? null : Number((studySessionsStarted / (libraryOpens + libraryQuestionViews)).toFixed(2)),
      },
      content: {
        mostStudiedPacks: mostStudiedPacks.rows,
        leastStudiedPacks: leastStudiedPacks.rows,
        topCanonicalQuestionsByViews: topViewedQuestions.rows,
        mostMissedCanonicalQuestions: mostMissedQuestions.rows,
        lowestCorrectRateQuestions: lowestCorrectRateQuestions.rows,
        questionsAbandonedBeforeReveal: abandonedBeforeReveal.rows,
        questionsRepeatedlyMissed: repeatedlyMissedQuestions.rows,
        canonicalQuestionAnalytics: canonicalQuestionAnalytics.rows,
        questionPerformance: canonicalQuestionAnalytics.rows,
      },
      communityFunnel: {
        contributionPageOpened: funnelCount("contribution_flow_opened"),
        signInWithAppleTapped: funnelCount("sign_in_with_apple_tapped"),
        signInSucceeded: funnelCount("sign_in_with_apple_succeeded"),
        signInFailed: funnelCount("sign_in_with_apple_failed"),
        contributionSubmitted: funnelCount("contribution_submitted"),
        contributionSubmitFailed: funnelCount("contribution_submit_failed"),
        contributionApproved: funnelCount("contribution_approved"),
        contributionRejected: funnelCount("contribution_rejected"),
      },
      purchaseFunnel: {
        purchaseScreenOpened: funnelCount("purchase_screen_opened"),
        purchaseStarted: funnelCount("purchase_started"),
        purchaseSucceeded: funnelCount("purchase_succeeded"),
        purchaseFailed: funnelCount("purchase_failed"),
        restorePurchaseStarted: funnelCount("restore_purchase_started"),
        restorePurchaseSucceeded: funnelCount("restore_purchase_succeeded"),
        restorePurchaseFailed: funnelCount("restore_purchase_failed"),
        purchaseConversionPercentage: percent(funnelCount("purchase_succeeded"), funnelCount("purchase_screen_opened")),
      },
      privateCards: {
        created: funnelCount("private_card_created"),
        shared: funnelCount("private_card_shared_completed"),
      },
      platformBreakdown: platformBreakdown.rows,
      appVersionBreakdown: appVersionBreakdown.rows,
      installDiagnostics: installDiagnostics.rows,
      perUserStudyActivity: perUserStudyActivity.rows,
      internalDiagnostics: internalDiagnostics.rows,
      coarseGeography: coarseGeography.rows,
      geoHeaderDiagnostics: geoHeaderDiagnostics(req),
      recentStudyActivity: recentStudyActivity.rows,
      reliabilityFailures: reliabilityFailures.rows,
      eventCounts: counts,
      auditNotes: [
        "App sessions are counted from app_launch events. The previous summary queried session_start, which the app does not emit.",
        "Canonical question tables now read question_id as emitted by the app, with canonicalQuestionID retained as a legacy fallback.",
        "Session abandonment counts study_session_started events older than 30 minutes with no study_session_completed event for the same anonymous install/session within 6 hours.",
        "Abandoned before reveal counts question_viewed events older than 30 minutes with no later reveal or rating for the same anonymous install/session/question within 30 minutes.",
        "Server country/region/city are captured only from coarse proxy geolocation headers when present. Timezone and locale are client-provided device settings and are not physical-location proof.",
      ],
    });
  } catch (err) {
    console.error("[admin/analytics/summary]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// TEMPORARY admin analytics bootstrap for pre-App-Store testing only.
// Remove after analytics verification. This does not bypass analytics auth; it
// only mints a normal backend JWT for the single known admin test user when the
// caller knows TEMP_ADMIN_BOOTSTRAP_TOKEN from Railway environment variables.
router.post("/admin/bootstrap-token", async (req, res) => {
  try {
    const expectedToken = config.tempAdminBootstrapToken;
    const providedToken = req.get("X-Admin-Bootstrap-Token");
    if (!expectedToken || providedToken !== expectedToken) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const before = await query(
      "select id, role from app_user where id = $1",
      [TEMP_ANALYTICS_BOOTSTRAP_USER_ID]
    );

    if (before.rowCount !== 1) {
      return res.status(404).json({ error: "Bootstrap user not found" });
    }

    const previousRole = before.rows[0].role;
    if (!["owner", "admin"].includes(previousRole)) {
      await query(
        "update app_user set role = 'owner', updated_at = now() where id = $1",
        [TEMP_ANALYTICS_BOOTSTRAP_USER_ID]
      );
    }

    const after = await query(
      "select id, role from app_user where id = $1",
      [TEMP_ANALYTICS_BOOTSTRAP_USER_ID]
    );
    const user = after.rows[0];
    const token = await issueJwt({ id: user.id, role: user.role });

    res.json({
      userId: user.id,
      previousRole,
      newRole: user.role,
      token,
    });
  } catch (err) {
    console.error("[admin/bootstrap-token]", err);
    res.status(500).json({ error: "Internal server error" });
  }
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

router.post(
  "/admin/questions/import",
  requireAuth,
  requireRole("owner"),
  express.text({ type: ["text/csv", "text/plain"], limit: "10mb" }),
  (req, res) => handleOwnerQuestionImport(req, res)
);

export async function handleOwnerQuestionImport(
  req,
  res,
  { queryFn = query, withTransactionFn = withTransaction } = {}
) {
  try {
    const csvText = typeof req.body === "string" ? req.body : "";
    const dryRun = req.query.dry_run !== "false";

    if (dryRun) {
      const { rows } = await queryFn(
        `select stable_id, content_hash, truth_statement_text
         from study_question`
      );
      const evaluation = evaluateOwnerQuestionCSV(csvText, rows);
      return res.json({ ...publicImportResult(evaluation), dryRun: true, imported: 0 });
    }

    const committed = await withTransactionFn(async (client) => {
      await client.query("LOCK TABLE study_question IN SHARE ROW EXCLUSIVE MODE");
      const { rows } = await client.query(
        `select stable_id, content_hash, truth_statement_text
         from study_question`
      );
      const evaluation = evaluateOwnerQuestionCSV(csvText, rows);
      if (!evaluation.ok) return { evaluation, imported: 0 };

      for (const item of evaluation.validRows) {
        const questionId = crypto.randomUUID();
        const submissionId = crypto.randomUUID();
        await client.query(
          `insert into study_question
             (id, stable_id, content_pack_id, topic, tags, prompt_text, answer_text,
              truth_statement_text, cloze_variants_json, source_origin, status,
              created_by_user_id, canonical_stable_id, moderation_status, content_hash,
              is_local_only, is_community_question, submitted_to_community_at, created_at, updated_at)
           values
             ($1,$2,$3,$4,$5,$6,$6,$6,null,'owner-csv-import','published',
              $7,$2,'published',$8,false,true,now(),now(),now())`,
          [
            questionId,
            item.stableId,
            OWNER_IMPORT_PACK_ID,
            item.category,
            item.tags,
            item.statement,
            req.user.sub,
            item.contentHash,
          ]
        );
        await client.query(
          `insert into study_submission
             (id, question_id, stable_id, content_pack_id, topic, tags, prompt_text,
              answer_text, truth_statement_text, authored_text, cloze_variants_json,
              submitter_id, submitter_alias, reason, note, status, content_hash,
              canonical_stable_id, created_at, updated_at)
           values
             ($1,$2,$3,$4,$5,$6,$7,$7,$7,$7,null,$8,'owner','owner-csv-import',
              'Imported from owner CSV','approved',$9,$3,now(),now())`,
          [
            submissionId,
            questionId,
            item.stableId,
            OWNER_IMPORT_PACK_ID,
            item.category,
            item.tags,
            item.statement,
            req.user.sub,
            item.contentHash,
          ]
        );
      }
      return { evaluation, imported: evaluation.validRows.length };
    });

    if (!committed.evaluation.ok) {
      return res.status(409).json({
        ...publicImportResult(committed.evaluation),
        dryRun: false,
        imported: 0,
        error: "Import changed or contains rejected rows. Run dry-run again.",
      });
    }

    const result = publicImportResult(committed.evaluation);
    result.results = result.results.map((item) => item.status === "valid"
      ? { ...item, status: "imported", message: "Imported and published." }
      : item);
    return res.json({ ...result, dryRun: false, imported: committed.imported });
  } catch (err) {
    console.error("[admin/questions/import]", err);
    return res.status(500).json({ error: "Import failed; no questions were committed." });
  }
}

function publicImportResult(evaluation) {
  const { validRows: _validRows, ...result } = evaluation;
  return result;
}

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
      contentHash,
      canonicalStableId,
      basedOnQuestionId,
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
    const usedContentHash = isNonEmptyString(contentHash)
      ? contentHash.trim()
      : normalizedContentHash(promptText ?? "", answerText ?? "", truthStatementText ?? "");
    const usedCanonicalStableId = isNonEmptyString(canonicalStableId ?? req.body?.canonical_stable_id)
      ? String(canonicalStableId ?? req.body?.canonical_stable_id).trim()
      : null;
    const usedBasedOnQuestionId = isNonEmptyString(basedOnQuestionId ?? req.body?.based_on_question_id)
      ? String(basedOnQuestionId ?? req.body?.based_on_question_id).trim()
      : null;
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
       where submitter_id = $1
         and reason = 'new-card'
         and status in ('pending', 'approved')
         and (stable_id = $2 or content_hash = $3)
       order by created_at desc
       limit 1`,
      [req.user.sub, usedStableId, usedContentHash]
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
      usedContentHash,
      usedCanonicalStableId,
      usedBasedOnQuestionId,
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
      content_hash: insertValues[14],
      canonical_stable_id: insertValues[15],
      based_on_question_id: insertValues[16],
    });
    await query(
      `insert into study_submission
         (id, question_id, stable_id, content_pack_id, topic, tags, prompt_text, answer_text,
          truth_statement_text, authored_text, cloze_variants_json, proposed_cloze_variants_json,
          submitter_id, submitter_alias, reason, note, status, content_hash, canonical_stable_id, based_on_question_id)
       values ($1,null,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'new-card',$14,'pending',$15,$16,$17)`,
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
         coalesce(study_submission.stable_id, study_question.stable_id) as stable_id,
         study_submission.content_hash as content_hash,
         study_submission.canonical_stable_id as canonical_stable_id,
         study_submission.based_on_question_id as based_on_question_id
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
         study_submission.submitter_id,
         coalesce(study_submission.stable_id, study_question.stable_id) as stable_id,
         study_submission.content_hash as content_hash,
         study_submission.canonical_stable_id as canonical_stable_id,
         study_submission.based_on_question_id as based_on_question_id,
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
            cloze_variants_json, source_origin, status, created_by_user_id, canonical_stable_id, based_on_question_id,
            moderation_status, content_hash, is_local_only, is_community_question, submitted_to_community_at, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'user-submission','published',$10,$11,$12,'published',$13,false,true,now(),now(),now())
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
           created_by_user_id    = coalesce(study_question.created_by_user_id, excluded.created_by_user_id),
           canonical_stable_id   = coalesce(excluded.canonical_stable_id, study_question.canonical_stable_id),
           based_on_question_id  = coalesce(excluded.based_on_question_id, study_question.based_on_question_id),
           moderation_status     = 'published',
           content_hash          = coalesce(excluded.content_hash, study_question.content_hash),
           is_local_only         = false,
           is_community_question = true,
           submitted_to_community_at = coalesce(study_question.submitted_to_community_at, excluded.submitted_to_community_at),
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
          question.submitter_id ?? req.user.sub,
          question.canonical_stable_id ?? null,
          question.based_on_question_id ?? null,
          question.content_hash ?? normalizedContentHash(question.prompt_text ?? "", question.answer_text ?? "", question.truth_statement_text ?? ""),
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
