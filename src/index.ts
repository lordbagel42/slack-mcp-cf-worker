import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Durable Object based Slack MCP Bridge
 * This acts as a bridge between Slack and an MCP client (like Claude Desktop or Poke)
 * running on Cloudflare Workers using Durable Objects for state and SSE for transport.
 */
export class SlackMcpBridge {
  state: DurableObjectState;
  server: Server;

  constructor(state: DurableObjectState) {
    this.state = state;
    
    this.server = new Server(
      {
        name: "slack-mcp-bridge",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "send_message",
          description: "Send a message to a Slack channel",
          inputSchema: {
            type: "object",
            properties: {
              channel: { type: "string", description: "Channel ID or name" },
              text: { type: "string", description: "Message text" },
            },
            required: ["channel", "text"],
          },
        },
        {
          name: "list_channels",
          description: "List available Slack channels",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case "send_message": {
          const { channel, text } = request.params.arguments as { channel: string, text: string };
          // Logic to call Slack API would go here
          return {
            content: [{ type: "text", text: `Message sent to ${channel}: ${text}` }],
          };
        }
        case "list_channels": {
          return {
            content: [{ type: "text", text: "Channels: #general, #random, #dev" }],
          };
        }
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }
    });
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/sse") {
      const transport = new SSEServerTransport("/messages", request.clone());
      await this.server.connect(transport);
      return transport.handleRequest(request);
    }
    
    if (url.pathname === "/messages") {
      // Handle messages from the transport
      return new Response("OK");
    }

    return new Response("Slack MCP Bridge DO", { status: 200 });
  }
}

export default {
  async fetch(request: Request, env: any) {
    const id = env.SLACK_BRIDGE.idFromName("global");
    const stub = env.SLACK_BRIDGE.get(id);
    return stub.fetch(request);
  },
};
