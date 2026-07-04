/* One pair's collapsible compare section inside JobDetail (S9).
 *
 * Header: rootA <-> rootB, the engine-axis ModeBadge + deletion badge (colored
 * ONLY from meaning.ts), change/conflict counts, and the per-pair baseline
 * badge. Body: the EXISTING components/plan PlanGrid (reused unchanged, colored
 * from meaning.ts) plus the per-pair BigDeleteGate.
 *
 * The per-row pair id comes from the PreviewJobResult wrapper (this component's
 * `pairId` prop), never from a field on PlanItem. */

import { rootTail } from "../../domain/job";
import { DELETION_MEANING } from "../../domain/meaning";
import { visibleItems } from "../../domain/plan";
import type { PairPreview, Resolution, SyncMode } from "../../ipc/bindings";
import { ModeBadge } from "../job/ModeBadge";
import { BaselineBadge } from "../plan/BaselineBadge";
import { BigDeleteGate } from "../plan/BigDeleteGate";
import { PlanGrid } from "../plan/PlanGrid";
import { Banner } from "../primitives/Banner";
import s from "./run.module.css";

interface Props {
  pair: PairPreview;
  /** Stable per-pair id from the run wrapper (PreviewJobResult.pairs[].pair_id). */
  pairId: string;
  /** Optional human label for the pair (from the Job's FolderPair). */
  label?: string;
  /** Engine-axis mode for this pair (from the resolved Job; header badge only). */
  mode?: SyncMode;
  /** Deletion policy discriminant for this pair (header badge only). */
  deletion?: "RecycleBin" | "Permanent";
  collapsed: boolean;
  onToggle: () => void;
  showInSync: boolean;
  resolutions: Record<string, Resolution>;
  onResolve: (path: string, r: Resolution) => void;
  bigDeleteConfirmed: boolean;
  onConfirmBigDelete: (v: boolean) => void;
}

export function PairSection({
  pair,
  pairId,
  label,
  mode,
  deletion,
  collapsed,
  onToggle,
  showInSync,
  resolutions,
  onResolve,
  bigDeleteConfirmed,
  onConfirmBigDelete,
}: Props) {
  const { plan } = pair;
  const items = visibleItems(plan, showInSync);
  const conflicts = plan.summary.conflicts;
  const changes =
    plan.summary.copy_a_to_b +
    plan.summary.copy_b_to_a +
    plan.summary.delete_a +
    plan.summary.delete_b;
  const del = deletion ? DELETION_MEANING[deletion] : undefined;

  return (
    <section className={s.pairSection} data-pair-id={pairId}>
      <header className={s.pairHeader}>
        <button
          type="button"
          className={s.pairToggle}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} pair ${label || pairId}`}
          onClick={onToggle}
        >
          <span className={s.caret} aria-hidden>
            {collapsed ? "▸" : "▾"}
          </span>
          <span className={s.pairRoots} title={`${plan.root_a} ↔ ${plan.root_b}`}>
            <span className={s.rootName}>{rootTail(plan.root_a)}</span>
            <span className={s.rootArrow} aria-hidden>
              ↔
            </span>
            <span className={s.rootName}>{rootTail(plan.root_b)}</span>
          </span>
          {label && <span className={s.pairLabel}>{label}</span>}
        </button>

        <div className={s.pairBadges}>
          {mode && <ModeBadge mode={mode} />}
          {del && (
            <span
              className={s.delBadge}
              style={{ color: `var(${del.fg})`, borderColor: `var(${del.border})` }}
              title={del.label}
            >
              {del.glyph} {del.label}
            </span>
          )}
          <BaselineBadge status={pair.baseline_status} />
          <span className={s.pairCount} data-kind="changes">
            {changes} changes
          </span>
          {conflicts > 0 && (
            <span
              className={s.pairCount}
              data-kind="conflicts"
              style={{ color: "var(--conflict-fg)" }}
            >
              {conflicts} conflicts
            </span>
          )}
        </div>
      </header>

      {!collapsed && (
        <div className={s.pairBody}>
          {/* Suppressed scan errors (permission denied, vanished entries, …) are
              surfaced as non-fatal warnings: the sync continued, these paths were
              skipped. Never blocks Apply. */}
          {plan.warnings.length > 0 && (
            <Banner intent="warn">
              {plan.warnings.length === 1 ? (
                plan.warnings[0]
              ) : (
                <ul style={{ margin: 0, paddingLeft: "var(--sp-4)" }}>
                  {plan.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </Banner>
          )}
          {plan.big_delete && (
            <BigDeleteGate
              warning={plan.big_delete}
              confirmed={bigDeleteConfirmed}
              onConfirm={onConfirmBigDelete}
            />
          )}
          <PlanGrid items={items} resolutions={resolutions} onResolve={onResolve} />
        </div>
      )}
    </section>
  );
}
