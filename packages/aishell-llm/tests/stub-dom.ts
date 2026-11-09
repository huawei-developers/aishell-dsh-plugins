/**
 * A minimal DOM stub for the provider-row shadow spec.
 *
 * The repo's vitest runs in the Node environment (no jsdom — deliberate,
 * see vitest.config.ts), and the shadow module under test is a thin
 * wrapper over a handful of DOM APIs. Rather than pulling a DOM
 * implementation into devDependencies for one spec, this file builds
 * just the surface it touches: Element with attribute storage and
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
  constructor(tagName: string)
  get children(): ElementStub[]
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  hasAttribute(name: string): boolean
  get rel(): string
  appendChild<T extends Node>(child: T): T
  remove(): void
  classIncludes(fragment: string): boolean
  get textContent(): string
  set textContent(value: string)
  closest(selector: string): ElementStub | null
  querySelectorAll(selector: string): ElementStub[]
  querySelector(selector: string): ElementStub | null
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
  constructor(tagName: string) { this.tagName = tagName.toUpperCase() }

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
    // A comma list matches the first ancestor ANY part matches, as in the
    // DOM (the shadow's row-sweep spelling is `[a], [b]`).
    const selectors = selector.split(',').map(part => part.trim()).filter(part => part !== '')
    let node: ElementStub | null = this as unknown as ElementStub
    while (node !== null) {
      if (selectors.some(part => matches(node as ElementStub, part))) return node
      node = (node as unknown as { parentElement: ElementStub | null }).parentElement
    }
    return null
  }

  querySelectorAll(selector: string): ElementStub[] {
    // A comma list means union-of-matches, as in the DOM. The stub's own
    // walk below re-splits on commas, so `[a], [b]` (the shadows' spelling)
    // sweeps both selectors without ordering guarantees — fine for the
    // attribute/class-fragment forms used here.
    const selectors = selector.split(',').map(part => part.trim()).filter(part => part !== '')
    const found: ElementStub[] = []
    const walk = (element: ElementStub): void => {
      for (const child of (element as unknown as { children: ElementStub[] }).children) {
        if (selectors.some(part => matches(child, part))) found.push(child)
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

/** One selector the stub understands: 'tag', '[attr]', '[attr="value"]',
 * '[class*="fragment"]', or 'tag[attr]' / 'tag[attr="value"]' combinations.
 * The `[class*=]` form matches the DOM's class-fragment semantics against
 * the full className string (the specs' rows carry CSS-module hashes, which
 * the shadows under test locate by `[class*="…"]` substring). */
function matches(element: ElementStub, selector: string): boolean {
  const combined = selector.match(/^([a-zA-Z][a-zA-Z0-9-]*)\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/)
  if (combined !== null) {
    const tag = combined[1] as string
    const name = combined[2] as string
    const value = combined[3]
    const stored = (element as unknown as { attributes: Map<string, string> }).attributes.get(name)
    if ((element as unknown as { tagName: string }).tagName !== tag.toUpperCase()) return false
    if (value === undefined) return stored !== undefined
    return stored === value
  }
  const classFragment = selector.match(/^\[class\*="([^"]*)"\]$/)
  if (classFragment !== null) {
    return (element as unknown as { className: string }).className.includes(classFragment[1] as string)
  }
  const attribute = selector.match(/^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/)
  if (attribute !== null) {
    const name = attribute[1] as string
    const value = attribute[2]
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
  }
  createElement(tagName: string): ElementStub { return new ElementClass(tagName) as unknown as ElementStub }
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
