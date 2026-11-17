/**
 * The standing reply notice.
 *
 * What this pins, and why each part is load-bearing:
 *
 *   1. It appears on BOTH anchors — the running status and the Turn footer —
 *      because the footer slot only exists after the Turn ends and the notice
 *      has to be visible while the answer is still being written. Dropping the
 *      running anchor makes it vanish for exactly the interval a reader watches.
 *   2. It is a SIBLING of the anchor, so its spacing and its position relative
 *      to the action row do not change when the anchors swap mid-Turn.
 *   3. A re-scan does not duplicate it. The observer re-runs on every subtree
 *      insertion, so idempotence is what keeps ten notices from stacking.
 *   4. The disposer removes every notice this install added.
 *   5. The text can never become markup — it comes from a locale dictionary.
 */

import { describe, expect, it } from 'vitest'

import {
  installReplyDisclaimer,
  REPLY_DISCLAIMER_MARKER,
} from '../src/client/reply-disclaimer.ts'
import { en, zh } from '../src/client/locales.ts'
import {
  installStubGlobals,
  makeStubDocument,
  record,
  StubMutationObserver,
} from './stub-dom.ts'

/** Put one anchor into the document body and hand it back. */
function anchor(document: Document, attribute: string, className: string): Element {
  const element = document.createElement('div')
  element.setAttribute(attribute, '')
  element.className = className
  // A row the anchor already holds, so appending can be told from prepending.
  const own = document.createElement('div')
  own.className = 'own-content'
  element.appendChild(own)
  document.body.appendChild(element)
  return element as unknown as Element
}

/** The notices inside one subtree. */
function noticesIn(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll(`[${REPLY_DISCLAIMER_MARKER}]`)) as unknown as Element[]
}

/**
 * The notice that follows one anchor, if any.
 *
 * Returns null for anything else that happens to follow: with two anchors in one
 * body, the sibling after the first is the second anchor, not a notice.
 */
function noticeAfter(anchorElement: Element): Element | null {
  const following = anchorElement.nextElementSibling as unknown as Element | null
  return following !== null && following.hasAttribute(REPLY_DISCLAIMER_MARKER) ? following : null
}

describe('installReplyDisclaimer', () => {
  it('places the notice after the running status, as its sibling', () => {
    // A sibling, never a child: the anchor is two different elements over the
    // life of a Turn, with unrelated inner layouts, so a child's spacing and its
    // position relative to the action row would differ between them.
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const running = anchor(document, 'data-chat-running', 'running')
      const dispose = installReplyDisclaimer(document, () => zh['reply.disclaimer'])

      const notice = noticeAfter(running)
      expect(notice).not.toBeNull()
      expect(notice?.textContent).toBe(zh['reply.disclaimer'])
      // Not inside: the status keeps its own content untouched.
      expect(noticesIn(running)).toHaveLength(0)
      expect(running.children).toHaveLength(1)
      dispose()
    } finally { uninstall() }
  })

  it('places the notice after the Turn footer, behind the action row', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const footer = anchor(document, 'data-turn-tail', 'footer')
      const dispose = installReplyDisclaimer(document, () => zh['reply.disclaimer'])

      expect(noticeAfter(footer)?.textContent).toBe(zh['reply.disclaimer'])
      expect(noticesIn(footer)).toHaveLength(0)
      dispose()
    } finally { uninstall() }
  })

  it('adds a notice to an anchor that appears later', () => {
    // Turns mount and unmount as the transcript grows, so the first sweep
    // cannot be the only one.
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const dispose = installReplyDisclaimer(document, () => en['reply.disclaimer'])
      const late = anchor(document, 'data-chat-running', 'running')
      StubMutationObserver.lastInstance?.notify([
        record({ type: 'childList', target: document.body as unknown as Node, addedNodes: [late as unknown as Node] }),
      ])

      expect(noticeAfter(late)).not.toBeNull()
      dispose()
    } finally { uninstall() }
  })

  it('does not duplicate a notice when the same anchor is swept again', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const running = anchor(document, 'data-chat-running', 'running')
      const dispose = installReplyDisclaimer(document, () => zh['reply.disclaimer'])
      // Any unrelated insertion re-runs the sweep over a subtree that may
      // contain this anchor again.
      StubMutationObserver.lastInstance?.notify([
        record({ type: 'childList', target: running as unknown as Node, addedNodes: [] }),
      ])

      expect(noticeAfter(running)).not.toBeNull()
      dispose()
    } finally { uninstall() }
  })

  it('takes its vertical rhythm from the Turn flow', () => {
    // The flow spaces rows with `--dsh-chat-flow-gap` as a top margin on each,
    // so the notice takes the flow's rhythm rather than a margin of its own.
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const running = anchor(document, 'data-chat-running', 'running')
      installReplyDisclaimer(document, () => zh['reply.disclaimer'])
      const notice = noticeAfter(running) as unknown as { getAttribute: (name: string) => string | null } | null
      const style = notice?.getAttribute('style') ?? ''
      expect(style).toContain('margin-top: var(--dsh-chat-flow-gap, 4px)')
      // No flex `order`: a sibling needs none, and one would make the notice's
      // position depend on the anchor's display type.
      expect(style).not.toContain('order')
    } finally { uninstall() }
  })

  it('follows a language switch on a Turn already on screen', () => {
    // The notice outlives the language that was active when it was placed, and a
    // DOM element gets no re-render of its own: the resolver is asked again and
    // the locale subscription re-sweeps, which is what reaches old Turns.
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const running = anchor(document, 'data-chat-running', 'running')
      let language: 'zh' | 'en' = 'zh'
      const listeners = new Set<() => void>()
      const dispose = installReplyDisclaimer(
        document,
        () => (language === 'zh' ? zh : en)['reply.disclaimer'],
        { subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
      )
      expect(noticeAfter(running)?.textContent).toBe(zh['reply.disclaimer'])

      language = 'en'
      for (const listener of listeners) listener()
      expect(noticeAfter(running)?.textContent).toBe(en['reply.disclaimer'])
      // Refreshed in place: the same node, not a second one.
      expect(document.querySelectorAll(`[${REPLY_DISCLAIMER_MARKER}]`)).toHaveLength(1)
      dispose()
    } finally { uninstall() }
  })

  it('re-asks the resolver on a plain sweep, too', () => {
    // The subscription covers "nothing else mutates". A mutation must not leave
    // the old language behind either, because that is the far more common case.
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const running = anchor(document, 'data-chat-running', 'running')
      let text: string = zh['reply.disclaimer']
      installReplyDisclaimer(document, () => text)
      text = en['reply.disclaimer']
      StubMutationObserver.lastInstance?.notify([
        record({ type: 'childList', target: running as unknown as Node, addedNodes: [] }),
      ])
      expect(noticeAfter(running)?.textContent).toBe(en['reply.disclaimer'])
    } finally { uninstall() }
  })

  it('unsubscribes on dispose, and reports nothing when not given a source', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      anchor(document, 'data-chat-running', 'running')
      let subscribed = 0
      let unsubscribed = 0
      const dispose = installReplyDisclaimer(document, () => zh['reply.disclaimer'], {
        subscribe: (listener) => {
          subscribed += 1
          void listener
          return () => { unsubscribed += 1 }
        },
      })
      dispose()
      expect(subscribed).toBe(1)
      expect(unsubscribed).toBe(1)
      // Without a source, install still works and dispose still cleans up.
      const bare = installReplyDisclaimer(document, () => zh['reply.disclaimer'])
      expect(() => { bare() }).not.toThrow()
    } finally { uninstall() }
  })

  it('removes every notice it added, and nothing else', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const running = anchor(document, 'data-chat-running', 'running')
      const footer = anchor(document, 'data-turn-tail', 'footer')
      const dispose = installReplyDisclaimer(document, () => zh['reply.disclaimer'])

      dispose()
      expect(noticeAfter(running)).toBeNull()
      expect(noticeAfter(footer)).toBeNull()
      // The anchors and their own content survive: an unload restores the
      // transcript, it does not empty it.
      expect(running.children).toHaveLength(1)
      expect(footer.children).toHaveLength(1)
    } finally { uninstall() }
  })

  it('renders the dictionary text as text, never as markup', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const running = anchor(document, 'data-chat-running', 'running')
      // A translator's apostrophe, or a string carrying an angle bracket, must
      // not be able to open an element.
      const dispose = installReplyDisclaimer(document, () => '<b>not markup</b>')

      const found = noticeAfter(running)
      expect(found?.textContent).toBe('<b>not markup</b>')
      dispose()
    } finally { uninstall() }
  })

  it('is a no-op without a DOM surface or without text', () => {
    expect(() => { installReplyDisclaimer({} as Document, () => 'x')() }).not.toThrow()
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const running = anchor(document, 'data-chat-running', 'running')
      const dispose = installReplyDisclaimer(document, () => '')
      expect(noticeAfter(running)).toBeNull()
      dispose()
    } finally { uninstall() }
  })
})

describe('the notice copy', () => {
  it('says the answer is machine-generated and needs checking, in both languages', () => {
    expect(zh['reply.disclaimer']).toBe('内容由 AI 生成，仅供参考')
    expect(en['reply.disclaimer']).toBe('AI-generated content. Verify before relying on it.')
  })
})