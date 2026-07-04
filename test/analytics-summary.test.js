import assert from "node:assert/strict";
import test from "node:test";
import { analyticsTestHooks } from "../src/routes.js";

const {
  analyticsDedupeKey,
  analyticsScope,
  requestedAnalyticsSegment,
  withScopedAppEvent,
} = analyticsTestHooks;

test("analytics segment defaults unknown values to all", () => {
  assert.equal(requestedAnalyticsSegment("all"), "all");
  assert.equal(requestedAnalyticsSegment("real"), "real");
  assert.equal(requestedAnalyticsSegment("internal"), "internal");
  assert.equal(requestedAnalyticsSegment("unexpected"), "all");
  assert.equal(requestedAnalyticsSegment(undefined), "all");
});

test("analytics scope tolerates missing internal configuration", () => {
  const previousInstallIds = process.env.ANALYTICS_INTERNAL_INSTALL_IDS;
  const previousUserIds = process.env.ANALYTICS_INTERNAL_USER_IDS;
  delete process.env.ANALYTICS_INTERNAL_INSTALL_IDS;
  delete process.env.ANALYTICS_INTERNAL_USER_IDS;

  try {
    const scope = analyticsScope("internal");
    assert.deepEqual(scope.internalInstallIds, []);
    assert.deepEqual(scope.internalUserIds, []);
    assert.match(scope.cte, /where false/i);
  } finally {
    if (previousInstallIds === undefined) {
      delete process.env.ANALYTICS_INTERNAL_INSTALL_IDS;
    } else {
      process.env.ANALYTICS_INTERNAL_INSTALL_IDS = previousInstallIds;
    }
    if (previousUserIds === undefined) {
      delete process.env.ANALYTICS_INTERNAL_USER_IDS;
    } else {
      process.env.ANALYTICS_INTERNAL_USER_IDS = previousUserIds;
    }
  }
});

test("analytics scope uses explicit internal install ids only", () => {
  const previousInstallIds = process.env.ANALYTICS_INTERNAL_INSTALL_IDS;
  const previousUserIds = process.env.ANALYTICS_INTERNAL_USER_IDS;
  process.env.ANALYTICS_INTERNAL_INSTALL_IDS = "install-a, install-b";
  delete process.env.ANALYTICS_INTERNAL_USER_IDS;

  try {
    const internalScope = analyticsScope("internal");
    assert.deepEqual(internalScope.params[0], ["install-a", "install-b"]);
    assert.match(internalScope.cte, /install_id = any\(\$1::text\[\]\)/);

    const realScope = analyticsScope("real");
    assert.match(realScope.cte, /where not/i);
  } finally {
    if (previousInstallIds === undefined) {
      delete process.env.ANALYTICS_INTERNAL_INSTALL_IDS;
    } else {
      process.env.ANALYTICS_INTERNAL_INSTALL_IDS = previousInstallIds;
    }
    if (previousUserIds === undefined) {
      delete process.env.ANALYTICS_INTERNAL_USER_IDS;
    } else {
      process.env.ANALYTICS_INTERNAL_USER_IDS = previousUserIds;
    }
  }
});

test("summary query scoping composes with select and with queries", () => {
  const scope = {
    cte: "select * from public.app_event where false",
    params: [],
  };

  assert.match(withScopedAppEvent("select count(*) from app_event", scope), /^with app_event as \(/i);
  assert.match(withScopedAppEvent("with recent as (select 1) select * from recent", scope), /^with app_event as \(.*\), recent as/s);
});

test("analytics dedupe keys are stable and event-specific", () => {
  const base = {
    installId: "install-a",
    name: "question_viewed",
    timestamp: "2026-07-03T12:00:00.000Z",
    properties: {
      anonymous_session_id: "session-a",
      question_id: "question-a",
    },
  };

  assert.equal(analyticsDedupeKey(base), analyticsDedupeKey({ ...base }));
  assert.notEqual(analyticsDedupeKey(base), analyticsDedupeKey({ ...base, name: "answer_revealed" }));
});
