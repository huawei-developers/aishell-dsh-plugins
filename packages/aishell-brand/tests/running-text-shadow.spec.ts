/**
 * Running-text shadow behavior.
 *
 * ui-chat's `chat` dictionary names the live running line after DeepSeek's
 * product language — zh "深度求索中" / "深度求索中，用时 {duration} ···",
 * en "Deep diving" / "Deep diving for {duration} ···" — and locale.register
 * throws on the claimed namespace, so the copy cannot be re-registered.
 * What this file pins is the DOM shadow that stands in for it:
 *
 *   1. one substring replacement covers both keys per language: the
 *      duration form begins with the bare form's prefix, so "深度求索中" →
 *      "思考中" and "Deep diving" → "Thinking" rewrite the long sentences
 *      too, while duration units and the "···" tail pass through;
 *   2. the TextShimmer highlight layer reads
 *      `content: attr(data-shimmer-text)`, so the attribute is rewritten
 *      alongside the text node — a stale attribute would flash the
 *      official copy every time the highlight sweeps;
 *   3. the per-second re-render (characterData mutations on the ticking
 *      clock) stays covered for as long as the row exists, and a row
 *      mounted later is swept on arrival;
 *   4. the row's aria status span carries the same text inside the same
 *      subtree, so it is rewritten by the same sweep;
 *   5. dispose restores the official copy on every live row.
 */

import { describe, it, expect } from 'vitest'
import { installRunningTextShadow, rebrandRunningText } from '../src/client/running-text-shadow.ts'
import { makeStubDocument, installStubGlobals, record, StubMutationObserver } from './stub-dom.ts'

/** Build one [data-chat-running] row shaped like RunningStatus renders it. */
function makeRunningRow(document: Document): {
  row: HTMLDivElement
  status: HTMLSpanElement
  shimmerText: HTMLSpanElement
  textNode: Text
} {
  const row = document.createElement('div') as unknown as HTMLDivElement
  row.setAttribute('data-chat-running', '')
  const status = document.createElement('span') as unknown as HTMLSpanElement
  status.setAttribute('role', 'status')
  row.appendChild(status)
  const content = document.createElement('span') as unknown as HTMLSpanElement
  const icon = document.createElement('span') as unknown as HTMLSpanElement
  icon.className = 'H1x2_runningIcon'
  content.appendChild(icon)
  const shimmerText = document.createElement('span') as unknown as HTMLSpanElement
  shimmerText.setAttribute('data-shimmer-text', '')
  const textNode = document.createTextNode('') as unknown as Text
  shimmerText.appendChild(textNode)
  content.appendChild(shimmerText)
  row.appendChild(content)
  document.body.appendChild(row)
  return { row, status, shimmerText, textNode }
}

describe('rebrandRunningText', () => {
  it('rewrites both zh forms through the shared prefix', () => {
    expect(rebrandRunningText('深度求索中')).toBe('思考中')
    expect(rebrandRunningText('深度求索中，用时 12秒 ···')).toBe('思考中，用时 12秒 ···')
    expect(rebrandRunningText('深度求索中，用时 3分4秒 ···')).toBe('思考中，用时 3分4秒 ···')
  })

  it('rewrites both en forms through the shared prefix', () => {
    expect(rebrandRunningText('Deep diving')).toBe('Thinking')
    expect(rebrandRunningText('Deep diving for 12s ···')).toBe('Thinking for 12s ···')
    expect(rebrandRunningText('Deep diving for 1m 4s ···')).toBe('Thinking for 1m 4s ···')
  })

  it('returns values without the official copy verbatim', () => {
    expect(rebrandRunningText('已完成')).toBe('已完成')
    expect(rebrandRunningText('Done for 12s ···')).toBe('Done for 12s ···')
    expect(rebrandRunningText('')).toBe('')
  })
})

describe('installRunningTextShadow', () => {
  it('sweeps a mounted row on install, text and shimmer attribute together', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const { shimmerText, textNode, status } = makeRunningRow(document)
      textNode.data = '深度求索中，用时 12秒 ···'
      shimmerText.setAttribute('data-shimmer-text', '深度求索中，用时 12秒 ···')
      status.textContent = '深度求索中'
      installRunningTextShadow(document)
      expect(textNode.data).toBe('思考中，用时 12秒 ···')
      expect(shimmerText.getAttribute('data-shimmer-text')).toBe('思考中，用时 12秒 ···')
      expect(status.textContent).toBe('思考中')
    } finally { uninstall() }
  })

  it('covers the per-second tick: a characterData rewrite is re-branded', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const { shimmerText, textNode } = makeRunningRow(document)
      textNode.data = '深度求索中，用时 12秒 ···'
      shimmerText.setAttribute('data-shimmer-text', '深度求索中，用时 12秒 ···')
      installRunningTextShadow(document)
      // The next second's tick re-renders the official copy; the DOM
      // delivers it as a characterData mutation on the same text node.
      textNode.data = '深度求索中，用时 13秒 ···'
      shimmerText.setAttribute('data-shimmer-text', '深度求索中，用时 13秒 ···')
      StubMutationObserver.lastInstance?.notify([
        record({ type: 'characterData', target: textNode as unknown as Node }),
      ])
      expect(textNode.data).toBe('思考中，用时 13秒 ···')
    } finally { uninstall() }
  })

  it('covers an attribute-only re-render of the shimmer copy', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const { shimmerText } = makeRunningRow(document)
      shimmerText.setAttribute('data-shimmer-text', '思考中，用时 12秒 ···')
      installRunningTextShadow(document)
      // TextShimmer's decorative layer re-renders by writing only the
      // attribute while the text node itself stays empty.
      shimmerText.setAttribute('data-shimmer-text', '深度求索中，用时 13秒 ···')
      StubMutationObserver.lastInstance?.notify([
        record({ type: 'attributes', target: shimmerText as unknown as Node }),
      ])
      expect(shimmerText.getAttribute('data-shimmer-text')).toBe('思考中，用时 13秒 ···')
    } finally { uninstall() }
  })

  it('sweeps a row that mounts after install', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      installRunningTextShadow(document)
      const { textNode } = makeRunningRow(document)
      textNode.data = '深度求索中'
      StubMutationObserver.lastInstance?.notify([
        record({ type: 'childList', target: document.body, addedNodes: [textNode.parentElement as unknown as Node] }),
      ])
      expect(textNode.data).toBe('思考中')
    } finally { uninstall() }
  })

  it('ignores official copy outside a running row', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const outside = document.createElement('span') as unknown as HTMLSpanElement
      const textNode = document.createTextNode('深度求索中') as unknown as Text
      outside.appendChild(textNode)
      document.body.appendChild(outside)
      installRunningTextShadow(document)
      expect(textNode.data).toBe('深度求索中')
    } finally { uninstall() }
  })

  it('dispose restores the official copy on every live row', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const { shimmerText, textNode, status } = makeRunningRow(document)
      textNode.data = '深度求索中，用时 12秒 ···'
      shimmerText.setAttribute('data-shimmer-text', '思考中，用时 12秒 ···')
      status.textContent = '思考中'
      const dispose = installRunningTextShadow(document)
      expect(textNode.data).toBe('思考中，用时 12秒 ···')
      dispose()
      expect(textNode.data).toBe('深度求索中，用时 12秒 ···')
      expect(shimmerText.getAttribute('data-shimmer-text')).toBe('深度求索中，用时 12秒 ···')
      expect(status.textContent).toBe('深度求索中')
    } finally { uninstall() }
  })

  it('returns a no-op disposer when the target has no DOM surface', () => {
    const dispose = installRunningTextShadow({} as Document)
    expect(() => { dispose() }).not.toThrow()
  })
})
