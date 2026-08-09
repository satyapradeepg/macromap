import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Spinner } from "./Spinner";

type ButtonVariant = "primary" | "secondary" | "destructive" | "ghost";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "border border-accent bg-accent text-white hover:bg-accent-2",
  secondary: "border border-border bg-surface text-foreground hover:bg-background",
  destructive: "border border-red-600/40 text-red-600 hover:bg-red-600/10",
  ghost: "border border-transparent text-muted hover:text-foreground",
};

// `loading`/`loadingText` centralize the "Verb…ing" ternary every call site
// used to hand-roll (see git history 2026-08-08 UI pass) -- callers now
// just pass the resting-state label as children and a loading label here,
// and get a spinner + disabled-while-loading for free.
export function Button({
  variant = "secondary",
  type = "button",
  className = "",
  loading = false,
  loadingText,
  disabled,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
  loadingText?: ReactNode;
}) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    >
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {loading ? (loadingText ?? children) : children}
    </button>
  );
}
