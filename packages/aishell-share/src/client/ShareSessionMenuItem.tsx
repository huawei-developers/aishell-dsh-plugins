/**
 * The "Share session" row in one Session's "..." menu.
 *
 * One entry in `sidebar.workspaces.session.menu.item`, placed between the
 * shipped `fork` row and the archive section so it sits with the other
 * actions on a conversation rather than beside archiving.
 *
 * The row dismisses the menu and asks the machine to open the share dialog;
 * it does not upload anything itself. A menu press is an intent to share, and
 * the confirmation the dialog draws is what sends.
 *
 * ## The icon
 *
 * Every shipped row in this menu leads with a glyph — pin, rename, fork — so a
 * row without one reads as an afterthought regardless of where it is ordered.
 * `IconRightUpOutlineRegular` is the arrow leaving a frame: the shape a reader
 * already knows as "share out" or "open elsewhere".
 *
 * Not `IconShareOutlineRegular`: its artwork is a paper plane, which beside
 * this session's messages reads as "send something", not "export this
 * conversation". Not `IconLinkOutlineRegular` either — a chain reads as "copy
 * link", and this row opens a dialog before any link exists.
 *
 * The glyph carries no `aria-label`: `MenuItemButton` already renders the row's
 * text as its accessible name, and the icon is decorative beside it.
 *
 * @module @huaweidevtools/aishell-dsh-share/client/ShareSessionMenuItem
 */

import { IconRightUpOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** What this row receives from its registrar. */
export interface ShareSessionMenuItemInjected {
  readonly startShare: (sessionId: SessionId) => void
}

/** Props of the menu row. */
export type ShareSessionMenuItemProps = PropsRuntime<'sidebar.workspaces.session.menu.item'> & PropsLocale<'aishell-share'> & ShareSessionMenuItemInjected

export function ShareSessionMenuItem({ sessionId, useMenuOpenState, startShare, t }: ShareSessionMenuItemProps): React.ReactElement {
  const [, setMenuOpen] = useMenuOpenState()

  return (
    <MenuItemButton
      icon={<IconRightUpOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false)
        startShare(sessionId)
      }}
    >
      {t('menu.share')}
    </MenuItemButton>
  )
}