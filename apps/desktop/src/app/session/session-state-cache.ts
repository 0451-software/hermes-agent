import type { ClientSessionState } from '../types'

export const DEFAULT_WARM_SESSION_TRANSCRIPT_COUNT = 24
export const DEFAULT_WARM_SESSION_TRANSCRIPT_BYTES = 32 * 1024 * 1024

interface SessionStateCacheLimits {
  maxBytes?: number
  maxCount?: number
}

interface SessionStateCacheCallbacks {
  isReferenced: (runtimeId: string, state: ClientSessionState) => boolean
  onEvict: (runtimeId: string, state: ClientSessionState) => void
  /** Optional liveness check for a cached snapshot's in-flight claims. A
   *  connection death mid-turn orphans snapshots: the respawned backend
   *  re-mints runtime ids, so their frozen busy/awaitingResponse flags never
   *  receive a settling publish (#95189) and would pin megabytes of warm
   *  transcript per reconnect cycle until restart. When wired, those flags
   *  only block eviction while the authoritative store still claims work for
   *  the same runtime id; without the probe they always block. */
  isAuthoritativelyActive?: (runtimeId: string, state: ClientSessionState) => boolean
}

function transcriptBytes(state: ClientSessionState): number {
  if (state.messages.length === 0) {
    return 0
  }

  // JS strings occupy two bytes per UTF-16 code unit. JSON also accounts for
  // ids, part tags, tool payloads, attachment metadata, and error text without
  // retaining a second serialized copy in the cache.
  return JSON.stringify(state.messages).length * 2
}

function countPendingMessages(state: ClientSessionState): number {
  let count = 0

  for (const message of state.messages) {
    if (message.pending === true) {
      count += 1
    }
  }

  return count
}

/**
 * Runtime state map whose settled, unreferenced transcripts form a weighted
 * LRU. Live/visible states and unsaved drafts are outside both limits.
 */
export class SessionStateCache extends Map<string, ClientSessionState> {
  readonly #callbacks: SessionStateCacheCallbacks
  readonly #maxBytes: number
  readonly #maxCount: number
  readonly #recency = new Map<string, number>()
  readonly #transcriptWeights = new WeakMap<ClientSessionState['messages'], number>()
  // Per-state pending message count, keyed by the state object. `set()` walks
  // `state.messages` exactly once (when a state is first installed or replaced)
  // so #isWarmSettled and prune() can decide in O(1) whether a transcript has
  // any draft or in-flight row. WeakMap so the count dies with the state
  // object the moment it is replaced or evicted — no manual cleanup, no leak
  // for state objects that never make it into the cache.
  readonly #pendingMessageCounts = new WeakMap<ClientSessionState, number>()
  #clock = 0

  constructor(callbacks: SessionStateCacheCallbacks, limits: SessionStateCacheLimits = {}) {
    super()
    this.#callbacks = callbacks
    this.#maxBytes = limits.maxBytes ?? DEFAULT_WARM_SESSION_TRANSCRIPT_BYTES
    this.#maxCount = limits.maxCount ?? DEFAULT_WARM_SESSION_TRANSCRIPT_COUNT
  }

  override get(runtimeId: string): ClientSessionState | undefined {
    const state = super.get(runtimeId)

    if (state) {
      this.#touch(runtimeId)
    }

    return state
  }

  override set(runtimeId: string, state: ClientSessionState): this {
    super.set(runtimeId, state)
    // Snapshot the pending-message count once per state install. updateSessionState
    // always calls `cache.set()` before `cache.prune()`, so prune always sees the
    // current count without walking messages again. The WeakMap entry rides with
    // this state object — when the entry is replaced or evicted, the count dies
    // with it.
    this.#pendingMessageCounts.set(state, countPendingMessages(state))
    this.#touch(runtimeId)

    return this
  }

  override delete(runtimeId: string): boolean {
    this.#recency.delete(runtimeId)

    return super.delete(runtimeId)
  }

  override clear(): void {
    this.#recency.clear()
    super.clear()
  }

  prune(): void {
    const candidates: Array<{ bytes: number; runtimeId: string; state: ClientSessionState; touched: number }> = []
    let bytes = 0

    for (const [runtimeId, state] of this.entries()) {
      if (!this.#isWarmSettled(runtimeId, state)) {
        continue
      }

      const weight = this.#weight(state)
      candidates.push({ bytes: weight, runtimeId, state, touched: this.#recency.get(runtimeId) ?? 0 })
      bytes += weight
    }

    let count = candidates.length

    if (count <= this.#maxCount && bytes <= this.#maxBytes) {
      return
    }

    candidates.sort((a, b) => a.touched - b.touched)

    for (const candidate of candidates) {
      if (count <= this.#maxCount && bytes <= this.#maxBytes) {
        break
      }

      // References and activity can change between insertion and pruning.
      const current = super.get(candidate.runtimeId)

      if (current !== candidate.state || !this.#isWarmSettled(candidate.runtimeId, current)) {
        continue
      }

      super.delete(candidate.runtimeId)
      this.#recency.delete(candidate.runtimeId)
      count -= 1
      bytes -= candidate.bytes
      this.#callbacks.onEvict(candidate.runtimeId, candidate.state)
    }
  }

  #isWarmSettled(runtimeId: string, state: ClientSessionState): boolean {
    // In-flight claims pin a transcript only while they are trustworthy: with
    // an authority probe wired, a frozen busy/awaitingResponse on an orphaned
    // snapshot stops blocking eviction (see callback docs). Without one, the
    // legacy behavior holds and the flags always block.
    if (
      (state.busy || state.awaitingResponse) &&
      this.#callbacks.isAuthoritativelyActive?.(runtimeId, state) !== false
    ) {
      return false
    }

    // O(1) check backed by the per-state counter populated in set(). The
    // WeakMap lookup is missing only if `state` was never installed via
    // set() — fall back to a one-shot scan in that rare case (typically a
    // hand-constructed state passed straight to `super.set` from a test
    // harness or a future caller we haven't migrated yet).
    const pendingCount = this.#pendingMessageCounts.get(state)
    const hasPending = pendingCount === undefined ? countPendingMessages(state) > 0 : pendingCount > 0

    return (
      Boolean(state.storedSessionId) &&
      state.messages.length > 0 &&
      !state.needsInput &&
      !hasPending &&
      !this.#callbacks.isReferenced(runtimeId, state)
    )
  }

  #weight(state: ClientSessionState): number {
    const cached = this.#transcriptWeights.get(state.messages)

    if (cached !== undefined) {
      return cached
    }

    const weight = transcriptBytes(state)
    this.#transcriptWeights.set(state.messages, weight)

    return weight
  }

  #touch(runtimeId: string): void {
    this.#clock += 1
    this.#recency.set(runtimeId, this.#clock)
  }
}
