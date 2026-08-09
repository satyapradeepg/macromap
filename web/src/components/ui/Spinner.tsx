// `currentColor` -- inherits whatever text color the caller already has
// (e.g. white inside a primary Button, muted inside a plain-text link), so
// it matches without a separate color prop. motion-reduce freezes it to a
// static ring+arc rather than removing it outright, so "in progress" is
// still conveyed visually, not solely through motion.
export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin motion-reduce:animate-none ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M12 2a10 10 0 0 1 10 10h-4a6 6 0 0 0-6-6V2z" />
    </svg>
  );
}
