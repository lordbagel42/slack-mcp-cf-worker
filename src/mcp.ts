import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SlackClient, SlackError, type SlackMessage } from "./slack.js";
import type { Env } from "./index.js";

/**
 * A generic, agent-facing MCP server that exposes Slack reading and sending.
 *
 * Any MCP-capable agent (Poke, Claude Desktop, Cursor, your own) can connect to
 * the deployed Worker and use these tools. State (a cached Slack client with its
 * channel-name lookup table) lives in the Durable Object that backs the agent.
 */
export class SlackAgent extends McpAgent<Env> {
  server = new McpServer({
    name: "slack-agent-mcp",
    version: "1.0.0",
  });

  private _slack: SlackClient | null = null;

  private slack(): SlackClient {
    if (!this._slack) {
      this._slack = new SlackClient({
        botToken: this.env.SLACK_BOT_TOKEN,
        userToken: this.env.SLACK_USER_TOKEN,
      });
    }
    return this._slack;
  }

  /** Wrap a tool body so Slack errors surface cleanly to the calling agent. */
  private async run(fn: () => Promise<string>) {
    try {
      const text = await fn();
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message =
        err instanceof SlackError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }

  async init() {
    const slack = () => this.slack();

    this.server.tool(
      "slack_whoami",
      "Verify the Slack connection and return the identity (bot/user and team) the server is authenticated as. Use this to confirm setup before other calls.",
      {},
      async () =>
        this.run(async () => {
          const r = await slack().authTest();
          return [
            `Connected to Slack workspace "${r.team}" (${r.team_id}).`,
            `Authenticated as ${r.user} (${r.user_id})${r.bot_id ? ` [bot ${r.bot_id}]` : ""}.`,
          ].join("\n");
        }),
    );

    this.server.tool(
      "slack_list_channels",
      "List Slack channels the app can see (public and private it has been added to). Returns names, IDs, and member counts. Use the returned IDs or names with the other tools.",
      {
        types: z
          .string()
          .optional()
          .describe(
            'Comma-separated conversation types. Default "public_channel,private_channel". Add "im,mpim" to include DMs.',
          ),
        limit: z.number().int().min(1).max(1000).optional().describe("Max channels to return (default 200)."),
        cursor: z.string().optional().describe("Pagination cursor from a previous call."),
      },
      async ({ types, limit, cursor }) =>
        this.run(async () => {
          const r = await slack().listChannels({ types, limit, cursor });
          if (!r.channels.length) return "No channels visible to this app.";
          const lines = r.channels.map((c) => {
            const flags = [c.is_private ? "private" : "public", c.is_archived ? "archived" : null]
              .filter(Boolean)
              .join(", ");
            const members = c.num_members != null ? `, ${c.num_members} members` : "";
            const topic = c.topic?.value ? ` — ${c.topic.value}` : "";
            return `#${c.name} (${c.id}) [${flags}${members}]${topic}`;
          });
          const next = r.response_metadata?.next_cursor;
          return lines.join("\n") + (next ? `\n\n(more available — cursor: ${next})` : "");
        }),
    );

    this.server.tool(
      "slack_read_channel",
      "Read recent messages from a Slack channel. Accepts a channel ID (C…/G…) or a #name. Returns messages newest-first with their timestamps (ts) so you can reply in-thread or react.",
      {
        channel: z.string().describe('Channel ID (e.g. C0123ABCD) or name (e.g. "#general").'),
        limit: z.number().int().min(1).max(200).optional().describe("Number of messages (default 50)."),
        cursor: z.string().optional().describe("Pagination cursor for older messages."),
        oldest: z.string().optional().describe("Only messages after this Unix ts."),
        latest: z.string().optional().describe("Only messages before this Unix ts."),
      },
      async ({ channel, limit, cursor, oldest, latest }) =>
        this.run(async () => {
          const id = await slack().resolveChannel(channel);
          const r = await slack().channelHistory({ channel: id, limit, cursor, oldest, latest });
          const names = await this.userNameMap(r.messages);
          if (!r.messages.length) return `No messages in ${channel}.`;
          const body = r.messages.map((m) => formatMessage(m, names)).join("\n");
          const next = r.response_metadata?.next_cursor;
          return (
            `Messages in ${channel} (${id}):\n${body}` +
            (r.has_more && next ? `\n\n(more available — cursor: ${next})` : "")
          );
        }),
    );

    this.server.tool(
      "slack_read_thread",
      "Read a full thread (the parent message and all replies) given the channel and the parent message's timestamp (ts).",
      {
        channel: z.string().describe("Channel ID or #name containing the thread."),
        ts: z.string().describe("Timestamp (ts) of the thread's parent message."),
        limit: z.number().int().min(1).max(200).optional().describe("Max messages (default 100)."),
      },
      async ({ channel, ts, limit }) =>
        this.run(async () => {
          const id = await slack().resolveChannel(channel);
          const r = await slack().threadReplies({ channel: id, ts, limit });
          const names = await this.userNameMap(r.messages);
          if (!r.messages.length) return "Thread not found or empty.";
          return `Thread in ${channel} (parent ${ts}):\n` + r.messages.map((m) => formatMessage(m, names)).join("\n");
        }),
    );

    this.server.tool(
      "slack_send_message",
      "Send a message to a Slack channel or DM. Accepts a channel ID or #name. To reply inside a thread, pass thread_ts (the parent message's ts). Returns the ts of the sent message.",
      {
        channel: z.string().describe('Channel ID or name (e.g. "#general"), or a user/DM ID.'),
        text: z.string().describe("Message text. Supports Slack mrkdwn."),
        thread_ts: z
          .string()
          .optional()
          .describe("If replying in a thread, the parent message's ts."),
        reply_broadcast: z
          .boolean()
          .optional()
          .describe("When replying in a thread, also post to the channel."),
      },
      async ({ channel, text, thread_ts, reply_broadcast }) =>
        this.run(async () => {
          const id = await slack().resolveChannel(channel);
          const r = await slack().postMessage({ channel: id, text, thread_ts, reply_broadcast });
          return `Sent to ${channel} (${r.channel}). Message ts: ${r.ts}`;
        }),
    );

    this.server.tool(
      "slack_add_reaction",
      "Add an emoji reaction to a message, identified by channel and message timestamp (ts).",
      {
        channel: z.string().describe("Channel ID or #name."),
        ts: z.string().describe("Timestamp (ts) of the target message."),
        emoji: z.string().describe('Emoji name without colons, e.g. "thumbsup".'),
      },
      async ({ channel, ts, emoji }) =>
        this.run(async () => {
          const id = await slack().resolveChannel(channel);
          await slack().addReaction({ channel: id, timestamp: ts, name: emoji });
          return `Added :${emoji.replace(/:/g, "")}: to message ${ts} in ${channel}.`;
        }),
    );

    this.server.tool(
      "slack_list_users",
      "List members of the Slack workspace with their IDs, display names, and titles. Useful for resolving who to mention or DM.",
      {
        limit: z.number().int().min(1).max(1000).optional().describe("Max users (default 200)."),
        cursor: z.string().optional().describe("Pagination cursor."),
      },
      async ({ limit, cursor }) =>
        this.run(async () => {
          const r = await slack().listUsers({ limit, cursor });
          const lines = r.members
            .filter((u) => !u.deleted)
            .map((u) => {
              const name = u.profile?.display_name || u.real_name || u.name || u.id;
              const title = u.profile?.title ? ` — ${u.profile.title}` : "";
              const bot = u.is_bot ? " [bot]" : "";
              return `${name} (${u.id})${bot}${title}`;
            });
          const next = r.response_metadata?.next_cursor;
          return lines.join("\n") + (next ? `\n\n(more available — cursor: ${next})` : "");
        }),
    );

    this.server.tool(
      "slack_get_user_profile",
      "Get detailed profile information for a single Slack user by their ID.",
      { user: z.string().describe("User ID, e.g. U0123ABCD.") },
      async ({ user }) =>
        this.run(async () => {
          const { user: u } = await slack().userInfo({ user });
          const p = u.profile || {};
          return [
            `Name: ${p.display_name || u.real_name || u.name || u.id}`,
            `ID: ${u.id}`,
            p.title ? `Title: ${p.title}` : null,
            p.email ? `Email: ${p.email}` : null,
            p.status_text ? `Status: ${p.status_text}` : null,
            u.is_bot ? "This is a bot user." : null,
          ]
            .filter(Boolean)
            .join("\n");
        }),
    );

    this.server.tool(
      "slack_search_messages",
      "Full-text search across Slack messages. Requires a user token (SLACK_USER_TOKEN with search:read); bot tokens cannot search. Supports Slack search operators like in:#channel, from:@user, before:, after:.",
      {
        query: z.string().describe('Search query, e.g. "deploy in:#eng from:@alice".'),
        count: z.number().int().min(1).max(100).optional().describe("Results per page (default 20)."),
        page: z.number().int().min(1).optional().describe("Page number (default 1)."),
      },
      async ({ query, count, page }) =>
        this.run(async () => {
          const r = await slack().searchMessages({ query, count, page });
          const matches = r.messages.matches;
          if (!matches.length) return `No messages found for "${query}".`;
          const lines = matches.map((m) => {
            const who = m.username || m.user || "unknown";
            const where = m.channel?.name ? `#${m.channel.name}` : m.channel?.id || "?";
            const link = m.permalink ? `\n  ${m.permalink}` : "";
            return `[${where}] ${who} (ts ${m.ts}): ${m.text}${link}`;
          });
          return `Found ${r.messages.total} match(es) for "${query}" (showing ${matches.length}):\n${lines.join("\n")}`;
        }),
    );
  }

  /** Build a userId -> display-name map for the users appearing in messages. */
  private async userNameMap(messages: SlackMessage[]): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const m of messages) if (m.user) ids.add(m.user);
    const map = new Map<string, string>();
    await Promise.all(
      [...ids].map(async (id) => {
        try {
          const { user } = await this.slack().userInfo({ user: id });
          map.set(id, user.profile?.display_name || user.real_name || user.name || id);
        } catch {
          map.set(id, id);
        }
      }),
    );
    return map;
  }
}

function formatMessage(m: SlackMessage, names: Map<string, string>): string {
  const who = m.user ? names.get(m.user) || m.user : m.bot_id ? `bot:${m.bot_id}` : "unknown";
  const text = (m.text || "").replace(/\s+$/, "");
  const thread =
    m.reply_count && m.reply_count > 0 ? ` (thread: ${m.reply_count} repl${m.reply_count === 1 ? "y" : "ies"})` : "";
  const reactions = m.reactions?.length
    ? " " + m.reactions.map((r) => `:${r.name}:×${r.count}`).join(" ")
    : "";
  return `- [${m.ts}] ${who}: ${text}${thread}${reactions}`;
}
