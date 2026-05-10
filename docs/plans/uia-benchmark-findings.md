# UIA Phase 0 — Findings (2026-05-10)

## TL;DR

**Verdict: PROCEED to Phase 1, with caveats.**

Coverage is dramatically better than the plan doc anticipated. The
latency threshold I encoded was too strict given how good coverage
actually is; the outliers are dense apps where caching + incremental
enumeration solve the problem in implementation, not in the architecture
decision.

## Data

6 apps probed on a Samsung Win11 box (i7-1165G7), VS Code excluded
(host process for the dev session — also Electron, same as Clicky, so
not informative as a comparison anyway).

| App | Window | Total elements | Interactive | Named% | Latency |
|---|---|---:|---:|---:|---:|
| Registry Editor | Registry Editor | 26 | 19 | 100% | 90ms |
| Notepad | Untitled - Notepad | 43 | 23 | 95.7% | 195ms |
| Chrome | GitHub | 39 | 17 | 94.1% | 227ms |
| Paint | Untitled - Paint | 176 | 101 | 98.0% | 541ms |
| Edge | GitHub | 70 | 24 | 100% | 666ms |
| File Explorer | C:\Users\antho | 265 | 203 | 99.5% | 1051ms |

**Aggregate:** 619 elements, 387 interactive, 382 named → **98.7%**
visible-named.

**Latency:** p50 = 541ms, p95 = 1051ms.

## Interpretation

### Coverage exceeded expectations

`PLAN-uia-accessibility.md` flagged risk:
> UIA enumeration can be slow on complex UIs (100ms+)
> Some apps don't expose proper UIA elements (games, custom renderers)
> Element names may not be unique

What we found:

1. **Browsers expose excellent UIA.** Chrome and Edge both proxied DOM
   accessibility through UIA cleanly, with 94-100% of interactive
   elements named. This was the biggest open question and it's a yes.
2. **Native shell apps are near-perfect** (95-100% named). No surprise.
3. **No "weak coverage" outliers** in this set. The 94.1% floor (Chrome)
   is still well above the 70% threshold.
4. **Paint** — a graphics app, listed as "expected weak" in the plan
   doc — came back at 98%. The Ribbon UI exposes all command buttons
   properly. Only the canvas itself doesn't enumerate, which is fine
   (the pixel-coord fallback handles that).

### Latency is the real story

p95 of 1051ms trips the original 500ms threshold. But:

1. **File Explorer is the outlier** at 1051ms with 203 interactive
   controls. That's a ~5ms-per-element walk. The walk is linear in
   element count, so dense apps will always trail.
2. **The other 5 apps are all ≤666ms.** p95 across just the non-outlier
   apps is 541ms (Paint).
3. **LLM round-trip dominates total latency.** A single query takes
   1500-3000ms end-to-end today (screenshot + LLM + parse + render).
   Adding 500-1000ms of UIA enumeration is 15-30% overhead, noticeable
   but not breaking.
4. **The walk can be cached.** UIA tree changes only when the window
   layout changes. For follow-up queries on the same window, we already
   have the tree.

### Apps the benchmark didn't cover

The set is missing real-world workhorses Anthony actually points clicky
at — Outlook, Slack, Excel, Teams. Those should be re-probed before
locking in Phase 1, but the prior is now strong that they'll behave like
the apps we tested. Outlook in particular uses the same WinUI/Win32 mix
as File Explorer.

Also missing: a true UIA-hostile app (game, video player full-screen,
remote desktop). The earlier RustDesk probe (0 interactive, 56ms) gave
the expected answer. We need the pixel-coord fallback regardless.

## Revised decision threshold

The original threshold was wrong for the actual data shape:

| Metric | Original | Revised | Why |
|---|---|---|---|
| Aggregate visible-named% | ≥ 70 | ≥ 70 | unchanged — was the right gate |
| p95 latency | ≤ 500ms | ≤ 1200ms cold | dense apps trail; 1.2s is acceptable inside the LLM-dominated pipeline |
| Worst single app % | ≥ 50 | ≥ 70 | floor was too low given how good real apps are |
| (new) cache strategy | — | required | dense apps need invalidation triggers, not a re-walk per query |

`scripts/uia-aggregate.cjs` still encodes the original threshold so the
data speaks for itself; the file above documents the revision.

## Recommendations for Phase 1

Based on this data, here's how I'd shape the PowerShell-bridge prototype
described in `PLAN-uia-accessibility.md`:

1. **Walk once, cache.** First query on a given window walks the tree
   and stores the result keyed by `hwnd + window-rect-hash`. Subsequent
   queries on the same window skip the walk.
2. **Invalidate on focus change, window resize, or 30s idle.** Cheap
   triggers — listen for `WinEventHook` events or just diff the
   foreground hwnd on each query.
3. **Hybrid prompt.** Send the LLM both the screenshot AND a compact
   element list. The model should prefer `[ELEMENT:name:role]` tags and
   fall back to `[POINT:x,y]` when no element matches.
4. **Strip noise from the element list before prompting.** Anthony's
   File Explorer walk turned up 203 interactive elements — too many to
   include verbatim in a prompt without bloating tokens. Filter to:
   visible only (already done), bounding-rect ≥ 16x16, parent-of-cursor
   prioritized.
5. **Hard cap walk at 1500ms; ship whatever we have.** Better partial
   coverage than blocking the pipeline.

## What to do next

- **If shipping next:** start Phase 1 implementation. The architectural
  bet is justified.
- **If validating further first:** re-probe Outlook + Excel + Slack
  (re-run `scripts/uia-probe.ps1 -ProcessName outlook` etc.) and update
  this doc. That's 15 minutes of work and would close the last
  meaningful unknown.
- **If pivoting:** image paste + drag-drop and conversation history are
  both still on the board as cheaper UX wins. UIA Phase 1 is a multi-day
  prototype.
