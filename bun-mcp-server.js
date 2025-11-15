#!/usr/bin/env bun
"use strict";

/**
 * Minimal MCP Streamable HTTP server (single /mcp endpoint) — Bun version.
 * - Uses Bun.serve (no Node http module).
 * - Implements: POST (JSON or SSE) and GET (SSE).
 * - Session header: Mcp-Session-Id (spec).
 * - Tools: echo, sum. Resources: mem://hello.txt
 */

import { randomUUID } from "crypto";

// ---------- Config ----------
const PORT = Number(process.env.PORT || 3333);
const MCP_PATH = "/mcp";
const PROTOCOL_VERSION = "2025-06-18";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:3000";

// ---------- CORS helpers ----------
function makeCorsHeaders(origin) {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
  };
}

function jsonResponse(origin, status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache",
      ...makeCorsHeaders(origin || ALLOWED_ORIGIN),
      ...extra,
    },
  });
}

function textResponse(origin, status, text, extra = {}) {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...makeCorsHeaders(origin || ALLOWED_ORIGIN),
      ...extra,
    },
  });
}

function badRequest(origin, msg) {
  return jsonResponse(origin, 400, {
    jsonrpc: "2.0",
    error: { code: -32600, message: msg },
  });
}

function notAllowed(origin) {
  return textResponse(origin, 405, "Method Not Allowed");
}

// ---------- JSON helpers ----------
function checkJSONRPC(msg) {
  return msg && typeof msg === "object" && msg.jsonrpc === "2.0";
}

// ---------- SSE helpers ----------
function createSSEStream(onStart) {
  const encoder = new TextEncoder();
  let keepTimer = null;

  const stream = new ReadableStream({
    start(controller) {
      const sendData = (obj, id) => {
        let chunk = "";
        if (id !== undefined) chunk += `id: ${id}\n`;
        chunk += `data: ${JSON.stringify(obj)}\n\n`;
        controller.enqueue(encoder.encode(chunk));
      };

      const sendComment = (text) => {
        controller.enqueue(encoder.encode(`: ${text}\n\n`));
      };

      const setKeepAlive = (ms = 15000) => {
        keepTimer = setInterval(() => sendComment("keepalive"), ms);
      };

      onStart({ controller, sendData, sendComment, setKeepAlive });
    },
    cancel() {
      if (keepTimer) clearInterval(keepTimer);
    },
  });

  return stream;
}

// ---------- Server state ----------
/** sessions[sessionId] = { initialized:boolean, cursor:number } */
const sessions = Object.create(null);

// Example “registry” for tools/resources
const tools = {
  echo: {
    name: "echo",
    title: "Echo text",
    description: "Returns the given text.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    run: async (args) => [{ type: "text", text: String(args.text ?? "") }],
  },
  sum: {
    name: "sum",
    title: "Sum numbers",
    description: "Sums an array of numbers.",
    inputSchema: {
      type: "object",
      properties: { values: { type: "array", items: { type: "number" } } },
      required: ["values"],
    },
    run: async (args) => {
      if (!Array.isArray(args.values)) throw new Error("values must be array");
      const total = args.values.reduce((a, b) => a + Number(b || 0), 0);
      return [{ type: "text", text: String(total) }];
    },
  },
};

const resources = [
  {
    uri: "mem://hello.txt",
    name: "hello.txt",
    title: "Hello Text",
    description: "Small in-memory resource",
    mimeType: "text/plain",
    _content: "Hello from a minimal MCP Streamable HTTP server (Bun)!\n",
  },
];

// ---------- MCP method handlers ----------
function initializeResult() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      logging: {},
      prompts: { listChanged: true },
      resources: { subscribe: false, listChanged: true },
      tools: { listChanged: true },
    },
    serverInfo: {
      name: "BareBunMCP-HTTP",
      title: "Bare Bun MCP (HTTP)",
      version: "0.2.0",
    },
    instructions:
      "Use tools/list, tools/call, resources/list, resources/read. Streamable HTTP enabled.",
  };
}

async function routeRequest(session, msg) {
  const { id, method, params } = msg;

  switch (method) {
    // Lifecycle
    case "initialize":
      return { id, result: initializeResult() };

    case "notifications/initialized":
      session.initialized = true;
      return { id: undefined, acceptOnly: true };

    // Tools
    case "tools/list": {
      const arr = Object.values(tools).map(({ run, ...def }) => def);
      return { id, result: { tools: arr, nextCursor: null } };
    }

    case "tools/call": {
      const { name, arguments: args = {} } = params || {};
      const t = tools[name];
      if (!t) {
        return {
          id,
          error: { code: -32601, message: `Unknown tool: ${name}` },
        };
      }
      try {
        const content = await t.run(args);
        return { id, result: { content, isError: false } };
      } catch (e) {
        return {
          id,
          result: {
            content: [{ type: "text", text: String(e.message || e) }],
            isError: true,
          },
        };
      }
    }

    // Resources
    case "resources/list": {
      const list = resources.map(({ _content, ...r }) => r);
      return { id, result: { resources: list, nextCursor: null } };
    }

    case "resources/read": {
      const { uri } = params || {};
      const r = resources.find((x) => x.uri === uri);
      if (!r) {
        return {
          id,
          error: { code: -32602, message: `Unknown resource: ${uri}` },
        };
      }
      const contents = [
        { uri: r.uri, mimeType: r.mimeType, text: r._content },
      ];
      return { id, result: { contents } };
    }

    default:
      return {
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// ---------- Security helpers ----------
function validateOrigin(req) {
  const origin = req.headers.get("origin");
  // Non-browser clients may omit Origin
  if (!origin) return true;

  // Simple dev rule: exact match with ALLOWED_ORIGIN
  if (origin === ALLOWED_ORIGIN) return true;

  // Optional: allow any localhost port during dev
  if (origin.startsWith("http://localhost")) return true;

  return false;
}

// ---------- HTTP server (Bun.serve) ----------
const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",

  async fetch(req) {
    const url = new URL(req.url);
    const origin = req.headers.get("origin") || undefined;

    // Enforce single endpoint
    if (url.pathname !== MCP_PATH) {
      return notAllowed(origin);
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      if (!validateOrigin(req)) {
        return textResponse(origin, 400, "Origin not allowed");
      }
      return new Response(null, {
        status: 204,
        headers: {
          ...makeCorsHeaders(origin || ALLOWED_ORIGIN),
        },
      });
    }

    // GET: open global SSE stream (server → client messages)
    if (req.method === "GET") {
      if (!validateOrigin(req)) return badRequest(origin, "Origin not allowed");

      const accept = String(req.headers.get("accept") || "");
      if (!accept.includes("text/event-stream")) {
        return notAllowed(origin);
      }

      const sessionId = req.headers.get("mcp-session-id");
      if (!sessionId || !sessions[sessionId]) {
        return textResponse(
          origin,
          404,
          "Unknown or missing session",
          makeCorsHeaders(origin || ALLOWED_ORIGIN)
        );
      }

      const session = sessions[sessionId];

      const stream = createSSEStream(({ sendData, setKeepAlive }) => {
        // Example server-initiated notification on connect
        session.cursor++;
        const notif = {
          jsonrpc: "2.0",
          method: "logging/message",
          params: {
            level: "info",
            logger: "mcp",
            message: "SSE stream opened",
          },
        };
        sendData(notif, session.cursor);

        // Keepalive
        setKeepAlive(15000);
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "MCP-Protocol-Version": PROTOCOL_VERSION,
          ...makeCorsHeaders(origin || ALLOWED_ORIGIN),
        },
      });
    }

    // POST: client → server (JSON-RPC or SSE response)
    if (req.method === "POST") {
      if (!validateOrigin(req)) return badRequest(origin, "Origin not allowed");

      const accept = String(req.headers.get("accept") || "");

      let msg;
      try {
        msg = await req.json();
      } catch {
        return badRequest(origin, "Invalid JSON");
      }
      if (!checkJSONRPC(msg)) return badRequest(origin, "Invalid JSON-RPC");

      // Session management per spec
      let sessionId = req.headers.get("mcp-session-id");
      let session = sessionId && sessions[sessionId];

      // initialize: create session
      if (msg.method === "initialize") {
        sessionId = randomUUID();
        session = sessions[sessionId] = {
          initialized: false,
          cursor: 0,
        };

        const out = await routeRequest(session, msg);
        return jsonResponse(
          origin,
          200,
          { jsonrpc: "2.0", id: msg.id, result: out.result },
          {
            "Mcp-Session-Id": sessionId,
            "MCP-Protocol-Version": PROTOCOL_VERSION,
          }
        );
      }

      // After initialize, require valid session
      if (!session) {
        return textResponse(
          origin,
          404,
          "Session not found (initialize first)",
          makeCorsHeaders(origin || ALLOWED_ORIGIN)
        );
      }

      // Notifications (no id) → 202 Accepted
      if (!("id" in msg) || msg.id === null) {
        await routeRequest(session, msg);
        return new Response(null, {
          status: 202,
          headers: {
            ...makeCorsHeaders(origin || ALLOWED_ORIGIN),
          },
        });
      }

      // Requests: JSON or SSE
      const wantsSSE = accept.includes("text/event-stream");

      if (!wantsSSE) {
        const out = await routeRequest(session, msg);
        if (out.error) {
          return jsonResponse(
            origin,
            200,
            { jsonrpc: "2.0", id: msg.id, error: out.error },
            { "MCP-Protocol-Version": PROTOCOL_VERSION }
          );
        }
        return jsonResponse(
          origin,
          200,
          { jsonrpc: "2.0", id: msg.id, result: out.result },
          { "MCP-Protocol-Version": PROTOCOL_VERSION }
        );
      }

      // Streamed tools/list / tools/call / resources/* via SSE
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const sendData = (obj, id) => {
            let chunk = "";
            if (id !== undefined) chunk += `id: ${id}\n`;
            chunk += `data: ${JSON.stringify(obj)}\n\n`;
            controller.enqueue(encoder.encode(chunk));
          };

          // Optional logging/message before final response
          session.cursor++;
          sendData(
            {
              jsonrpc: "2.0",
              method: "logging/message",
              params: {
                level: "info",
                logger: "mcp",
                message: `Handling ${msg.method}`,
              },
            },
            session.cursor
          );

          const out = await routeRequest(session, msg);
          const final =
            out.error != null
              ? { jsonrpc: "2.0", id: msg.id, error: out.error }
              : { jsonrpc: "2.0", id: msg.id, result: out.result };

          session.cursor++;
          sendData(final, session.cursor);
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "MCP-Protocol-Version": PROTOCOL_VERSION,
          ...makeCorsHeaders(origin || ALLOWED_ORIGIN),
        },
      });
    }

    return notAllowed(origin);
  },
});

console.error(
  `[mcp] Bun MCP HTTP server listening on http://${server.hostname}:${server.port}${MCP_PATH}`
);
console.error(
  `[mcp] Restricting to localhost; lock this down further before exposing remotely.`
);
