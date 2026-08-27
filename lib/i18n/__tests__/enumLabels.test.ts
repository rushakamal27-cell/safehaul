import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  translateRiskLevel,
  translateContextStatus,
  translateZoneAvailability,
  translateContextualSpeedComponent,
  translateMissingContextItem,
} from "../enumLabels";

describe("translateRiskLevel", () => {
  test("translates each known level", () => {
    assert.equal(translateRiskLevel("LOW", "ru"), "Низкий риск");
    assert.equal(translateRiskLevel("MEDIUM", "ru"), "Средний риск");
    assert.equal(translateRiskLevel("HIGH", "ru"), "Высокий риск");
    assert.equal(translateRiskLevel("CRITICAL", "ru"), "Критический риск");
  });

  test("'en' returns the same English labels DashboardScreen's LEVEL_CONFIG previously hardcoded", () => {
    assert.equal(translateRiskLevel("LOW", "en"), "Low Risk");
    assert.equal(translateRiskLevel("HIGH", "en"), "High Risk");
  });

  test("an unrecognized level falls back to the HIGH label, matching the existing `?? LEVEL_CONFIG.HIGH` behavior", () => {
    assert.equal(translateRiskLevel("SOMETHING_NEW", "en"), "High Risk");
    assert.equal(translateRiskLevel("SOMETHING_NEW", "ru"), "Высокий риск");
  });
});

describe("translateContextStatus", () => {
  test("translates each of the three ContextStatus values", () => {
    assert.equal(translateContextStatus("full_live", "ru"), "Все данные в реальном времени");
    assert.equal(translateContextStatus("partial_live", "ru"), "Частично в реальном времени");
    assert.equal(translateContextStatus("demo", "ru"), "Публичная демо-версия");
  });
});

describe("translateZoneAvailability", () => {
  test("translates each of the four ZoneAvailability values", () => {
    assert.equal(translateZoneAvailability("matched", "ru"), "В зоне мониторинга риска");
    assert.equal(translateZoneAvailability("outside_monitored_zones", "ru"), "Вне зон мониторинга риска");
    assert.equal(translateZoneAvailability("location_unavailable", "ru"), "Местоположение недоступно");
    assert.equal(translateZoneAvailability("location_stale", "ru"), "Данные о местоположении устарели");
  });
});

describe("translateContextualSpeedComponent", () => {
  test("translates by the stable key, not the pre-formatted English label", () => {
    assert.equal(translateContextualSpeedComponent("weather", "ru"), "Погода");
    assert.equal(translateContextualSpeedComponent("zone", "ru"), "Зона риска");
    assert.equal(translateContextualSpeedComponent("fatigue", "ru"), "Усталость");
    assert.equal(translateContextualSpeedComponent("behavior", "ru"), "Недавнее поведение");
  });
});

describe("translateMissingContextItem", () => {
  test("translates the three known missingContext values", () => {
    assert.equal(translateMissingContextItem("Weather", "ru"), "погоды");
    assert.equal(translateMissingContextItem("Zone risk", "ru"), "зоны риска");
    assert.equal(translateMissingContextItem("HOS", "ru"), "часов работы (HOS)");
  });

  test("an unrecognized item falls back to the original English string", () => {
    assert.equal(translateMissingContextItem("Something New", "ru"), "Something New");
  });
});
