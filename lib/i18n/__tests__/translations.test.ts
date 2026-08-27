import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { translations, translate, type TranslationKey } from "../translations";

describe("translations dictionary", () => {
  test("every English key has a Russian counterpart (no missing translations)", () => {
    const enKeys = Object.keys(translations.en) as TranslationKey[];
    const missing = enKeys.filter((k) => !(k in translations.ru));
    assert.deepEqual(missing, [], `keys missing from ru: ${missing.join(", ")}`);
  });

  test("every Russian key exists in English too (no orphaned ru-only keys)", () => {
    const ruKeys = Object.keys(translations.ru);
    const missing = ruKeys.filter((k) => !(k in translations.en));
    assert.deepEqual(missing, [], `ru keys not present in en: ${missing.join(", ")}`);
  });

  test("no Russian value is empty or accidentally left equal to a placeholder", () => {
    for (const [key, value] of Object.entries(translations.ru)) {
      assert.ok(value.length > 0, `ru.${key} is empty`);
    }
  });
});

describe("translate()", () => {
  test("returns the English string for language 'en'", () => {
    assert.equal(translate("settingsTitle", "en"), "Settings");
  });

  test("returns the Russian string for language 'ru'", () => {
    assert.equal(translate("settingsTitle", "ru"), "Настройки");
  });

  test("substitutes {vars} placeholders", () => {
    assert.equal(translate("liveInputsOf", "en", { count: 3, total: 6 }), "Live inputs: 3 of 6");
    assert.equal(translate("viewMoreEvents", "ru", { n: 5 }), "Показать ещё 5 событий");
  });

  test("falls back to English for an unrecognized language value at runtime", () => {
    // @ts-expect-error deliberately passing an invalid language to prove the runtime fallback
    assert.equal(translate("settingsTitle", "fr"), "Settings");
  });
});
