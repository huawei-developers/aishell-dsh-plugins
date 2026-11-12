/**
 * A controllable stand-in for the browser's `EventSource`.
 *
 * The real one opens a socket and reconnects on its own, which a unit test
 * cannot drive. This records the URL it was asked to open, publishes frames on
 * command, and counts closes, so a test asserts what the plugin does with a
 * frame rather than how the browser delivered it.
 */

/** One live `EventSource`, as this stub models it. */
export class StubEventSource {
  static readonly instances: StubEventSource[] = []

  /** URL the plugin passed to the constructor. */
  readonly url: string
  /** Whether the plugin released this source. */
  closed = false

  /** Handlers registered through `addEventListener`, by event type. */
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    StubEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const existing = this.listeners.get(type)
    if (existing === undefined) this.listeners.set(type, new Set([listener]))
    else existing.add(listener)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  /** Publish one frame body, as the transport would. */
  emit(data: unknown): void {
    const event = { data } as MessageEvent<string>
    this.onmessage?.(event)
    for (const listener of this.listeners.get('message') ?? []) listener(event)
  }

  close(): void {
    this.closed = true
  }
}

/**
 * Install the stub as the global `EventSource`.
 *
 * @returns the previous global value to restore, and a reset of the record.
 */
export function installStubEventSource(): { uninstall: () => void, sources: () => StubEventSource[] } {
  const previous = (globalThis as { EventSource?: unknown }).EventSource
  ;(globalThis as { EventSource?: unknown }).EventSource = StubEventSource
  StubEventSource.instances.length = 0
  return {
    uninstall: (): void => {
      ;(globalThis as { EventSource?: unknown }).EventSource = previous
      StubEventSource.instances.length = 0
    },
    sources: (): StubEventSource[] => StubEventSource.instances,
  }
}