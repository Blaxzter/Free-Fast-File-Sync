import s from "./primitives.module.css";

interface Props {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

export function Toggle({ label, checked, onChange }: Props) {
  return (
    <label className={s.toggle}>
      <span className={[s.toggleTrack, checked ? s.toggleOn : ""].filter(Boolean).join(" ")}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className={s.toggleKnob} />
      </span>
      <span>{label}</span>
    </label>
  );
}
