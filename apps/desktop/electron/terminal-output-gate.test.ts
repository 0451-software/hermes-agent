import assert from 'node:assert/strict'

import { test } from 'vitest'

import { createTerminalOutputGate } from './terminal-output-gate'

// Wait for one setImmediate round so a coalesced flush lands. The gate
// batches attached-mode chunks and dispatches them on the next tick (see
// terminal-output-gate.ts).
const flushImmediates = () => new Promise<void>(resolve => setImmediate(resolve))

function buildHarness() {
  const events: string[] = []
  let cleanups = 0

  const gate = createTerminalOutputGate({
    onExitFlushed: () => {
      events.push('cleanup')
      cleanups += 1
    },
    sendData: data => events.push(`data:${data}`),
    sendExit: payload => events.push(`exit:${payload.code}:${payload.signal}`)
  })

  return { gate, events, cleanups: () => cleanups }
}

test('detached: holds the initial shell prompt until the renderer attaches', () => {
  const { gate, events } = buildHarness()
  gate.data('$ ')
  assert.deepEqual(events, [])

  gate.attach()
  assert.deepEqual(events, ['data:$ '])

  gate.data('pwd\r\n')
  // Attached-mode bytes flush on the next tick; behavior is now coalesced.
  assert.deepEqual(events, ['data:$ '])
})

test('attached: chunks arriving across ticks produce one IPC per tick, in order', async () => {
  const { gate, events } = buildHarness()
  gate.attach()
  gate.data('pwd\r\n')
  await flushImmediates()
  assert.deepEqual(events, ['data:pwd\r\n'])

  gate.data('ls -la\r\n')
  await flushImmediates()
  assert.deepEqual(events, ['data:pwd\r\n', 'data:ls -la\r\n'])
})

test('attached: many chunks in one tick coalesce into a single IPC, order preserved', async () => {
  const { gate, events } = buildHarness()
  gate.attach()
  // ~30 fast chunks, as a verbose command would emit.
  for (let i = 0; i < 30; i += 1) {
    gate.data(`chunk${i}|`)
  }
  assert.deepEqual(events, [], 'synchronous batch must not yet have flushed')
  await flushImmediates()
  // Exactly one data event regardless of input chunk count.
  const dataEvents = events.filter(e => e.startsWith('data:'))
  assert.equal(dataEvents.length, 1)
  const joined = dataEvents[0].slice('data:'.length)
  for (let i = 0; i < 30; i += 1) {
    assert.ok(joined.includes(`chunk${i}|`), `missing chunk${i}| in coalesced output`)
  }
  // Order preserved.
  assert.ok(joined.indexOf('chunk0|') < joined.indexOf('chunk29|'))
})

test('flushed startup output forwards before a late-arriving early shell exit', async () => {
  const { gate, events } = buildHarness()
  gate.data('startup failed\r\n')
  gate.exit({ code: 1, signal: null })
  assert.deepEqual(events, [])

  gate.attach()
  assert.deepEqual(events, ['data:startup failed\r\n', 'exit:1:null', 'cleanup'])
})

test('attached+exit: exit synchronously flushes any pending bytes before sendExit', () => {
  const { gate, events } = buildHarness()
  gate.attach()
  gate.data('tail-bytes')
  // Even though the attached-mode batch hasn't ticked yet, exit drains it
  // so the terminal's last bytes aren't reordered past the exit signal.
  gate.exit({ code: 0, signal: 'SIGTERM' })
  assert.deepEqual(events, ['data:tail-bytes', 'exit:0:SIGTERM', 'cleanup'])
})

test('attach is idempotent and never replays startup output twice', async () => {
  const { gate, events } = buildHarness()
  gate.data('$ ')
  gate.attach()
  gate.attach()
  assert.deepEqual(events, ['data:$ '])

  // And no further data on subsequent identical attaches.
  gate.attach()
  await flushImmediates()
  assert.deepEqual(events, ['data:$ '])
})
