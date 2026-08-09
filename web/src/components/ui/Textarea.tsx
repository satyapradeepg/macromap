import { forwardRef, type TextareaHTMLAttributes } from "react";

type TextareaSize = "md" | "sm";

const SIZE_CLASSES: Record<TextareaSize, string> = {
  md: "px-3 py-2 text-sm",
  sm: "px-3 py-1.5 text-sm",
};

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "size"> & { size?: TextareaSize }
>(function Textarea({ size = "md", className = "", ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={`w-full rounded-lg border border-border bg-surface text-foreground placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/30 focus:outline-none ${SIZE_CLASSES[size]} ${className}`}
      {...props}
    />
  );
});
