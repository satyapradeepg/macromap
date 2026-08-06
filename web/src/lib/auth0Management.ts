// Auth0 Management API access -- only for deleting a user's identity as the
// final step of account deletion (/account's delete-account action). Needs
// the app's Auth0 Application authorized as a Machine-to-Machine client for
// the "Auth0 Management API" with the delete:users scope (Auth0 dashboard:
// APIs > Auth0 Management API > Machine to Machine Applications). Not
// required for anything else in this app -- login/logout/session all go
// through the regular OIDC flow (lib/auth0.ts), not this API.

async function getManagementApiToken(): Promise<string> {
  const domain = process.env.AUTH0_DOMAIN!;
  const res = await fetch(`https://${domain}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: process.env.AUTH0_CLIENT_ID,
      client_secret: process.env.AUTH0_CLIENT_SECRET,
      audience: `https://${domain}/api/v2/`,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Failed to get an Auth0 Management API token (${res.status}) -- check that this Application is authorized as a Machine-to-Machine client for the Auth0 Management API with the delete:users scope.`,
    );
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// Idempotent-ish: a 404 (already deleted) is treated as success, since
// deleteAccount's action deletes app data first and may be retried after a
// partial failure.
export async function deleteAuth0User(userId: string): Promise<void> {
  const token = await getManagementApiToken();
  const domain = process.env.AUTH0_DOMAIN!;

  const res = await fetch(`https://${domain}/api/v2/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to delete Auth0 user (${res.status}).`);
  }
}
