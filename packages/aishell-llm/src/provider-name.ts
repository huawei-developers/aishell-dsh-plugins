/**
 * The aishell provider's display name, shared by both plugin halves.
 *
 * The Host half registers it on the configurable-provider directory (the
 * Models page renders it as the provider row's name), and the browser half's
 * row shadow finds that row by matching the rendered name against this
 * literal (see `client/provider-row-shadow.ts`). It must stay a single
 * literal string — the shadow compares `textContent` with it.
 *
 * It is also the name `providerInfo()` reports, so the picker and the Models
 * row call the route the same thing: this package's whole surface is one
 * product, and qualifying it by cloud ("AI Shell (Huawei Cloud)") added a
 * distinction no reader needed — there is no second AI Shell to tell it
 * apart from.
 */

export const PROVIDER_DISPLAY_NAME = 'AI Shell'
