import { useRouterState } from "@tanstack/react-router";
import { RefreshCw, Search } from "lucide-react";
import { useStore } from "../../app/store";
import { Button } from "../primitives/Button";
import s from "./shell.module.css";

/** Breadcrumb derived from the path. Keeps the shell sparse. */
function useBreadcrumb(): { section: string; current?: string } {
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  const parts = pathname.split("/").filter(Boolean);
  const section = parts[0] ? parts[0][0]!.toUpperCase() + parts[0].slice(1) : "Jobs";
  const current = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return current ? { section, current } : { section };
}

export function TopBar() {
  const { section, current } = useBreadcrumb();
  const setPaletteOpen = useStore((st) => st.setCommandPaletteOpen);

  return (
    <header className={s.topbar}>
      <div className={s.crumb}>
        <span className={s.crumbMuted}>{section}</span>
        {current && (
          <>
            <span className={s.crumbMuted}>/</span>
            <span className={s.crumbCurrent}>{current}</span>
          </>
        )}
      </div>

      <span className={s.topbarGrow} />

      {/* Sync-All stub */}
      <Button
        variant="secondary"
        small
        icon={<RefreshCw size={14} />}
        title="Sync all jobs (coming soon)"
        disabled
      >
        Sync All
      </Button>

      {/* Cmd-K stub */}
      <button
        className={s.cmdk}
        onClick={() => setPaletteOpen(true)}
        title="Command palette (coming soon)"
      >
        <Search size={13} />
        <span>Search jobs, paths…</span>
        <span className={s.kbd}>⌘K</span>
      </button>
    </header>
  );
}
