import assert from "node:assert/strict";
import test from "node:test";
import { feedbackNotificationPayload, notifyFeedbackOwner } from "../src/routes.js";

const feedback = {
  id: "feedback-1",
  category: "Bug",
  body: "The answer did not play.",
  createdAt: "2026-08-04T12:00:00.000Z",
  appVersion: "1.7.1",
  buildNumber: "186",
  platform: "iOS",
  questionId: "adx-1",
};

test("feedback notification payload is metadata-only", () => {
  const payload = feedbackNotificationPayload(feedback);
  assert.equal(payload.event, "feedback_received");
  assert.equal(payload.feedback.id, feedback.id);
  assert.equal(payload.feedback.category, feedback.category);
  assert.equal(payload.feedback.questionId, feedback.questionId);
  assert.equal("message" in payload.feedback, false);
});

test("feedback notification is a graceful no-op when unconfigured", async () => {
  const result = await notifyFeedbackOwner(feedback, { webhookUrl: "" });
  assert.deepEqual(result, { configured: false, delivered: false });
});

test("feedback notification posts safe metadata and reports delivery", async () => {
  let request;
  const result = await notifyFeedbackOwner(feedback, {
    webhookUrl: "https://notify.example.test/feedback",
    fetchImpl: async (_url, options) => {
      request = options;
      return new Response("ok", { status: 200 });
    },
  });
  assert.deepEqual(result, { configured: true, delivered: true });
  const body = JSON.parse(request.body);
  assert.equal(body.feedback.id, feedback.id);
  assert.equal("message" in body.feedback, false);
});

test("feedback notification failure is contained", async () => {
  const result = await notifyFeedbackOwner(feedback, {
    webhookUrl: "https://notify.example.test/feedback",
    fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.deepEqual(result, { configured: true, delivered: false });
});
