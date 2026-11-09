/**
 * A minimal DOM stub for the brand shadow specs.
 *
 * The repo's vitest runs in the Node environment (no jsdom — deliberate,
 * see vitest.config.ts), and the shadow modules under test are thin
 * wrappers over a handful of DOM APIs. Rather than pulling a DOM
 * implementation into devDependencies for three specs, this file builds
 * just the surface they touch: Element with attribute storage and
 * querySelector over a hand-rolled child list, Text nodes, a Document
 * with head/body, plus the constructor globals (MutationObserver,
 * NodeFilter, Node) the modules read.
 *
 * The behavior under test (attribute get/set, subtree sweeps, observer
 * callbacks driven synchronously by the spec) is identical on the stub,
 * which is why the modules accept the Document as a parameter and why the
 * stub deliberately does not subclass the lib.dom types — it only needs
 * to be shape-compatible where the modules touch it, and every such site
 * is cast at the boundary below.
 *
 * @module tests/stub-dom
 */

/** Node type constants, mirroring the DOM's. */
export const NODE_ELEMENT = 1
export const NODE_TEXT = 3

/** The `Node` global the shadow modules read (instanceof checks). */
export const StubNode = class {
  static readonly ELEMENT_NODE = NODE_ELEMENT
  static readonly TEXT_NODE = NODE_TEXT
  nodeType: number
  parentElement: InstanceType<typeof StubElement> | null = null
  constructor(nodeType: number) { this.nodeType = nodeType }
}

/** The `NodeFilter` global the text shadow's TreeWalker reads. */
export const StubNodeFilter = { SHOW_TEXT: 4 } as const

/**
 * A Text node: `data` is the live string the shadows rewrite and the
 * specs assert against.
 */
export const StubText = class {
  nodeType = NODE_TEXT
  parentElement: InstanceType<typeof StubElement> | null = null
  data: string
  constructor(data: string) { this.data = data }
}

/** Internal shape shared by element children. */
type AnyNode = { nodeType: number, parentElement: ElementStub | null }

/** The element stub's own type, before the Document cast. */
declare class ElementStub {
  readonly tagName: string
  readonly attributes: Map<string, string>
  readonly childNodes: Node[]
  className: string
  nodeType: number
  parentElement: ElementStub | null
  ownerDocument: Document | null
  readonly dataset: Record<string, string>
  readonly classList: {
    add: (name: string) => void
    remove: (name: string) => void
    contains: (name: string) => boolean
  }
  readonly listeners: Map<string, Array<() => void>>
  constructor(tagName: string)
  get children(): ElementStub[]
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  hasAttribute(name: string): boolean
  get rel(): string
  appendChild<T extends Node>(child: T): T
  insertBefore<T extends Node>(child: T, before: Node | null): T
  remove(): void
  classIncludes(fragment: string): boolean
  /** Inline style; only `cssText` is read or written by the modules here. */
  readonly style: { cssText: string }
  get textContent(): string
  set textContent(value: string)
  closest(selector: string): ElementStub | null
  querySelectorAll(selector: string): ElementStub[]
  querySelector(selector: string): ElementStub | null
  addEventListener(type: string, handler: () => void): void
  removeEventListener(type: string, handler: () => void): void
  /** Dispatch one event, as the browser would (the spec drives it). */
  dispatch(type: string): void
}

// The element stub itself. Declared through a class expression so the
// self-referential parentElement type above can name it.
const ElementClass = class {
  readonly tagName: string
  readonly attributes = new Map<string, string>()
  readonly childNodes: Node[] = []
  className = ''
  readonly nodeType = NODE_ELEMENT
  parentElement: ElementStub | null = null
  /**
   * The document this element belongs to, as the DOM provides.
   *
   * Set by `DocumentClass.createElement`/`appendChild` (see `adopt`), or by a
   * spec constructing a subtree directly. Without it a module that creates a
   * child element — `content.ownerDocument.createElement(...)`, which is how
   * a detached-safe module must do it — cannot run against this stub at all.
   */
  ownerDocument: Document | null = null
  /** Event type → handlers, so `removeEventListener` can actually remove. */
  readonly listeners = new Map<string, Array<() => void>>()
  /** Inline style; `cssText` is the only member the modules here touch. */
  readonly style = { cssText: '' }
  constructor(tagName: string) { this.tagName = tagName.toUpperCase() }

  /**
   * `dataset`, backed by `attributes` the way the DOM backs it: `dataset.foo`
   * is the `data-foo` attribute, camelCase mapped to kebab-case. Backed rather
   * than parallel so `querySelector('[data-x]')` sees what `dataset.x = ''`
   * wrote — the modules under test rely on exactly that round trip.
   */
  get dataset(): Record<string, string> {
    const attributes = this.attributes
    return new Proxy({} as Record<string, string>, {
      get: (_target, key: string) => attributes.get(camelToData(key)) ?? undefined,
      set: (_target, key: string, value: string) => {
        if (value === undefined || value === null) attributes.delete(camelToData(key))
        else attributes.set(camelToData(key), value)
        return true
      },
      deleteProperty: (_target, key: string) => {
        attributes.delete(camelToData(key))
        return true
      },
      has: (_target, key: string) => attributes.has(camelToData(key)),
      ownKeys: () => [...attributes.keys()].filter(name => name.startsWith('data-')),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    })
  }

  /** `classList`, backed by `className` so `[class*="…"]` sees the changes. */
  get classList(): { add: (n: string) => void, remove: (n: string) => void, contains: (n: string) => boolean } {
    const read = (): string[] => this.className.split(/\s+/).filter(part => part !== '')
    const write = (names: string[]): void => { this.className = names.join(' ') }
    return {
      add: (name: string) => { const names = read(); if (!names.includes(name)) write([...names, name]) },
      remove: (name: string) => { write(read().filter(part => part !== name)) },
      contains: (name: string) => read().includes(name),
    }
  }

  addEventListener(type: string, handler: () => void): void {
    const handlers = this.listeners.get(type) ?? []
    handlers.push(handler)
    this.listeners.set(type, handlers)
  }

  removeEventListener(type: string, handler: () => void): void {
    const handlers = this.listeners.get(type)
    if (handlers === undefined) return
    const index = handlers.indexOf(handler)
    if (index !== -1) handlers.splice(index, 1)
  }

  /** Dispatch one event, as the browser would; the spec drives it. */
  dispatch(type: string): void {
    // Snapshot before iterating: a handler may remove itself (the shadows'
    // disposers do), and mutating the array mid-loop would skip the next one.
    const handlers = this.listeners.get(type)
    if (handlers === undefined) return
    for (const handler of Array.from(handlers)) handler()
  }

  insertBefore<T extends Node>(child: T, before: Node | null): T {
    const index = before === null ? -1 : this.childNodes.indexOf(before)
    if (index === -1) return this.appendChild(child)
    this.childNodes.splice(index, 0, child)
    if (child instanceof ElementClass || child instanceof TextClass) {
      ;(child as unknown as AnyNode).parentElement = this as unknown as ElementStub
    }
    return child
  }

  get children(): ElementStub[] {
    return this.childNodes.filter(node => node instanceof ElementClass) as unknown as ElementStub[]
  }

  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  removeAttribute(name: string): void { this.attributes.delete(name) }
  hasAttribute(name: string): boolean { return this.attributes.has(name) }
  get rel(): string { return this.attributes.get('rel') ?? '' }

  appendChild<T extends Node>(child: T): T {
    this.childNodes.push(child)
    if (child instanceof ElementClass || child instanceof TextClass) {
      ;(child as unknown as AnyNode).parentElement = this as unknown as ElementStub
    }
    adopt(child, this.ownerDocument)
    return child
  }

  remove(): void {
    const parent = this.parentElement
    if (parent === null) return
    const siblings = (parent as unknown as { childNodes: Node[] }).childNodes
    const index = siblings.indexOf(this as unknown as Node)
    if (index !== -1) siblings.splice(index, 1)
    this.parentElement = null
  }

  classIncludes(fragment: string): boolean { return this.className.includes(fragment) }

  /** Concatenated Text children, as the DOM's textContent reads; setting
   * replaces them with one Text node, as the DOM's write does. */
  get textContent(): string {
    return this.childNodes
      .filter(node => node instanceof TextClass)
      .map(node => (node as unknown as { data: string }).data)
      .join('')
  }
  set textContent(value: string) {
    const texts = this.childNodes.filter(node => node instanceof TextClass)
    for (const text of texts) {
      const index = this.childNodes.indexOf(text)
      if (index !== -1) this.childNodes.splice(index, 1)
    }
    const replacement = new TextClass(value)
    this.appendChild(replacement as unknown as Node)
  }

  /** Whether `selector` names an attribute this element carries. Only the
   * attribute forms the shadows use ('[attr]', '[attr="value"]') are
   * understood — the DOM's closest() is a selector engine, this is the
   * slice the shadows actually query with. */
  closest(selector: string): ElementStub | null {
    let node: ElementStub | null = this as unknown as ElementStub
    while (node !== null) {
      if (matches(node, selector)) return node
      node = (node as unknown as { parentElement: ElementStub | null }).parentElement
    }
    return null
  }

  querySelectorAll(selector: string): ElementStub[] {
    const found: ElementStub[] = []
    const walk = (element: ElementStub): void => {
      for (const child of (element as unknown as { children: ElementStub[] }).children) {
        if (matches(child, selector)) found.push(child)
        walk(child)
      }
    }
    walk(this as unknown as ElementStub)
    return found
  }

  querySelector(selector: string): ElementStub | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
}

/** `data-foo-bar` for a `dataset.fooBar` key, as the DOM maps it. */
function camelToData(key: string): string {
  return `data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`
}

/**
 * Give a subtree its document, as the DOM does on insertion.
 *
 * Recursive because a module may create a wrapper and fill it before
 * appending: by the time the append happens the children exist and must
 * inherit the same document, or a later `ownerDocument.createElement` inside
 * them would find nothing.
 */
function adopt(node: Node, doc: Document | null): void {
  if (doc === null) return
  if (node instanceof ElementClass || node instanceof TextClass) {
    ;(node as unknown as { ownerDocument: Document | null }).ownerDocument = doc
  }
  const children = (node as unknown as { childNodes?: Node[] }).childNodes
  if (children !== undefined) for (const child of children) adopt(child, doc)
}

/**
 * One selector the stub understands: 'tag', '[attr]', '[attr="value"]',
 * '[class*="value"]', or 'tag[attr]' / 'tag[attr="value"]' / 'tag[class*="v"]'
 * combinations.
 *
 * `[class*="…"]` is not a nicety: the host's class names are CSS-module
 * hashes, so every shadow in this package matches them by substring. A stub
 * that could not answer that selector would make those modules untestable.
 */
function matches(element: ElementStub, selector: string): boolean {
  const combined = selector.match(/^([a-zA-Z][a-zA-Z0-9-]*)\[([a-zA-Z-]+)(\*)?(?:="([^"]*)")?\]$/)
  if (combined !== null) {
    const tag = combined[1] as string
    const name = combined[2] as string
    const substring = combined[3] === '*'
    const value = combined[4]
    if ((element as unknown as { tagName: string }).tagName !== tag.toUpperCase()) return false
    if (name === 'class' && substring) {
      return value !== undefined && (element as unknown as { className: string }).className.includes(value)
    }
    const stored = (element as unknown as { attributes: Map<string, string> }).attributes.get(name)
    if (value === undefined) return stored !== undefined
    return stored === value
  }
  const attribute = selector.match(/^\[([a-zA-Z-]+)(\*)?(?:="([^"]*)")?\]$/)
  if (attribute !== null) {
    const name = attribute[1] as string
    const substring = attribute[2] === '*'
    const value = attribute[3]
    if (name === 'class' && substring) {
      return value !== undefined && (element as unknown as { className: string }).className.includes(value)
    }
    const stored = (element as unknown as { attributes: Map<string, string> }).attributes.get(name)
    if (value === undefined) return stored !== undefined
    return stored === value
  }
  return (element as unknown as { tagName: string }).tagName === selector.toUpperCase()
}

/** The text node stub (paired with ElementClass above). */
const TextClass = class {
  readonly nodeType = NODE_TEXT
  parentElement: ElementStub | null = null
  data: string
  constructor(data: string) { this.data = data }
}

/** The document stub's own type, before the Document cast. */
declare class DocumentStub {
  readonly head: ElementStub
  readonly body: ElementStub
  readonly baseURI: string
  constructor()
  createElement(tagName: string): ElementStub
  createTextNode(data: string): Text
  createTreeWalker(root: Node, whatToShow: number): { nextNode(): Node | null }
  querySelectorAll(selector: string): ElementStub[]
  querySelector(selector: string): ElementStub | null
}

const DocumentClass = class {
  readonly head: ElementStub
  readonly body: ElementStub
  readonly baseURI = 'https://shell.local/'
  constructor() {
    this.head = new ElementClass('head') as unknown as ElementStub
    this.body = new ElementClass('body') as unknown as ElementStub
    // The document owns its own head/body; children appended below inherit
    // this through adopt().
    ;(this.head as unknown as { ownerDocument: Document | null }).ownerDocument = this as unknown as Document
    ;(this.body as unknown as { ownerDocument: Document | null }).ownerDocument = this as unknown as Document
  }
  createElement(tagName: string): ElementStub {
    const element = new ElementClass(tagName) as unknown as ElementStub
    ;(element as unknown as { ownerDocument: Document | null }).ownerDocument = this as unknown as Document
    return element
  }
  createTextNode(data: string): Text { return new TextClass(data) as unknown as Text }
  createTreeWalker(root: Node, whatToShow: number): { nextNode(): Node | null } {
    const texts: Node[] = []
    const collect = (node: Node): void => {
      if (node instanceof TextClass && (whatToShow & 4) !== 0) texts.push(node)
      const children = (node as unknown as { childNodes?: Node[] }).childNodes
      if (children !== undefined) for (const child of children) collect(child)
    }
    collect(root)
    let index = 0
    return { nextNode: () => texts[index++] ?? null }
  }
  querySelectorAll(selector: string): ElementStub[] {
    const head = this.head as unknown as { querySelectorAll(selector: string): ElementStub[] }
    const body = this.body as unknown as { querySelectorAll(selector: string): ElementStub[] }
    return [...head.querySelectorAll(selector), ...body.querySelectorAll(selector)]
  }
  querySelector(selector: string): ElementStub | null {
    const head = this.head as unknown as { querySelector(selector: string): ElementStub | null }
    const body = this.body as unknown as { querySelector(selector: string): ElementStub | null }
    return head.querySelector(selector) ?? body.querySelector(selector) ?? null
  }
}

/** Element stub constructor, for specs that build nodes directly. */
export const StubElement = ElementClass as unknown as new (tagName: string) => ElementStub

/** Document stub constructor; the cast is the boundary the modules see. */
export const makeStubDocument = (): Document => new DocumentClass() as unknown as Document

/**
 * A MutationObserver stand-in: records nothing, but hands the spec the
 * dispatch hook the real DOM would provide. The shadows' observer bodies
 * run verbatim through `notify`.
 *
 * Every construction is remembered on `lastInstance`, so a spec can drive
 * the observer the module under test just created.
 */
export class StubMutationObserver {
  /** The most recently constructed instance (reset by installStubGlobals). */
  static lastInstance: StubMutationObserver | undefined
  private callback: MutationCallback
  constructor(callback: MutationCallback) {
    this.callback = callback
    StubMutationObserver.lastInstance = this
  }
  observe(): void { /* the spec drives delivery; nothing to watch */ }
  disconnect(): void { /* no background delivery to stop */ }
  /** Deliver one mutation batch, as the DOM would. */
  notify(mutations: MutationRecord[]): void {
    this.callback(mutations, this as unknown as MutationObserver)
  }
}

/** Build one MutationRecord-shaped object for StubMutationObserver.notify. */
export function record(init: {
  type: 'characterData' | 'attributes' | 'childList'
  target: Node
  addedNodes?: Node[]
}): MutationRecord {
  return {
    type: init.type,
    target: init.target,
    addedNodes: (init.addedNodes ?? []) as unknown as NodeList,
    removedNodes: [] as unknown as NodeList,
    previousValue: null,
    attributeName: null,
    attributeNamespace: null,
    oldValue: null,
  } as unknown as MutationRecord
}

/**
 * Install the stub globals one document implies, returning the uninstall.
 *
 * The modules read `MutationObserver`, `NodeFilter`, and `Node` off the
 * global scope — the same names a browser provides. `fetch` is optional
 * (the favicon shadow's manifest path needs it); installing it lets a
 * spec script the manifest response.
 */
export function installStubGlobals(fetchImpl?: typeof fetch): () => void {
  const prior = {
    MutationObserver: globalThis.MutationObserver,
    NodeFilter: (globalThis as { NodeFilter?: unknown }).NodeFilter,
    Node: (globalThis as { Node?: unknown }).Node,
    fetch: globalThis.fetch,
  }
  StubMutationObserver.lastInstance = undefined
  globalThis.MutationObserver = StubMutationObserver as unknown as typeof MutationObserver
  ;(globalThis as { NodeFilter?: unknown }).NodeFilter = StubNodeFilter
  ;(globalThis as { Node?: unknown }).Node = StubNode
  if (fetchImpl !== undefined) globalThis.fetch = fetchImpl
  return () => {
    globalThis.MutationObserver = prior.MutationObserver as typeof MutationObserver
    ;(globalThis as { NodeFilter?: unknown }).NodeFilter = prior.NodeFilter
    ;(globalThis as { Node?: unknown }).Node = prior.Node
    globalThis.fetch = prior.fetch
  }
}
