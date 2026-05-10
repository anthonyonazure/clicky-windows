# UIA Phase 1 Runtime Snapshot — called from src/services/uia.ts on every
# query (cached). Walks the target window's accessibility tree and emits a
# lean JSON describing each interactive element by integer id, with center
# coordinates in DISPLAY-ABSOLUTE pixels so the renderer can route them
# without coordinate-space math.
#
# Differs from uia-probe.ps1 in two ways:
#   1. Output is compact, geared for prompt inclusion + IPC, not analysis.
#   2. Emits ALL output as a single JSON object on stdout (first/only line)
#      so the Node side can parse it without scrubbing log noise.
#
# Usage (from Node child_process.spawn):
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/uia-snapshot.ps1
#       [-ProcessName notepad] [-Hwnd 123456] [-WindowTitle 'pattern']
#       [-MaxDepth 12] [-MaxElements 4000] [-TimeoutMs 1500]

[CmdletBinding()]
param(
  [int]$MaxDepth = 12,
  [int]$MaxElements = 4000,
  [int]$TimeoutMs = 1500,
  [string]$ProcessName,
  [string]$WindowTitle,
  [long]$Hwnd = 0,
  [int]$TargetPid = 0
)

$ErrorActionPreference = 'Stop'

function Emit-Json($obj) {
  $obj | ConvertTo-Json -Depth 8 -Compress
}

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  Emit-Json @{ ok = $false; error = "load-uia-failed"; detail = $_.Exception.Message }
  exit 1
}

Add-Type -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindowVisible(System.IntPtr hWnd);
"@ -Name 'WinAPI' -Namespace 'UIASnap' | Out-Null

# Interactive control types we care about for pointing. Lower-cased so we
# match LocalizedControlType in any English Windows UI.
$INTERACTIVE = @{}
@(
  'button', 'check box', 'combo box', 'edit', 'hyperlink', 'link',
  'list item', 'menu item', 'radio button', 'tab', 'tab item',
  'tree item', 'split button', 'slider', 'spinner', 'header item'
) | ForEach-Object { $INTERACTIVE[$_] = $true }

function Test-Interactive {
  param([string]$ct)
  if ([string]::IsNullOrWhiteSpace($ct)) { return $false }
  return $INTERACTIVE.ContainsKey($ct.ToLowerInvariant())
}

function Find-Target {
  param([string]$proc, [string]$titleRegex, [int]$targetPid, [long]$wnd)

  if ($wnd -ne 0) {
    try {
      $el = [System.Windows.Automation.AutomationElement]::FromHandle([System.IntPtr]$wnd)
      if ($el) { return $el }
    } catch {}
    return $null
  }

  $desktop = [System.Windows.Automation.AutomationElement]::RootElement
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $child = $walker.GetFirstChild($desktop)

  $candidates = @()
  while ($null -ne $child) {
    try {
      $info = $child.Current
      $h = [System.IntPtr]$info.NativeWindowHandle
      $isVisible = [UIASnap.WinAPI]::IsWindowVisible($h)
      if ($isVisible -and -not $info.IsOffscreen) {
        $candidates += [pscustomobject]@{
          el        = $child
          name      = $info.Name
          processId = $info.ProcessId
          hwnd      = $h.ToInt64()
        }
      }
    } catch {}
    $child = $walker.GetNextSibling($child)
  }

  foreach ($c in $candidates) {
    if ($targetPid -and $c.processId -ne $targetPid) { continue }
    if ($proc) {
      $p = $null
      try { $p = Get-Process -Id $c.processId -ErrorAction SilentlyContinue } catch {}
      if (-not $p -or $p.ProcessName -notlike "*$proc*") { continue }
    }
    if ($titleRegex -and ($c.name -notmatch $titleRegex)) { continue }
    return $c.el
  }

  # No filters? Fall back to foreground window.
  if (-not ($proc -or $titleRegex -or $targetPid)) {
    $fg = [UIASnap.WinAPI]::GetForegroundWindow()
    if ($fg -ne [System.IntPtr]::Zero) {
      try { return [System.Windows.Automation.AutomationElement]::FromHandle($fg) } catch {}
    }
  }
  return $null
}

$root = Find-Target -proc $ProcessName -titleRegex $WindowTitle -targetPid $TargetPid -wnd $Hwnd
if ($null -eq $root) {
  Emit-Json @{ ok = $false; error = "no-window-matched" }
  exit 0
}

$rootInfo = $root.Current
$rootRect = $rootInfo.BoundingRectangle
$elements = New-Object System.Collections.Generic.List[object]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$queue = New-Object System.Collections.Generic.Queue[object]
$queue.Enqueue(@{ el = $root; depth = 0 })

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$nextId = 1
$truncated = $false

while ($queue.Count -gt 0) {
  if ($sw.ElapsedMilliseconds -gt $TimeoutMs) {
    $truncated = $true
    break
  }
  if ($elements.Count -ge $MaxElements) {
    $truncated = $true
    break
  }

  $node = $queue.Dequeue()
  $el = $node.el
  $depth = [int]$node.depth

  try {
    $info = $el.Current
    if ((Test-Interactive $info.LocalizedControlType) -and -not $info.IsOffscreen) {
      $bounds = $info.BoundingRectangle
      $w = [int]$bounds.Width
      $h = [int]$bounds.Height
      if ($w -ge 8 -and $h -ge 8) {
        $name = $info.Name
        if (-not [string]::IsNullOrWhiteSpace($name)) {
          $cx = [int]($bounds.X + $bounds.Width / 2)
          $cy = [int]($bounds.Y + $bounds.Height / 2)
          $elements.Add([pscustomobject]@{
            id   = $nextId
            name = $name
            role = $info.LocalizedControlType
            x    = $cx
            y    = $cy
            w    = $w
            h    = $h
          }) | Out-Null
          $nextId++
        }
      }
    }
  } catch {
    continue
  }

  if ($depth -ge $MaxDepth) { continue }

  try {
    $child = $walker.GetFirstChild($el)
    while ($null -ne $child) {
      $queue.Enqueue(@{ el = $child; depth = $depth + 1 })
      $child = $walker.GetNextSibling($child)
    }
  } catch {}
}

$sw.Stop()

$hwndOut = 0
try { $hwndOut = ([System.IntPtr]$rootInfo.NativeWindowHandle).ToInt64() } catch {}

$procName = ""
try {
  $p = Get-Process -Id $rootInfo.ProcessId -ErrorAction SilentlyContinue
  if ($p) { $procName = $p.ProcessName }
} catch {}

$result = [pscustomobject]@{
  ok           = $true
  hwnd         = $hwndOut
  windowName   = $rootInfo.Name
  process      = $procName
  processId    = $rootInfo.ProcessId
  rect         = @{
    x = [int]$rootRect.X
    y = [int]$rootRect.Y
    w = [int]$rootRect.Width
    h = [int]$rootRect.Height
  }
  elapsedMs    = [int]$sw.ElapsedMilliseconds
  truncated    = $truncated
  elements     = $elements
}

Emit-Json $result
