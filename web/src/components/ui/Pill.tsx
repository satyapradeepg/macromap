import type { ButtonHTMLAttributes } from "react";

type PillSize = "md" | "sm";

const SIZE_CLASSES: Record<PillSize, string> = {
  md: "px-3 py-1.5 text-sm",
  sm: "px-3 py-1 text-xs",
};

export function Pill({
  active = false,
  size = "md",
  type = "button",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; size?: PillSize }) {
  return (
    <button
      type={type}
      className={`rounded-full border font-semibold transition-colors ${SIZE_CLASSES[size]} ${
        active
          ? "border-accent bg-accent text-white"
          : "border-border bg-surface text-muted"
      } ${className}`}
      {...props}
    />
  );
}
