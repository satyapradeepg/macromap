import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Every route except the homepage and the ops MCP route (which has its own
// OPS_MCP_TOKEN bearer-token gate, checked separately in that route) sits
// behind a single, deployment-wide HTTP Basic Auth challenge. This replaced
// a homegrown gate cookie that had to be kept in sync by hand with the
// separate Supabase session cookie used for persona identity -- that
// coordination produced two real bugs in one day (a stale comment-only
// edit that left the old anonymous-bootstrap code running, and a cookie
// scoped to the wrong path that made /onboarding and /plan unreachable
// even when authenticated). Basic Auth has no cookie to scope, clear, or
// keep in sync at all: the browser resends the Authorization header on
// every request itself.
const PUBLIC_PATHS = new Set(["/", "/api/mcp"]);

function hasValidBasicAuth(request: NextRequest): boolean {
  const username = process.env.ACCESS_USERNAME;
  const password = process.env.ACCESS_PASSWORD;
  if (!username || !password) return false;

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return false;

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator === -1) return false;

  return (
    decoded.slice(0, separator) === username &&
    decoded.slice(separator + 1) === password
  );
}

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="MacroMap"' },
  });
}

// Refreshes the Supabase session on every request. No-login guest bootstrap
// (PRD 7.1) is disabled: signInAnonymously() ran on every unauthenticated
// request with no way to distinguish real visitors from platform health
// probes, which kept Supabase's anonymous-auth rate limit permanently
// exhausted (99% of container logs, continuous since 2026-07-26).
export async function updateSession(request: NextRequest) {
  if (
    !PUBLIC_PATHS.has(request.nextUrl.pathname) &&
    !hasValidBasicAuth(request)
  ) {
    return unauthorized();
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  await supabase.auth.getUser();

  return supabaseResponse;
}
