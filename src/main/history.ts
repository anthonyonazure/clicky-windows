import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export interface HistoryEntry {
  /** Insertion timestamp (Date.now) — also used as the entry id. */
  t: number;
  /** User prompt. */
  p: string;
  /** Assistant response (raw, with POINT/ELEMENT tags intact). */
  r: string;
  /** True if the query carried a pasted/dropped image instead of a screen capture. */
  attached?: boolean;
  /** AI provider that answered ("anthropic" | "openai" | "openrouter"). */
  provider?: string;
  /** Foreground window name at query time, if a UIA snapshot was taken. */
  window?: string;
}

interface AppendInput {
  prompt: string;
  response: string;
  attached?: boolean;
  provider?: string;
  window?: string;
}

/**
 * Append-only conversation log. Each query writes one JSON-Lines entry
 * to `userData/history.ndjson`. Loaded into memory on first access for
 * cheap search/recent reads — fine at personal scale (think: 10k entries
 * is ~2 MB and parses in under 50ms).
 *
 * Deliberately NOT using FTS5/SQLite for v1: substring matching covers
 * the "what did I ask last week" use case, and avoiding native modules
 * keeps the Electron build simple. Promote to SQLite if search quality
 * or scale becomes a real limit.
 */
export class HistoryStore {
  private readonly filePath: string;
  private cache: HistoryEntry[] | null = null;
  private writeStream: fs.WriteStream | null = null;
  /** Hard cap on what we load into memory — older entries stay on disk. */
  private readonly MAX_IN_MEMORY = 5000;

  constructor() {
    const dir = app.isReady()
      ? app.getPath("userData")
      : path.join(process.env.APPDATA || process.env.HOME || ".", "clicky-windows");
    this.filePath = path.join(dir, "history.ndjson");
  }

  /** Append a new entry. Returns the entry id (timestamp). */
  append(input: AppendInput): number {
    const entry: HistoryEntry = {
      t: Date.now(),
      p: input.prompt,
      r: input.response,
      ...(input.attached ? { attached: true } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.window ? { window: input.window } : {}),
    };

    try {
      this.ensureDir();
      // synchronous append — tiny payload, simpler than streaming.
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      console.warn(
        "[Clicky] history append failed:",
        err instanceof Error ? err.message : err
      );
      return entry.t;
    }

    if (this.cache) {
      this.cache.push(entry);
      if (this.cache.length > this.MAX_IN_MEMORY) {
        // Slide window — newest entries are what users search.
        this.cache.splice(0, this.cache.length - this.MAX_IN_MEMORY);
      }
    }
    return entry.t;
  }

  /** Most recent N entries, newest first. */
  recent(limit = 20): HistoryEntry[] {
    const all = this.load();
    return all.slice(-limit).reverse();
  }

  /**
   * Case-insensitive substring search over prompt + response. Ranked by
   * recency (newest matches first). Empty query returns recent().
   */
  search(query: string, limit = 20): HistoryEntry[] {
    const q = (query || "").trim().toLowerCase();
    if (!q) return this.recent(limit);
    const all = this.load();
    const matches: HistoryEntry[] = [];
    // Walk newest → oldest so we stop early once we have `limit` hits.
    for (let i = all.length - 1; i >= 0 && matches.length < limit; i--) {
      const e = all[i];
      if (
        e.p.toLowerCase().includes(q) ||
        e.r.toLowerCase().includes(q)
      ) {
        matches.push(e);
      }
    }
    return matches;
  }

  /** Drop every entry. File is truncated on disk. */
  clear(): void {
    try {
      fs.writeFileSync(this.filePath, "", "utf-8");
    } catch (err) {
      console.warn(
        "[Clicky] history clear failed:",
        err instanceof Error ? err.message : err
      );
    }
    this.cache = [];
  }

  private load(): HistoryEntry[] {
    if (this.cache) return this.cache;
    if (!fs.existsSync(this.filePath)) {
      this.cache = [];
      return this.cache;
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const lines = raw.split("\n");
      const out: HistoryEntry[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj && typeof obj.t === "number" && typeof obj.p === "string" && typeof obj.r === "string") {
            out.push(obj);
          }
        } catch {
          // Skip torn / partial lines (could happen if the app crashed
          // mid-write). The rest of the file remains usable.
        }
      }
      if (out.length > this.MAX_IN_MEMORY) {
        out.splice(0, out.length - this.MAX_IN_MEMORY);
      }
      this.cache = out;
      return this.cache;
    } catch (err) {
      console.warn(
        "[Clicky] history load failed:",
        err instanceof Error ? err.message : err
      );
      this.cache = [];
      return this.cache;
    }
  }

  private ensureDir(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
