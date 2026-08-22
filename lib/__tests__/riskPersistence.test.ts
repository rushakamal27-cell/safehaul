import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { shouldPersistDailyHistory } from "../riskPersistence";

describe("shouldPersistDailyHistory", () => {
  test("a pilot driver's /api/risk call must NOT persist daily historical Audit records", () => {
    assert.equal(shouldPersistDailyHistory(true), false);
  });

  test("a demo (non-pilot) driver's /api/risk call still persists — no autonomous pipeline exists for them", () => {
    assert.equal(shouldPersistDailyHistory(false), true);
  });
});
