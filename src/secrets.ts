import type { PluginContext, SettingField } from "emdash";

// Declares every setting to core so `type: "secret"` fields are encrypted at rest
// (AES-GCM, EMDASH_ENCRYPTION_KEY). Built from DEFAULT_SETTINGS + SECRET_KEYS so
// the schema can never drift from the custom Settings page's field list; the
// custom page stays the only UI (core skips the auto-form when one exists).
export function buildSettingsSchema(
  defaults: object,
  secretKeys: readonly string[],
): Record<string, SettingField> {
  const schema: Record<string, SettingField> = {};
  for (const [key, def] of Object.entries(defaults)) {
    const label = key;
    schema[key] = secretKeys.includes(key)
      ? { type: "secret", label }
      : typeof def === "boolean"
        ? { type: "boolean", label }
        : typeof def === "number"
          ? { type: "number", label }
          : { type: "string", label };
  }
  return schema;
}

const MIGRATED_FLAG = "state:secrets-encrypted-v1";
let migrationFailedThisIsolate = false;

// Secrets saved before the schema existed are plaintext in the options table and
// stay readable; re-saving through the `settings:` KV alias writes them as
// encrypted envelopes. Runs once (flag in KV); a failure (e.g. no
// EMDASH_ENCRYPTION_KEY yet) is retried on the next isolate, never thrown.
export async function ensureSecretsEncrypted(ctx: PluginContext, secretKeys: readonly string[]): Promise<void> {
  if (migrationFailedThisIsolate) return;
  try {
    if (await ctx.kv.get(MIGRATED_FLAG)) return;
    for (const key of secretKeys) {
      const value = await ctx.kv.get<unknown>(`settings:${key}`);
      if (typeof value === "string" && value) await ctx.kv.set(`settings:${key}`, value);
    }
    await ctx.kv.set(MIGRATED_FLAG, true);
  } catch (err) {
    migrationFailedThisIsolate = true;
    console.warn(`[secrets] could not encrypt stored secrets yet: ${err}`);
  }
}
