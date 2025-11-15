#!/usr/bin/env node
'use strict';

/**
 * Minimal MCP Streamable HTTP server (single /mcp endpoint).
 * - No external libs. Uses Node's http + crypto.
 * - Implements: POST (JSON or SSE) and GET (SSE).
 * - Session header: Mcp-Session-Id (spec).
 * - Tools: echo, sum. Resources: mem://hello.txt
 *
 * SECURITY NOTE: In production, add proper auth (e.g., Bearer/OAuth),
 * validate Origin, and prefer localhost bind for local servers. :contentReference[oaicite:1]{index=1}
 */

const http = require('http');
const { randomUUID } = require('crypto');

// ---------- Config ----------
const PORT = process.env.PORT || 3333;
const MCP_PATH = '/mcp';
const PROTOCOL_VERSION = '2025-06-18'; // advertise/expect this version :contentReference[oaicite:2]{index=2}
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';

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


// ---------- Simple utils ----------
function sendJSON(res, status, body, headers = {}) {
  const cors = makeCorsHeaders(res._origin || ALLOWED_ORIGIN);
  const h = Object.assign(
    {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
    cors,
    headers
  );
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, h);
  res.end(buf);
}


function notAllowed(res) {
  const cors = makeCorsHeaders(res._origin || ALLOWED_ORIGIN);
  res.writeHead(405, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...cors,
  });
  res.end('Method Not Allowed');
}

function badRequest(res, msg) {
  sendJSON(res, 400, { jsonrpc: '2.0', error: { code: -32600, message: msg } });
}


function checkJSONRPC(msg) {
  return msg && typeof msg === 'object' && msg.jsonrpc === '2.0';
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ---------- SSE helpers ----------
function openSSE(res, extraHeaders = {}) {
  const cors = makeCorsHeaders(res._origin || ALLOWED_ORIGIN);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...cors,
    ...extraHeaders,
  });
}


function sseData(res, obj, id = undefined) {
  if (id) res.write(`id: ${id}\n`);
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function sseComment(res, text) {
  res.write(`: ${text}\n\n`);
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
    serverInfo: { name: 'BareNodeMCP-HTTP', title: 'Bare Node MCP (HTTP)', version: '0.2.0' },
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
      return { id: undefined, acceptOnly: true }; // 202 Accepted per spec for notifications

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
          result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true },
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

// ---------- Security helpers (spec guidance) ----------
function validateOrigin(req) {
  const origin = req.headers.origin;
  // Non-browser clients may omit Origin
  if (!origin) return true;

  // Simple dev rule: exact match with ALLOWED_ORIGIN
  if (origin === ALLOWED_ORIGIN) return true;

  // Optional: allow any localhost port during dev
  if (origin.startsWith('http://localhost')) return true;

  return false;
}


// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  res._origin = req.headers.origin; // stash it so helpers can use
  try {
    // Enforce single endpoint
    if (req.url !== MCP_PATH) return notAllowed(res);

    const origin = req.headers.origin;

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      if (!validateOrigin(req)) {
        const headers = makeCorsHeaders(origin);
        res.writeHead(400, {
          'Content-Type': 'text/plain; charset=utf-8',
          ...headers,
        });
        return res.end('Origin not allowed');
      }

      const headers = makeCorsHeaders(origin);
      res.writeHead(204, {
        ...headers,
      });
      return res.end();
    }

    // GET: open an SSE stream (server → client messages) :contentReference[oaicite:4]{index=4}
    if (req.method === 'GET') {
      if (!validateOrigin(req)) return badRequest(res, 'Origin not allowed');

      const accept = String(req.headers.accept || '');
      if (!accept.includes('text/event-stream')) return notAllowed(res);

      const sessionId = req.headers['mcp-session-id'];
      if (!sessionId || !sessions[sessionId]) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8',
          ...makeCorsHeaders(res._origin || ALLOWED_ORIGIN),
         });
        return res.end('Unknown or missing session');
      }

      const session = sessions[sessionId];
      if (!session.sseClients) session.sseClients = new Set();

      openSSE(res, { 'MCP-Protocol-Version': PROTOCOL_VERSION });
      session.sseClients.add(res);

      // Simple keepalive to keep proxies happy
      const keep = setInterval(() => sseComment(res, 'keepalive'), 15000);

      req.on('close', () => {
        clearInterval(keep);
        session.sseClients.delete(res);
      });

      // Example server-initiated notification on connect:
      const notif = {
        jsonrpc: '2.0',
        method: 'logging/message',
        params: { level: 'info', logger: 'mcp', message: 'SSE stream opened' },
      };
      sseData(res, notif, ++session.cursor);
      return;
    }

    // POST: client → server message (request, notification, or response) :contentReference[oaicite:5]{index=5}
    if (req.method === 'POST') {
      if (!validateOrigin(req)) return badRequest(res, 'Origin not allowed');

      // Ensure Accept header supports both for requests; for simplicity we honor it only for "request"
      const accept = String(req.headers.accept || '');

      const msg = await parseBody(req);
      if (!checkJSONRPC(msg)) return badRequest(res, 'Invalid JSON-RPC');

      // Session management per spec: assign on initialize, then require header thereafter. :contentReference[oaicite:6]{index=6}
      let sessionId = req.headers['mcp-session-id'];
      let session = sessionId && sessions[sessionId];

      if (msg.method === 'initialize') {
        // Create new session
        sessionId = randomUUID();
        session = sessions[sessionId] = { initialized: false, sseClients: new Set(), cursor: 0 };

        // Return JSON one-shot InitializeResult (allowed by spec)
        const out = await routeRequest(session, msg);
        return sendJSON(
          res,
          200,
          { jsonrpc: '2.0', id: msg.id, result: out.result },
          { 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': PROTOCOL_VERSION }
        );
      }

      // After initialize, require a valid session
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8',
          ...makeCorsHeaders(res._origin || ALLOWED_ORIGIN),
         });
        return res.end('Session not found (initialize first)');
      }

      // Notifications or responses from client → return 202 Accepted with no body. :contentReference[oaicite:7]{index=7}
      if (!('id' in msg) || msg.id === null) {
        // Update server state if needed (e.g., notifications/initialized)
        const out = await routeRequest(session, msg);
        res.writeHead(202, {
          ...makeCorsHeaders(res._origin || ALLOWED_ORIGIN),
        });
        return res.end();
      }

      // For requests: server MUST return either JSON or SSE stream. We do:
      // - If Accept includes text/event-stream → stream
      // - Else return JSON one-shot. :contentReference[oaicite:8]{index=8}
      const wantsSSE = accept.includes('text/event-stream');

      if (!wantsSSE) {
        const out = await routeRequest(session, msg);
        if (out.error) {
          return sendJSON(res, 200, { jsonrpc: '2.0', id: msg.id, error: out.error }, { 'MCP-Protocol-Version': PROTOCOL_VERSION });
        }
        return sendJSON(res, 200, { jsonrpc: '2.0', id: msg.id, result: out.result }, { 'MCP-Protocol-Version': PROTOCOL_VERSION });
      }

      // SSE response stream for this request
      openSSE(res, { 'MCP-Protocol-Version': PROTOCOL_VERSION });

      // (Optional) Server may send related notifications before the final response. :contentReference[oaicite:9]{index=9}
      sseData(
        res,
        {
          jsonrpc: '2.0',
          method: 'logging/message',
          params: { level: 'info', logger: 'mcp', message: `Handling ${msg.method}` },
        },
        ++session.cursor
      );

      // Compute the actual response
      const out = await routeRequest(session, msg);
      const final = out.error
        ? { jsonrpc: '2.0', id: msg.id, error: out.error }
        : { jsonrpc: '2.0', id: msg.id, result: out.result };

      // Send final response then close stream (SHOULD close after response). :contentReference[oaicite:10]{index=10}
      sseData(res, final, ++session.cursor);
      return res.end();
    }

    notAllowed(res);
  } catch (e) {
    try {
      badRequest(res, `Server error: ${e && e.message ? e.message : String(e)}`);
    } catch {}
  }
});

// Graceful session cleanup
server.on('clientError', () => { /* ignore */ });

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[mcp] Streamable HTTP server listening on http://127.0.0.1:${PORT}${MCP_PATH}`);
  console.error(`[mcp] Restricting to localhost; see spec security guidance for remote use.`);
});
