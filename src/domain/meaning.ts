/* THE single source of truth for enum -> color + label + glyph.
 *
 * INVARIANT: component color comes ONLY from this map, keyed by the exact
 * serde enum string. Never hardcode a meaning hex in a component.
 *
 * Colors are referenced as CSS custom-property names (the `var()` token), so
 * the actual hex stays in tokens.css. A renderer does:
 *   const m = ACTION_MEANING[item.action];
 *   style={{ color: `var(${m.fg})`, background: `var(${m.bg})` }}
 */

import type {
  Action,
  BaselineStatusKind,
  ChangeKind,
  ConflictType,
  DeletionPolicy,
  ItemStatus,
  SyncMode,
} from "../ipc/bindings";

/** A meaning entry: CSS var names + display strings. */
export interface Meaning {
  /** Foreground/icon/dot token, e.g. "--copy-fg". */
  fg: string;
  /** Tinted background token, e.g. "--copy-bg". */
  bg: string;
  /** Saturated border token, e.g. "--copy-border". */
  border: string;
  /** Human label. */
  label: string;
  /** Optional meaning glyph (semantic text, never an icon). */
  glyph?: string;
}

function meaning(name: string, label: string, glyph?: string): Meaning {
  return {
    fg: `--${name}-fg`,
    bg: `--${name}-bg`,
    border: `--${name}-border`,
    label,
    ...(glyph !== undefined ? { glyph } : {}),
  };
}

/** Action -> meaning (resolved action column / badge). */
export const ACTION_MEANING: Record<Action, Meaning> = {
  Noop: meaning("neutral", "in sync", "·"),
  CopyAtoB: meaning("copy", "A → B", "→"),
  CopyBtoA: meaning("copy", "B → A", "←"),
  DeleteA: meaning("del", "del A", "−"),
  DeleteB: meaning("del", "del B", "−"),
  UpdateBaselineOnly: meaning("neutral", "baseline", "·"),
  Conflict: meaning("conflict", "conflict", "⬥"),
};

/** ChangeKind -> meaning (per-side A/B change vs baseline). */
export const CHANGE_MEANING: Record<ChangeKind, Meaning> = {
  Unchanged: meaning("neutral", "—", "·"),
  Created: meaning("ok", "new", "+"),
  Modified: meaning("warn", "mod", "~"),
  Deleted: meaning("del", "del", "−"),
  TypeChanged: meaning("conflict", "type", "⇄"),
};

/** ConflictType -> meaning. StateDesync is DANGER (refuse-to-act), not magenta. */
export const CONFLICT_MEANING: Record<ConflictType, Meaning> = {
  EditEdit: meaning("conflict", "edit/edit", "✎✎"),
  CreateCreate: meaning("conflict", "create/create", "++"),
  ModifyDelete: meaning("conflict", "modify/delete", "✎✕"),
  DeleteTypeChange: meaning("conflict", "delete/type", "✕⇄"),
  ModifyTypeChange: meaning("conflict", "modify/type", "✎⇄"),
  TypeChangeTypeChange: meaning("conflict", "type/type", "⇄⇄"),
  StateDesync: meaning("danger", "desync · refusing", "⚠"),
};

/** BaselineStatusKind -> meaning (job-level trust banner). */
export const BASELINE_MEANING: Record<BaselineStatusKind, Meaning> = {
  Present: meaning("ok", "Baseline loaded · deletions enabled"),
  FirstSync: meaning("watch", "First sync · union only, no deletions"),
  Corrupt: meaning("warn", "Baseline unreadable · safe union fallback"),
};

/** ItemStatus -> meaning (Activity / apply report). */
export const STATUS_MEANING: Record<ItemStatus, Meaning> = {
  Done: meaning("ok", "done"),
  Skipped: meaning("neutral", "skipped"),
  Failed: meaning("danger", "failed"),
  Conflict: meaning("conflict", "conflict"),
};

/** SyncMode -> meaning (mode badge in the job editor / pair header).
 * TwoWay is neutral (no one-way risk), Mirror is warn-tinted (destructive: B
 * becomes a faithful copy of A, B-side extras deleted), Update is copy-blue
 * (additive A→B, never deletes). */
export const MODE_MEANING: Record<SyncMode, Meaning> = {
  TwoWay: meaning("neutral", "two-way", "↔"),
  Mirror: meaning("warn", "mirror", "→"),
  Update: meaning("copy", "update", "→"),
};

/** DeletionPolicy -> meaning, keyed by the serde `kind` discriminant strings. */
export const DELETION_MEANING: Record<DeletionPolicy["kind"], Meaning> = {
  RecycleBin: meaning("ok", "Recycle Bin", "♺"),
  Permanent: meaning("danger", "Permanent", "✕"),
};

/** Human labels for Resolution options (no color of their own). */
export const RESOLUTION_LABEL: Record<string, string> = {
  KeepA: "Keep A",
  KeepB: "Keep B",
  KeepNewer: "Keep newer",
  KeepBoth: "Keep both",
  PropagateDelete: "Apply delete",
  KeepModified: "Keep edited",
  KeepTypeChanged: "Keep replacement",
  Skip: "Skip",
};
