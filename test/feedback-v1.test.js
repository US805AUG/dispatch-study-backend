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
    school: "Example Dispatch Academy",
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
  const minimal = validResponse({ school: null, retentionText: null, discoverySource: null, purchaseAnswer: null });
  assert.equal(validateFeedbackV1Response(minimal).ok, true);
});

test("rejects invalid enums and bounded free text", () => {
  assert.equal(validateFeedbackV1Response(validResponse({ journeyStage: "student-ish" })).ok, false);
  assert.equal(validateFeedbackV1Response(validResponse({ retentionText: "x".repeat(1001) })).ok, false);
  assert.equal(validateFeedbackV1Response(validResponse({ school: "x".repeat(201) })).ok, false);
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
      school: "Example Dispatch Academy",
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
    }] }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.interviews[0].journeyStage, "currently_in_school");
  assert.equal(res.body.interviews[0].contact.email, "pilot@example.com");
  assert.equal("installId" in res.body.interviews[0], false);
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
