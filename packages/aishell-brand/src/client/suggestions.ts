/**
 * The New-Session example cards, and the shapes they need.
 *
 * One array drives the whole strip: add or reorder a card by editing
 * `SUGGESTIONS` and adding its three keys to `locales.ts`, and nothing else.
 * The row renders whatever it is given — three or fewer display side by side
 * with no arrows, more than three become a carousel.
 *
 * ## This file holds no copy
 *
 * Every string a person reads — the card title, its one-line gloss, and the
 * prompt a click inserts — lives in `locales.ts`, addressed by the keys here.
 * A card whose text were inlined would be readable in exactly one language,
 * and the prompt it inserted would start a conversation in that language no
 * matter what the reader's locale was.
 *
 * The three keys per card are separate rather than one blob because the
 * surfaces differ: the card shows `title` and `gloss` (both clamped — one
 * line and two lines — so a long string ellipsizes instead of breaking the
 * row), while `prompt` goes to the composer and is never displayed on the
 * card. A prompt that only restates its title makes the click pointless;
 * written as a pair, the prompt carries the context and the expected output
 * that make the first message worth sending without editing.
 *
 * ## Sizing, when editing copy
 *
 * Three cards share one row, which at the default column leaves roughly 150px
 * per title — about seven CJK glyphs, or noticeably more Latin ones. Measured
 * against the shipped set: every title fits at 560px and above, and all five
 * clip below ~460px. Keep them within a couple of characters of each other —
 * the longest one is otherwise the only card that ever shows an ellipsis,
 * which reads as a bug rather than as a long name.
 *
 * @module @huaweidevtools/aishell-dsh-brand/client/suggestions
 */

import type { AishellBrandLocaleKey } from './locales.ts'

/** One example card: what it looks like, and what a click inserts. */
export interface Suggestion {
  /**
   * Stable identity for React keys and for the carousel's position maths.
   * Not shown to anyone — it names the dictionary key prefix, so renaming it
   * means renaming three keys in `locales.ts`.
   */
  readonly id: string
  /** Icon key resolved by {@link SuggestionIconArt}. */
  readonly icon: SuggestionIcon
  /** The tile colour, measured to work in both themes. See {@link SuggestionHue}. */
  readonly hue: SuggestionHue
  /** Dictionary key for the card's one-line title. */
  readonly titleKey: AishellBrandLocaleKey
  /** Dictionary key for the line under the title. */
  readonly glossKey: AishellBrandLocaleKey
  /** Dictionary key for the text inserted into the composer. */
  readonly promptKey: AishellBrandLocaleKey
}

/** The icon set this strip can draw. Keys are local to this plugin. */
export type SuggestionIcon = 'cloud' | 'deploy' | 'architecture' | 'cost' | 'security'

/**
 * The tile colour for one card, as the shell's own token names.
 *
 * ## Why each card carries its own hue
 *
 * A row of small glyphs is read at a glance, and one accent across all of them
 * makes it a wall of identical tiles. The shell answers this exact situation
 * per item: `FileTypeIcon` gives every entry in a row its own hue (`code` blue,
 * `excel` green, `folder` amber, `image` violet). Colour is what makes such a
 * row scannable, and five hues beside the brand mark do not read as noise
 * because each one belongs to a card rather than competing with the others.
 *
 * ## These are STATIC tokens, not the semantic ones
 *
 * `--dsw-alias-state-success-primary` and friends mean "the operation
 * succeeded" / "this needs attention". A card about cost is not a warning, so
 * borrowing the warning colour would be a lie the palette tells. The `static`
 * family is the one intended for decorative identity, which is exactly what a
 * card's hue is — and `FileTypeIcon` reaches for the same family.
 *
 * ## The values were chosen by measurement, in both themes
 *
 * Violet is the exception: the design platform ships NO violet token, so
 * `FileTypeIcon` defines one locally (`rgb(139, 118, 246)`) for its own
 * artwork. The same value is reused here rather than inventing a second one,
 * and it is the only literal colour in this plugin.
 *
 * The five were picked to clear three bars at once, in both themes:
 *
 *   - glyph on its tile >= 4.5 — measured 5.42 at worst (violet);
 *   - tile against the card >= 1.6 — measured 2.05 at worst;
 *   - worst pairwise colour distance >= 30 (CIE76 dE) — measured 38.7.
 *
 * The last bar is the one that matters for "five colours, not one blur": an
 * obvious-looking pick like blue + violet measures only 17.5 apart, which is
 * why this is measured rather than eyeballed. Adding the fifth hue did not
 * move either floor — red's nearest neighbour is amber at 42.9, and the
 * tightest pair is still blue vs violet.
 */
export interface SuggestionHue {
  /**
   * The tile fill. A SOLID hue, with the glyph in `--dsw-alias-label-primary-
   * foreground` on top.
   *
   * A tint of the hue was the first attempt and it measured badly: a glyph
   * drawn in a hue on top of a tint of that same hue has almost nothing to
   * separate them, so the contrast was 1.8–2.8 — and RAISING the tint made it
   * worse, since more of the hue behind the glyph means less difference from
   * it. A solid tile puts the glyph on full-strength colour instead, which
   * measured 5.4–9.9 for the same hues.
   */
  readonly tile: string
}

/**
 * The cards, in display order.
 *
 * Order matters only for the ring's starting window: the strip opens on the
 * first {@link VISIBLE} cards, so the first entries are the ones a person
 * sees without pressing an arrow.
 */
export const SUGGESTIONS: readonly Suggestion[] = [
  {
    id: 'inventory',
    icon: 'cloud',
    // Blue: the colour the shell already uses for a machine's identity
    // (`FileTypeIcon`'s `code`), and the one the brand itself is drawn in.
    hue: { tile: 'var(--dsw-static-blue-400)' },
    titleKey: 'suggestion.inventory.title',
    glossKey: 'suggestion.inventory.gloss',
    promptKey: 'suggestion.inventory.prompt',
  },
  {
    id: 'deploy',
    icon: 'deploy',
    // Green: "it is running".
    hue: { tile: 'var(--dsw-static-green-500)' },
    titleKey: 'suggestion.deploy.title',
    glossKey: 'suggestion.deploy.gloss',
    promptKey: 'suggestion.deploy.prompt',
  },
  {
    id: 'enterprise',
    icon: 'architecture',
    // The local violet, shared with FileTypeIcon's artwork.
    hue: { tile: 'rgb(139, 118, 246)' },
    titleKey: 'suggestion.enterprise.title',
    glossKey: 'suggestion.enterprise.gloss',
    promptKey: 'suggestion.enterprise.prompt',
  },
  {
    id: 'billing',
    icon: 'cost',
    // The 600 step rather than 400/500: amber is the lightest of the set, and
    // at 400 the tile fell to 1.72 against the card in light mode — barely an
    // object. The darker step reads as one in both themes.
    hue: { tile: 'var(--dsw-static-amber-600)' },
    titleKey: 'suggestion.billing.title',
    glossKey: 'suggestion.billing.gloss',
    promptKey: 'suggestion.billing.prompt',
  },
  {
    id: 'security',
    icon: 'security',
    // The palette's only remaining family. The theme ships amber, blue,
    // deepseek, green, neutral and red; the first four cards take blue, green,
    // the local violet and amber, so red is what is left — which is also the
    // colour a security review would want.
    //
    // 400 rather than 500 or 600, measured against the same three bars the
    // rest of this file was chosen by. Glyph on tile: 5.75 at 400, 5.02 at
    // 500, 4.20 at 600 — and 600 is under the 4.5 bar, so it is out. 400 also
    // keeps the whole set's floor where it was (violet's 5.42), where 500
    // would lower it. Separation is comfortable either way: red's nearest
    // neighbour is amber at 42.9 dE, over the 30 bar. With red added, the
    // set's tightest pair is still blue vs violet at 38.7 — unchanged.
    hue: { tile: 'var(--dsw-static-red-400)' },
    titleKey: 'suggestion.security.title',
    glossKey: 'suggestion.security.gloss',
    promptKey: 'suggestion.security.prompt',
  },
]