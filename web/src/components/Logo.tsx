export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`text-sm font-extrabold tracking-tight ${className}`}>
      Macro<span className="text-accent">Map</span>
    </span>
  );
}
