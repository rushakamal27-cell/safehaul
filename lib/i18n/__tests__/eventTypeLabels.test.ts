import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { translateEventType, translateFormattedEventTitle } from "../eventTypeLabels";

describe("translateEventType (raw canonical type available)", () => {
  test("'en' formats the same way app/api/audit/route.ts's formatEventType does", () => {
    assert.equal(translateEventType("harsh_braking", "en"), "Harsh Braking");
    assert.equal(translateEventType("mobile_usage", "en"), "Mobile Usage");
  });

  test("'ru' translates every known canonical DriverEvent type", () => {
    assert.equal(translateEventType("harsh_braking", "ru"), "Резкое торможение");
    assert.equal(translateEventType("following_distance", "ru"), "Небезопасная дистанция");
    assert.equal(translateEventType("mobile_usage", "ru"), "Использование телефона");
    assert.equal(translateEventType("rolling_stop", "ru"), "Неполная остановка");
    assert.equal(translateEventType("speeding", "ru"), "Превышение скорости");
    assert.equal(translateEventType("crash", "ru"), "ДТП");
  });

  test("an unrecognized future type falls back to the same Title-Case English formatting, never blank", () => {
    assert.equal(translateEventType("some_new_event_type", "ru"), "Some New Event Type");
  });
});

describe("translateFormattedEventTitle (only the already-formatted title survives — e.g. Audit)", () => {
  test("'en' returns the title unchanged", () => {
    assert.equal(translateFormattedEventTitle("Harsh Braking", "en"), "Harsh Braking");
  });

  test("'ru' reverses the Title Case -> snake_case transform and translates", () => {
    assert.equal(translateFormattedEventTitle("Harsh Braking", "ru"), "Резкое торможение");
    assert.equal(translateFormattedEventTitle("Mobile Usage", "ru"), "Использование телефона");
    assert.equal(translateFormattedEventTitle("Following Distance", "ru"), "Небезопасная дистанция");
  });

  test("an unrecognized formatted title falls back to the original English title unchanged, never a broken guess", () => {
    assert.equal(translateFormattedEventTitle("Some Brand New Alert", "ru"), "Some Brand New Alert");
  });
});
