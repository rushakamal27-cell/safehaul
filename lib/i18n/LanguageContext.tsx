"use client";

/**
 * lib/i18n/LanguageContext.tsx
 *
 * Client-side language provider for SafeHaul's presentation-layer
 * localization. English is the default; Russian is manually selectable
 * (Settings → Language) and persists locally via `localStorage` — no
 * backend/DB field, matching the Plan Mode report's hard constraint
 * against a UI-preference backend endpoint.
 *
 * Mirrors this repo's existing standalone-hook convention
 * (lib/useTelegram.ts): a small, self-contained provider + hook, guarded
 * for SSR since Next.js still does an initial server render even though
 * every consuming screen is already `"use client"`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { translate, type Language, type TranslationKey } from "./translations";

const STORAGE_KEY = "safehaul_language";

interface LanguageContextValue {
  language: Language;
  setLanguage: (lang: Language) => void;
  /** Looks up `key` for the current language, falling back to English for any unknown key/language — see translate() in ./translations. */
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

function readStoredLanguage(): Language {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "ru" ? "ru" : "en";
  } catch {
    // localStorage unavailable (private mode, disabled storage, etc.) —
    // fall back to the default rather than throwing.
    return "en";
  }
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  // Always starts "en" on the server render; synced from localStorage in
  // an effect after mount (same SSR-safe pattern as useTelegram.ts's
  // Telegram-SDK read) so there's no server/client markup mismatch.
  const [language, setLanguageState] = useState<Language>("en");

  useEffect(() => {
    setLanguageState(readStoredLanguage());
  }, []);

  useEffect(() => {
    try {
      document.documentElement.lang = language;
    } catch {
      // Non-fatal — the <html lang> attribute is a nice-to-have, not
      // required for the UI to function correctly.
    }
  }, [language]);

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // Non-fatal — the selection still applies for the rest of this
      // session even if it can't be persisted.
    }
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => translate(key, language, vars),
    [language]
  );

  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

/** Falls back to English with a no-op setter if called outside LanguageProvider (defensive — every screen in this app is rendered under RootLayout's provider) rather than throwing. */
export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (ctx) return ctx;
  return {
    language: "en",
    setLanguage: () => {},
    t: (key, vars) => translate(key, "en", vars),
  };
}
