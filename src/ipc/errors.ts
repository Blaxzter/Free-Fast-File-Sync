/* SyncError shape + errorMessage(), ported from the throwaway src/api.ts.
 * A SyncError serializes as { kind, detail }. */

export interface SyncError {
  kind: string;
  detail?: unknown;
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "kind" in e) {
    const se = e as SyncError;
    const detail =
      typeof se.detail === "string" ? se.detail : se.detail ? JSON.stringify(se.detail) : "";
    return detail ? `${se.kind}: ${detail}` : se.kind;
  }
  return String(e);
}
