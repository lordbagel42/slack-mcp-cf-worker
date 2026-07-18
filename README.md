# Slack MCP Cloudflare Worker

A bridge that exposes Slack functionality as a Model Context Protocol (MCP) server running on Cloudflare Workers.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Deploy to Cloudflare:
   ```bash
   npx wrangler deploy
   ```

3. To test locally:
   ```bash
   npx wrangler dev
   ```

## Usage

Once deployed, the MCP server will be available at your worker's URL. You can connect to it using an MCP client by providing the SSE endpoint:
`https://your-worker.your-subdomain.workers.dev/sse`

## Features

- **SSE Transport**: Uses Server-Sent Events for MCP communication.
- **Durable Objects**: Maintains state using Cloudflare Durable Objects.
- **Slack Tools**: Example tools for sending messages and listing channels.
