import { enLocale } from "./messages/en";
import type { LocalePlugin } from "./types";

const localePlugins: LocalePlugin[] = [enLocale];

/**
 * 根据标识获取已注册的语言包。
 * @param id 要查询的语言标识
 * @returns 已注册的语言包，不存在时返回 undefined
 */
export function getLocalePlugin(id: string): LocalePlugin | undefined {
  return localePlugins.find((plugin) => plugin.id === id);
}

/** 获取当前已注册语言的稳定顺序列表。 */
export function getSupportedLocales(): string[] {
  return localePlugins.map((plugin) => plugin.id);
}
