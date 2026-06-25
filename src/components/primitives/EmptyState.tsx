import type { ReactNode } from "react";
import s from "./primitives.module.css";

interface Props {
  icon?: ReactNode;
  title: string;
  subline?: ReactNode;
  actions?: ReactNode;
}

export function EmptyState({ icon, title, subline, actions }: Props) {
  return (
    <div className={s.empty}>
      {icon && <div className={s.emptyIcon}>{icon}</div>}
      <div className={s.emptyTitle}>{title}</div>
      {subline && <div className={s.emptySub}>{subline}</div>}
      {actions && <div className={s.emptyActions}>{actions}</div>}
    </div>
  );
}
