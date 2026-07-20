/**
 * Minimal, dependency-free Slack Web API client for Cloudflare Workers.
 *
 * Uses the global `fetch` (available in the Workers runtime) and form-encoded
 * requests with a Bearer token — the form Slack accepts uniformly across both
 * its read ("GET-style") and write methods.
 */

export interface SlackTokens {
  /** Bot token (xoxb-...). Used for the vast majority of calls. */
  botToken: string;
  /**
   * Optional user token (xoxp-...). Required only for methods that bots
   * cannot perform, most notably `search.messages`.
   */
  userToken?: string;
}

export class SlackError extends Error {
  constructor(
    public readonly slackError: string,
    public readonly method: string,
    public readonly response?: unknown,
  ) {
    super(`Slack API error from ${method}: ${slackError}`);
    this.name = "SlackError";
  }
}

type ParamValue = string | number | boolean | undefined | null;

export class SlackClient {
  private readonly botToken: string;
  private readonly userToken?: string;
  private static readonly BASE = "https://slack.com/api";

  /** Cache of channel-name -> channel-id, filled lazily from conversations.list. */
  private channelNameCache: Map<string, string> | null = null;

  constructor(tokens: SlackTokens) {
    this.botToken = tokens.botToken;
    this.userToken = tokens.userToken;
  }

  private async call<T = any>(
    method: string,
    params: Record<string, ParamValue> = {},
    opts: { useUserToken?: boolean } = {},
  ): Promise<T & { ok: true }> {
    const token = opts.useUserToken ? this.userToken : this.botToken;
    if (!token) {
      throw new SlackError(
        opts.useUserToken
          ? "missing_user_token (set SLACK_USER_TOKEN for this operation)"
          : "missing_bot_token (set SLACK_BOT_TOKEN)",
        method,
      );
    }

    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        body.set(key, String(value));
      }
    }

    const res = await fetch(`${SlackClient.BASE}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body,
    });

    let json: any;
    try {
      json = await res.json();
    } catch {
      throw new SlackError(`http_${res.status}_non_json_response`, method);
    }

    if (!json.ok) {
      throw new SlackError(json.error || `http_${res.status}`, method, json);
    }
    return json;
  }

  /** Confirm the token works and return the bot/user identity. */
  authTest() {
    return this.call<{
      url: string;
      team: string;
      user: string;
      team_id: string;
      user_id: string;
      bot_id?: string;
    }>("auth.test");
  }

  /**
   * List channels the app can see. `types` defaults to public + private
   * channels; pass "public_channel,private_channel,mpim,im" to widen.
   */
  listChannels(args: {
    types?: string;
    limit?: number;
    cursor?: string;
    exclude_archived?: boolean;
  } = {}) {
    return this.call<{
      channels: SlackChannel[];
      response_metadata?: { next_cursor?: string };
    }>("conversations.list", {
      types: args.types ?? "public_channel,private_channel",
      limit: args.limit ?? 200,
      cursor: args.cursor,
      exclude_archived: args.exclude_archived ?? true,
    });
  }

  /** Read recent messages from a channel. */
  channelHistory(args: {
    channel: string;
    limit?: number;
    cursor?: string;
    oldest?: string;
    latest?: string;
  }) {
    return this.call<{
      messages: SlackMessage[];
      has_more: boolean;
      response_metadata?: { next_cursor?: string };
    }>("conversations.history", {
      channel: args.channel,
      limit: args.limit ?? 50,
      cursor: args.cursor,
      oldest: args.oldest,
      latest: args.latest,
    });
  }

  /** Read a thread (parent + replies) given the parent message ts. */
  threadReplies(args: { channel: string; ts: string; limit?: number; cursor?: string }) {
    return this.call<{
      messages: SlackMessage[];
      has_more: boolean;
      response_metadata?: { next_cursor?: string };
    }>("conversations.replies", {
      channel: args.channel,
      ts: args.ts,
      limit: args.limit ?? 100,
      cursor: args.cursor,
    });
  }

  /** Post a message. `blocks` is JSON-stringified when present. */
  postMessage(args: {
    channel: string;
    text: string;
    thread_ts?: string;
    blocks?: unknown;
    reply_broadcast?: boolean;
    unfurl_links?: boolean;
  }) {
    return this.call<{ channel: string; ts: string; message: SlackMessage }>(
      "chat.postMessage",
      {
        channel: args.channel,
        text: args.text,
        thread_ts: args.thread_ts,
        blocks: args.blocks ? JSON.stringify(args.blocks) : undefined,
        reply_broadcast: args.reply_broadcast,
        unfurl_links: args.unfurl_links,
      },
    );
  }

  /** Add an emoji reaction to a message. */
  addReaction(args: { channel: string; timestamp: string; name: string }) {
    return this.call("reactions.add", {
      channel: args.channel,
      timestamp: args.timestamp,
      name: args.name.replace(/:/g, ""),
    });
  }

  /** List workspace users. */
  listUsers(args: { limit?: number; cursor?: string } = {}) {
    return this.call<{
      members: SlackUser[];
      response_metadata?: { next_cursor?: string };
    }>("users.list", { limit: args.limit ?? 200, cursor: args.cursor });
  }

  /** Look up a single user by ID. */
  userInfo(args: { user: string }) {
    return this.call<{ user: SlackUser }>("users.info", { user: args.user });
  }

  /**
   * Full-text search across messages. Requires a user token (xoxp-) with the
   * `search:read` scope — bot tokens cannot call search.messages.
   */
  searchMessages(args: { query: string; count?: number; page?: number }) {
    return this.call<{
      messages: {
        total: number;
        matches: SlackSearchMatch[];
      };
    }>(
      "search.messages",
      { query: args.query, count: args.count ?? 20, page: args.page ?? 1 },
      { useUserToken: true },
    );
  }

  /**
   * Resolve a "#channel-name" (or bare "channel-name") to a channel ID.
   * IDs (C…, G…, D…) are returned as-is. Results are cached per client
   * instance to avoid re-listing on every send.
   */
  async resolveChannel(channel: string): Promise<string> {
    const trimmed = channel.trim();
    // Already an ID (channel, group/private, or DM).
    if (/^[CGD][A-Z0-9]{6,}$/.test(trimmed)) return trimmed;

    const name = trimmed.replace(/^#/, "").toLowerCase();

    if (!this.channelNameCache) {
      this.channelNameCache = new Map();
      let cursor: string | undefined;
      do {
        const res = await this.listChannels({
          types: "public_channel,private_channel",
          limit: 1000,
          cursor,
          exclude_archived: false,
        });
        for (const c of res.channels) {
          if (c.name) this.channelNameCache.set(c.name.toLowerCase(), c.id);
        }
        cursor = res.response_metadata?.next_cursor || undefined;
      } while (cursor);
    }

    const id = this.channelNameCache.get(name);
    if (!id) {
      throw new SlackError(
        `channel_not_found (no channel named "${channel}" is visible to this app — invite the bot to it, or pass a channel ID)`,
        "resolveChannel",
      );
    }
    return id;
  }
}

export interface SlackChannel {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  num_members?: number;
  topic?: { value: string };
  purpose?: { value: string };
}

export interface SlackMessage {
  type: string;
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: { name: string; count: number; users: string[] }[];
}

export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
    email?: string;
    title?: string;
    status_text?: string;
  };
}

export interface SlackSearchMatch {
  type: string;
  ts: string;
  text: string;
  user?: string;
  username?: string;
  channel?: { id: string; name?: string };
  permalink?: string;
}
