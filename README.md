# Slack Agent MCP — Cloudflare Worker

A **generic AI-agent MCP server for Slack**, deployable to a Cloudflare Worker. Connect
any MCP-capable agent — [Poke](https://poke.com), Claude, Cursor, or your own — and give
it the ability to **read** and **send** Slack messages, plus search, react, and look up
users.

It exposes the same kind of experience as the Claude Slack app / Slack MCP, but as a
self-hosted, agent-agnostic endpoint you own.

## Tools

| Tool | What it does |
| --- | --- |
| `slack_whoami` | Verify the connection; return the authenticated identity + team |
| `slack_list_channels` | List channels the app can see (public + private it's in) |
| `slack_read_channel` | Read recent messages from a channel (by ID or `#name`) |
| `slack_read_thread` | Read a full thread (parent + replies) |
| `slack_send_message` | Send a message or thread reply to a channel/DM |
| `slack_add_reaction` | Add an emoji reaction to a message |
| `slack_list_users` | List workspace members with IDs and titles |
| `slack_get_user_profile` | Get one user's profile by ID |
| `slack_search_messages` | Full-text search (needs a user token, see below) |

## How it works

- Built on Cloudflare's [`agents`](https://developers.cloudflare.com/agents/) SDK
  (`McpAgent`) + the official MCP TypeScript SDK.
- Exposes **two transports** so nearly any client works:
  - `/mcp` — **Streamable HTTP** (modern, recommended)
  - `/sse` — legacy Server-Sent Events
- State (a cached Slack client + channel-name lookup table) lives in a Durable Object.
- Optional bearer-token auth gates both endpoints.

## Setup

### 1. Create the Slack app

Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**, paste
[`slack-app-manifest.yaml`](./slack-app-manifest.yaml), and install it to your workspace.

Then:

- Copy the **Bot User OAuth Token** (`xoxb-...`) → this is `SLACK_BOT_TOKEN`.
- Invite the bot to any channel you want it to read/post in: `/invite @agent-mcp`.
- (Optional) For `slack_search_messages`, uncomment the `user` scope in the manifest,
  reinstall, and copy the **User OAuth Token** (`xoxp-...`) → `SLACK_USER_TOKEN`.

### 2. Install & configure

```bash
npm install

# Production secrets:
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put MCP_AUTH_TOKEN      # a long random string; the key agents present
npx wrangler secret put SLACK_USER_TOKEN    # optional, only for search
```

For local development, copy `.dev.vars.example` → `.dev.vars` and fill it in, then:

```bash
npm run dev        # http://localhost:8787
```

### 3. Deploy

```bash
npm run deploy
```

Your server is now at `https://slack-mcp-cf-worker.<your-subdomain>.workers.dev`.

Sanity-check it:

```bash
curl https://<your-worker-url>/health
```

## Connecting an agent

Give the agent the endpoint URL and, if you set `MCP_AUTH_TOKEN`, the token.

### Poke

Settings → Integrations → **Add Custom MCP Server**, or via CLI:

```bash
npx poke@latest mcp add https://<your-worker-url>/mcp -n "Slack" -k "<MCP_AUTH_TOKEN>"
```

Poke sends the key as `Authorization: Bearer <token>` on every request, which this server
validates.

### Claude / Cursor / other MCP clients

Point the client at `https://<your-worker-url>/mcp` (Streamable HTTP) or `/sse` (legacy).
If a client can't set an `Authorization` header, this server also accepts the token via an
`x-api-key` header or a `?token=<token>` query parameter.

## Authentication

- If `MCP_AUTH_TOKEN` is **set**, every `/mcp` and `/sse` request must present it
  (`Authorization: Bearer …`, `x-api-key: …`, or `?token=…`). Requests without a valid
  token get `401`.
- If it's **unset**, the endpoints are open — only do that behind other network controls.
- `/` and `/health` are always public and never expose secrets.

## Environment / secrets

| Name | Required | Purpose |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | Bot token (`xoxb-...`) for read/send/react/users |
| `SLACK_USER_TOKEN` | no | User token (`xoxp-...`); only for `slack_search_messages` |
| `MCP_AUTH_TOKEN` | recommended | Shared secret agents must present |

## Local project layout

```
src/
  index.ts   Worker entry: routing, auth, health, landing page
  mcp.ts     McpAgent + all Slack tool definitions
  slack.ts   Dependency-free Slack Web API client
slack-app-manifest.yaml   One-click Slack app definition
wrangler.toml             Worker + Durable Object config
```

## Notes & limits

- The bot can only read/post in channels it has been **invited** to (Slack's model).
- `slack_search_messages` needs a **user** token — bot tokens can't call `search.messages`.
- This is a self-hosted bridge; you are responsible for who you share the URL/token with.
