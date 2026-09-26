# Hermes Desktop CPU Bundle — Build & Run Guide

This is a **test bundle** combining 13 independent perf fixes targeting the
Hermes desktop app's high CPU utilization while a session is active and the
agent is taking turns. All 13 fixes are also available as individual draft PRs
on this fork (`https://github.com/0451-software/hermes-agent/pulls`); this
branch is just the same fixes pre-merged onto `main` for local build/test.

**Bundle commit:** `1cd8b4167b890acc43d66027605bbfb00ed2cee6`
**Branch:** `desktop-cpu-bundle-2026-09-26` on `0451-software/hermes-agent`
**Upstream base:** `NousResearch/hermes-agent` main (commit `cb399b56d9`)

## What's in the bundle (16 files / +638 / -157 lines)

| # | Fix | File(s) | Net | What it changes |
|---|-----|---------|-----|-----------------|
| 1 | deep-compare gate | `apps/desktop/src/app/session/hooks/use-session-state-cache.ts` | +39/-6 | Skip per-flush deep-compare when no error frames exist |
| 2 | inflight throttle | `apps/desktop/src/lib/inflight-turn-journal.ts` | +52/-0 | Idempotency fingerprint skips redundant 160 KB localStorage writes |
| 3 | sticky-prompt early-exit | `use-sticky-prompt-clip.ts`, `list.tsx` | +11/-6 | Mirror useMessagesBelow's isAtBottom bail-out |
| 4 | messages-below effect deps | `use-messages-below.ts` | +22/-2 | Internal useRef fingerprint prevents identity-churn refire |
| 5 | useAuiState selectors | new `inter-agent-index.ts`, `assistant-message.tsx`, `user-message.tsx`, `list.tsx` | +127/-66 | Hoist O(m^2) selector scan to a parent memo via Context |
| 6 | thread signatures | `list.tsx` | +27/-4 | Fold two thread-signature selectors into one combined pass |
| 7 | weighted groups | `list.tsx`, `use-timeline-reveal.ts` | +54/-20 | Parallel weights array removes per-group object spread |
| 8 | runtime parts reuse | `tool-parts.ts` | +46/-9 | Refactor dedup loop to forward-scan, lazy Set, early return |
| 9 | session-state-cache prune | `session-state-cache.ts` | +32/-3 | WeakMap-based O(1) pending-message counter |
| 10 | session-states flush | `session-states.ts`, `session-dot-state.ts` | +97/-19 | Per-flush read patterns |
| 11 | remote-display GPU gate | `apps/desktop/electron/main.ts` | +15/-1 | `HERMES_DESKTOP_FORCE_GPU_REMOTE_DISPLAY` opt-out |
| 12 | failed-api async flush | `apps/desktop/electron/main.ts` | +1/-1 | Replace sync flush with async flush in catch block |
| 13 | terminal IPC rAF | `terminal-output-gate.ts`, `.test.ts` | +115/-20 | Coalesce attached-mode chunks via setImmediate |

## Building

The bundle uses pnpm for the desktop app. From the bundle worktree root:

```bash
# 1. Install dependencies (the desktop app lives under apps/desktop)
cd apps/desktop
pnpm install --frozen-lockfile=false

# 2. Typecheck
pnpm -w tsc -p apps/desktop/tsconfig.json --noEmit
# (full repo tsc OOMs in 8 GB sandboxes; per-package tsc is enough)
```

## Running the desktop app

```bash
cd apps/desktop
pnpm dev
```

This starts the Electron app with HMR. The fix that is most likely to give
an immediate, visible reduction in CPU is **Fix 1** (deep-compare gate) —
when the agent streams a long response, CPU should drop within seconds.

## Targeted perf verification

To verify the per-flush reconcile path is no longer the bottleneck:

1. Open the app, start a chat session.
2. Send a message that produces a long streaming response.
3. Open Chrome DevTools (View > Toggle Developer Tools) and profile.

**Expected delta on a long stream:**
- "Recalculate Style" tasks should drop by **>50%** on the streaming path.
- "Scripting" should no longer be dominated by `preserveLocalAssistantErrors`.
- The throttled "Idle Callback (setTimeout)" path should fire ~2-3 Hz instead of
  ~30 Hz for the inflight journal write (Fix 2).

If you can capture a Performance trace before and after this bundle, the
biggest visible diff should be in the `_intersectionObserver → reconcile →
flushPendingViewState` chain.

## Individual PR testing

If you'd rather review / test one fix at a time:

```bash
git checkout -b test/fix-N origin/agent/desktop-cpu/fix-N-<slug>
# (e.g. fix-1-deep-compare-gate, fix-2-inflight-throttle, etc.)
```

Each PR is independent; you can check them out one by one on top of `main`.

## Reporting

For each fix, please report:
- Did CPU drop during streaming?
- Did the UI feel snappier during agent turns?
- Any regressions (crashes, wrong content, scroll glitches)?

Open an issue on the fork and tag `@Barry` so I can triage.

---

**DO NOT PUSH THIS BRANCH TO UPSTREAM.** This is a fork-only test bundle.
The 13 individual draft PRs are the artefacts that will (after G's review)
be re-targeted to `NousResearch/hermes-agent`.
