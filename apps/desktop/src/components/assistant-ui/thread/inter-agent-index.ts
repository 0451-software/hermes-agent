// PERF (Fix 5): hoists three O(messages) `useAuiState` selectors —
// `interAgentSender`, `latestUserId`, `runtimeUserOrdinal` — to a single
// parent-level pass keyed on the structural signature. Each selector
// used to scan the whole message list from every mounted message on
// every store update (O(messages²) per flush + a full-text greedy regex).
// Computing once per signature flip and serving per-message values from
// Maps gives O(messages) per flush.
import { useAuiState } from '@assistant-ui/react'
import { createContext, useContext, useMemo } from 'react'

import { dispatchedTo } from '@/components/assistant-ui/thread/agent-delivery'
import { messageContentText } from '@/components/assistant-ui/thread/content'
import { AGENT_MESSAGE_RE } from '@/components/assistant-ui/thread/user-message'

export interface ThreadIndexValue {
  readonly interAgentSenderById: ReadonlyMap<string, string | null>
  readonly runtimeUserOrdinalById: ReadonlyMap<string, number | null>
  readonly latestUserId: string | null
}

const EMPTY_INDEX: ThreadIndexValue = Object.freeze({
  interAgentSenderById: new Map(),
  runtimeUserOrdinalById: new Map(),
  latestUserId: null
})

const ThreadIndexContext = createContext<ThreadIndexValue>(EMPTY_INDEX)

export const ThreadIndexProvider = ThreadIndexContext.Provider
export function useThreadIndex(): ThreadIndexValue {
  return useContext(ThreadIndexContext)
}

type MinimalMessage = { id: string; role: string; content: unknown }

/** One pass producing every per-message value the children used to derive
 *  independently. Re-runs only when the structural signature flips. */
export function buildThreadIndex(messages: readonly MinimalMessage[]): ThreadIndexValue {
  const interAgentSenderById = new Map<string, string | null>()
  const runtimeUserOrdinalById = new Map<string, number | null>()
  const userContentCache: (string | null)[] = new Array(messages.length).fill(null)
  let latestUserId: string | null = null
  let userOrdinal = 0

  // Forward pass: user ordinals, cached joined text, null sender seed.
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]

    if (message.role === 'user') {
      runtimeUserOrdinalById.set(message.id, userOrdinal++)
      userContentCache[i] = messageContentText(message.content as never)
      latestUserId = message.id
    } else if (message.role === 'assistant') {
      interAgentSenderById.set(message.id, null)
    }
  }

  // Back-walk: stamp a sender on assistant rows whose nearest earlier
  // user row is an inter-agent delivery this bot did NOT dispatch.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue

    for (let j = i - 1; j >= 0; j--) {
      const prev = messages[j]

      if (prev.role === 'assistant') continue
      if (prev.role !== 'user') break

      const text = userContentCache[j]

      if (!text) break

      const match = AGENT_MESSAGE_RE.exec(text.trim())

      if (!match) break

      const earlierSlice = messages.slice(0, j) as MinimalMessage[]
      const isRoundTrip = dispatchedTo(earlierSlice, [match[1], match[2], match[3]])

      if (!isRoundTrip) {
        interAgentSenderById.set(messages[i].id, (match[1] || match[3] || 'agent').trim())
      }

      break
    }
  }

  return { interAgentSenderById, runtimeUserOrdinalById, latestUserId }
}

/** Memoize on the structural signature (ids + roles + count). Weight
 *  changes per token flush do NOT invalidate this, which is the point. */
export function useThreadIndexValue(): ThreadIndexValue {
  const signature = useAuiState(s => s.thread.messages.map((m, i) => `${i}:${m.id}:${m.role}`).join('|'))
  const messages = useAuiState(s => s.thread.messages) as readonly MinimalMessage[]

  return useMemo(() => buildThreadIndex(messages), [signature])
}