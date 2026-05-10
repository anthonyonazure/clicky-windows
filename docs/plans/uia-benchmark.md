# UIA Phase 0 Benchmark — Procedure

## Goal

Decide whether to invest in the UIA-based pointing pipeline described in
[PLAN-uia-accessibility.md](PLAN-uia-accessibility.md) by measuring the
quality of the Windows accessibility tree on real apps.

## Decision threshold

All three must pass to proceed to Phase 1:

| Metric | Threshold | Why |
|---|---|---|
| Aggregate visible-named% | ≥ 70 | If most clickable controls have no usable Name, the LLM can't target them by name |
| p95 walk latency | ≤ 500ms | Per-query overhead has to fit inside the existing pipeline budget |
| Worst single-app visible-named% | ≥ 50 | UIA failing badly on one common app is a deal-breaker — pixel fallback would dominate |

If any fails, hold on UIA investment and document the gap. The hybrid
fallback (POINT pixel coords) is still in scope, but Phase 1 isn't worth
the integration cost without coverage.

## Procedure

For each target app:

1. Open the app, bring it to focus, and let the UI settle.
2. Run the probe — it reads the foreground window:

   ```powershell
   pwsh -File scripts/uia-probe.ps1 -OutFile results/<appname>.json
   ```

   On PS 5.1 (no `pwsh`):

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/uia-probe.ps1 -OutFile results/<appname>.json
   ```

3. The probe prints a one-line summary and saves a JSON of every element
   walked. Don't move/resize the window during the walk.

After all apps are probed, summarize:

```bash
node scripts/uia-aggregate.cjs results/*.json
```

The aggregator prints the per-app table, the aggregate row, and the
PROCEED / HOLD verdict.

## Suggested target apps

Aim for breadth — different rendering models will produce very different
UIA quality. **Eight apps is enough** to read the verdict; ten makes the
p95 stable.

| App | Why |
|---|---|
| **VS Code** | Electron-based — common case; baseline for our own renderer |
| **Chrome** | Web rendering with Chrome-injected accessibility |
| **Outlook** (or Mail) | Native Win32 + WinUI mix |
| **Excel** | Cell grids stress dense uniform UIs |
| **Slack** | Electron app; comparison point against VS Code |
| **File Explorer** | Native shell, high coverage expected |
| **Task Manager** | Native, very dense — stress test |
| **Notepad** | Trivial baseline — should be ~100% |
| **Photopea** *(optional)* | Canvas-heavy — expected weak coverage |
| **A game** *(optional)* | Native renderer, no UIA — expected near-zero |

The optional canvas/game cases aren't part of the threshold check
(skip from `results/` before aggregating, or the verdict tanks unfairly).
They're useful for sanity-checking that pixel fallback will be needed.

## What "interactive" means

The probe tags an element as interactive if its `LocalizedControlType`
matches a hard-coded list (button, menu item, list item, tab, hyperlink,
edit, combo box, etc.). Adjust `$INTERACTIVE` in `uia-probe.ps1` to add
locale-specific strings if you're testing a non-English Windows.

`visible-named%` is the more honest metric than `named%`: off-screen
elements (collapsed menus, virtualized list items) often lack Name even
when they'd populate it once visible — counting them dilutes the signal.

## Output structure

```
results/<app>.json
{
  window: "...", processId: ..., elapsedMs: ...,
  totalElements: ..., interactiveCount: ..., visibleInteractiveCount: ...,
  namedInteractiveCount: ..., visibleNamedCount: ...,
  namedRatio: 0.74, visibleNamedRatio: 0.86,
  hitElementCap: false, hitTimeout: false,
  elements: [ { depth, controlType, name, hasName, automationId, ... }, ... ]
}
```

The `elements` array is for ad-hoc analysis — e.g. listing all unnamed
buttons in Excel to figure out what the gap looks like. The aggregator
ignores it.

## What's next if PROCEED

Phase 1 from `PLAN-uia-accessibility.md`: PowerShell-bridged element
enumeration injected into the LLM prompt, plus a hybrid POINT/ELEMENT
resolver in the overlay renderer. Native (Rust/NAPI-RS or P/Invoke) is
Phase 2.

## What's next if HOLD

Document the gap in HANDOFF.md. Possible next moves:
- Try modern UIA (`UIAutomationCore` / `CUIAutomation8`) instead of
  System.Windows.Automation — the modern API exposes more properties on
  some Electron apps.
- Narrow the scope of the win: even partial UIA coverage might pay off
  for specific app categories (e.g. enterprise forms) without being a
  general replacement for POINT.
- Skip UIA, ship the other deliverables (image paste, conversation
  history) instead.
