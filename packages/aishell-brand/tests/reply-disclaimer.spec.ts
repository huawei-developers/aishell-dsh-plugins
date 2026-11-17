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
  // A row the anchor already holds, so a notice's position among the anchor's
  // own children is observable.
  const own = document.createElement('div')
  own.className = 'own-content'
  element.appendChild(own)
  document.body.appendChild(element)
  return element as unknown as Element
}

/**
 * A Turn footer as the shell writes it: the Turn-tail slot anchor, then the
 * action row.
 */
function footer(document: Document, turn = 1): Element {
  const element = document.createElement('div')
  element.className = 'footer'
  element.setAttribute('data-turn-tail', String(turn))
  const slot = document.createElement('div')
  slot.setAttribute('data-slot', 'conversation.chat.turnTail')
  const actions = document.createElement('div')
  actions.setAttribute('data-clock', 'end')
  actions.className = 'actions'
  element.appendChild(slot)
  element.appendChild(actions)
  document.body.appendChild(element)
  return element as unknown as Element
}

/** The notices inside one subtree. */
function noticesIn(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll(`[${REPLY_DISCLAIMER_MARKER}]`)) as unknown as Element[]
}

/** The notice inside one anchor, if any. */
function noticeInside(anchorElement: Element): Element | null {
  return anchorElement.querySelector(`[${REPLY_DISCLAIMER_MARKER}]`) as unknown as Element | null
}

describe('installReplyDisclaimer', () => {
  it('puts the notice inside the running status', () => {
    // Inside, not beside: the anchor is the node React replaces as a Turn
    // streams, so a notice within it is replaced with it rather than orphaned.
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const running = anchor(document, 'data-chat-running', 'running')
      const dispose = installReplyDisclaimer(document, () => zh['reply.disclaimer'])

      const notice = noticeInside(running)
      expect(notice).not.toBeNull()
      expect(notice?.textContent).toBe(zh['reply.disclaimer'])
      dispose()
    } finally { uninstall() }
  })

  it('places the notice below the reply and above the action row', () => {
    // The footer's own content is the copy / like / dislike row, so appending
    // would put the notice under the controls. It belongs above them: the
    // reply's closing line, then the things a reader can do about it.
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const tail = footer(document)
      const dispose = installReplyDisclaimer(document, () => zh['reply.disclaimer'])

      const notice = noticeInside(tail)
      expect(notice).not.toBeNull()
      // Before the row, after the Turn-tail slot.
      const children = Array.from(tail.children) as unknown as Element[]
      const index = children.indexOf(notice as unknown as Element)
      const rowIndex = children.findIndex(child => child.hasAttribute('data-clock'))
      expect(index).toBeGreaterThan(0)
      expect(index).toBeLessThan(rowIndex)
      dispose()
    } finally { uninstall() }
  })

  it('adds a notice to an anchor that appears later', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const dispose = installReplyDisclaimer(document, () => en['reply.disclaimer'])
      const late = footer(document)
      StubMutationObserver.lastInstance?.notify([
        record({ type: 'childList', target: document.body as unknown as Node, addedNodes: [late as unknown as Node] }),
      ])

      expect(noticeInside(late)).not.toBeNull()
      dispose()
    } finally { uninstall() }
  })

  it('does not duplicate a notice when the same anchor is swept again', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const tail = footer(document)
      installReplyDisclaimer(document, () => zh['reply.disclaimer'])
      StubMutationObserver.lastInstance?.notify([
        record({ type: 'childList', target: tail as unknown as Node, addedNodes: [] }),
      ])

      expect(noticesIn(tail).length).toBe(1)
    } finally { uninstall() }
  })

  it('leaves one notice per Turn when React replaces the anchor', () => {
    // The failure this rules out, measured on a live page: React swaps the
    // anchor for a fresh element, and a notice placed BESIDE the old one is left
    // behind — still showing the language it was written in — while the next
    // sweep adds a second beside the new anchor. Inside the anchor there is
    // nothing to leave behind.
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const row = document.createElement('div')
      row.className = 'flowItem'
      document.body.appendChild(row)

      const first = document.createElement('div')
      first.setAttribute('data-turn-tail', '1')
      row.appendChild(first)
      const dispose = installReplyDisclaimer(document, () => zh['reply.disclaimer'])
      expect(noticesIn(document).length).toBe(1)

      first.remove()
      const replacement = document.createElement('div')
      replacement.setAttribute('data-turn-tail', '1')
      const actions = document.createElement('div')
      actions.setAttribute('data-clock', 'end')
      replacement.appendChild(actions)
      row.appendChild(replacement)
      StubMutationObserver.lastInstance?.notify([
        record({ type: 'childList', target: row as unknown as Node, addedNodes: [replacement as unknown as Node] }),
      ])

      expect(noticesIn(document).length).toBe(1)
      expect(noticeInside(replacement)).not.toBeNull()
      dispose()
    } finally { uninstall() }
  })

  it('takes the anchor\'s own spacing rather than a margin of its own', () => {
    // Both anchors are columns that already space their children. A margin here
    // would add to that rhythm rather than follow it.
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const tail = footer(document)
      installReplyDisclaimer(document, () => zh['reply.disclaimer'])
      const style = noticeInside(tail)?.getAttribute('style') ?? ''
      expect(style).toContain('margin: 0')
    } finally { uninstall() }
  })

  it('follows a language switch on a Turn already on screen', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const tail = footer(document)
      let language: 'zh' | 'en' = 'zh'
      const listeners = new Set<() => void>()
      const dispose = installReplyDisclaimer(
        document,
        () => (language === 'zh' ? zh : en)['reply.disclaimer'],
        { subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
      )
      expect(noticeInside(tail)?.textContent).toBe(zh['reply.disclaimer'])

      language = 'en'
      for (const listener of listeners) listener()
      expect(noticeInside(tail)?.textContent).toBe(en['reply.disclaimer'])
      expect(noticesIn(tail).length).toBe(1)
      dispose()
    } finally { uninstall() }
  })

  it('keeps the glyph when the text changes', () => {
    // A language switch rewrites the label. Assigning `textContent` would
    // replace every child of the notice, leaving a bare line where the glyph
    // was — so the label is its own text node, and only that node is written.
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const tail = footer(document)
      let text: string = zh['reply.disclaimer']
      installReplyDisclaimer(document, () => text)

      const notice = noticeInside(tail) as unknown as { innerHTML: string, childNodes: unknown[] } | null
      expect(notice?.innerHTML).toContain('<svg')

      text = en['reply.disclaimer']
      StubMutationObserver.lastInstance?.notify([
        record({ type: 'childList', target: tail as unknown as Node, addedNodes: [] }),
      ])

      const after = noticeInside(tail) as unknown as { innerHTML: string, textContent: string } | null
      expect(after?.textContent).toBe(en['reply.disclaimer'])
      // Still one glyph, not zero and not two.
      expect(after?.innerHTML?.match(/<svg/g)?.length).toBe(1)
    } finally { uninstall() }
  })

  it('re-asks the resolver on a plain sweep, too', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const tail = footer(document)
      let text: string = zh['reply.disclaimer']
      installReplyDisclaimer(document, () => text)
      text = en['reply.disclaimer']
      StubMutationObserver.lastInstance?.notify([
        record({ type: 'childList', target: tail as unknown as Node, addedNodes: [] }),
      ])
      expect(noticeInside(tail)?.textContent).toBe(en['reply.disclaimer'])
    } finally { uninstall() }
  })

  it('unsubscribes on dispose, and reports nothing when not given a source', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      footer(document)
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
      const bare = installReplyDisclaimer(document, () => zh['reply.disclaimer'])
      expect(() => { bare() }).not.toThrow()
    } finally { uninstall() }
  })

  it('removes every notice it added, and nothing else', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const running = anchor(document, 'data-chat-running', 'running')
      const tail = footer(document, 2)
      const dispose = installReplyDisclaimer(document, () => zh['reply.disclaimer'])

      dispose()
      expect(noticeInside(running)).toBeNull()
      expect(noticeInside(tail)).toBeNull()
      // The anchors and their own content survive: an unload restores the
      // transcript, it does not empty it.
      expect(noticesIn(document).length).toBe(0)
      expect(tail.hasAttribute('data-turn-tail')).toBe(true)
    } finally { uninstall() }
  })

  it('leads the notice with a decorative sparkle', () => {
    // Decorative: the text is the statement, so the glyph is hidden from the
    // accessibility tree rather than being announced as an unnamed icon.
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const running = anchor(document, 'data-chat-running', 'running')
      const dispose = installReplyDisclaimer(document, () => zh['reply.disclaimer'])

      const notice = noticeInside(running) as unknown as { innerHTML: string, textContent: string } | null
      expect(notice?.innerHTML).toContain('<svg')
      expect(notice?.innerHTML).toContain('aria-hidden="true"')
      // The glyph is a sibling of the text, not part of it.
      expect(notice?.textContent).toBe(zh['reply.disclaimer'])
      dispose()
    } finally { uninstall() }
  })

  it('renders the dictionary text as text, never as markup', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const running = anchor(document, 'data-chat-running', 'running')
      const dispose = installReplyDisclaimer(document, () => '<b>not markup</b>')

      expect(noticeInside(running)?.textContent).toBe('<b>not markup</b>')
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
      expect(noticeInside(running)).toBeNull()
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