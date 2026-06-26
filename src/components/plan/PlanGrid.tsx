import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { ACTION_MEANING } from "../../domain/meaning";
import type { PlanItem, Resolution } from "../../domain/plan";
import { actionClass, formatBytes } from "../../domain/plan";
import { ActionBadge } from "./ActionBadge";
import { ChangeGlyph } from "./ChangeGlyph";
import { ConflictTag } from "./ConflictTag";
import s from "./plan.module.css";
import { ResolutionSelect } from "./ResolutionSelect";

interface Props {
  items: PlanItem[];
  resolutions: Record<string, Resolution>;
  onResolve: (path: string, r: Resolution) => void;
}

const ROW_PX = 30;

function splitPath(path: string): { parent: string; base: string } {
  const i = path.lastIndexOf("/");
  if (i < 0) return { parent: "", base: path };
  return { parent: path.slice(0, i + 1), base: path.slice(i + 1) };
}

function dirArrow(it: PlanItem): string {
  switch (it.action) {
    case "CopyAtoB":
      return "→";
    case "CopyBtoA":
      return "←";
    case "Conflict":
      return "⬥";
    case "DeleteA":
    case "DeleteB":
      return "−";
    default:
      return "·";
  }
}

function PlanRow({
  it,
  resolution,
  onResolve,
}: {
  it: PlanItem;
  resolution: Resolution | undefined;
  onResolve: (r: Resolution) => void;
}) {
  const { parent, base } = splitPath(it.path);
  const isConflict = it.action === "Conflict";
  const isDesync = it.conflict === "StateDesync";
  const rowCls = [s.gridRow, isDesync ? s.rowDanger : isConflict ? s.rowConflict : ""]
    .filter(Boolean)
    .join(" ");
  const m = ACTION_MEANING[it.action];

  return (
    <div className={rowCls} data-action={actionClass(it.action)}>
      <input type="checkbox" defaultChecked disabled={isDesync} aria-label="include" />
      <span className={s.cellPath} title={it.note || it.path}>
        <span className={s.pathParent}>{parent}</span>
        <span className={s.pathBase}>{base}</span>
        {isConflict && it.conflict && <ConflictTag type={it.conflict} />}
      </span>
      <div className={s.cellCenter}>
        <ChangeGlyph change={it.a_change} />
      </div>
      <div className={s.cellCenter}>
        <span className={s.dirArrow} style={{ color: `var(${m.fg})` }}>
          {dirArrow(it)}
        </span>
      </div>
      <div className={s.cellCenter}>
        <ChangeGlyph change={it.b_change} />
      </div>
      <div>
        <ActionBadge action={it.action} />
      </div>
      <span className={s.cellSize}>{formatBytes(it.a?.size ?? it.b?.size ?? 0)}</span>
      <div className={s.cellResolve}>
        {isConflict && it.resolution_options.length > 0 && (
          <ResolutionSelect
            options={it.resolution_options}
            value={resolution}
            onChange={onResolve}
          />
        )}
      </div>
    </div>
  );
}

/** Virtualized compare grid. One row per PlanItem. */
export function PlanGrid({ items, resolutions, onResolve }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    overscan: 12,
  });

  return (
    <div className={s.gridWrap}>
      <div className={s.gridHeader}>
        <span />
        <span>path</span>
        <span style={{ textAlign: "center" }}>A</span>
        <span style={{ textAlign: "center" }}>⇄</span>
        <span style={{ textAlign: "center" }}>B</span>
        <span>action</span>
        <span style={{ textAlign: "right" }}>size</span>
        <span>resolve</span>
      </div>
      {items.length === 0 ? (
        <div className={s.gridEmpty}>✓ Everything is in sync.</div>
      ) : (
        <div className={s.gridScroll} ref={scrollRef}>
          <div style={{ height: virt.getTotalSize(), position: "relative" }}>
            {virt.getVirtualItems().map((row) => {
              const it = items[row.index]!;
              return (
                <div
                  key={it.path}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${row.start}px)`,
                  }}
                >
                  <PlanRow
                    it={it}
                    resolution={resolutions[it.path]}
                    onResolve={(r) => onResolve(it.path, r)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
