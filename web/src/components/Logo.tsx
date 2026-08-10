export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`font-display text-lg font-bold tracking-tight ${className}`}>
      Macro<span className="text-accent">Map</span>
    </span>
  );
}
