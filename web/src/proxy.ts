import { NextResponse, type NextRequest } from "next/server";
import { auth0 } from "@/lib/auth0";

// Auth0 is the only gate now (see migration 0034_auth0_identity_swap.sql for
// the RLS side, and the removed HTTP Basic Auth gate this replaces). Only
// the homepage (public marketing page) and the ops MCP route (its own
// separate OPS_MCP_TOKEN bearer gate, checked in that route handler) are
// reachable without a real Auth0 session.
const PUBLIC_PATHS = new Set(["/", "/api/mcp"]);

export async function proxy(request: NextRequest) {
  const authRes = await auth0.middleware(request);

  // /auth/login, /auth/logout, /auth/callback etc. -- let the SDK's own
  // response (which may set/clear session cookies) through untouched.
  if (request.nextUrl.pathname.startsWith("/auth")) {
    return authRes;
  }

  if (PUBLIC_PATHS.has(request.nextUrl.pathname)) {
    return authRes;
  }

  const session = await auth0.getSession(request);
  if (!session) {
    const loginUrl = new URL("/auth/login", request.nextUrl.origin);
    loginUrl.searchParams.set(
      "returnTo",
      request.nextUrl.pathname + request.nextUrl.search,
    );
    return NextResponse.redirect(loginUrl);
  }

  return authRes;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
