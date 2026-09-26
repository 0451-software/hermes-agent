import { setImmediate, clearImmediate } from 'node:timers'

export interface TerminalExitPayload {
  code: number | null
  signal: string | null
}

interface TerminalOutputGateOptions {
  onExitFlushed: () => void
  sendData: (data: string) => void
  sendExit: (payload: TerminalExitPayload) => void
}

const MAX_PENDING_OUTPUT = 1024 * 1024

export function createTerminalOutputGate({ onExitFlushed, sendData, sendExit }: TerminalOutputGateOptions) {
  let attached = false
  let pendingData = ''
  let pendingExit: TerminalExitPayload | null = null
  // Attached-mode coalescing: PTY chunks queue up and flush as a single IPC
  // send per Node tick (setImmediate), instead of one send per chunk. A
  // verbose command that emits thousands of chunks per second now wakes the
  // renderer thousands-of-chunks-per-second → ≤ hundreds-of-times-per-second.
  // FINAL-REPORT §4 row 13 (B F2 HIGH).
  let coalesced: string[] = []
  let flushHandle: NodeJS.Immediate | null = null

  const flushExit = (payload: TerminalExitPayload) => {
    sendExit(payload)
    onExitFlushed()
  }

  const flushCoalesced = () => {
    flushHandle = null

    if (coalesced.length === 0) {
      return
    }

    const joined = coalesced.join('')
    coalesced = []
    sendData(joined)
  }

  const scheduleFlush = () => {
    if (flushHandle !== null) {
      return
    }

    flushHandle = setImmediate(flushCoalesced)
  }

  const cancelScheduledFlush = () => {
    if (flushHandle !== null) {
      clearImmediate(flushHandle)
      flushHandle = null
    }
    coalesced = []
  }

  return {
    attach(): void {
      if (attached) {
        return
      }

      // Detach may have raced with mid-coalesce; drop anything in flight so a
      // late flush doesn't strand before we re-attach.
      cancelScheduledFlush()

      attached = true

      if (pendingData) {
        sendData(pendingData)
        pendingData = ''
      }

      if (pendingExit) {
        const payload = pendingExit
        pendingExit = null
        flushExit(payload)
      }
    },
    data(chunk: string): void {
      if (attached) {
        coalesced.push(chunk)
        scheduleFlush()

        return
      }

      pendingData = `${pendingData}${chunk}`.slice(-MAX_PENDING_OUTPUT)
    },
    exit(payload: TerminalExitPayload): void {
      if (attached) {
        // Drain anything still coalesced so the last bytes aren't reordered
        // past the exit signal.
        if (flushHandle !== null) {
          clearImmediate(flushHandle)
          flushCoalesced()
        }
        flushExit(payload)

        return
      }

      pendingExit = payload
    }
  }
}
