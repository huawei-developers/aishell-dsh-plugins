/**
 * The Huawei Cloud skills market tab: list, filter, and act.
 *
 * ## Layout
 *
 * The tab renders inside the Plugins page's content area, which already owns the
 * page header, its tabs, and the scroll container. So this component contributes
 * only what the tab itself owns: a row for what the person types, a row for what
 * they narrow by, and the grid of cards (or one skill's page). It draws no title
 * of its own — the page above it already says where the person is.
 *
 * Neither row is sticky. The page above already carries a header and a tab row,
 * and a third persistent band on a phone would take the height the list needs.
 *
 * ## Structure
 *
 * Search and refresh act on what was typed, so they share a row; the install
 * switch and the category rail both narrow the same result, so they share the
 * next one. Each card is an `<article>` whose heading holds the link that opens
 * the skill's page; the action is a separate native control lifted above that
 * link's stretched hit area, the "content card with a stretched link" model
 * rather than a whole-card link — a card carrying a button cannot also be one
 * link.
 *
 * One page of cards at a time, because the catalogue is large enough that holding
 * all of it is the work every keystroke would redo.
 *
 * The busy state is per skill, not global: installing one leaves the others
 * actionable.
 *
 * ## Why no dialog for install
 *
 * Installing is reversible by the uninstall button beside it, so it does not
 * interrupt. Uninstall is confirmed, because the confirmation is the only thing
 * standing between a mis-click and losing the bundle.
 *
 * @module @huaweidevtools/aishell-dsh-huaweicloud-skills-market/client/SkillsMarket
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
// Type-only: pulls the ui-slots contracts this component's props are typed against.
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  DetailDocument,
  Input,
  useDetailDocumentLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'

import type { MarketSkill } from '../route.ts'
import { cardTags, categoriesOf, installedCount, pageOf, visibleSkills, type InstallFilter, type MarketStore } from './store.ts'
import type {} from './locales.ts'
import styles from './styles.module.css'

/** What the tab's registrant supplies. */
export interface SkillsMarketInjected {
  /** The store, created once per registration. */
  readonly store: MarketStore
}

/** The component's props. */
export type SkillsMarketProps = PropsLocale<'aishell-huaweicloud-skills-market'> & InjectFace<SkillsMarketInjected>

/**
 * Subscribe a component to the store.
 *
 * @param store - the market store.
 * @returns the current snapshot, re-read on every change.
 */
/**
 * The name without its vendor prefix.
 *
 * Every upstream name opens with `huawei-cloud-`, which carries nothing on a
 * page that is entirely Huawei Cloud; the rest of the name is what distinguishes
 * one skill from another. The full name stays in the button's `title` and on the
 * skill's page, where the registry's spelling matters.
 *
 * @param name - the catalogue name.
 * @returns the name a card shows.
 */
/** Six placeholders: enough to fill a page's first screen without pretending to
 * be the real count. */
const SKELETON_CARDS = [0, 1, 2, 3, 4, 5]

function shortName(name: string): string {
  return name.startsWith('huawei-cloud-') ? name.slice('huawei-cloud-'.length) : name
}

function useMarket(store: MarketStore): MarketStore {
  return useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribe(listener), [store]),
    useCallback(() => store.snapshot(), [store]),
    useCallback(() => store.snapshot(), [store]),
  )
}

/**
 * Render the tab.
 *
 * @param props - the locale seat and the store.
 * @returns the tab's content.
 */
export function SkillsMarket(props: SkillsMarketProps): ReactNode {
  const market = useMarket(props.store)
  const t = props.t
  const [confirming, setConfirming] = useState<string | undefined>(undefined)

  // The tab's entry is the one moment a read is wanted, and the store remembers
  // that it happened: a remount of this component — a tab switch away and back —
  // must not spend another clone.
  useEffect(() => {
    if (!props.store.snapshot().started) props.store.refresh()
  }, [props.store])

  if (market.detail.status !== 'closed') {
    return <SkillPage market={market} t={t} onUninstall={setConfirming} />
  }

  const catalog = market.state.status === 'ready' ? market.state.catalog : undefined
  const skills = catalog?.skills ?? []
  const matching = visibleSkills(skills, market.query, market.category, market.installFilter)
  const page = pageOf(matching, market.page)
  const categories = categoriesOf(skills)
  const installed = installedCount(skills)

  return (
    <div className={styles['aishell-market']}>
      {/* One row for what the person types, one for what they narrow by. Search
          and refresh stay with the text they act on; the two filters share a row
          because a filter changes a filter's result, and reading them side by side
          shows that they compose. */}
      <div className={styles['aishell-market__bar']}>
        <Input
          className={styles['aishell-market__search'] ?? ''}
          type="search"
          icon={<SearchIcon />}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          value={market.query}
          onChange={(event) => { market.search(event.target.value) }}
        />
        {/* A refresh is one action with no options, so it is an icon with a
            name rather than a word that costs a third of the toolbar's width. */}
        <button
          type="button"
          className={styles['aishell-market__refresh']}
          aria-label={t('action.refresh')}
          title={t('action.refresh')}
          data-busy={market.state.status === 'ready' && market.state.refreshing ? 'true' : undefined}
          disabled={market.state.status === 'loading' || (market.state.status === 'ready' && market.state.refreshing)}
          onClick={() => { market.refresh() }}
        >
          <RefreshIcon />
        </button>
      </div>

      {/* Two filter groups in one row. `role="group"` on each keeps them
          distinguishable to a screen reader: the install switch is exclusive,
          the category rail is not, and reading them as one widget would misstate
          that. */}
      <div className={styles['aishell-market__filters']}>
        {/* A segmented control, not chips: these three are one exclusive choice,
            so they read as a single switch rather than three filters. Exactly one
            carries `aria-pressed="true"`, and no label changes when it does. */}
        <div className={styles['aishell-market__segment']} role="group" aria-label={t('filter.install')}>
          {(['all', 'installed', 'available'] as const).map(option => (
            <button
              key={option}
              type="button"
              className={styles['aishell-market__segmentItem']}
              aria-pressed={market.installFilter === option}
              onClick={() => { market.filterInstall(option as InstallFilter) }}
            >
              {option === 'all'
                ? t('filter.install.all', { count: skills.length })
                : option === 'installed'
                  ? t('filter.install.installed', { count: installed })
                  : t('filter.install.available', { count: skills.length - installed })}
            </button>
          ))}
        </div>
        {categories.length > 1 && (
          <div className={styles['aishell-market__categories']} role="group" aria-label={t('filter.label')}>
            <CategoryChip
              label={t('filter.all')}
              selected={market.category === undefined}
              onSelect={() => { market.filter(undefined) }}
            />
            {categories.map(category => (
              <CategoryChip
                key={category}
                label={category}
                selected={market.category === category}
                onSelect={() => { market.filter(category) }}
              />
            ))}
          </div>
        )}
      </div>

      <Body
        market={market}
        page={page}
        total={skills.length}
        t={t}
        onUninstall={setConfirming}
      />
      {confirming !== undefined && (
        <UninstallDialog
          name={confirming}
          t={t}
          onCancel={() => { setConfirming(undefined) }}
          onConfirm={() => {
            market.uninstall(confirming)
            setConfirming(undefined)
          }}
        />
      )}
    </div>
  )
}

/**
 * Render the list's body: skeletons, an error, an empty state, or rows.
 *
 * @param props - the market, the filtered skills, the locale, and the uninstall opener.
 * @returns the body.
 */
function Body({ market, page, total, t, onUninstall }: {
  market: MarketStore
  page: ReturnType<typeof pageOf>
  total: number
  t: SkillsMarketProps['t']
  onUninstall: (name: string) => void
}): ReactNode {
  // A pager that leaves the scroll position at the old page's foot reads as "the
  // button did nothing". Moving the view to the new page's first card, and focus
  // with it, is what makes the change visible — including to someone who is not
  // looking at the whole page move.
  const listRef = useRef<HTMLUListElement>(null)
  const shownPage = page.page
  const previousPage = useRef(shownPage)
  useEffect(() => {
    // Only a page the person asked for: the first render is the tab opening, and
    // scrolling then would move a page they have not read yet.
    const changed = previousPage.current !== shownPage
    previousPage.current = shownPage
    const list = listRef.current
    if (!changed || list === null) return
    list.scrollIntoView({ block: 'start', behavior: 'smooth' })
    list.focus({ preventScroll: true })
  }, [shownPage])
  if (market.state.status === 'loading') {
    return (
      <div className={styles['aishell-market__state']} role="status" aria-live="polite">
        <p className={styles['aishell-market__stateTitle']}>{t('state.loading')}</p>
        <p className={styles['aishell-market__stateHint']}>{t('state.loadingHint')}</p>
        <ul className={styles['aishell-market__list']} aria-hidden="true">
          {SKELETON_CARDS.map(index => <SkeletonRow key={index} />)}
        </ul>
      </div>
    )
  }

  if (market.state.status === 'failed') {
    return (
      <div className={styles['aishell-market__state']} role="alert">
        <p className={styles['aishell-market__stateTitle']}>{t('state.failed')}</p>
        <p className={styles['aishell-market__stateHint']}>{market.state.message}</p>
        <Button variant="outline" size="sm" onClick={() => { market.refresh() }}>{t('state.retry')}</Button>
      </div>
    )
  }

  if (page.skills.length === 0) {
    return (
      <div className={styles['aishell-market__state']} role="status">
        <p className={styles['aishell-market__stateTitle']}>{t('state.empty')}</p>
        <p className={styles['aishell-market__stateHint']}>{t('state.emptyHint')}</p>
      </div>
    )
  }

  const matching = page.pageCount === 1 ? page.skills.length : undefined

  return (
    <>
      {/* One live count, worded for whether a filter narrowed the list: a person
          who typed a filter should see that it applied, not a total. The page
          number rides the same line, because it answers the same question —
          where am I in what matched. */}
      <p className={styles['aishell-market__count']} aria-live="polite">
        {matching === undefined
          ? t('count.paged', { page: page.page + 1, pages: page.pageCount })
          : matching === total
            ? t('count.skills', { count: matching })
            : t('count.filtered', { count: matching })}
      </p>
      <ul className={styles['aishell-market__list']} ref={listRef} tabIndex={-1}>
        {page.skills.map(skill => (
          <SkillCard
            key={skill.name}
            skill={skill}
            market={market}
            t={t}
            onUninstall={() => { onUninstall(skill.name) }}
          />
        ))}
      </ul>
      {page.pageCount > 1 && (
        <nav className={styles['aishell-market__pager']} aria-label={t('pager.label')}>
          <Button
            variant="outline"
            size="sm"
            disabled={page.page === 0}
            onClick={() => { market.goToPage(page.page - 1) }}
          >
            {t('pager.previous')}
          </Button>
          <span className={styles['aishell-market__pagerStatus']} aria-live="polite">
            {t('pager.status', { page: page.page + 1, pages: page.pageCount })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page.page >= page.pageCount - 1}
            onClick={() => { market.goToPage(page.page + 1) }}
          >
            {t('pager.next')}
          </Button>
        </nav>
      )}
    </>
  )
}

/**
 * One skill's card.
 *
 * The card is a shop window: what the skill is, what it does, and the one action
 * beside it. Three details are deliberate rather than decorative:
 *
 *   - **The whole card is a target, the name is the link.** The title's button
 *     stretches an overlay across the card (`::after`), so a click anywhere opens
 *     the page, while the install button is lifted above that overlay so it keeps
 *     its own clicks. The accessible name stays short — one link per card — which
 *     is the stretched-link model rather than a link wrapping the article.
 *   - **The installed mark rides the corner**, where it is visible while scanning
 *     names and never competes with the action below it.
 *   - **The tags carry the card's facts**, category and product first, so the
 *     product name does not have to be stated twice.
 *
 * @param props - the skill, the market, the locale, and the uninstall opener.
 * @returns the card.
 */
function SkillCard({ skill, market, t, onUninstall }: {
  skill: MarketSkill
  market: MarketStore
  t: SkillsMarketProps['t']
  onUninstall: () => void
}): ReactNode {
  const busy = market.activity?.name === skill.name
  const failed = market.failure?.name === skill.name
  return (
    <li>
      <article className={styles['card']} aria-busy={busy}>
        {skill.installed && (
          <span className={styles['card__badge']}>
            <TickIcon />
            {t('action.installed')}
          </span>
        )}
        <h3 className={styles['card__title']}>
          <button
            type="button"
            className={styles['card__link']}
            title={skill.name}
            onClick={() => { market.openDetail(skill.name) }}
          >
            {shortName(skill.name)}
          </button>
        </h3>
        <p className={styles['card__text']}>{skill.description}</p>
        {failed && (
          <p className={styles['card__error']} role="alert">{market.failure?.message}</p>
        )}
        <div className={styles['card__foot']}>
          <div className={styles['card__tags']}>
            {cardTags(skill).map(label => (
              <span key={label} className={styles['tag']}>{label}</span>
            ))}
          </div>
          <div className={styles['card__actions']}>
            <SkillAction skill={skill} market={market} t={t} onUninstall={onUninstall} />
          </div>
        </div>
      </article>
    </li>
  )
}

/**
 * Render one skill's page.
 *
 * @param props - the market and the locale.
 * @returns the page.
 */
function SkillPage({ market, t, onUninstall }: {
  market: MarketStore
  t: SkillsMarketProps['t']
  onUninstall: (name: string) => void
}): ReactNode {
  const detail = market.detail
  // The catalogue entry the page is about, for the action beside its title.
  const detailSkill = detail.status === 'closed' || market.state.status !== 'ready'
    ? undefined
    : market.state.catalog.skills.find(candidate => candidate.name === detail.name)
  // `DetailDocument` owns the chrome a rendered document needs — a named scroll
  // region, copy buttons, footnote chrome — and its labels must stay
  // reference-stable across renders or it re-parses the document each time.
  const labels = useDetailDocumentLabels(useMemo(() => ({
    title: t('detail.documentTitle'),
    loading: t('state.loading'),
    retry: t('state.retry'),
    copy: t('action.copy'),
    copied: t('action.copied'),
    codeBlock: t('detail.codeBlock'),
    wrap: t('detail.wrap'),
    unwrap: t('detail.unwrap'),
    footnotes: t('detail.footnotes'),
  }), [t]))
  return (
    <div className={styles['aishell-market__page']}>
      <div className={styles['aishell-market__pageBar']}>
        <Button variant="ghost" size="sm" onClick={() => { market.closeDetail() }}>{t('action.back')}</Button>
        {/* The action the person came here to decide about, where they are
            deciding it. Reading a skill's instructions is the step that precedes
            installing or removing it, and the card is off screen by now. */}
        {detailSkill !== undefined && (
          <SkillAction
            skill={detailSkill}
            market={market}
            t={t}
            onUninstall={() => { onUninstall(detailSkill.name) }}
          />
        )}
      </div>
      {detail.status === 'ready'
        ? (
            <article className={styles['aishell-market__document']}>
              <DetailDocument
                state={{ status: 'found', markdown: detail.detail.body }}
                labels={labels}
                onRetry={() => { market.openDetail(detail.name) }}
              />
              <p className={styles['aishell-market__source']}>
                <a href={detail.detail.sourceUrl} target="_blank" rel="noreferrer noopener">
                  {t('action.openSource')}
                </a>
              </p>
            </article>
          )
        : (
            <DetailDocument
              state={detail.status === 'failed'
                ? { status: 'error', message: detail.message }
                : { status: 'loading' }}
              labels={labels}
              onRetry={() => {
                if (detail.status !== 'closed') market.openDetail(detail.name)
              }}
            />
          )}
    </div>
  )
}

/**
 * One category filter chip.
 *
 * A native button with `aria-pressed` rather than a tab: these are independent
 * filters, not panels, and the whole set is one row a person scans.
 *
 * @param props - the label, whether it is selected, and what to do on click.
 * @returns the chip.
 */
function CategoryChip({ label, selected, onSelect }: {
  label: string
  selected: boolean
  onSelect: () => void
}): ReactNode {
  return (
    <button
      type="button"
      className={styles['aishell-market__chip']}
      aria-pressed={selected}
      onClick={onSelect}
    >
      {label}
    </button>
  )
}

/**
 * The uninstall confirmation.
 *
 * A `dialog` element rather than a custom overlay: it brings focus containment,
 * Escape, and the top layer without a library, and it is the one interruption
 * this tab makes.
 *
 * @param props - the skill name, the locale, and the two answers.
 * @returns the dialog.
 */
function UninstallDialog({ name, t, onCancel, onConfirm }: {
  name: string
  t: SkillsMarketProps['t']
  onCancel: () => void
  onConfirm: () => void
}): ReactNode {
  // A native <dialog> opened with `showModal()`: the browser owns Escape, focus
  // containment, and the top layer, so none of the three is reimplemented here.
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (dialog === null || dialog.open) return
    dialog.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      className={styles['aishell-market__dialog']}
      aria-labelledby="aishell-market-uninstall-title"
      // Escape closes the element itself; the state has to follow it, or the
      // row stays armed for an uninstall the person just declined.
      onCancel={(event) => { event.preventDefault(); onCancel() }}
      onClick={(event) => { if (event.target === event.currentTarget) onCancel() }}
    >
      <h2 id="aishell-market-uninstall-title" className={styles['aishell-market__dialogTitle']}>{t('action.uninstall')}</h2>
      <p className={styles['aishell-market__dialogBody']}>{name}</p>
      <div className={styles['aishell-market__dialogActions']}>
        <Button variant="ghost" size="sm" onClick={onCancel}>{t('action.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={onConfirm}>{t('action.uninstall')}</Button>
      </div>
    </dialog>
  )
}

/**
 * One skeleton row, shown while the first read runs.
 *
 * @returns the skeleton.
 */
function SkeletonRow(): ReactNode {
  // The placeholder mirrors the card's four regions, so the list does not jump
  // when the real cards replace it.
  return (
    <li>
      <div className={`${styles['card']} ${styles['card--skeleton']}`}>
        <div className={`${styles['skeleton']} ${styles['skeleton--title']}`} />
        <div className={`${styles['skeleton']} ${styles['skeleton--text']}`} />
        <div className={`${styles['skeleton']} ${styles['skeleton--text2']}`} />
        <div className={styles['card__foot']}>
          <div className={styles['card__tags']}>
            <div className={`${styles['skeleton']} ${styles['skeleton--tag']}`} />
            <div className={`${styles['skeleton']} ${styles['skeleton--tag']}`} />
          </div>
        </div>
      </div>
    </li>
  )
}

/**
 * The install or uninstall control for one skill, wherever it is shown.
 *
 * One component for the card and the detail page, so the two surfaces cannot
 * disagree about what is installed or what the button says while a request runs.
 *
 * @param props - the skill, the market, the locale, and the uninstall opener.
 * @returns the button.
 */
function SkillAction({ skill, market, t, onUninstall }: {
  skill: MarketSkill
  market: MarketStore
  t: SkillsMarketProps['t']
  onUninstall: () => void
}): ReactNode {
  const busy = market.activity?.name === skill.name
  return skill.installed
    ? (
        <Button variant="ghost" size="sm" disabled={busy} onClick={onUninstall}>
          {busy && market.activity?.kind === 'uninstall' ? t('action.uninstalling') : t('action.uninstall')}
        </Button>
      )
    : (
        <Button
          variant="outline"
          size="sm"
          disabled={busy || market.activity !== undefined}
          onClick={() => { market.install(skill.name) }}
        >
          {busy && market.activity?.kind === 'install' ? t('action.installing') : t('action.install')}
        </Button>
      )
}

/** A 16px circular refresh arrow; it spins while a read runs (see the sheet). */
function RefreshIcon(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M13.5 2.6v3.2h-3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A 10px tick, used by the installed corner mark. */
function TickIcon(): ReactNode {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2 6.5 4.5 9 10 3.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A 16px magnifier, drawn inline so the tab carries no icon dependency. */
function SearchIcon(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}