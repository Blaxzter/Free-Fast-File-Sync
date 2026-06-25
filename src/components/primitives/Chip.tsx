import s from "./primitives.module.css";

interface Props {
  /** Bold count. */
  n: number;
  label: string;
  /** Optional meaning fg token for the count, e.g. "--copy-fg". */
  color?: string;
}

export function Chip({ n, label, color }: Props) {
  return (
    <span className={s.chip}>
      <b style={color ? { color: `var(${color})` } : undefined}>{n.toLocaleString()}</b> {label}
    </span>
  );
}
