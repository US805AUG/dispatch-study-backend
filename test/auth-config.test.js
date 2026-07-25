import test from "node:test";
import assert from "node:assert/strict";
import { parseAppleAudiences } from "../src/config.js";

test("parseAppleAudiences preserves approved audiences and trims blanks", () => {
  const audiences = parseAppleAudiences(
    " com.samg.Flight-Dispatch-Question-Bank, com.samg.study-ops, ,"
  );
  assert.deepEqual(audiences, ["com.samg.Flight-Dispatch-Question-Bank", "com.samg.study-ops"]);
  assert.equal(audiences.includes("com.samg.Flight-Dispatch-Question-Bank"), true);
  assert.equal(audiences.includes("com.samg.study-ops"), true);
});

test("parseAppleAudiences fails closed for an empty value", () => {
  assert.deepEqual(parseAppleAudiences("  ,  "), []);
});
