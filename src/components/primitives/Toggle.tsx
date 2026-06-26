import * as Switch from "@radix-ui/react-switch";
import { useId } from "react";
import s from "./primitives.module.css";

interface Props {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}

/** Switch control. Radix owns the behavior (role="switch", aria-checked,
 * keyboard, focus, disabled); the look comes from our tokens via the
 * `[data-state]` selectors in primitives.module.css (no Tailwind). */
export function Toggle({ label, checked, onChange, disabled }: Props) {
  const id = useId();
  return (
    <div className={s.toggle}>
      <Switch.Root
        id={id}
        className={s.toggleTrack}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      >
        <Switch.Thumb className={s.toggleKnob} />
      </Switch.Root>
      <label htmlFor={id} className={s.toggleLabel}>
        {label}
      </label>
    </div>
  );
}
