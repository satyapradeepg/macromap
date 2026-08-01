import type { ButtonHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary" | "destructive" | "ghost";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "border border-accent bg-accent text-white hover:bg-accent-2",
  secondary: "border border-border bg-surface text-foreground hover:bg-background",
  destructive: "border border-red-600/40 text-red-600 hover:bg-red-600/10",
  ghost: "border border-transparent text-muted hover:text-foreground",
};

export function Button({
  variant = "secondary",
  type = "button",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    />
  );
}
