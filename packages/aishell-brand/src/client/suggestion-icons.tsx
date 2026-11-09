/**
 * Inline SVG artwork for the suggestion cards.
 *
 * Inline rather than an icon dependency: the strip draws five shapes, and a
 * dependency would add a package, a version to track, and a bundle face to
 * keep in step with the host.
 *
 * Every path is drawn on a 24×24 viewBox with `currentColor`, so a card
 * decides the colour by setting `color` and nothing here hard-codes a theme
 * value.
 *
 * ## Shape rules, learned by getting them wrong
 *
 * The first draft drew "deploy" as a box with an arrow leaving it — which
 * reads as SHARE or export, the one meaning this card must not carry. A
 * glyph in a row is read at a glance and out of context, so each one
 * has to be recognisable on its own:
 *
 *   - nothing may resemble the share glyph (box + outward arrow) or the
 *     external-link glyph (box + arrow through a corner);
 *   - every shape is closed and filled-ish in silhouette, because outlines
 *     at 20px in a row blur into each other;
 *   - no glyph carries more than three strokes, so they stay distinguishable
 *     at the size they are actually drawn.
 *
 * These rules are not machine-checked: rendering the glyphs needs
 * `react-dom/server`, which this repo does not depend on, and vitest here
 * collects only `.spec.ts` (not `.tsx`). The browser harness in
 * `scripts/render-check/` is what actually puts them on screen.
 *
 * @module @huaweidevtools/aishell-dsh-brand/client/suggestion-icons
 */

import type { ReactNode } from 'react'
import type { SuggestionIcon } from './suggestions.ts'

/** Props shared by every glyph. */
interface IconProps {
  /** Rendered size in px; the cards use 20. */
  readonly size?: number
}

/** One stroked path with the shared paint attributes. */
function Stroke({ d }: { readonly d: string }): ReactNode {
  return (
    <path
      d={d}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  )
}

/**
 * A stack of servers: the resource inventory.
 *
 * Three stacked slabs with a status dot each — unmistakably "machines you
 * own", and it shares no silhouette with any other glyph here.
 */
function InventoryIcon(): ReactNode {
  return (
    <>
      <Stroke d="M4 5.5h16v4H4z" />
      <Stroke d="M4 14.5h16v4H4z" />
      <Stroke d="M7 7.5h.01" />
      <Stroke d="M7 16.5h.01" />
    </>
  )
}

/**
 * A rocket: deploying something so it runs.
 *
 * Chosen over any box-with-arrow because that family is exactly the share
 * glyph. A rocket is a single closed silhouette — nothing in this set can
 * be confused with it.
 */
function DeployIcon(): ReactNode {
  return (
    <>
      <Stroke d="M12 3c2.8 1.9 4.2 4.6 4.2 7.6 0 2.3-.9 4.3-2.1 5.6H9.9C8.7 14.9 7.8 12.9 7.8 10.6 7.8 7.6 9.2 4.9 12 3Z" />
      <Stroke d="M9.9 16.2 8.4 19.4l2.3-1M14.1 16.2l1.5 3.2-2.3-1" />
      <Stroke d="M12 9.4a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z" />
    </>
  )
}

/**
 * A layered sitemap: account hierarchy and network partitions.
 *
 * One node branching to three, drawn as a single tree — reads as "structure"
 * rather than "file" or "folder", which a plain box-and-boxes would.
 */
function ArchitectureIcon(): ReactNode {
  return (
    <>
      <Stroke d="M9.5 3.5h5v3.4h-5z" />
      <Stroke d="M3.5 17.1h5v3.4h-5z" />
      <Stroke d="M9.5 17.1h5v3.4h-5z" />
      <Stroke d="M15.5 17.1h5v3.4h-5z" />
      <Stroke d="M12 6.9v4.2" />
      <Stroke d="M6 17.1v-2.4h12v2.4" />
    </>
  )
}

/**
 * A receipt with a downward trend: cost review.
 *
 * The torn bottom edge is what makes it a bill rather than a document —
 * without it the shape is a generic page and reads as "export a report".
 */
function CostIcon(): ReactNode {
  return (
    <>
      <Stroke d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z" />
      <Stroke d="M9.5 8.4h5" />
      <Stroke d="M9.5 12.2h3.2" />
    </>
  )
}

/**
 * A shield with a check: the security review.
 *
 * A shield is the one shape in this set that carries "protection" on its own,
 * and the check inside it reads as an inspection that came back — which is
 * the tool's actual job (it reports what it found, not that all is well).
 *
 * Chosen over a magnifier, which was the other candidate: a magnifier and the
 * already-shipped cost glyph both reduce to "a rounded outline with a small
 * mark inside" at 17px, and magnifiers are the generic stand-in for any
 * lookup. The shield keeps this glyph's silhouette distinct from the others.
 *
 * The check's elbow sits at x=11.2 and its tail rises to the shield's inner
 * edge; both strokes stay inside the outline so nothing breaks the closed
 * silhouette the shape rules ask for.
 */
function SecurityIcon(): ReactNode {
  return (
    <>
      <Stroke d="M12 3 4.8 5.9v5.3c0 4.3 2.9 8.3 7.2 9.9 4.3-1.6 7.2-5.6 7.2-9.9V5.9z" />
      <Stroke d="m8.9 12.1 2.3 2.3 4.4-4.4" />
    </>
  )
}

/** Resolve one icon key to its glyph. */
export function SuggestionIconArt({
  icon,
  size = 20,
}: IconProps & { readonly icon: SuggestionIcon }): ReactNode {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" style={{ flex: 'none' }}>
      {icon === 'cloud' && <InventoryIcon />}
      {icon === 'deploy' && <DeployIcon />}
      {icon === 'architecture' && <ArchitectureIcon />}
      {icon === 'cost' && <CostIcon />}
      {icon === 'security' && <SecurityIcon />}
    </svg>
  )
}