import test from "node:test";
import assert from "node:assert/strict";
import { runTransactionOnClient } from "../src/db.js";

test("transaction helper commits a successful operation", async () => {
  const statements = [];
  const client = { query: async (statement) => { statements.push(statement); } };
  const result = await runTransactionOnClient(client, async () => "done");

  assert.equal(result, "done");
  assert.deepEqual(statements, ["BEGIN", "COMMIT"]);
});

test("transaction helper rolls back a failed operation", async () => {
  const statements = [];
  const client = { query: async (statement) => { statements.push(statement); } };

  await assert.rejects(
    runTransactionOnClient(client, async () => { throw new Error("fail"); }),
    /fail/
  );
  assert.deepEqual(statements, ["BEGIN", "ROLLBACK"]);
});
