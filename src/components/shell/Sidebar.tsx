import { Link, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  CalendarClock,
  Cloud,
  Eye,
  FolderSync,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from "lucide-react";
import type { ReactNode } from "react";
import { useStore } from "../../app/store";
import { StatusDot } from "../primitives/StatusDot";
import s from "./shell.module.css";

interface NavSection {
  to: string;
  label: string;
  icon: ReactNode;
  badge?: string;
}

const SECTIONS: NavSection[] = [
  { to: "/jobs", label: "Jobs", icon: <FolderSync size={16} /> },
  { to: "/activity", label: "Activity", icon: <Activity size={16} /> },
  { to: "/schedules", label: "Schedules", icon: <CalendarClock size={16} />, badge: "soon" },
  { to: "/watch", label: "Watch", icon: <Eye size={16} />, badge: "soon" },
  { to: "/cloud", label: "Cloud", icon: <Cloud size={16} />, badge: "soon" },
  { to: "/settings", label: "Settings", icon: <Settings size={16} /> },
];

export function Sidebar() {
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const toggle = useStore((s) => s.toggleSidebar);
  const phase = useStore((s) => s.run.phase);
  const pathname = useRouterState({ select: (st) => st.location.pathname });

  const engineLabel =
    phase === "applying" ? "syncing…" : phase === "scanning" ? "scanning…" : "idle";
  const engineColor =
    phase === "idle" ? "--neutral-fg" : phase === "applying" ? "--accent" : "--watch-fg";

  return (
    <aside className={s.sidebar}>
      <div className={s.brand}>
        <span className={s.brandMark}>⇄</span>
        {!collapsed && (
          <div className={s.brandText}>
            <span className={s.brandWord}>fast-file-sync</span>
            <span className={s.brandSub}>.gitignore-aware</span>
          </div>
        )}
      </div>

      <nav className={s.nav}>
        {SECTIONS.map((sec) => {
          const active = pathname === sec.to || pathname.startsWith(sec.to + "/");
          return (
            <Link
              key={sec.to}
              to={sec.to}
              className={[s.navItem, active ? s.navActive : ""].filter(Boolean).join(" ")}
              title={sec.label}
            >
              {sec.icon}
              {!collapsed && <span className={s.navLabel}>{sec.label}</span>}
              {!collapsed && sec.badge && <span className={s.navBadge}>{sec.badge}</span>}
            </Link>
          );
        })}
      </nav>

      <div className={s.sidebarFooter}>
        <span className={s.enginePill}>
          <StatusDot color={engineColor} live={phase !== "idle"} />
          {!collapsed && <span>engine {engineLabel}</span>}
        </span>
        <button className={s.enginePill} onClick={toggle} style={{ cursor: "pointer" }}>
          {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
          {!collapsed && <span>collapse</span>}
        </button>
      </div>
    </aside>
  );
}
