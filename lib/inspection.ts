/**
 * lib/inspection.ts
 *
 * Types, AI prompt, and JSON validator for vehicle inspections.
 * The AI is asked to return a strict JSON object — no prose.
 */

export interface CheckItem {
  name:   string;  // "Tires" | "Brakes" | "Lights" | "Windshield" | "Engine Bay"
  status: "PASS" | "WARN" | "FAIL";
  detail: string;  // max 80 chars
}

export interface InspectionResult {
  overallResult: "PASS" | "WARN" | "FAIL";
  summary:       string;   // one plain-English sentence, max 120 chars
  confidence:    number;   // 0–1
  checkItems:    CheckItem[];
}

/**
 * System prompt sent to Claude with the inspection image.
 * Enforces strict JSON-only output with no surrounding text.
 */
export const INSPECTION_SYSTEM_PROMPT = `
You are a commercial vehicle pre-trip inspection AI for a trucking safety platform.

Analyze the provided image and return ONLY a JSON object — no prose, no markdown, no code fences.

Required JSON schema:
{
  "overallResult": "PASS" | "WARN" | "FAIL",
  "summary": "<one plain-English sentence describing the overall inspection result, max 120 chars>",
  "confidence": <number between 0.0 and 1.0>,
  "checkItems": [
    { "name": "Tires",       "status": "PASS"|"WARN"|"FAIL", "detail": "<finding, max 80 chars>" },
    { "name": "Brakes",      "status": "PASS"|"WARN"|"FAIL", "detail": "<finding, max 80 chars>" },
    { "name": "Lights",      "status": "PASS"|"WARN"|"FAIL", "detail": "<finding, max 80 chars>" },
    { "name": "Windshield",  "status": "PASS"|"WARN"|"FAIL", "detail": "<finding, max 80 chars>" },
    { "name": "Engine Bay",  "status": "PASS"|"WARN"|"FAIL", "detail": "<finding, max 80 chars>" }
  ]
}

Rules:
- overallResult is FAIL if any checkItem is FAIL; WARN if any is WARN and none are FAIL; otherwise PASS.
- If a component is not visible in the image, set status to WARN and note "Not visible in image".
- confidence reflects how clearly the image shows the vehicle components (low if blurry or wrong angle).
- Return exactly 5 checkItems in the order listed above.
- Output raw JSON only. No other text.
`.trim();

const VALID_STATUSES = new Set(["PASS", "WARN", "FAIL"]);
const EXPECTED_NAMES = ["Tires", "Brakes", "Lights", "Windshield", "Engine Bay"];

/** Parse and validate the raw AI text response. Throws if invalid. */
export function parseInspectionResponse(raw: string): InspectionResult {
  let parsed: any;
  try {
    // Strip accidental markdown fences if the model includes them
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`AI returned non-JSON: ${raw.slice(0, 200)}`);
  }

  if (!VALID_STATUSES.has(parsed.overallResult)) {
    throw new Error(`Invalid overallResult: ${parsed.overallResult}`);
  }
  if (typeof parsed.summary !== "string" || parsed.summary.length === 0) {
    throw new Error("Missing or empty summary");
  }
  if (typeof parsed.confidence !== "number") {
    throw new Error("Missing confidence");
  }
  if (!Array.isArray(parsed.checkItems) || parsed.checkItems.length !== 5) {
    throw new Error("checkItems must be an array of exactly 5 items");
  }
  for (const item of parsed.checkItems) {
    if (!EXPECTED_NAMES.includes(item.name)) {
      throw new Error(`Unexpected checkItem name: ${item.name}`);
    }
    if (!VALID_STATUSES.has(item.status)) {
      throw new Error(`Invalid status for ${item.name}: ${item.status}`);
    }
  }

  return {
    overallResult: parsed.overallResult,
    summary:       parsed.summary.slice(0, 120),
    confidence:    Math.min(1, Math.max(0, parsed.confidence)),
    checkItems:    parsed.checkItems.map((i: any) => ({
      name:   i.name,
      status: i.status,
      detail: String(i.detail ?? "").slice(0, 80),
    })),
  };
}
