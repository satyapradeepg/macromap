import { logout } from "./actions";

export function LogoutBar() {
  return (
    <div className="flex justify-end px-6 py-3">
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
