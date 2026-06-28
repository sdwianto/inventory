/** Loose document / row types for gradual strict migration. */
export type JsonObject = Record<string, unknown>;
export type JsonArray = unknown[];

export function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value);
}

export function num(value: unknown, fallback = 0): number {
  const n = parseFloat(String(value));
  return Number.isFinite(n) ? n : fallback;
}
