import crypto from "crypto";
import { query } from "./db.js";

export const FEEDBACK_V1_VERSION = 1;

const JOURNEY_STAGES = new Set([
  "starting_school_soon",
  "currently_in_school",
  "independent_adx",
  "certificated",
  "just_exploring",
]);

const SCHOOL_CODES = new Set([
  "aircraft_dispatch_academy",
  "ifod",
  "flight_dispatch_network",
  "flamingo_air_academy",
  "jeppesen_dispatch_academy",
  "other",
]);

const SCHOOL_TITLES = new Map([
  ["aircraft_dispatch_academy", "Aircraft Dispatch Academy (ADA)"],
  ["ifod", "Institute of Flight Operations and Dispatch (IFOD)"],
  ["flight_dispatch_network", "Flight Dispatch Network (FDN)"],
  ["flamingo_air_academy", "Flamingo Air Academy"],
  ["jeppesen_dispatch_academy", "Jeppesen Dispatch Academy"],
  ["other", "Other"],
]);

const JOBS_TO_BE_DONE = new Set([
  "pass_adx",
  "keep_up_with_school",
  "understand_material",
  "practice_and_review",
  "prepare_for_interviews",
  "stay_sharp",
  "just_curious",
  "other",
]);

const CURRENT_VALUES = new Set([
  "better_than_expected",
  "pretty_useful",
  "okay",
  "not_what_i_wanted",
  "not_used_enough",
]);

const DISCOVERY_SOURCES = new Set([
  "app_store",
  "school_or_instructor",
  "classmate_or_coworker",
  "reddit",
  "web_search",
  "social_media",
  "recommendation",
  "other",
  "prefer_not_to_say",
]);

const PURCHASE_ANSWERS = new Set([
  "did_not_know",
  "considering",
  "too_expensive",
  "do_not_need_yet",
  "free_material_only",
  "no",
  "prefer_not_to_say",
]);

const SUBSCRIBER_STATES = new Set(["subscriber", "non_subscriber", "unknown"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredText(value, maxLength) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

function optionalText(value, maxLength) {
  if (value == null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, value: null };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  return { ok: trimmed.length <= maxLength, value: trimmed.length <= maxLength ? trimmed : null };
}

function enumValue(value, allowed, required) {
  if (!required && (value == null || value === "")) return { ok: true, value: null };
  return { ok: typeof value === "string" && allowed.has(value), value };
}

export function validateFeedbackV1Response(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "A valid feedback response is required." };
  }

  const promptInstanceId = requiredText(body.promptInstanceId, 64);
  const installId = requiredText(body.anonymousInstallId, 160);
  const journey = enumValue(body.journeyStage, JOURNEY_STAGES, true);
  const job = enumValue(body.jobToBeDone, JOBS_TO_BE_DONE, true);
  const currentValue = enumValue(body.currentValue, CURRENT_VALUES, true);
  const discovery = enumValue(body.discoverySource, DISCOVERY_SOURCES, false);
  const purchase = enumValue(body.purchaseAnswer, PURCHASE_ANSWERS, false);
  const subscriber = enumValue(body.subscriberState, SUBSCRIBER_STATES, true);
  const legacySchool = optionalText(body.school, 200);
  const schoolCode = enumValue(body.schoolCode, SCHOOL_CODES, false);
  const schoolName = optionalText(body.schoolName, 200);
  const retention = optionalText(body.retentionText, 1000);

  if (body.feedbackVersion !== FEEDBACK_V1_VERSION) {
    return { ok: false, error: "Unsupported feedback version." };
  }
  if (!promptInstanceId || !UUID_PATTERN.test(promptInstanceId) || !installId) {
    return { ok: false, error: "A valid prompt and installation identifier are required." };
  }
  if (!journey.ok || !job.ok || !currentValue.ok || !discovery.ok || !purchase.ok || !subscriber.ok) {
    return { ok: false, error: "One or more feedback answers are invalid." };
  }
  if (!legacySchool.ok || !schoolName.ok || !retention.ok) {
    return { ok: false, error: "A feedback text field is too long or invalid." };
  }
  if (!schoolCode.ok) {
    return { ok: false, error: "The selected school is invalid." };
  }
  const normalizedSchoolCode = schoolCode.value ?? (legacySchool.value ? "other" : null);
  const normalizedSchoolName = schoolName.value ?? legacySchool.value;
  const schoolJourney = journey.value === "starting_school_soon" || journey.value === "currently_in_school";
  if ((!schoolJourney && (normalizedSchoolCode || normalizedSchoolName))
      || (normalizedSchoolName && normalizedSchoolCode !== "other")) {
    return { ok: false, error: "The school response is inconsistent with the selected journey." };
  }
  if (subscriber.value === "subscriber" && purchase.value != null) {
    return { ok: false, error: "Purchase feedback is not accepted for active subscribers." };
  }

  return {
    ok: true,
    value: {
      promptInstanceId,
      installId,
      journeyStage: journey.value,
      schoolCode: normalizedSchoolCode,
      schoolName: normalizedSchoolName,
      jobToBeDone: job.value,
      currentValue: currentValue.value,
      retentionText: retention.value,
      discoverySource: discovery.value,
      purchaseAnswer: purchase.value,
      subscriberState: subscriber.value,
      appVersion: optionalText(body.appVersion, 32).value,
      buildNumber: optionalText(body.buildNumber, 32).value,
      platform: optionalText(body.platform, 32).value,
    },
  };
}

export async function handleFeedbackV1Submission(req, res, { queryFn = query } = {}) {
  const validation = validateFeedbackV1Response(req.body);
  if (!validation.ok) return res.status(400).json({ error: validation.error });
  const value = validation.value;
  try {
    const responseId = crypto.randomUUID();
    const inserted = await queryFn(
      `INSERT INTO feedback_v1_response
        (id, prompt_instance_id, install_id, feedback_version, journey_stage, school_code, school,
         job_to_be_done, current_value, retention_text, discovery_source, purchase_answer,
         subscriber_state, app_version, build_number, platform)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (prompt_instance_id) DO NOTHING
       RETURNING id`,
      [
        responseId,
        value.promptInstanceId,
        value.installId,
        FEEDBACK_V1_VERSION,
        value.journeyStage,
        value.schoolCode,
        value.schoolName,
        value.jobToBeDone,
        value.currentValue,
        value.retentionText,
        value.discoverySource,
        value.purchaseAnswer,
        value.subscriberState,
        value.appVersion,
        value.buildNumber,
        value.platform,
      ]
    );
    if (inserted.rows[0]?.id) {
      return res.status(201).json({ ok: true, id: inserted.rows[0].id, duplicate: false });
    }
    const existing = await queryFn(
      "SELECT id FROM feedback_v1_response WHERE prompt_instance_id = $1",
      [value.promptInstanceId]
    );
    return res.status(200).json({ ok: true, id: existing.rows[0]?.id, duplicate: true });
  } catch (error) {
    console.error("[feedback-v1] response insert failed", error?.name || "unknown_error");
    return res.status(500).json({ error: "Unable to send feedback." });
  }
}

export async function handleFeedbackV1TesterInterest(req, res, { queryFn = query } = {}) {
  const promptInstanceId = requiredText(req.body?.promptInstanceId, 64);
  if (!promptInstanceId || !UUID_PATTERN.test(promptInstanceId)) {
    return res.status(400).json({ error: "A valid prompt identifier is required." });
  }
  try {
    const result = await queryFn(
      `UPDATE feedback_v1_response
          SET tester_interest_at = COALESCE(tester_interest_at, now())
        WHERE prompt_instance_id = $1
        RETURNING id`,
      [promptInstanceId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Feedback response not found." });
    return res.json({ ok: true });
  } catch (error) {
    console.error("[feedback-v1] tester interest update failed", error?.name || "unknown_error");
    return res.status(500).json({ error: "Unable to save tester interest." });
  }
}

export function validateFeedbackV1Contact(body) {
  const promptInstanceId = requiredText(body?.promptInstanceId, 64);
  const email = requiredText(body?.email, 254);
  if (!promptInstanceId || !UUID_PATTERN.test(promptInstanceId)) {
    return { ok: false, error: "A valid prompt identifier is required." };
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  return { ok: true, value: { promptInstanceId, email: email.toLowerCase() } };
}

export async function handleFeedbackV1Contact(req, res, { queryFn = query } = {}) {
  const validation = validateFeedbackV1Contact(req.body);
  if (!validation.ok) return res.status(400).json({ error: validation.error });
  try {
    const response = await queryFn(
      "SELECT id, tester_interest_at FROM feedback_v1_response WHERE prompt_instance_id = $1",
      [validation.value.promptInstanceId]
    );
    if (!response.rows[0]) return res.status(404).json({ error: "Feedback response not found." });
    if (!response.rows[0].tester_interest_at) {
      return res.status(409).json({ error: "Tester interest must be recorded first." });
    }
    const contactId = crypto.randomUUID();
    const result = await queryFn(
      `INSERT INTO feedback_v1_contact (id, response_id, email, consent_version)
       VALUES ($1,$2,$3,'feedback_tester_v1')
       ON CONFLICT (response_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [contactId, response.rows[0].id, validation.value.email]
    );
    return res.status(201).json({ ok: true, id: result.rows[0].id });
  } catch (error) {
    console.error("[feedback-v1] contact insert failed", error?.name || "unknown_error");
    return res.status(500).json({ error: "Unable to save contact information." });
  }
}

export async function handleOwnerFeedbackV1List(req, res, { queryFn = query } = {}) {
  const requestedLimit = Number.parseInt(req.query?.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const before = req.query?.before ? new Date(req.query.before) : null;
  if (before && Number.isNaN(before.getTime())) return res.status(400).json({ error: "Invalid before cursor." });
  try {
    const result = await queryFn(
      `SELECT r.id, r.prompt_instance_id, r.submitted_at, r.journey_stage, r.school_code, r.school,
              r.job_to_be_done, r.current_value, r.retention_text, r.discovery_source,
              r.purchase_answer, r.subscriber_state, r.app_version, r.build_number,
              r.platform, r.tester_interest_at, c.email, c.created_at AS contact_created_at
         FROM feedback_v1_response r
         LEFT JOIN feedback_v1_contact c ON c.response_id = r.id
        WHERE ($1::timestamptz IS NULL OR r.submitted_at < $1::timestamptz)
        ORDER BY r.submitted_at DESC
        LIMIT $2`,
      [before ? before.toISOString() : null, limit + 1]
    );
    const interviews = result.rows.slice(0, limit).map((row) => ({
      id: row.id,
      promptInstanceId: row.prompt_instance_id,
      timestamp: row.submitted_at,
      journeyStage: row.journey_stage,
      school: feedbackV1SchoolDisplay(row.school_code, row.school),
      schoolCode: row.school_code,
      schoolName: row.school,
      jobToBeDone: row.job_to_be_done,
      currentValue: row.current_value,
      retentionText: row.retention_text,
      discoverySource: row.discovery_source,
      purchaseAnswer: row.purchase_answer,
      subscriberState: row.subscriber_state,
      appVersion: row.app_version,
      buildNumber: row.build_number,
      platform: row.platform,
      testerInterested: Boolean(row.tester_interest_at),
      contact: row.email ? { email: row.email, submittedAt: row.contact_created_at } : null,
    }));
    res.set("Cache-Control", "no-store");
    return res.json({
      interviews,
      hasMore: result.rows.length > limit,
      nextBefore: interviews.length ? interviews.at(-1).timestamp : null,
    });
  } catch (error) {
    console.error("[admin/feedback-v1] list failed", error?.name || "unknown_error");
    return res.status(500).json({ error: "Unable to load feedback interviews." });
  }
}

function feedbackV1SchoolDisplay(schoolCode, schoolName) {
  if (!schoolCode) return schoolName ?? null;
  const title = SCHOOL_TITLES.get(schoolCode) ?? schoolCode;
  return schoolCode === "other" && schoolName ? `${title} — ${schoolName}` : title;
}
