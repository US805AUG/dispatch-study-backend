import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { issueJwt } from "../src/auth.js";
import { config } from "../src/config.js";
import { router } from "../src/routes.js";
import {
  handleFeedbackV1Contact,
  handleFeedbackV1Submission,
  handleFeedbackV1TesterInterest,
  handleOwnerFeedbackV1List,
  validateFeedbackV1Contact,
  validateFeedbackV1Response,
} from "../src/feedbackV1.js";

const promptInstanceId = "d8e5f96b-3bb2-4b9a-b1a1-65bc714bfce4";

function validResponse(overrides = {}) {
  return {
    promptInstanceId,
    anonymousInstallId: "install-1",
    feedbackVersion: 1,
    journeyStage: "currently_in_school",
    schoolCode: "ifod",
    schoolName: null,
    jobToBeDone: "keep_up_with_school",
    currentValue: "pretty_useful",
    retentionText: "More explanations.",
    discoverySource: "app_store",
    purchaseAnswer: "considering",
    subscriberState: "non_subscriber",
    appVersion: "1.7.4",
    buildNumber: "190",
    platform: "iOS",
    ...overrides,
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("validates complete and optional Feedback V1 responses", () => {
  assert.equal(validateFeedbackV1Response(validResponse()).ok, true);
  const minimal = validResponse({ schoolCode: null, schoolName: null, retentionText: null, discoverySource: null, purchaseAnswer: null });
  assert.equal(validateFeedbackV1Response(minimal).ok, true);
});

test("rejects invalid enums and bounded free text", () => {
  assert.equal(validateFeedbackV1Response(validResponse({ journeyStage: "student-ish" })).ok, false);
  assert.equal(validateFeedbackV1Response(validResponse({ schoolCode: "not_a_school" })).ok, false);
  assert.equal(validateFeedbackV1Response(validResponse({ retentionText: "x".repeat(1001) })).ok, false);
  assert.equal(validateFeedbackV1Response(validResponse({ schoolCode: "other", schoolName: "x".repeat(201) })).ok, false);
});

test("normalizes named, other, skipped, and legacy school submissions", () => {
  const named = validateFeedbackV1Response(validResponse());
  assert.deepEqual([named.value.schoolCode, named.value.schoolName], ["ifod", null]);
  const other = validateFeedbackV1Response(validResponse({ schoolCode: "other", schoolName: "Mountain West Dispatch" }));
  assert.deepEqual([other.value.schoolCode, other.value.schoolName], ["other", "Mountain West Dispatch"]);
  const skipped = validateFeedbackV1Response(validResponse({ schoolCode: null, schoolName: null }));
  assert.deepEqual([skipped.value.schoolCode, skipped.value.schoolName], [null, null]);
  const legacy = validateFeedbackV1Response(validResponse({ schoolCode: undefined, schoolName: undefined, school: "Legacy School" }));
  assert.deepEqual([legacy.value.schoolCode, legacy.value.schoolName], ["other", "Legacy School"]);
});

test("rejects school data for unrelated journeys and custom names for named choices", () => {
  assert.equal(validateFeedbackV1Response(validResponse({ journeyStage: "certificated" })).ok, false);
  assert.equal(validateFeedbackV1Response(validResponse({ schoolName: "Should not accompany IFOD" })).ok, false);
});

test("rejects purchase answers for active subscribers", () => {
  assert.equal(validateFeedbackV1Response(validResponse({ subscriberState: "subscriber" })).ok, false);
  assert.equal(validateFeedbackV1Response(validResponse({ subscriberState: "subscriber", purchaseAnswer: null })).ok, true);
});

test("submission is idempotent by prompt instance", async () => {
  const calls = [];
  const res = responseRecorder();
  await handleFeedbackV1Submission({ body: validResponse() }, res, {
    queryFn: async (statement, params) => {
      calls.push({ statement, params });
      if (statement.startsWith("INSERT")) return { rows: [] };
      return { rows: [{ id: "existing-response" }] };
    },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, id: "existing-response", duplicate: true });
  assert.equal(calls.length, 2);
});

test("submission writes named and Other school data to distinct columns", async () => {
  const insertedParameters = [];
  for (const body of [
    validResponse(),
    validResponse({ promptInstanceId: "819a1f93-2640-4bf5-8ae4-f691b59d66df", schoolCode: "other", schoolName: "Mountain West Dispatch" }),
  ]) {
    const res = responseRecorder();
    await handleFeedbackV1Submission({ body }, res, {
      queryFn: async (_statement, params) => {
        insertedParameters.push(params);
        return { rows: [{ id: `response-${insertedParameters.length}` }] };
      },
    });
    assert.equal(res.statusCode, 201);
  }
  assert.deepEqual(insertedParameters[0].slice(5, 7), ["ifod", null]);
  assert.deepEqual(insertedParameters[1].slice(5, 7), ["other", "Mountain West Dispatch"]);
});

test("tester interest requires an existing survey", async () => {
  const res = responseRecorder();
  await handleFeedbackV1TesterInterest({ body: { promptInstanceId } }, res, {
    queryFn: async () => ({ rows: [] }),
  });
  assert.equal(res.statusCode, 404);
});

test("contact validation rejects malformed email", () => {
  assert.equal(validateFeedbackV1Contact({ promptInstanceId, email: "not-an-email" }).ok, false);
  assert.equal(validateFeedbackV1Contact({ promptInstanceId, email: "Pilot@Example.com" }).value.email, "pilot@example.com");
});

test("contact requires explicit tester interest", async () => {
  const res = responseRecorder();
  await handleFeedbackV1Contact({ body: { promptInstanceId, email: "pilot@example.com" } }, res, {
    queryFn: async () => ({ rows: [{ id: "response-1", tester_interest_at: null }] }),
  });
  assert.equal(res.statusCode, 409);
});

test("owner retrieval exposes interview fields and separated contact", async () => {
  const res = responseRecorder();
  res.set = () => res;
  await handleOwnerFeedbackV1List({ query: {} }, res, {
    queryFn: async () => ({ rows: [{
      id: "response-1",
      prompt_instance_id: promptInstanceId,
      submitted_at: "2026-09-07T12:00:00.000Z",
      journey_stage: "currently_in_school",
      school_code: "other",
      school: "Mountain West Dispatch",
      job_to_be_done: "keep_up_with_school",
      current_value: "pretty_useful",
      retention_text: "More explanations.",
      discovery_source: "app_store",
      purchase_answer: "considering",
      subscriber_state: "non_subscriber",
      app_version: "1.7.4",
      build_number: "190",
      platform: "iOS",
      tester_interest_at: "2026-09-07T12:01:00.000Z",
      email: "pilot@example.com",
      contact_created_at: "2026-09-07T12:02:00.000Z",
      install_id: "must-not-be-returned",
    }, {
      id: "response-2",
      prompt_instance_id: "819a1f93-2640-4bf5-8ae4-f691b59d66df",
      submitted_at: "2026-09-07T11:00:00.000Z",
      journey_stage: "starting_school_soon",
      school_code: "aircraft_dispatch_academy",
      school: null,
      job_to_be_done: "pass_adx",
      current_value: "not_used_enough",
      retention_text: null,
      discovery_source: null,
      purchase_answer: null,
      subscriber_state: "non_subscriber",
      app_version: "1.7.4",
      build_number: "190",
      platform: "iOS",
      tester_interest_at: null,
      email: null,
      contact_created_at: null,
    }] }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.interviews[0].journeyStage, "currently_in_school");
  assert.equal(res.body.interviews[0].school, "Other — Mountain West Dispatch");
  assert.equal(res.body.interviews[0].schoolCode, "other");
  assert.equal(res.body.interviews[0].schoolName, "Mountain West Dispatch");
  assert.equal(res.body.interviews[0].contact.email, "pilot@example.com");
  assert.equal("installId" in res.body.interviews[0], false);
  assert.equal(res.body.interviews[1].school, "Aircraft Dispatch Academy (ADA)");
  assert.equal(res.body.interviews[1].schoolCode, "aircraft_dispatch_academy");
  assert.equal(res.body.interviews[1].schoolName, null);
});

test("owner interview route requires authentication and owner role", async () => {
  const previousSecret = config.jwtSecret;
  config.jwtSecret = "feedback-v1-owner-route-test-secret";
  const app = express();
  app.use("/api", router);
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/api/admin/feedback-v1`;
    const unauthenticated = await fetch(url);
    assert.equal(unauthenticated.status, 401);
    const token = await issueJwt({ id: "feedback-route-user", role: "user" });
    const forbidden = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(forbidden.status, 403);
  } finally {
    config.jwtSecret = previousSecret;
    await new Promise((resolve) => server.close(resolve));
  }
});
