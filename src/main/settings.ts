import { app, safeStorage } from "electron";
import * as fs from "fs";
import * as path from "path";

interface SettingsSchema {
  // API Keys (BYOK) — encrypted at rest via safeStorage (DPAPI on Windows).
  // Values held in memory in their on-disk form (encrypted blob with `enc:v1:`
  // prefix, or legacy plaintext for un-migrated installs). Decryption happens
  // at access time inside `get()` / `getAll()` / `revealKey()`.
  anthropicApiKey: string;
  openaiApiKey: string;
  openrouterApiKey: string;
  assemblyaiApiKey: string;
  elevenlabsApiKey: string;

  // Optional proxy (for non-BYOK / org deployments)
  proxyUrl: string;
  useProxy: boolean;

  // Transcription
  transcriptionProvider: "assemblyai" | "openai" | "whisper-local";

  // TTS
  ttsEnabled: boolean;
  ttsProvider: "elevenlabs" | "openai" | "local";
  elevenlabsVoiceId: string;
  openaiTtsVoice: string;

  // Hotkey
  pushToTalkHotkey: string;

  // AI Provider
  aiProvider: "anthropic" | "openai" | "openrouter";
  claudeModel: string;
  openaiModel: string;
  openrouterModel: string;

  // UI
  alwaysOnTop: boolean;
  cursorBuddyEnabled: boolean;

  // HIPAA
  hipaaMode: boolean;

  // UI Automation hybrid pointing (Phase 1 prototype). When on, every
  // query snapshots the foreground window's accessibility tree and feeds
  // an element list to the model so it can emit [ELEMENT:id] tags that
  // skip the pass-2 refinement call.
  uiaEnabled: boolean;
}

const defaults: SettingsSchema = {
  anthropicApiKey: "",
  openaiApiKey: "",
  openrouterApiKey: "",
  assemblyaiApiKey: "",
  elevenlabsApiKey: "",
  proxyUrl: "",
  useProxy: false,
  transcriptionProvider: "assemblyai",
  ttsEnabled: true,
  ttsProvider: "local",
  elevenlabsVoiceId: "kPzsL2i3teMYv0FxEYQ6",
  openaiTtsVoice: "alloy",
  pushToTalkHotkey: "Ctrl+Shift",
  alwaysOnTop: false,
  cursorBuddyEnabled: true,
  aiProvider: "anthropic",
  claudeModel: "claude-sonnet-4-5-20250929",
  openaiModel: "gpt-4o",
  openrouterModel: "anthropic/claude-sonnet-4-5",
  hipaaMode: false,
  uiaEnabled: false,
};

const SENSITIVE_KEYS: ReadonlySet<keyof SettingsSchema> = new Set<keyof SettingsSchema>([
  "anthropicApiKey",
  "openaiApiKey",
  "openrouterApiKey",
  "assemblyaiApiKey",
  "elevenlabsApiKey",
]);

const ENC_PREFIX = "enc:v1:";
const MASK_PREFIX = "••••";

export type SensitiveKey =
  | "anthropicApiKey"
  | "openaiApiKey"
  | "openrouterApiKey"
  | "assemblyaiApiKey"
  | "elevenlabsApiKey";

export function isSensitiveKey(key: string): key is SensitiveKey {
  return SENSITIVE_KEYS.has(key as keyof SettingsSchema);
}

/**
 * Settings store with at-rest encryption for API keys (DPAPI on Windows
 * via Electron `safeStorage`). Plain JSON file for everything else; avoids
 * the electron-store ESM headaches.
 */
export class SettingsStore {
  private data: SettingsSchema;
  private filePath: string;

  constructor() {
    const userDataPath = app.isReady()
      ? app.getPath("userData")
      : path.join(
          process.env.APPDATA || process.env.HOME || ".",
          "clicky-windows"
        );

    this.filePath = path.join(userDataPath, "settings.json");
    this.data = { ...defaults };

    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<SettingsSchema>;
        this.data = { ...defaults, ...parsed };
      }
    } catch {
      // Use defaults on any read error
    }
  }

  get<K extends keyof SettingsSchema>(
    key: K,
    fallback?: SettingsSchema[K]
  ): SettingsSchema[K] {
    const raw = this.data[key];
    if (SENSITIVE_KEYS.has(key) && typeof raw === "string") {
      const plain = this.decryptValue(raw);
      if (!plain && fallback !== undefined) return fallback;
      return plain as SettingsSchema[K];
    }
    if (raw === undefined && fallback !== undefined) return fallback;
    return raw;
  }

  set<K extends keyof SettingsSchema>(
    key: K,
    value: SettingsSchema[K]
  ): void {
    // Defensive: never persist a redacted display string back to disk.
    // The renderer should only call set() with a real new value.
    if (
      SENSITIVE_KEYS.has(key) &&
      typeof value === "string" &&
      value.startsWith(MASK_PREFIX)
    ) {
      return;
    }

    if (SENSITIVE_KEYS.has(key) && typeof value === "string") {
      this.data[key] = this.encryptValue(value) as SettingsSchema[K];
    } else {
      this.data[key] = value;
    }
    this.save();
  }

  /**
   * Returns settings with sensitive keys decrypted to plaintext. Main-process
   * internal use only — never expose this directly over IPC. Use
   * `getRedacted()` for the renderer.
   */
  getAll(): SettingsSchema {
    const out = { ...this.data };
    for (const key of SENSITIVE_KEYS) {
      const raw = this.data[key as keyof SettingsSchema];
      if (typeof raw === "string") {
        (out as Record<string, unknown>)[key] = this.decryptValue(raw);
      }
    }
    return out;
  }

  /**
   * Returns settings safe to send to the renderer: non-sensitive values are
   * plaintext; sensitive keys are masked (`••••<last4>`) so the renderer can
   * show a "stored" hint without ever holding the raw key.
   */
  getRedacted(): SettingsSchema {
    const out = { ...this.data };
    for (const key of SENSITIVE_KEYS) {
      const raw = this.data[key as keyof SettingsSchema];
      if (typeof raw === "string" && raw) {
        const plain = this.decryptValue(raw);
        (out as Record<string, unknown>)[key] = plain ? this.maskKey(plain) : "";
      } else {
        (out as Record<string, unknown>)[key] = "";
      }
    }
    return out;
  }

  /**
   * Returns the plaintext value of one sensitive key. For edit-time UI flows
   * (e.g. user clicks "Show" to verify or copy). Returns empty string for
   * unknown / non-sensitive keys.
   */
  revealKey(key: string): string {
    if (!isSensitiveKey(key)) return "";
    const raw = this.data[key];
    return typeof raw === "string" ? this.decryptValue(raw) : "";
  }

  getAllRaw(): SettingsSchema {
    return { ...this.data };
  }

  isConfigured(): boolean {
    if (this.get("useProxy") && this.get("proxyUrl")) {
      return true;
    }
    return !!this.get("anthropicApiKey");
  }

  isHipaaMode(): boolean {
    return this.get("hipaaMode");
  }

  /**
   * Encrypts any sensitive keys still stored as legacy plaintext on disk.
   * Idempotent and safe to call once per startup, after `app.whenReady()`.
   * If safeStorage isn't available (rare on Windows — only when DPAPI is
   * unreachable), this is a no-op and keys remain plaintext.
   */
  migrateIfNeeded(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn(
        "[Clicky] safeStorage unavailable — API keys will remain in plaintext on disk."
      );
      return;
    }

    let dirty = false;
    for (const key of SENSITIVE_KEYS) {
      const raw = this.data[key as keyof SettingsSchema];
      if (typeof raw !== "string" || !raw) continue;
      if (raw.startsWith(ENC_PREFIX)) continue;
      // Legacy plaintext — encrypt in place.
      const encrypted = this.encryptValue(raw);
      if (encrypted !== raw) {
        (this.data as unknown as Record<string, string>)[key] = encrypted;
        dirty = true;
      }
    }
    if (dirty) {
      this.save();
      console.log("[Clicky] Migrated legacy plaintext API keys to encrypted storage.");
    }
  }

  private encryptValue(plaintext: string): string {
    if (!plaintext) return "";
    if (plaintext.startsWith(ENC_PREFIX)) return plaintext; // already encrypted
    if (!safeStorage.isEncryptionAvailable()) return plaintext;
    try {
      const buf = safeStorage.encryptString(plaintext);
      return ENC_PREFIX + buf.toString("base64");
    } catch (err) {
      console.warn("[Clicky] safeStorage.encryptString failed:", err);
      return plaintext;
    }
  }

  private decryptValue(stored: string): string {
    if (!stored) return "";
    if (!stored.startsWith(ENC_PREFIX)) return stored; // legacy plaintext
    if (!safeStorage.isEncryptionAvailable()) return "";
    try {
      const b64 = stored.slice(ENC_PREFIX.length);
      return safeStorage.decryptString(Buffer.from(b64, "base64"));
    } catch (err) {
      // Common cause: settings.json copied from a different Windows account.
      console.warn(
        "[Clicky] safeStorage.decryptString failed (key won't be usable):",
        err
      );
      return "";
    }
  }

  private maskKey(plaintext: string): string {
    if (!plaintext) return "";
    const last4 = plaintext.length >= 4 ? plaintext.slice(-4) : plaintext;
    return MASK_PREFIX + last4;
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch {
      // Silent fail on write error
    }
  }
}
