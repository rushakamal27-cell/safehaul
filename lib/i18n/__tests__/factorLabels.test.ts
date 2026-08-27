import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { translateFactorName } from "../factorLabels";

describe("translateFactorName", () => {
  test("'en' returns the name unchanged", () => {
    assert.equal(translateFactorName("Harsh Braking", "en"), "Harsh Braking");
  });

  test("translates every known factor name emitted by lib/riskEngine.ts's labelMap", () => {
    assert.equal(translateFactorName("Harsh Braking", "ru"), "Резкое торможение");
    assert.equal(translateFactorName("Speeding", "ru"), "Превышение скорости");
    assert.equal(translateFactorName("Harsh Maneuver", "ru"), "Резкий манёвр");
    assert.equal(translateFactorName("Distracted Driving", "ru"), "Невнимательное вождение");
    assert.equal(translateFactorName("Mechanical Risk", "ru"), "Механический риск");
    assert.equal(translateFactorName("Fatigue", "ru"), "Усталость");
    assert.equal(translateFactorName("Weather", "ru"), "Погода");
    assert.equal(translateFactorName("Zone Risk", "ru"), "Риск участка");
    assert.equal(translateFactorName("Following Distance", "ru"), "Небезопасная дистанция");
    assert.equal(translateFactorName("Rolling Stop", "ru"), "Неполная остановка");
  });

  test("an unrecognized future factor name falls back to the original English string, never blank", () => {
    assert.equal(translateFactorName("Some New Factor", "ru"), "Some New Factor");
  });
});
