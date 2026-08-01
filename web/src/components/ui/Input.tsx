import type { InputHTMLAttributes } from "react";

type InputSize = "md" | "sm";

const SIZE_CLASSES: Record<InputSize, string> = {
  md: "px-3 py-2 text-sm",
  sm: "px-3 py-1.5 text-sm",
};

export function Input({
  size = "md",
  className = "",
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { size?: InputSize }) {
  return (
    <input
      className={`w-full rounded-lg border border-border bg-surface text-foreground placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/30 focus:outline-none ${SIZE_CLASSES[size]} ${className}`}
      {...props}
    />
  );
}
