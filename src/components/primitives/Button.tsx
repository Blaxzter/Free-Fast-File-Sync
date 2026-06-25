import type { ButtonHTMLAttributes, ReactNode } from "react";
import s from "./primitives.module.css";

type Variant = "secondary" | "primary" | "go" | "danger" | "ghost" | "icon";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  small?: boolean;
  icon?: ReactNode;
}

const VARIANT_CLASS: Record<Variant, string> = {
  secondary: s.secondary,
  primary: s.primary,
  go: s.go,
  danger: s.danger,
  ghost: s.ghost,
  icon: s.iconBtn,
};

export function Button({
  variant = "secondary",
  small,
  icon,
  children,
  className,
  ...rest
}: Props) {
  const base = variant === "icon" ? s.iconBtn : `${s.btn} ${VARIANT_CLASS[variant]}`;
  const cls = [base, small ? s.small : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <button className={cls} {...rest}>
      {icon}
      {children}
    </button>
  );
}
