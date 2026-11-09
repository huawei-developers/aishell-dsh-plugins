/**
 * aishell-llm locale dictionaries — the Models-page provider row's copy.
 *
 * The row shadow is a DOM patch, not a React render, so its strings do not
 * ride the framework's locale seat: the install reads them through `t` at
 * install time and repaints on a locale switch (the client half re-installs
 * on `locale/change`). zh is the key-set source of truth; en mirrors it.
 *
 * @module @huaweidevtools/aishell-dsh-llm/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'aishell-llm' as const

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  // Status dot hover copy, by readiness. The warn state keeps the actionable
  // half — where to enter AK/SK — because that is the one thing a fresh user
  // cannot guess.
  'provider.ready': '已就绪',
  'provider.warn': '未就绪 — 凭据未配置（点击对话输入框上方的凭据按钮填写 AK/SK）',
} as const

/** English dictionary. */
export const en = {
  'provider.ready': 'Ready',
  'provider.warn':
    'Not ready — credentials missing (click the credentials button above the chat input to enter AK/SK)',
} as const

/** All keys (derived from the zh dictionary, the source of truth). */
export type AishellLlmLocaleKey = keyof typeof zh

// Merge the `aishell-llm` namespace into the framework's LocaleNamespaceMap
// so a typed `t` resolves at compile time for the shadow's install copy.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'aishell-llm': AishellLlmLocaleKey
  }
}
