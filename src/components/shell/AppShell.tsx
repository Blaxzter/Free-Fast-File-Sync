import { Outlet } from "@tanstack/react-router";
import { useStore } from "../../app/store";
import { Sidebar } from "./Sidebar";
import { StatusStrip } from "./StatusStrip";
import s from "./shell.module.css";
import { TopBar } from "./TopBar";

/** Persistent 3-zone shell: sidebar + (topbar / routed content / status strip). */
export function AppShell() {
  const collapsed = useStore((st) => st.sidebarCollapsed);
  return (
    <div className={[s.shell, collapsed ? s.shellCollapsed : ""].filter(Boolean).join(" ")}>
      <Sidebar />
      <div className={s.main}>
        <TopBar />
        <div className={s.content}>
          <Outlet />
        </div>
        <StatusStrip />
      </div>
    </div>
  );
}
