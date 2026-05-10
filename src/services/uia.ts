import { spawn } from "child_process";
import * as path from "path";
import { app } from "electron";

export interface UIAElement {
  id: number;
  name: string;
  role: string;
  /** Center X in display-absolute pixels (multi-monitor virtual desktop). */
  x: number;
  /** Center Y in display-absolute pixels. */
  y: number;
  w: number;
  h: number;
}

export interface UIASnapshot {
  hwnd: number;
  windowName: string;
  process: string;
  processId: number;
  rect: { x: number; y: number; w: number; h: number };
  elapsedMs: number;
  truncated: boolean;
  elements: UIAElement[];
  /** Date.now() when this snapshot was captured (set by Node, not PS). */
  capturedAt: number;
}

interface PsResultOk extends Omit<UIASnapshot, "capturedAt"> {
  ok: true;
}

interface PsResultErr {
  ok: false;
  error: string;
  detail?: string;
}

type PsResult = PsResultOk | PsResultErr;

interface SnapshotOptions {
  processName?: string;
  hwnd?: number;
  windowTitle?: string;
  /**
   * Cap the PowerShell walk. The benchmark showed dense apps (File
   * Explorer) take ~1000ms; 1500ms is the agreed Phase 1 ceiling.
   */
  timeoutMs?: number;
}

/**
 * Phase 1 UIA service. Shells out to PowerShell + System.Windows.Automation,
 * with per-window caching so dense windows don't re-walk on every query.
 *
 * Cache key: hwnd + rect. Invalidated on:
 *   - rect change (window moved or resized — UIA coords are now stale)
 *   - TTL_MS elapsed (defensive — covers content changes the rect doesn't)
 */
export class UIAService {
  private readonly TTL_MS = 30_000;
  private readonly cache = new Map<number, UIASnapshot>();
  private readonly scriptPath: string;

  constructor() {
    // app.getAppPath() points to the project root in dev, the asar root in
    // production. `scripts/` is plain files in both layouts.
    this.scriptPath = path.join(app.getAppPath(), "scripts", "uia-snapshot.ps1");
  }

  /**
   * Take a UIA snapshot. Returns null on any failure (caller continues
   * without UIA hints — the POINT pipeline still works).
   */
  async snapshot(opts: SnapshotOptions = {}): Promise<UIASnapshot | null> {
    const raw = await this.runScript(opts);
    if (!raw || !raw.ok) return null;

    const fresh: UIASnapshot = { ...raw, capturedAt: Date.now() };

    // Cache-or-replace by hwnd. If rect or timestamp drifted we just
    // overwrite — the new snapshot is the truth.
    if (fresh.hwnd) this.cache.set(fresh.hwnd, fresh);
    return fresh;
  }

  /**
   * Cache lookup: return a recent snapshot for this hwnd if its rect still
   * matches what we last saw and the TTL hasn't expired. Caller is
   * responsible for hwnd discovery (e.g. via screen.getCursorScreenPoint
   * + window-at-point) — Phase 1 just uses foreground.
   */
  getCached(hwnd: number, currentRect?: UIASnapshot["rect"]): UIASnapshot | null {
    const hit = this.cache.get(hwnd);
    if (!hit) return null;
    if (Date.now() - hit.capturedAt > this.TTL_MS) {
      this.cache.delete(hwnd);
      return null;
    }
    if (
      currentRect &&
      (currentRect.x !== hit.rect.x ||
        currentRect.y !== hit.rect.y ||
        currentRect.w !== hit.rect.w ||
        currentRect.h !== hit.rect.h)
    ) {
      this.cache.delete(hwnd);
      return null;
    }
    return hit;
  }

  /**
   * Resolve an ELEMENT id from an LLM response back to its display-absolute
   * center coordinates. Returns null if id is unknown.
   */
  resolve(snapshot: UIASnapshot, id: number): UIAElement | null {
    return snapshot.elements.find((el) => el.id === id) || null;
  }

  /**
   * Render a snapshot as a prompt fragment the model can use to choose
   * elements. Keeps token count low: id, name, role only.
   */
  toPromptList(snapshot: UIASnapshot, maxItems = 80): string {
    if (snapshot.elements.length === 0) return "";
    const lines: string[] = [];
    lines.push(
      `UI elements in the foreground window "${snapshot.windowName || snapshot.process}" (use [ELEMENT:id] to point at one):`
    );
    const items = snapshot.elements.slice(0, maxItems);
    for (const el of items) {
      // Strip newlines from names — some Win32 controls embed them.
      const name = el.name.replace(/\s+/g, " ").trim();
      lines.push(`  [${el.id}] ${name} (${el.role})`);
    }
    if (snapshot.elements.length > maxItems) {
      lines.push(`  ... ${snapshot.elements.length - maxItems} more not shown`);
    }
    return lines.join("\n");
  }

  private runScript(opts: SnapshotOptions): Promise<PsResult | null> {
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.scriptPath,
    ];
    if (opts.timeoutMs) {
      args.push("-TimeoutMs", String(opts.timeoutMs));
    }
    if (opts.hwnd) {
      args.push("-Hwnd", String(opts.hwnd));
    } else if (opts.processName) {
      args.push("-ProcessName", opts.processName);
    } else if (opts.windowTitle) {
      args.push("-WindowTitle", opts.windowTitle);
    }

    return new Promise((resolve) => {
      // Prefer PowerShell 7 (`pwsh`), fall back silently to Windows PowerShell
      // (`powershell`) — both ship with the .NET assemblies we need.
      const child = spawn("pwsh", args, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      let killed = false;

      const killTimer = setTimeout(() => {
        killed = true;
        try {
          child.kill("SIGKILL");
        } catch {}
      }, (opts.timeoutMs ?? 1500) + 2000);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf-8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf-8");
      });

      child.on("error", (err) => {
        clearTimeout(killTimer);
        // If pwsh isn't installed, retry with windows powershell once.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          this.runScriptFallback(args.slice(2), opts).then(resolve);
          return;
        }
        console.warn("[Clicky] UIA pwsh spawn failed:", err.message);
        resolve(null);
      });

      child.on("close", (code) => {
        clearTimeout(killTimer);
        if (killed) {
          console.warn("[Clicky] UIA snapshot killed after timeout");
          resolve(null);
          return;
        }
        if (code !== 0 && !stdout) {
          console.warn("[Clicky] UIA snapshot exited non-zero:", code, stderr.slice(0, 300));
          resolve(null);
          return;
        }
        const parsed = this.parse(stdout);
        if (!parsed) {
          console.warn(
            "[Clicky] UIA snapshot stdout was not valid JSON:",
            stdout.slice(0, 200)
          );
        }
        resolve(parsed);
      });
    });
  }

  private runScriptFallback(
    forwardArgs: string[],
    opts: SnapshotOptions
  ): Promise<PsResult | null> {
    return new Promise((resolve) => {
      const child = spawn("powershell.exe", forwardArgs, { windowsHide: true });
      let stdout = "";
      let killed = false;
      const killTimer = setTimeout(() => {
        killed = true;
        try {
          child.kill("SIGKILL");
        } catch {}
      }, (opts.timeoutMs ?? 1500) + 2000);

      child.stdout.on("data", (c) => {
        stdout += c.toString("utf-8");
      });
      child.on("error", () => {
        clearTimeout(killTimer);
        resolve(null);
      });
      child.on("close", () => {
        clearTimeout(killTimer);
        if (killed) {
          resolve(null);
          return;
        }
        resolve(this.parse(stdout));
      });
    });
  }

  private parse(raw: string): PsResult | null {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      return JSON.parse(trimmed) as PsResult;
    } catch {
      return null;
    }
  }
}
