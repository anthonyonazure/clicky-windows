/**
 * Minimal Cortex client.
 *
 * Cortex (https://github.com/anthonyonazure/cortex) is Anthony's local
 * knowledge OS — an Express server on port 5201 backed by SQLite + FTS5
 * and a memo-as-markdown-file store. We push each Clicky Q&A pair as a
 * memo so the knowledge accumulates in one place across tools.
 *
 * Behaviour notes:
 *   - Fire-and-forget. If Cortex isn't running or returns an error, we
 *     log once and move on — never block or fail the chat query.
 *   - 1500ms timeout per request. Local HTTP should be sub-100ms; longer
 *     means Cortex is wedged or doing a big index rebuild.
 */

interface PushMemoInput {
  /** Full memo body — markdown. */
  content: string;
  /** Tag list (e.g. ["clicky", "anthropic", "Notepad"]). */
  tags?: string[];
  /** Cortex memo state. Defaults to "idea" on the server when omitted. */
  state?: "idea" | "draft" | "active" | "review" | "done" | "archived";
}

interface PushMemoResult {
  ok: boolean;
  memoId?: string;
  error?: string;
}

export class CortexClient {
  constructor(private baseUrl: string) {}

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  /**
   * Create a memo. Returns { ok: false, error } on any failure — caller
   * should log and continue, never throw on cortex outages.
   */
  async pushMemo(input: PushMemoInput): Promise<PushMemoResult> {
    if (!this.baseUrl) return { ok: false, error: "no-base-url" };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);

    try {
      const res = await fetch(this.normalizedUrl("/api/memos"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: input.content,
          tags: input.tags || [],
          state: input.state,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const text = await safeText(res);
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 120)}` };
      }
      const body = (await res.json()) as { id?: string };
      return { ok: true, memoId: body.id };
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  /**
   * Quick reachability check. Used by the settings UI to show a connection
   * status next to the toggle. Hits a cheap endpoint and treats any 2xx
   * (or 404 — server is up, route just doesn't exist on older builds) as
   * a live signal.
   */
  async ping(): Promise<{ ok: boolean; error?: string }> {
    if (!this.baseUrl) return { ok: false, error: "no-base-url" };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1000);
    try {
      const res = await fetch(this.normalizedUrl("/api/memos?limit=1"), {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok || res.status === 404) return { ok: true };
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  private normalizedUrl(suffix: string): string {
    const base = this.baseUrl.replace(/\/+$/, "");
    return base + suffix;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Render a Clicky Q&A pair into the markdown shape Cortex expects.
 * Strips POINT/ELEMENT tags from the response so the saved memo stays
 * readable — the tag info is just renderer plumbing.
 */
export function formatMemoBody(opts: {
  prompt: string;
  response: string;
  attached?: boolean;
  window?: string;
  provider?: string;
}): string {
  const clean = opts.response
    .replace(/\[POINT:[^\]]+\]/g, "")
    .replace(/\[ELEMENT:\d+\]/g, "")
    .trim();

  const metaParts: string[] = [];
  if (opts.attached) metaParts.push("image-attached");
  if (opts.window) metaParts.push(`window: ${opts.window}`);
  if (opts.provider) metaParts.push(`provider: ${opts.provider}`);
  const meta = metaParts.length ? `\n\n_${metaParts.join(" · ")}_` : "";

  return `**Q:** ${opts.prompt}\n\n**A:** ${clean || "(no response)"}${meta}`;
}

/**
 * Pick tags suitable for a Clicky memo. "clicky" is always present so
 * Anthony can filter the noise out of Cortex if he ever wants to.
 */
export function buildMemoTags(opts: {
  attached?: boolean;
  window?: string;
  provider?: string;
  extra?: string[];
}): string[] {
  const tags = new Set<string>(["clicky"]);
  if (opts.provider) tags.add(opts.provider);
  if (opts.attached) tags.add("image");
  if (opts.window) {
    // Slugify window names like "Untitled - Notepad" → "untitled-notepad".
    // Keeps tag lists tidy in Cortex's filter UI.
    const slug = opts.window
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
    if (slug) tags.add(slug);
  }
  for (const t of opts.extra || []) tags.add(t);
  return [...tags];
}
