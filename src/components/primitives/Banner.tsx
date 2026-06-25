import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, ShieldAlert } from "lucide-react";
import s from "./primitives.module.css";

export type BannerIntent = "info" | "ok" | "warn" | "danger";

interface Props {
  intent: BannerIntent;
  children: ReactNode;
}

const INTENT: Record<BannerIntent, { token: string; icon: ReactNode }> = {
  info: { token: "--watch-fg", icon: <Info size={15} /> },
  ok: { token: "--ok-fg", icon: <CheckCircle2 size={15} /> },
  warn: { token: "--warn-fg", icon: <AlertTriangle size={15} /> },
  danger: { token: "--danger-fg", icon: <ShieldAlert size={15} /> },
};

export function Banner({ intent, children }: Props) {
  const { token, icon } = INTENT[intent];
  return (
    <div
      className={s.banner}
      style={{ borderLeftColor: `var(${token})`, color: `var(${token})` }}
      role="alert"
    >
      <span className={s.bannerIcon}>{icon}</span>
      <div className={s.bannerBody} style={{ color: "var(--text)" }}>
        {children}
      </div>
    </div>
  );
}
