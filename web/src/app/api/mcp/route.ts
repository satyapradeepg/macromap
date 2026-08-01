import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { listTestPersonas } from "@/lib/mcpOps/listTestPersonas";
import { getPersonaPlan } from "@/lib/mcpOps/getPersonaPlan";
import { checkSpoonacularQuota } from "@/lib/mcpOps/checkSpoonacularQuota";

// Private ops route — read-only Supabase admin tools for debugging (list test
// personas, inspect a persona's generated plan, check Spoonacular quota).
// Deliberately does NOT expose persona deletion (irreversible; keep that on
// the existing /profiles UI or the Supabase dashboard, not an agent-callable
// tool). Gated by OPS_MCP_TOKEN — unset by default, so every call 401s until
// that's deliberately configured.

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown) {
  return {
    content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
    isError: true as const,
  };
}

const rawHandler = createMcpHandler(
  (server) => {
    server.registerTool(
      "list_test_personas",
      {
        title: "List test personas",
        description:
          "List all test personas in the live Supabase project (label, persona_user_id, created_at, last_used_at).",
        inputSchema: z.object({}),
      },
      async () => {
        try {
          return textResult(await listTestPersonas());
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "get_persona_plan",
      {
        title: "Get persona plan",
        description:
          "Fetch a test persona's most recent generated meal plan (targets/actuals/reconciliation status) plus its meal slots, by persona label.",
        inputSchema: z.object({
          label: z.string().describe('The test persona\'s label, e.g. "user1".'),
        }),
      },
      async ({ label }) => {
        try {
          return textResult(await getPersonaPlan(label));
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "check_spoonacular_quota",
      {
        title: "Check Spoonacular quota",
        description:
          "Check a Spoonacular API key's remaining daily quota via a cheap 1-point ingredient-search call. Defaults to the SPOONACULAR_API_KEY env var if no key is given.",
        inputSchema: z.object({
          apiKey: z
            .string()
            .optional()
            .describe("Spoonacular API key to check. Defaults to SPOONACULAR_API_KEY."),
        }),
      },
      async ({ apiKey }) => {
        try {
          return textResult(await checkSpoonacularQuota(apiKey));
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  },
  { serverInfo: { name: "macromap-ops", version: "0.1.0" } },
);

function verifyToken(_req: Request, bearerToken?: string) {
  const expected = process.env.OPS_MCP_TOKEN;
  if (!expected || !bearerToken || bearerToken !== expected) return undefined;
  return { token: bearerToken, clientId: "macromap-ops-caller", scopes: [] };
}

const handler = withMcpAuth(rawHandler, verifyToken, { required: true });

export { handler as GET, handler as POST };
