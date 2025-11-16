#!/usr/bin/env node
'use strict';

/**
 * Minimal MCP Streamable HTTP server (single /mcp endpoint).
 * Express version (less boilerplate than raw http).
 *
 * - Uses Express for routing + JSON body parsing.
 * - Implements: POST (JSON or SSE) and GET (SSE).
 * - Session header: Mcp-Session-Id (spec).
 * - Tools: echo, sum. Resources: mem://hello.txt
 *
 * SECURITY NOTE:
 * In production, add proper auth (Bearer/OAuth), stricter Origin checks,
 * TLS, and do NOT bind directly to 0.0.0.0 without a reverse proxy.
 */

const express = require('express');
const { randomUUID } = require('crypto');

// ---------- Config ----------
const PORT = process.env.PORT || 3333;
const MCP_PATH = '/mcp';
const PROTOCOL_VERSION = '2025-06-18';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';

// ---------- CORS helpers ----------
function makeCorsHeaders(origin) {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
  };
}

function sendJSON(res, origin, status, body, headers = {}) {
  const cors = makeCorsHeaders(origin || ALLOWED_ORIGIN);
  res
    .status(status)
    .set({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      ...cors,
      ...headers,
    })
    .send(JSON.stringify(body));
}

function notAllowed(res, origin) {
  const cors = makeCorsHeaders(origin || ALLOWED_ORIGIN);
  res
    .status(405)
    .set({
      'Content-Type': 'text/plain; charset=utf-8',
      ...cors,
    })
    .send('Method Not Allowed');
}

function badRequest(res, origin, msg) {
  sendJSON(res, origin, 400, {
    jsonrpc: '2.0',
    error: { code: -32600, message: msg },
  });
}

function textResponse(res, origin, status, text) {
  const cors = makeCorsHeaders(origin || ALLOWED_ORIGIN);
  res
    .status(status)
    .set({
      'Content-Type': 'text/plain; charset=utf-8',
      ...cors,
    })
    .send(text);
}

// ---------- SSE helpers ----------
function openSSE(res, origin, extraHeaders = {}) {
  const cors = makeCorsHeaders(origin || ALLOWED_ORIGIN);
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...cors,
    ...extraHeaders,
  });
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
}

function sseData(res, obj, id = undefined) {
  if (id !== undefined) res.write(`id: ${id}\n`);
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function sseComment(res, text) {
  res.write(`: ${text}\n\n`);
}

// ---------- JSON-RPC helpers ----------
function checkJSONRPC(msg) {
  return msg && typeof msg === 'object' && msg.jsonrpc === '2.0';
}

// ---------- Server state ----------
/** sessions[sessionId] = { initialized:boolean, sseClients:Set<res>, cursor:number } */
const sessions = Object.create(null);

// Example “registry” for tools/resources
const tools = {
  echo: {
    name: 'echo',
    title: 'Echo text',
    description: 'Returns the given text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    run: async (args) => [{ type: 'text', text: String(args.text ?? '') }],
  },
  sum: {
    name: 'sum',
    title: 'Sum numbers',
    description: 'Sums an array of numbers.',
    inputSchema: {
      type: 'object',
      properties: { values: { type: 'array', items: { type: 'number' } } },
      required: ['values'],
    },
    run: async (args) => {
      if (!Array.isArray(args.values)) throw new Error('values must be array');
      const total = args.values.reduce((a, b) => a + Number(b || 0), 0);
      return [{ type: 'text', text: String(total) }];
    },
  },
};

const resources = [
  {
    uri: 'mem://hello.txt',
    name: 'hello.txt',
    title: 'Hello Text',
    description: 'Small in-memory resource',
    mimeType: 'text/plain',
    _content: 'Hello from a minimal MCP Streamable HTTP server!\n',
  },
];

// ---------- MCP method handlers (transport-agnostic) ----------
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
      name: 'BareNodeMCP-HTTP-Express',
      title: 'Bare Node MCP (HTTP, Express)',
      version: '0.2.0',
    },
    instructions:
      'Use tools/list, tools/call, resources/list, resources/read. Streamable HTTP enabled.',
  };
}

async function routeRequest(session, msg) {
  const { id, method, params } = msg;

  switch (method) {
    // Lifecycle
    case 'initialize':
      return { id, result: initializeResult() };

    case 'notifications/initialized':
      session.initialized = true;
      return { id: undefined, acceptOnly: true }; // no response body

    // Tools
    case 'tools/list': {
      const arr = Object.values(tools).map(({ run, ...def }) => def);
      return { id, result: { tools: arr, nextCursor: null } };
    }
    case 'tools/call': {
      const { name, arguments: args = {} } = params || {};
      const t = tools[name];
      if (!t) return { id, error: { code: -32601, message: `Unknown tool: ${name}` } };
      try {
        const content = await t.run(args);
        return { id, result: { content, isError: false } };
      } catch (e) {
        return {
          id,
          result: {
            content: [{ type: 'text', text: String(e.message || e) }],
            isError: true,
          },
        };
      }
    }

    // Resources
    case 'resources/list': {
      const list = resources.map(({ _content, ...r }) => r);
      return { id, result: { resources: list, nextCursor: null } };
    }
    case 'resources/read': {
      const { uri } = params || {};
      const r = resources.find((x) => x.uri === uri);
      if (!r) return { id, error: { code: -32602, message: `Unknown resource: ${uri}` } };
      const contents = [{ uri: r.uri, mimeType: r.mimeType, text: r._content }];
      return { id, result: { contents } };
    }

    default:
      return { id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// ---------- Security helpers ----------
function validateOrigin(origin) {
  // Non-browser clients may omit Origin
  if (!origin) return true;

  // Simple dev rule: exact match with ALLOWED_ORIGIN
  if (origin === ALLOWED_ORIGIN) return true;

  // Optional: allow any localhost port during dev
  if (origin.startsWith('http://localhost')) return true;

  return false;
}

// ---------- Express app setup ----------
const app = express();

// JSON body parser for POST /mcp
app.use(express.json());

// CORS preflight handler for /mcp
app.options(MCP_PATH, (req, res) => {
  const origin = req.get('origin');
  if (!validateOrigin(origin || '')) {
    const headers = makeCorsHeaders(origin || ALLOWED_ORIGIN);
    res
      .status(400)
      .set({
        'Content-Type': 'text/plain; charset=utf-8',
        ...headers,
      })
      .send('Origin not allowed');
    return;
  }

  const headers = makeCorsHeaders(origin || ALLOWED_ORIGIN);
  res.status(204).set(headers).send();
});

// Main MCP endpoint
app.all(MCP_PATH, async (req, res) => {
  const origin = req.get('origin') || undefined;

  try {
    // GET: open an SSE stream (server → client messages)
    if (req.method === 'GET') {
      if (!validateOrigin(origin || '')) return badRequest(res, origin, 'Origin not allowed');

      const accept = String(req.get('accept') || '');
      if (!accept.includes('text/event-stream')) return notAllowed(res, origin);

      const sessionId = req.get('mcp-session-id');
      if (!sessionId || !sessions[sessionId]) {
        return textResponse(res, origin, 404, 'Unknown or missing session');
      }

      const session = sessions[sessionId];
      if (!session.sseClients) session.sseClients = new Set();

      openSSE(res, origin, { 'MCP-Protocol-Version': PROTOCOL_VERSION });
      session.sseClients.add(res);

      // Simple keepalive
      const keep = setInterval(() => sseComment(res, 'keepalive'), 15000);

      req.on('close', () => {
        clearInterval(keep);
        session.sseClients.delete(res);
      });

      // Example server-initiated notification on connect
      const notif = {
        jsonrpc: '2.0',
        method: 'logging/message',
        params: { level: 'info', logger: 'mcp', message: 'SSE stream opened' },
      };
      sseData(res, notif, ++session.cursor);
      return;
    }

    // POST: client → server message (JSON-RPC over HTTP)
    if (req.method === 'POST') {
      if (!validateOrigin(origin || '')) return badRequest(res, origin, 'Origin not allowed');

      const accept = String(req.get('accept') || '');
      const msg = req.body;

      if (!checkJSONRPC(msg)) return badRequest(res, origin, 'Invalid JSON-RPC');

      // Session management per spec
      let sessionId = req.get('mcp-session-id');
      let session = sessionId && sessions[sessionId];

      // initialize: create new session
      if (msg.method === 'initialize') {
        sessionId = randomUUID();
        session = (sessions[sessionId] = {
          initialized: false,
          sseClients: new Set(),
          cursor: 0,
        });

        const out = await routeRequest(session, msg);
        return sendJSON(
          res,
          origin,
          200,
          { jsonrpc: '2.0', id: msg.id, result: out.result },
          {
            'Mcp-Session-Id': sessionId,
            'MCP-Protocol-Version': PROTOCOL_VERSION,
          }
        );
      }

      // After initialize, require a valid session
      if (!session) {
        return textResponse(res, origin, 404, 'Session not found (initialize first)');
      }

      // Notifications: no id → 202 Accepted, no body
      if (!('id' in msg) || msg.id === null) {
        await routeRequest(session, msg);
        const cors = makeCorsHeaders(origin || ALLOWED_ORIGIN);
        res.status(202).set(cors).end();
        return;
      }

      // For requests, choose JSON or SSE response
      const wantsSSE = accept.includes('text/event-stream');

      if (!wantsSSE) {
        const out = await routeRequest(session, msg);
        if (out.error) {
          return sendJSON(
            res,
            origin,
            200,
            { jsonrpc: '2.0', id: msg.id, error: out.error },
            { 'MCP-Protocol-Version': PROTOCOL_VERSION }
          );
        }
        return sendJSON(
          res,
          origin,
          200,
          { jsonrpc: '2.0', id: msg.id, result: out.result },
          { 'MCP-Protocol-Version': PROTOCOL_VERSION }
        );
      }

      // SSE response stream for this request (per-call streaming)
      openSSE(res, origin, { 'MCP-Protocol-Version': PROTOCOL_VERSION });

      // Optional: log message before final response
      sseData(
        res,
        {
          jsonrpc: '2.0',
          method: 'logging/message',
          params: {
            level: 'info',
            logger: 'mcp',
            message: `Handling ${msg.method}`,
          },
        },
        ++session.cursor
      );

      const out = await routeRequest(session, msg);
      const final = out.error
        ? { jsonrpc: '2.0', id: msg.id, error: out.error }
        : { jsonrpc: '2.0', id: msg.id, result: out.result };

      sseData(res, final, ++session.cursor);
      return res.end();
    }

    // Any other method on /mcp
    return notAllowed(res, origin);
  } catch (e) {
    try {
      badRequest(
        res,
        origin,
        `Server error: ${e && e.message ? e.message : String(e)}`
      );
    } catch {
      // ignore
    }
  }
});

// ---------- Start server ----------
app.listen(PORT, '127.0.0.1', () => {
  console.error(
    `[mcp] Express MCP HTTP server listening on http://127.0.0.1:${PORT}${MCP_PATH}`
  );
  console.error(
    `[mcp] Restricting to localhost; see spec security guidance for remote use.`
  );
});
