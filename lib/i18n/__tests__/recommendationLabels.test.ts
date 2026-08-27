import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { translateRecommendation } from "../recommendationLabels";

const ALL_KNOWN_RECOMMENDATIONS = [
  "Consider a rest break soon.",
  "Use extra caution due to current weather conditions.",
  "Reduce speed and maintain a safe following distance.",
  "Proceed carefully in the current risk zone.",
  "Increase following distance to avoid sudden stops.",
  "Smooth acceleration and turns improve safety and fuel efficiency.",
  "Put the phone away — distracted driving is a leading cause of crashes.",
  "High-speed power loss detected — pull over safely and inspect the vehicle.",
  "Come to a complete stop at stop signs and red lights.",
];

describe("translateRecommendation", () => {
  test("'en' returns every known recommendation unchanged", () => {
    for (const rec of ALL_KNOWN_RECOMMENDATIONS) {
      assert.equal(translateRecommendation(rec, "en"), rec);
    }
  });

  test("'ru' translates every known recommendation to a non-empty, different string", () => {
    for (const rec of ALL_KNOWN_RECOMMENDATIONS) {
      const translated = translateRecommendation(rec, "ru");
      assert.notEqual(translated, rec, `expected a real translation for: ${rec}`);
      assert.ok(translated.length > 0);
    }
  });

  test("a specific known translation, spot-checked", () => {
    assert.equal(
      translateRecommendation("Consider a rest break soon.", "ru"),
      "Скоро стоит сделать перерыв на отдых."
    );
  });

  test("an unrecognized future recommendation falls back to the original English sentence, never blank", () => {
    const novel = "This sentence does not exist in the engine yet.";
    assert.equal(translateRecommendation(novel, "ru"), novel);
  });
});
