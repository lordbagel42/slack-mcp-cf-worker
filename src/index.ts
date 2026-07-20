import { SlackAgent } from "./mcp.js";

/**
 * Bindings available to the Worker. Set secrets with `wrangler secret put`.
 */
export interface Env {
  /** Durable Object namespace backing the MCP agent. */
  MCP_OBJECT: DurableObjectNamespace;

  /** Slack bot token (xoxb-...). Required. */
  SLACK_BOT_TOKEN: string;

  /** Optional Slack user token (xoxp-...) — needed only for slack_search_messages. */
  SLACK_USER_TOKEN?: string;

  /**
   * Optional shared secret. When set, every request to /mcp and /sse must
   * present it as `Authorization: Bearer <token>` (also accepted via the
   * `x-api-key` header or a `?token=` query param). This is the key you paste
   * into Poke / Claude / any agent when adding the integration.
   */
  MCP_AUTH_TOKEN?: string;
}

// The Durable Object class must be exported from the Worker entrypoint.
export { SlackAgent };

/** Length-safe constant-time-ish string comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Return the presented credential from header or query, if any. */
function presentedToken(request: Request, url: URL): string | null {
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  const apiKey = request.headers.get("x-api-key");
  if (apiKey) return apiKey.trim();
  const q = url.searchParams.get("token");
  if (q) return q.trim();
  return null;
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", message: "Missing or invalid MCP auth token." }),
    { status: 401, headers: { "content-type": "application/json", "www-authenticate": "Bearer" } },
  );
}

const LANDING = `Slack Agent MCP — a generic Model Context Protocol server for Slack.

Connect any MCP-capable agent (Poke, Claude, Cursor, ...) to this Worker:

  Streamable HTTP (recommended):  <this-url>/mcp
  Legacy SSE:                     <this-url>/sse

If this server is protected, send your token as:
  Authorization: Bearer <token>   (or ?token=<token>)

Tools: slack_whoami, slack_list_channels, slack_read_channel, slack_read_thread,
       slack_send_message, slack_add_reaction, slack_list_users,
       slack_get_user_profile, slack_search_messages

See the README for setup and the Slack app manifest.
`;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Public, unauthenticated endpoints.
    if (path === "/" || path === "") {
      return new Response(LANDING, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (path === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "slack-agent-mcp",
          botTokenConfigured: Boolean(env.SLACK_BOT_TOKEN),
          userTokenConfigured: Boolean(env.SLACK_USER_TOKEN),
          authRequired: Boolean(env.MCP_AUTH_TOKEN),
          endpoints: { streamableHttp: "/mcp", sse: "/sse" },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }

    const isMcp = path === "/mcp";
    const isSse = path === "/sse" || path === "/sse/message";

    if (isMcp || isSse) {
      // Enforce the shared secret when configured.
      if (env.MCP_AUTH_TOKEN) {
        const presented = presentedToken(request, url);
        if (!presented || !timingSafeEqual(presented, env.MCP_AUTH_TOKEN)) {
          return unauthorized();
        }
      }
      if (!env.SLACK_BOT_TOKEN) {
        return new Response(
          JSON.stringify({
            error: "server_misconfigured",
            message: "SLACK_BOT_TOKEN is not set. Run: wrangler secret put SLACK_BOT_TOKEN",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      if (isMcp) return SlackAgent.serve("/mcp").fetch(request, env, ctx);
      return SlackAgent.serveSSE("/sse").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
