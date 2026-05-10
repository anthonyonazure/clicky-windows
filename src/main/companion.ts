import { BrowserWindow, nativeImage, screen } from "electron";
import { ScreenCapture, ScreenshotResult, cropScreenshotRegion } from "./screenshot";
import { SettingsStore } from "./settings";
import { ClaudeService } from "../services/claude";
import { OpenAIChatService } from "../services/openai-chat";
import { OpenRouterChatService } from "../services/openrouter-chat";
import {
  TranscriptionProvider,
  createTranscriptionProvider,
} from "../services/transcription/interface";
import { createTTSProvider } from "../services/tts/interface";
import { UIAService, UIASnapshot } from "../services/uia";

interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
}

interface AIProvider {
  query(params: {
    transcript: string;
    screenshots: ScreenshotResult[];
    cursorPosition: { x: number; y: number };
    conversationHistory: ConversationEntry[];
    uiaContext?: string;
  }): Promise<{ text: string }>;
}

interface ResolvedTag {
  x: number;          // display-local CSS pixels (overlay-window space)
  y: number;
  label: string;
  screen: number;     // overlay window index = screen.getAllDisplays() index
  source: "element" | "point";
}

const MAX_CONVERSATION_HISTORY = 10;

/**
 * Central orchestrator — mirrors CompanionManager.swift from macOS version.
 *
 * Flow: voice → screenshot → ai (anthropic or openai) → tts → overlay pointing
 */
export class CompanionManager {
  private settings: SettingsStore;
  private screenCapture: ScreenCapture;
  private transcription: TranscriptionProvider;
  private conversationHistory: ConversationEntry[] = [];
  private overlayWindows: BrowserWindow[] = [];
  private uia: UIAService;

  constructor(settings: SettingsStore, overlayWindows: BrowserWindow[]) {
    this.settings = settings;
    this.screenCapture = new ScreenCapture();
    this.transcription = createTranscriptionProvider(settings);
    this.overlayWindows = overlayWindows;
    this.uia = new UIAService();
  }

  private getAIProvider(): AIProvider {
    const provider = this.settings.get("aiProvider");
    if (provider === "openai") {
      return new OpenAIChatService(this.settings);
    }
    if (provider === "openrouter") {
      return new OpenRouterChatService(this.settings);
    }
    return new ClaudeService(this.settings);
  }

  private broadcastStage(stage: string, label: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("companion:stage", { stage, label });
      }
    }
  }

  /**
   * Process a user query: capture screen (or use an attached image), send
   * to AI, speak response.
   *
   * If `attachedImage` is provided, we skip the screen capture entirely
   * and answer about that image instead. POINT/ELEMENT tags from the
   * model still get parsed but are not routed to the cursor overlay —
   * they'd land on random spots of the real screen, which would be wrong.
   */
  async processQuery(
    transcript: string,
    attachedImage?: { data: string; mime?: string }
  ): Promise<string> {
    try {
    const hasAttachment = !!attachedImage;

    // 1. Capture screenshots (skipped when an attachment is provided).
    let screenshots: ScreenshotResult[];
    if (hasAttachment) {
      this.broadcastStage("capturing", "Loading image...");
      const synthetic = this.buildAttachmentScreenshot(attachedImage!.data);
      screenshots = synthetic ? [synthetic] : [];
    } else {
      this.broadcastStage("capturing", "Reading screen...");
      screenshots = await this.screenCapture.captureAllScreens();
    }
    const cursorPos = this.screenCapture.getCursorPosition();

    // 1b. Optionally snapshot the foreground window's UIA tree. The walk
    //     can stall on dense apps, so cap at 1500ms and treat any failure
    //     as "no UIA hint" — the POINT pipeline still works. Skipped for
    //     attached-image queries (no screen to point at).
    let uiaSnapshot: UIASnapshot | null = null;
    if (this.settings.get("uiaEnabled") && !hasAttachment) {
      this.broadcastStage("uia", "Scanning UI...");
      const t0 = Date.now();
      try {
        uiaSnapshot = await this.uia.snapshot({ timeoutMs: 1500 });
        if (uiaSnapshot) {
          console.log(
            `[Clicky] UIA snapshot: ${uiaSnapshot.elements.length} elements from "${uiaSnapshot.windowName}" in ${Date.now() - t0}ms`
          );
        } else {
          console.log("[Clicky] UIA snapshot: unavailable");
        }
      } catch (err) {
        console.warn("[Clicky] UIA snapshot threw:", err instanceof Error ? err.message : err);
      }
    }
    const uiaContext = uiaSnapshot ? this.uia.toPromptList(uiaSnapshot) : undefined;

    // 2. Send to AI provider with conversation history
    this.conversationHistory.push({ role: "user", content: transcript });

    this.broadcastStage("querying", "Analyzing...");
    const ai = this.getAIProvider();
    const response = await ai.query({
      transcript,
      screenshots,
      cursorPosition: cursorPos,
      conversationHistory: this.conversationHistory,
      uiaContext,
    });

    this.conversationHistory.push({ role: "assistant", content: response.text });

    // Trim history
    if (this.conversationHistory.length > MAX_CONVERSATION_HISTORY * 2) {
      this.conversationHistory = this.conversationHistory.slice(-MAX_CONVERSATION_HISTORY * 2);
    }

    // 3a. Parse raw POINT tags (still in image-pixel space).
    const rawTags = this.parseRawPointTags(response.text);
    console.log("[Clicky] Claude response:", response.text);
    console.log("[Clicky] Raw POINT tags:", JSON.stringify(rawTags));

    // 3a'. Parse ELEMENT tags and resolve each via the UIA snapshot.
    //      Element-resolved tags skip the refinement pass — UIA already
    //      gives precise OS-supplied bounds.
    const elementResolved: ResolvedTag[] = [];
    if (uiaSnapshot) {
      const elementIds = this.parseElementTags(response.text);
      console.log("[Clicky] ELEMENT tag ids:", JSON.stringify(elementIds));
      for (const id of elementIds) {
        const el = this.uia.resolve(uiaSnapshot, id);
        if (!el) {
          console.warn(`[Clicky] ELEMENT:${id} not found in snapshot`);
          continue;
        }
        const local = this.absoluteToLocal(el.x, el.y);
        if (!local) continue;
        elementResolved.push({
          x: local.x,
          y: local.y,
          label: el.name,
          screen: local.screen,
          source: "element",
        });
      }
    }

    // 3b. Second-pass refinement: only Claude for now.
    //     For each tag, crop ~400px around the estimated point and ask the
    //     model to return the precise pixel center. Falls back to the raw
    //     tag if anything goes wrong.
    const aiProviderName = this.settings.get("aiProvider");
    let refinedTags = rawTags;
    if (aiProviderName === "anthropic" && rawTags.length > 0 && !hasAttachment) {
      this.broadcastStage("refining", "Refining points...");
      const claude = new ClaudeService(this.settings);
      refinedTags = await Promise.all(
        rawTags.map(async (tag) => {
          const shot = screenshots[tag.screen] || screenshots[0];
          if (!shot) return tag;
          try {
            // 300 imageDim px — small enough to reduce ambiguity with
            // neighboring similar elements (e.g. like/dislike), large enough
            // to give context. At native DPI this is a much sharper patch
            // than cropping the downsampled pass-1 image.
            const crop = cropScreenshotRegion(shot, tag.x, tag.y, 300);
            const refined = await claude.refinePoint(
              crop.data,
              crop.claudeSize.w,
              crop.claudeSize.h,
              tag.label
            );
            if (refined) {
              // Refined coords live in native crop-pixel space. Map back to
              // imageDimensions (pass-1) space so later scaling to display
              // px works consistently.
              const imgX = crop.origin.x + refined.x / crop.pxPerImageDim;
              const imgY = crop.origin.y + refined.y / crop.pxPerImageDim;
              console.log(
                `[Clicky] Refined "${tag.label}": (${tag.x},${tag.y}) → (${Math.round(imgX)},${Math.round(imgY)})`
              );
              return { ...tag, x: Math.round(imgX), y: Math.round(imgY) };
            }
          } catch (err) {
            console.warn(
              `[Clicky] Refinement failed for "${tag.label}":`,
              err instanceof Error ? err.message : err
            );
          }
          return tag;
        })
      );
    }

    // 3c. Scale image-pixel coords to display-pixel coords for the overlay.
    const pointResolved: ResolvedTag[] = refinedTags.map((tag) => {
      const shot = screenshots[tag.screen] || screenshots[0];
      if (!shot) {
        return { x: tag.x, y: tag.y, label: tag.label, screen: tag.screen, source: "point" };
      }
      const scaleX = shot.bounds.width / shot.imageDimensions.width;
      const scaleY = shot.bounds.height / shot.imageDimensions.height;
      return {
        x: Math.round(tag.x * scaleX),
        y: Math.round(tag.y * scaleY),
        label: tag.label,
        screen: tag.screen,
        source: "point",
      };
    });

    // 3d. Merge ELEMENT-resolved and POINT-resolved tags. Both arrays now
    //     hold display-local CSS pixel coordinates, ready for the overlay.
    //     Attached-image queries skip overlay routing — there's no live UI
    //     to point at.
    const allTags: ResolvedTag[] = hasAttachment
      ? []
      : [...elementResolved, ...pointResolved];
    console.log("[Clicky] Final tags:", JSON.stringify(allTags));
    console.log("[Clicky] Overlay windows:", this.overlayWindows.length);
    if (allTags.length > 0 && this.overlayWindows.length > 0) {
      const byScreen = new Map<number, ResolvedTag[]>();
      for (const tag of allTags) {
        const list = byScreen.get(tag.screen) || [];
        list.push(tag);
        byScreen.set(tag.screen, list);
      }
      for (const [screenIdx, tags] of byScreen) {
        if (screenIdx < 0 || screenIdx >= this.overlayWindows.length) {
          console.warn(
            `[Clicky] Tag screen=${screenIdx} is out of range (have ${this.overlayWindows.length} overlay windows); routing to primary display.`
          );
        }
        const win = this.overlayWindows[screenIdx] || this.overlayWindows[0];
        if (win && !win.isDestroyed()) {
          win.webContents.send("overlay:point", tags);
        }
      }
    }

    // 4. Speak response (strip POINT and ELEMENT tags) — non-blocking.
    //    Re-read settings each time so chat toggle changes take effect immediately.
    const spokenText = response.text
      .replace(/\[POINT:[^\]]+\]/g, "")
      .replace(/\[ELEMENT:\d+\]/g, "")
      .trim();
    const ttsOn = this.settings.get("ttsEnabled");
    const ttsProv = this.settings.get("ttsProvider");
    if (ttsOn && spokenText) {
      this.broadcastStage("speaking", "Speaking...");
      try {
        const tts = createTTSProvider(this.settings);
        tts.speak(spokenText).catch((err) => {
          console.warn("TTS failed (non-fatal):", err.message);
        });
      } catch (err: unknown) {
        console.warn("TTS provider creation failed:", err instanceof Error ? err.message : err);
      }
    }

    return response.text;
    } finally {
      this.broadcastStage("done", "");
    }
  }

  private parseRawPointTags(
    text: string
  ): Array<{ x: number; y: number; label: string; screen: number }> {
    const regex = /\[POINT:(\d+),(\d+):([^:]+):screen(\d+)\]/g;
    const tags: Array<{ x: number; y: number; label: string; screen: number }> = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      tags.push({
        x: parseInt(match[1], 10),
        y: parseInt(match[2], 10),
        label: match[3],
        screen: parseInt(match[4], 10),
      });
    }

    return tags;
  }

  /**
   * Re-encode a user-supplied image (PNG, JPEG, anything Electron's
   * NativeImage can parse) into a ScreenshotResult that flows through the
   * existing AI-query path. JPEG output keeps claude.ts's hardcoded
   * media_type happy. Bounds + imageDimensions are set to the JPEG size
   * so any (unused) coordinate math is at 1:1.
   */
  private buildAttachmentScreenshot(base64: string): ScreenshotResult | null {
    try {
      const buf = Buffer.from(base64, "base64");
      const img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) return null;

      const size = img.getSize();
      const MAX = 1568;
      const maxEdge = Math.max(size.width, size.height);
      const scaled =
        maxEdge > MAX
          ? img.resize({
              width: Math.round((size.width * MAX) / maxEdge),
              height: Math.round((size.height * MAX) / maxEdge),
            })
          : img;
      const scaledSize = scaled.getSize();
      const jpeg = scaled.toJPEG(85);

      return {
        data: jpeg.toString("base64"),
        displayIndex: 0,
        bounds: {
          x: 0,
          y: 0,
          width: scaledSize.width,
          height: scaledSize.height,
        },
        imageDimensions: { width: scaledSize.width, height: scaledSize.height },
      };
    } catch (err) {
      console.warn(
        "[Clicky] Failed to decode attached image:",
        err instanceof Error ? err.message : err
      );
      return null;
    }
  }

  private parseElementTags(text: string): number[] {
    const regex = /\[ELEMENT:(\d+)\]/g;
    const ids: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      ids.push(parseInt(match[1], 10));
    }
    return ids;
  }

  /**
   * Convert display-absolute (virtual-desktop) pixel coords into
   * display-local CSS pixel coords + the matching overlay window index.
   * Returns null if no display contains the point (shouldn't happen in
   * practice but guard against unhooked monitors).
   */
  private absoluteToLocal(
    absX: number,
    absY: number
  ): { x: number; y: number; screen: number } | null {
    const displays = screen.getAllDisplays();
    for (let i = 0; i < displays.length; i++) {
      const b = displays[i].bounds;
      if (absX >= b.x && absX < b.x + b.width && absY >= b.y && absY < b.y + b.height) {
        return { x: absX - b.x, y: absY - b.y, screen: i };
      }
    }
    const nearest = screen.getDisplayNearestPoint({ x: absX, y: absY });
    const idx = displays.findIndex((d) => d.id === nearest.id);
    if (idx < 0) return null;
    const b = nearest.bounds;
    return { x: absX - b.x, y: absY - b.y, screen: idx };
  }

  clearHistory(): void {
    this.conversationHistory = [];
  }
}
