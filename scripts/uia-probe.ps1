# UIA Phase 0 Probe — walks the UI Automation tree of the foreground window
# and writes a JSON report describing every element it sees, plus aggregate
# counts (total / interactive / visible / named).
#
# Usage:
#   pwsh -File scripts/uia-probe.ps1 -OutFile results/vscode.json
#
# Bring the target app to focus *before* the script runs (e.g. via a small
# delay, or use Alt-Tab and a `Start-Sleep 3` in the caller).
#
# Notes:
#   - Works on PowerShell 5.1+ and PowerShell 7.
#   - Uses System.Windows.Automation (UIA, the legacy COM-bridged API).
#     Sufficient for a coverage benchmark; production code would prefer
#     the modern UIAutomationCore (CUIAutomation8) via P/Invoke or a
#     Rust addon.

[CmdletBinding()]
param(
  [int]$MaxDepth = 12,
  [int]$MaxElements = 8000,
  [int]$TimeoutSeconds = 30,
  [string]$OutFile = "uia-probe-result.json",
  # Target selection (any one). If none given, walks the foreground window.
  [string]$ProcessName,    # match by process name (e.g. 'notepad', 'explorer')
  [string]$WindowTitle,    # match by window title regex
  [int]$ProcessId          # match by exact PID
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindowVisible(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Auto, SetLastError=true)]
public static extern int GetWindowTextLength(System.IntPtr hWnd);
"@ -Name 'WinAPI' -Namespace 'UIAProbe' | Out-Null

function Find-TargetElement {
  param([string]$proc, [string]$titleRegex, [int]$targetPid)

  # Walk top-level windows under the desktop and find the first match.
  $desktop = [System.Windows.Automation.AutomationElement]::RootElement
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $child = $walker.GetFirstChild($desktop)

  $candidates = @()
  while ($null -ne $child) {
    try {
      $info = $child.Current
      $hwnd = [System.IntPtr]$info.NativeWindowHandle
      $isVisible = [UIAProbe.WinAPI]::IsWindowVisible($hwnd)
      if ($isVisible -and -not $info.IsOffscreen) {
        $candidates += [pscustomobject]@{
          el        = $child
          name      = $info.Name
          processId = $info.ProcessId
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
  return $null
}

$root = $null
if ($ProcessName -or $WindowTitle -or $ProcessId) {
  $root = Find-TargetElement -proc $ProcessName -titleRegex $WindowTitle -targetPid $ProcessId
  if ($null -eq $root) {
    Write-Error ("no top-level window matched (ProcessName='{0}', WindowTitle='{1}', PID={2})" -f $ProcessName, $WindowTitle, $ProcessId)
    exit 1
  }
} else {
  $hwnd = [UIAProbe.WinAPI]::GetForegroundWindow()
  if ($hwnd -eq [System.IntPtr]::Zero) {
    Write-Error "no foreground window"
    exit 1
  }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $root) {
    Write-Error "could not obtain AutomationElement for foreground window"
    exit 1
  }
}

$windowName = $root.Current.Name
$processId = $root.Current.ProcessId
$processName = try { (Get-Process -Id $processId -ErrorAction SilentlyContinue).ProcessName } catch { "" }
Write-Host "Probing window '$windowName' (process $processName, pid $processId)"

# Control types we treat as "interactive" — i.e. things a user would
# plausibly click or focus, and therefore the things a UIA-based pointing
# pipeline needs to find. LocalizedControlType varies by UI language; we
# include common English strings here. Add localized aliases as needed.
$INTERACTIVE = @(
  'button',  'check box',  'combo box',  'edit',         'hyperlink',
  'link',    'list item',  'menu item',  'radio button', 'tab',
  'tab item','tree item',  'split button','slider',      'spinner',
  'header item'
)

function Test-Interactive {
  param([string]$ct)
  if ([string]::IsNullOrWhiteSpace($ct)) { return $false }
  $lower = $ct.ToLowerInvariant()
  return $INTERACTIVE -contains $lower
}

$elements = New-Object System.Collections.Generic.List[object]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$queue = New-Object System.Collections.Generic.Queue[object]
$queue.Enqueue(@{ el = $root; depth = 0 })

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$timeoutMs = $TimeoutSeconds * 1000
$timedOut = $false

while ($queue.Count -gt 0 -and $elements.Count -lt $MaxElements) {
  if ($sw.ElapsedMilliseconds -gt $timeoutMs) {
    $timedOut = $true
    break
  }

  $node = $queue.Dequeue()
  $el = $node.el
  $depth = [int]$node.depth

  try {
    $info = $el.Current
    $ct = $info.LocalizedControlType
    $name = $info.Name
    $bounds = $info.BoundingRectangle

    $row = [pscustomobject]@{
      depth        = $depth
      controlType  = $ct
      name         = $name
      hasName      = -not [string]::IsNullOrWhiteSpace($name)
      automationId = $info.AutomationId
      className    = $info.ClassName
      isEnabled    = $info.IsEnabled
      isOffscreen  = $info.IsOffscreen
      x            = [int]$bounds.X
      y            = [int]$bounds.Y
      w            = [int]$bounds.Width
      h            = [int]$bounds.Height
    }
    $elements.Add($row) | Out-Null
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
  } catch {
    # Some elements throw on tree walk (security, disposed handles, COM
    # marshaling errors). Skip and keep going.
  }
}

$sw.Stop()
$elapsedMs = [int]$sw.ElapsedMilliseconds

$interactive = @($elements | Where-Object { Test-Interactive $_.controlType })
$visible = @($interactive | Where-Object { -not $_.isOffscreen -and $_.w -gt 0 -and $_.h -gt 0 })
$named = @($interactive | Where-Object { $_.hasName })
$visibleNamed = @($visible | Where-Object { $_.hasName })

$namedRatio = if ($interactive.Count -gt 0) {
  [math]::Round($named.Count / $interactive.Count, 3)
} else { 0.0 }

$visibleNamedRatio = if ($visible.Count -gt 0) {
  [math]::Round($visibleNamed.Count / $visible.Count, 3)
} else { 0.0 }

$result = [pscustomobject]@{
  window                  = $windowName
  process                 = $processName
  processId               = $processId
  elapsedMs               = $elapsedMs
  hitElementCap           = ($elements.Count -ge $MaxElements)
  hitTimeout              = $timedOut
  totalElements           = $elements.Count
  interactiveCount        = $interactive.Count
  visibleInteractiveCount = $visible.Count
  namedInteractiveCount   = $named.Count
  visibleNamedCount       = $visibleNamed.Count
  namedRatio              = $namedRatio
  visibleNamedRatio       = $visibleNamedRatio
  elements                = $elements
}

# Make sure the parent dir exists.
$outDir = Split-Path -Parent $OutFile
if ($outDir -and -not (Test-Path $outDir)) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

$result | ConvertTo-Json -Depth 8 -Compress | Out-File -FilePath $OutFile -Encoding utf8

Write-Host ("elapsed={0}ms  total={1}  interactive={2}  visible={3}  named={4}  named%={5}  visible-named%={6}" -f `
  $elapsedMs, $elements.Count, $interactive.Count, $visible.Count, $named.Count, ($namedRatio * 100), ($visibleNamedRatio * 100))

if ($timedOut) { Write-Warning "Walk hit timeout at $TimeoutSeconds seconds; results are partial." }
if ($elements.Count -ge $MaxElements) { Write-Warning "Walk hit element cap of $MaxElements; results are partial." }

Write-Host "saved: $OutFile"
