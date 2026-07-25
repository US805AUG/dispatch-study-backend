import crypto from "crypto";

export const OWNER_IMPORT_PACK_ID = "dispatcher-advancement";

export const APPROVED_CATEGORIES_BY_PACK = Object.freeze({
  [OWNER_IMPORT_PACK_ID]: Object.freeze([
    "Regulations",
    "Navigation, Equipment and Facilities",
    "Aerodynamics",
    "Performance",
    "Flight Operations",
    "Emergencies, Hazards and Human Factors",
    "Meteorology and Weather",
  ]),
});

const REQUIRED_HEADERS = ["stable_id", "category", "cloze_statement"];
const OPTIONAL_HEADERS = ["tags"];
const ALLOWED_HEADERS = new Set([...REQUIRED_HEADERS, ...OPTIONAL_HEADERS]);
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function parseCSV(text) {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("CSV file is empty.");
  }

  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let justClosedQuote = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          justClosedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (justClosedQuote && character !== "," && character !== "\n" && character !== "\r") {
      throw new Error("Malformed CSV quoting.");
    }

    if (character === '"') {
      if (field.length !== 0) throw new Error("Malformed CSV quoting.");
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
      justClosedQuote = false;
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      justClosedQuote = false;
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("CSV contains an unclosed quoted field.");
  row.push(field);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

export function contentHashForStatement(statement) {
  const normalized = [statement, statement, statement]
    .map((value) => String(value).trim().toLowerCase().replace(/\s+/g, " "))
    .join("|");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export function validateBracketAuthoredStatement(statement) {
  if (typeof statement !== "string" || statement.trim().length === 0) {
    return "cloze_statement is required.";
  }
  if (/[\r\n]/.test(statement)) {
    return "cloze_statement must contain exactly one physical statement.";
  }

  let insideBracket = false;
  let hidden = "";
  let outside = "";
  let pairCount = 0;
  for (const character of statement) {
    if (character === "[") {
      if (insideBracket) return "cloze_statement has nested or malformed brackets.";
      insideBracket = true;
      hidden = "";
    } else if (character === "]") {
      if (!insideBracket) return "cloze_statement has an unmatched closing bracket.";
      if (hidden.trim().length === 0) return "Bracketed cloze spans cannot be empty.";
      insideBracket = false;
      pairCount += 1;
    } else if (insideBracket) {
      hidden += character;
    } else {
      outside += character;
    }
  }

  if (insideBracket) return "cloze_statement has an unmatched opening bracket.";
  if (pairCount === 0) return "cloze_statement requires at least one bracketed cloze span.";
  if (!/[A-Za-z]/.test(outside)) return "Add visible statement text outside the brackets.";
  return null;
}

export function evaluateOwnerQuestionCSV(csvText, existingQuestions = []) {
  let parsedRows;
  try {
    parsedRows = parseCSV(csvText);
  } catch (error) {
    return fileError(error.message);
  }
  if (parsedRows.length === 0) return fileError("CSV file is empty.");

  const headers = parsedRows[0].map((value, index) => index === 0 ? value.replace(/^\uFEFF/, "") : value);
  const duplicateHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
  const missingHeaders = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  const unsupportedHeaders = headers.filter((header) => !ALLOWED_HEADERS.has(header));
  if (duplicateHeaders.length > 0) return fileError(`Duplicate CSV header: ${duplicateHeaders[0]}.`);
  if (missingHeaders.length > 0) return fileError(`Missing required CSV header: ${missingHeaders[0]}.`);
  if (unsupportedHeaders.length > 0) return fileError(`Unsupported CSV header: ${unsupportedHeaders[0]}.`);

  const headerIndex = Object.fromEntries(headers.map((header, index) => [header, index]));
  const approvedCategories = APPROVED_CATEGORIES_BY_PACK[OWNER_IMPORT_PACK_ID];
  const approvedSet = new Set(approvedCategories);
  const existingByStableID = new Map();
  const existingByHash = new Map();
  for (const question of existingQuestions) {
    const hash = question.content_hash || contentHashForStatement(question.truth_statement_text ?? "");
    existingByStableID.set(question.stable_id, { ...question, resolvedHash: hash });
    if (hash) existingByHash.set(hash, question.stable_id);
  }

  const seenStableIDs = new Map();
  const seenHashes = new Map();
  const results = [];
  const validRows = [];

  for (let rowIndex = 1; rowIndex < parsedRows.length; rowIndex += 1) {
    const columns = parsedRows[rowIndex];
    const csvRow = rowIndex + 1;
    if (columns.length > headers.length) {
      results.push(rejected(csvRow, "Row has more columns than the CSV header."));
      continue;
    }

    const stableId = columns[headerIndex.stable_id] ?? "";
    const category = columns[headerIndex.category] ?? "";
    const statement = columns[headerIndex.cloze_statement] ?? "";
    const tagsCell = headerIndex.tags == null ? "" : (columns[headerIndex.tags] ?? "");
    const tags = tagsCell.split(",").map((tag) => tag.trim()).filter(Boolean);
    const errors = [];

    if (!STABLE_ID_PATTERN.test(stableId)) {
      errors.push("stable_id is required and may contain only letters, numbers, '.', '_', ':', or '-'.");
    }
    if (!approvedSet.has(category)) {
      errors.push(`Unsupported category for ${OWNER_IMPORT_PACK_ID}: ${category || "(blank)"}.`);
    }
    const clozeError = validateBracketAuthoredStatement(statement);
    if (clozeError) errors.push(clozeError);

    if (errors.length > 0) {
      results.push(rejected(csvRow, errors.join(" "), stableId));
      continue;
    }

    const contentHash = contentHashForStatement(statement);
    const existing = existingByStableID.get(stableId);
    if (existing) {
      if (existing.resolvedHash === contentHash) {
        results.push(duplicate(csvRow, stableId, "Already published with the same stable_id and content."));
      } else {
        results.push(rejected(csvRow, "stable_id already exists with different content.", stableId));
      }
      continue;
    }
    if (existingByHash.has(contentHash)) {
      results.push(duplicate(csvRow, stableId, `Exact content is already published as ${existingByHash.get(contentHash)}.`));
      continue;
    }
    if (seenStableIDs.has(stableId)) {
      const first = seenStableIDs.get(stableId);
      const message = first.contentHash === contentHash
        ? `Duplicate of CSV row ${first.csvRow}.`
        : `stable_id conflicts with CSV row ${first.csvRow}.`;
      results.push(first.contentHash === contentHash ? duplicate(csvRow, stableId, message) : rejected(csvRow, message, stableId));
      continue;
    }
    if (seenHashes.has(contentHash)) {
      results.push(duplicate(csvRow, stableId, `Exact content duplicates CSV row ${seenHashes.get(contentHash)}.`));
      continue;
    }

    const row = { csvRow, stableId, category, statement, tags, contentHash };
    seenStableIDs.set(stableId, row);
    seenHashes.set(contentHash, csvRow);
    validRows.push(row);
    results.push({ row: csvRow, stableId, status: "valid", message: "Ready to import." });
  }

  return response(results, validRows, approvedCategories);
}

function response(results, validRows, approvedCategories) {
  const count = (status) => results.filter((result) => result.status === status).length;
  return {
    ok: count("rejected") === 0,
    packId: OWNER_IMPORT_PACK_ID,
    approvedCategories,
    counts: {
      total: results.length,
      valid: count("valid"),
      duplicate: count("duplicate"),
      rejected: count("rejected"),
    },
    results,
    validRows,
  };
}

function fileError(message) {
  return response([{ row: 1, stableId: null, status: "rejected", message }], [], APPROVED_CATEGORIES_BY_PACK[OWNER_IMPORT_PACK_ID]);
}

function rejected(row, message, stableId = null) {
  return { row, stableId: stableId || null, status: "rejected", message };
}

function duplicate(row, stableId, message) {
  return { row, stableId, status: "duplicate", message };
}
