import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVED_CATEGORIES_BY_PACK,
  evaluateOwnerQuestionCSV,
  OWNER_IMPORT_PACK_ID,
  validateBracketAuthoredStatement,
} from "../src/ownerQuestionImport.js";

const HEADER = "stable_id,category,cloze_statement,tags";

test("dispatcher advancement exposes exactly the approved pack-scoped categories", () => {
  assert.deepEqual(APPROVED_CATEGORIES_BY_PACK[OWNER_IMPORT_PACK_ID], [
    "Regulations",
    "Navigation, Equipment and Facilities",
    "Aerodynamics",
    "Performance",
    "Flight Operations",
    "Emergencies, Hazards and Human Factors",
    "Meteorology and Weather",
  ]);
});

test("owner CSV preserves bracket-authored statement and accepts quoted commas", () => {
  const statement = "Navigation requires [VOR, DME, and GPS] equipment.";
  const csv = `${HEADER}\nadx-0001,"Navigation, Equipment and Facilities","${statement}",navigation`;
  const result = evaluateOwnerQuestionCSV(csv);

  assert.equal(result.ok, true);
  assert.equal(result.counts.valid, 1);
  assert.equal(result.validRows[0].statement, statement);
  assert.equal(result.validRows[0].category, "Navigation, Equipment and Facilities");
});

test("owner CSV rejects blank, differently capitalized, and unsupported categories", () => {
  for (const category of ["", "regulations", "Weather"]) {
    const csv = `${HEADER}\nadx-0001,${category},A dispatcher uses [approved data].,`;
    const result = evaluateOwnerQuestionCSV(csv);
    assert.equal(result.ok, false);
    assert.equal(result.counts.rejected, 1);
  }
});

test("owner CSV reports exact existing duplicates and stable ID conflicts", () => {
  const statement = "A dispatcher uses [approved data].";
  const csv = `${HEADER}\nadx-0001,Regulations,${statement},`;
  const first = evaluateOwnerQuestionCSV(csv);
  const existing = [{
    stable_id: "adx-0001",
    content_hash: first.validRows[0].contentHash,
    truth_statement_text: statement,
  }];
  const duplicate = evaluateOwnerQuestionCSV(csv, existing);
  const conflict = evaluateOwnerQuestionCSV(
    `${HEADER}\nadx-0001,Regulations,A dispatcher uses [different data].,`,
    existing
  );

  assert.equal(duplicate.counts.duplicate, 1);
  assert.equal(conflict.counts.rejected, 1);
});

test("owner CSV rejects multiline and malformed bracket statements", () => {
  assert.match(validateBracketAuthoredStatement("First [answer].\nSecond [answer]."), /one physical statement/);
  assert.match(validateBracketAuthoredStatement("Missing [answer."), /unmatched opening/);
  assert.match(validateBracketAuthoredStatement("[answer]"), /visible statement text/);
});

test("owner CSV rejects unsupported columns and conflicting repeated stable IDs", () => {
  const unsupported = evaluateOwnerQuestionCSV(
    "stable_id,category,cloze_statement,difficulty\nadx-1,Regulations,Use [data].,hard"
  );
  const conflict = evaluateOwnerQuestionCSV(
    `${HEADER}\nadx-1,Regulations,Use [data].,\nadx-1,Regulations,Use [other data].,`
  );

  assert.equal(unsupported.counts.rejected, 1);
  assert.equal(conflict.counts.rejected, 1);
});

test("owner CSV rejects characters after a closed quoted field", () => {
  const result = evaluateOwnerQuestionCSV(
    `${HEADER}\nadx-1,Regulations,"Use [data]."unexpected,`
  );

  assert.equal(result.ok, false);
  assert.match(result.results[0].message, /Malformed CSV quoting/);
});
