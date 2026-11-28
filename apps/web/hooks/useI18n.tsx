"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import { getLocalePlugin, getSupportedLocales } from "@/lib/i18n/registry";
import { translateMessage } from "@/lib/i18n/format";
import type { Locale, Translate, TranslationParams } from "@/lib/i18n/types";

const locale: Locale = "en";

interface I18nContextValue {
  locale: Locale;
  t: Translate;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function getMessages(): Record<string, Record<string, string>> {
  return Object.fromEntries(getSupportedLocales().flatMap((id) => {
    const plugin = getLocalePlugin(id);
    return plugin ? [[id, plugin.messages]] : [];
  }));
}

/**
 * Provides Pi Web's interface locale (English only) and its translation function.
 * @param props React children
 * @returns the children inside the i18n context
 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const messages = useMemo(() => getMessages(), []);
  const t = useCallback((key: string, params?: TranslationParams) => translateMessage(locale, key, messages, params), [messages]);
  const value = useMemo(() => ({ locale, t }), [t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Returns the i18n context of the component tree.
 * @returns the current locale and the translation function
 * @throws when the component is not inside I18nProvider
 */
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
