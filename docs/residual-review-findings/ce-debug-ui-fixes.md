# Outstanding verification & residual risks — `ce-debug-ui-fixes`

Plan: `docs/plans/2026-07-29-001-fix-transfer-rings-otp-dropzone-plan.md`
Branch base: `1a96e72`

U7 called for the two-device matrix to live in the PR description. This branch
is staying local for now, so it lives here instead. Everything below is
outstanding — nothing here has been run.

---

## Two-device manual matrix (U7)

Needs two real devices on one network. Run the whole table **twice**: once over
Wi-Fi, once over phone hotspot.

For each row, confirm **both** peers reach a clean idle — no rings, no stranded
overlay, drop zone back — **and** that a second transfer started immediately
afterwards works.

| # | Exit path | Wi-Fi | Hotspot |
| :-- | :-- | :-- | :-- |
| 1 | Sender success | ☐ | ☐ |
| 2 | Receiver success | ☐ | ☐ |
| 3 | Sender cancels mid-transfer | ☐ | ☐ |
| 4 | Receiver cancels mid-transfer | ☐ | ☐ |
| 5 | Peer disconnect (kill the far tab mid-transfer) | ☐ | ☐ |
| 6 | Leave room mid-transfer | ☐ | ☐ |
| 7 | Batch multi-file (3+ files) | ☐ | ☐ |

Row 7 additionally: rings must run **continuously** across file boundaries and
stop exactly once, after the final file — not restart per file.

Row 1 is worth extra attention. It was reachable only through
`window._completeTransferCh3`, which `src/App.tsx` was deleting on effect
cleanup; that is fixed on this branch (`66b9486`) but has never been confirmed
on real hardware.

## Manual Android pass (R8)

On a real Android soft keyboard, not an emulated UA:

- ☐ Backspace on a **filled** OTP box clears that box, focus stays.
- ☐ Backspace on an **empty** box clears the previous box, focus moves there.
- ☐ Exactly one box changes per keypress — never two.
- ☐ After clearing all four, re-typing advances through all four and fires join.
- ☐ **Hold** backspace to auto-repeat: every repeat deletes one box (see the
  residual risk below).

---

## Residual risks

Neither was actioned. Both are recorded rather than fixed.

### 1. OTP erase guard could swallow a fast IME auto-repeat

`claimErase()` in `index.html` de-duplicates one physical keypress arriving via
three listeners using a 40 ms window. The window is only reset by `keydown`.

On desktop this is safe — every auto-repeat fires a fresh `keydown`. On the
IME-only path (Android reporting `keyCode 229`, or a keyboard that emits
`beforeinput` with no usable `keydown`), a soft keyboard auto-repeating faster
than 40 ms would have its second delete swallowed.

Not reproduced; the automated suite exercises 60 ms spacing and passes. The
manual Android hold-backspace check above is what would surface it. If it does,
the plan's deferred **OTP single-controller rewrite** is the real fix.

### 2. Transfer visuals are single-slot, so simultaneous send+receive would collide

`enterTransferVisuals(mode)` / `resetTransferVisuals()` track one direction. If
one device were ever sending and receiving at the same time, whichever direction
finished first would call `resetTransferVisuals()` and tear down the other
direction's rings too.

Pre-existing — the removed sphere/particle coupling had the same single-slot
assumption and was worse, since it also corrupted the shared particle field.
`sendFile` (`src/App.tsx:753`) guards duplicate *local* sends but not an inbound
transfer arriving mid-send. I could not find a UI route that reaches this state,
and the role/signalling protocol is explicitly outside this plan's scope.

Fixing it means giving the lifecycle owner a per-direction refcount instead of a
single mode. Only worth doing if bidirectional transfer becomes a real feature.
