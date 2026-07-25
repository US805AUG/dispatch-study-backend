import test from "node:test";
import assert from "node:assert/strict";
import { parseAppleAudiences } from "../src/config.js";

test("parseAppleAudiences preserves approved audiences and trims blanks", () => {
  assert.deepEqual(
    parseAppleAudiences(" com.samg.Flight-Dispatch-Question-Bank, com.samg.study-ops, ,"),
    ["com.samg.Flight-Dispatch-Question-Bank", "com.samg.study-ops"]
  );
});

test("parseAppleAudiences fails closed for an empty value", () => {
  assert.deepEqual(parseAppleAudiences("  ,  "), []);
});
