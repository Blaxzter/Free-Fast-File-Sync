import s from "./primitives.module.css";

interface Props {
  /** A meaning fg token name, e.g. "--ok-fg". */
  color: string;
  large?: boolean;
  live?: boolean;
  title?: string;
}

export function StatusDot({ color, large, live, title }: Props) {
  const cls = [s.dot, large ? s.dotLg : "", live ? s.dotLive : ""].filter(Boolean).join(" ");
  return <span className={cls} style={{ background: `var(${color})` }} title={title} />;
}
