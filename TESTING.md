# Hermes Desktop CPU Bundle — Build & Run Guide

This is a **test bundle** combining 13 independent perf fixes targeting the
Hermes desktop app's high CPU utilization while a session is active and the
agent is taking turns. All 13 fixes are also available as individual draft PRs
on this fork (`https://github.com/0451-software/hermes-agent/pulls`); this
branch is just the same fixes pre-merged onto `main` for local build/test.

**Bundle commit:** `69b7f3e076abdcafcbbe80b2da47e47ce36c9b51`
**Branch:** `desktop-cpu-bundle-2026-09-26` on `0451-software/hermes-agent`
**Upstream base:** `NousResearch/hermes-agent` main

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

## Prerequisites

- **Node** `^22.22.0 || ^24.11.0 || >=26.0.0` (see `apps/desktop/package.json` engines)
- **npm** (the desktop app uses **npm**, not pnpm — there is no pnpm-workspace.yaml)
- **Python 3.14** + **uv** (the desktop bundles a Python agent payload via `npm run payload`; the dev loop doesn't need this)
- **Git** with LFS disabled or not required (no LFS in the repo)

> The desktop workspace's `node_modules` are **hoisted to the repo root**, so
> `npm ci` from the repo root installs everything the build needs.
> `apps/desktop/scripts/assert-root-install.mjs` will refuse to start the
> build if root install is missing or partial.

## Building & running (corrected)

From the **repo root** (`/workspace/source/hermes-agent` in the container,
the cloned `hermes-agent` directory on your machine):

```bash
# 1. Clone the fork and switch to the bundle
git clone https://github.com/0451-software/hermes-agent.git
cd hermes-agent
git checkout desktop-cpu-bundle-2026-09-26

# 2. Install dependencies from the repo root (hoisted workspace install)
npm ci

# 3. Typecheck the touched files (full repo tsc OOMs in 8 GB sandboxes; this is enough)
cd apps/desktop
npx tsc --build tsconfig.electron.json --noEmit    # electron main + IPC
npx tsc --build tsconfig.json --noEmit             # renderer
```

### Run the desktop app (dev mode)

```bash
cd apps/desktop
npm run dev
```

This runs `concurrently` over two processes:

- `dev:renderer` — Vite dev server on `http://127.0.0.1:5174` (HMR)
- `dev:electron` — `tsc --build tsconfig.electron.json`, then waits for the
  renderer to come up, then `electron .` against the dev URL

`dev:renderer` re-runs `assert-root-install.mjs` first; if root install is
missing, you'll get a clear error pointing back at step 2.

### Build a packaged app (optional)

```bash
cd apps/desktop
npm run build      # full build → apps/desktop/dist
npm run start      # runs electron against the built dist
```

Or for an unpacked distributable:

```bash
npm run pack       # produces an unpacked Electron app under apps/desktop/dist
```

### Quick smoke-test checklist

1. App window opens; no `assert-root-install` or `katex/dist/katex.min.css`
   unresolved-import errors.
2. Start a chat session, send a message.
3. The agent streams a long response — confirm:
   - **CPU drops during streaming** (was the original symptom).
   - "Recalculate Style" tasks in DevTools Performance trace drop >50%.
   - "Scripting" is no longer dominated by `preserveLocalAssistantErrors`.
   - The inflight journal `setTimeout` fires 2-3 Hz instead of ~30 Hz
     (visible in the trace as an `Idle Callback (setTimeout)` task; this
     proves Fix 2's idempotency fingerprint is short-circuiting).
4. Open DevTools → Performance → record a 30 s trace during a long stream.
   Compare against a baseline from `fork/main`.

## Testing a single fix in isolation

If you'd rather review / test one fix at a time:

```bash
# from the repo root, after `npm ci`
git fetch origin
git checkout -b test/fix-N origin/agent/desktop-cpu/fix-N-<slug>
# e.g. fix-1-deep-compare-gate, fix-2-inflight-throttle, etc.
cd apps/desktop
npm run dev
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
