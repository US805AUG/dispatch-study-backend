import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { issueJwt } from "../src/auth.js";
import { config } from "../src/config.js";
import {
  handleOwnerQuestionImport,
  router,
} from "../src/routes.js";

const VALID_CSV = [
  "stable_id,category,cloze_statement,tags",
  "adx-route-1,Regulations,A dispatcher uses [approved data].,dispatch",
].join("\n");

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("import route requires authentication and owner role before parsing CSV", async () => {
  const previousSecret = config.jwtSecret;
  config.jwtSecret = "owner-import-route-test-secret";
  const app = express();
  app.use("/api", router);
  const server = app.listen(0, "127.0.0.1");

  try {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/api/admin/questions/import`;
    const unauthenticated = await fetch(url, {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: VALID_CSV,
    });
    assert.equal(unauthenticated.status, 401);

    const userToken = await issueJwt({ id: "route-user", role: "user" });
    const forbidden = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${userToken}`,
        "content-type": "text/csv",
      },
      body: VALID_CSV,
    });
    assert.equal(forbidden.status, 403);
  } finally {
    config.jwtSecret = previousSecret;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("dry run is the default and never exposes internal valid rows", async () => {
  let transactionCalled = false;
  const res = responseRecorder();
  await handleOwnerQuestionImport(
    { body: VALID_CSV, query: {}, user: { sub: "owner-id" } },
    res,
    {
      queryFn: async () => ({ rows: [] }),
      withTransactionFn: async () => {
        transactionCalled = true;
        throw new Error("transaction must not run during dry-run");
      },
    }
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.imported, 0);
  assert.equal(res.body.counts.valid, 1);
  assert.equal("validRows" in res.body, false);
  assert.equal(transactionCalled, false);
});

test("commit revalidates and refuses rejected rows without inserts", async () => {
  const rejectedCSV = VALID_CSV.replace("Regulations", "regulations");
  const statements = [];
  const client = {
    async query(statement) {
      statements.push(statement);
      if (statement.includes("select stable_id")) return { rows: [] };
      return {};
    },
  };
  const res = responseRecorder();
  await handleOwnerQuestionImport(
    { body: rejectedCSV, query: { dry_run: "false" }, user: { sub: "owner-id" } },
    res,
    { withTransactionFn: (operation) => operation(client) }
  );

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.imported, 0);
  assert.equal(res.body.counts.rejected, 1);
  assert.equal(statements.some((statement) => statement.includes("insert into")), false);
});

test("commit preserves statement text and writes canonical plus audit rows", async () => {
  const calls = [];
  const client = {
    async query(statement, params = []) {
      calls.push({ statement, params });
      if (statement.includes("select stable_id")) return { rows: [] };
      return {};
    },
  };
  const res = responseRecorder();
  await handleOwnerQuestionImport(
    { body: VALID_CSV, query: { dry_run: "false" }, user: { sub: "owner-id" } },
    res,
    { withTransactionFn: (operation) => operation(client) }
  );

  const inserts = calls.filter(({ statement }) => statement.includes("insert into"));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.imported, 1);
  assert.equal(res.body.results[0].status, "imported");
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0].params[2], "dispatcher-advancement");
  assert.equal(inserts[0].params[3], "Regulations");
  assert.equal(inserts[0].params[5], "A dispatcher uses [approved data].");
  assert.equal(inserts[0].params[6], "owner-id");
  assert.match(inserts[0].statement, /cloze_variants_json/);
  assert.match(inserts[0].statement, /null,'owner-csv-import','published'/);
  assert.match(inserts[1].statement, /insert into study_submission/);
});
