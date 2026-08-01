import Link from "next/link";
import { logout } from "./actions";

export function LogoutBar({
  showBackToProfiles = false,
}: {
  showBackToProfiles?: boolean;
}) {
  return (
    <div className="flex justify-end gap-4 px-6 py-3">
      {showBackToProfiles && (
        <Link href="/profiles" className="text-sm text-muted hover:underline">
          Back to profiles
        </Link>
      )}
      <form action={logout}>
        <button
          type="submit"
          className="text-sm text-muted hover:underline"
        >
          Log out
        </button>
      </form>
    </div>
  );
}
