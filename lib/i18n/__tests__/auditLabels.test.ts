import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  translateAuditBadge,
  translateAuditTitle,
  translateAuditDetail,
  translateAuditMeta,
} from "../auditLabels";

describe("translateAuditBadge", () => {
  test("'en' returns the badge unchanged", () => {
    assert.equal(translateAuditBadge("TRIP", "en"), "TRIP");
  });

  test("translates every known fixed badge, including the three dangerLevel-derived risk badges", () => {
    assert.equal(translateAuditBadge("INCIDENT", "ru"), "ИНЦИДЕНТ");
    assert.equal(translateAuditBadge("TRIP", "ru"), "ПОЕЗДКА");
    assert.equal(translateAuditBadge("LOW RISK", "ru"), "НИЗКИЙ РИСК");
    assert.equal(translateAuditBadge("MEDIUM RISK", "ru"), "СРЕДНИЙ РИСК");
    assert.equal(translateAuditBadge("HIGH RISK", "ru"), "ВЫСОКИЙ РИСК");
  });

  test("an unrecognized badge falls back to the original English text", () => {
    assert.equal(translateAuditBadge("SOMETHING NEW", "ru"), "SOMETHING NEW");
  });
});

describe("translateAuditTitle", () => {
  test("translates the fixed Daily Safety Score / Daily Driving Summary titles shared by both the legacy and autonomous builders", () => {
    assert.equal(translateAuditTitle("Daily Safety Score", "ru"), "Ежедневная оценка безопасности");
    assert.equal(translateAuditTitle("Daily Driving Summary", "ru"), "Сводка за день");
  });

  test("falls through to the event-type reverse lookup for a driver-event title", () => {
    assert.equal(translateAuditTitle("Harsh Braking", "ru"), "Резкое торможение");
    assert.equal(translateAuditTitle("Mobile Usage", "ru"), "Использование телефона");
  });

  test("an unrecognized title with no event-type match falls back to the original English title", () => {
    assert.equal(translateAuditTitle("Some Brand New Card Type", "ru"), "Some Brand New Card Type");
  });
});

describe("translateAuditDetail", () => {
  test("translates the two known 'no data' fallback sentences exactly", () => {
    assert.equal(
      translateAuditDetail("Trip logged. Location data not available.", "ru"),
      "Поездка зафиксирована. Данные о местоположении недоступны."
    );
    assert.equal(
      translateAuditDetail("Route span unavailable — no trustworthy moving observation this day.", "ru"),
      "Маршрут недоступен — в этот день не было достоверных данных о движении."
    );
  });

  test("translates the score-sentence templates, preserving the embedded number", () => {
    assert.equal(
      translateAuditDetail("Driver safety score: 93 out of 100", "ru"),
      "Оценка безопасности водителя: 93 из 100"
    );
    assert.equal(
      translateAuditDetail("Average safety score: 77 out of 100", "ru"),
      "Средняя оценка безопасности: 77 из 100"
    );
  });

  test("translates the driver-event detection sentence, keeping the provider brand name untranslated", () => {
    assert.equal(
      translateAuditDetail("Detected by Samsara onboard telematics.", "ru"),
      "Обнаружено бортовой телематикой Samsara."
    );
  });

  test("a raw location/zone-name detail (no template match) passes through unchanged — addresses are never auto-translated", () => {
    const raw = "Philadelphia, PA → LaPorte County, IN";
    assert.equal(translateAuditDetail(raw, "ru"), raw);
  });

  test("a driver's free-text incident description (no template match) passes through unchanged", () => {
    const freeText = "Hit a pothole near the exit ramp, no damage visible.";
    assert.equal(translateAuditDetail(freeText, "ru"), freeText);
  });
});

describe("translateAuditMeta", () => {
  test("'en' returns the array unchanged (same reference contents)", () => {
    const meta = ["🛣 705 mi", "🌦 Weather Risk 12%"];
    assert.deepEqual(translateAuditMeta(meta, "en"), meta);
  });

  test("translates every known chip template, preserving embedded numbers", () => {
    assert.deepEqual(
      translateAuditMeta(
        ["🛣 705 mi", "🌦 Weather Risk 12%", "🗺 Area Risk 8%", "22 of 24 hourly samples", "🧪 Demo Data"],
        "ru"
      ),
      ["🛣 705 миль", "🌦 Риск погоды 12%", "🗺 Риск участка 8%", "22 из 24 часовых замеров", "🧪 Демо-данные"]
    );
  });

  test("an unrecognized chip passes through unchanged rather than breaking the array", () => {
    assert.deepEqual(translateAuditMeta(["📍 Some Address, TX"], "ru"), ["📍 Some Address, TX"]);
  });
});
