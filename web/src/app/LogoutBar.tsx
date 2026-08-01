import Link from "next/link";
import { Logo } from "@/components/Logo";
import { logout } from "./actions";

export function LogoutBar({
  showBackToProfiles = false,
}: {
  showBackToProfiles?: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border px-6 py-3">
      <Link href="/profiles">
        <Logo />
      </Link>
      <div className="flex gap-4">
        {showBackToProfiles && (
          <Link href="/profiles" className="text-sm text-muted hover:underline">
            Back to profiles
          </Link>
        )}
        <form action={logout}>
          <button type="submit" className="text-sm text-muted hover:underline">
            Switch profile
          </button>
        </form>
      </div>
    </div>
  );
}
