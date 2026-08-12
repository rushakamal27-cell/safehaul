import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { verifyCronSecret } from "../cronAuth";

describe("verifyCronSecret", () => {
  const ORIGINAL = process.env.CRON_SECRET;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = ORIGINAL;
  });

  test("correct bearer token is accepted", () => {
    process.env.CRON_SECRET = "test-secret";
    assert.equal(verifyCronSecret("Bearer test-secret"), true);
  });

  test("wrong bearer token is rejected", () => {
    process.env.CRON_SECRET = "test-secret";
    assert.equal(verifyCronSecret("Bearer wrong-secret"), false);
  });

  test("missing authorization header is rejected", () => {
    process.env.CRON_SECRET = "test-secret";
    assert.equal(verifyCronSecret(null), false);
  });

  test("CRON_SECRET not configured fails closed, even with a header present", () => {
    delete process.env.CRON_SECRET;
    assert.equal(verifyCronSecret("Bearer anything"), false);
  });
});
