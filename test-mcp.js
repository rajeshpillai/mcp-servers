// test-mcp-full.js
// Full MCP server test harness for Streamable HTTP MCP server.
// No external libraries, Node.js only.

const http = require("http");

// -------------------- Helpers --------------------

// POST JSON and read full body (one-shot JSON response)
function postJson(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 3333,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          Origin: "http://localhost",
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: raw,
          });
        });
      }
    );

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// POST expecting SSE (like: curl -N -X POST ... -H "Accept: text/event-stream")
function postSse(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 3333,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          Accept: "text/event-stream, application/json",
          Origin: "http://localhost",
          ...headers,
        },
      },
      (res) => {
        res.setEncoding("utf8");

        console.log("\n[SSE POST] Status:", res.statusCode);
        console.log("[SSE POST] Headers:", res.headers);
        console.log("[SSE POST] -------- STREAM START --------");

        res.on("data", (chunk) => {
          // Raw SSE frames (lines starting with "data:", "id:", ":" etc.)
          console.log("[SSE EVENT]", chunk.toString());
        });

        res.on("end", () => {
          console.log("[SSE POST] -------- STREAM END --------\n");
          resolve();
        });
      }
    );

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// GET a long-lived SSE stream (like: curl -N GET /mcp ...)
function getSse(path, headers = {}) {
  const req = http.request(
    {
      hostname: "127.0.0.1",
      port: 3333,
      path,
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Origin: "http://localhost",
        ...headers,
      },
    },
    (res) => {
      console.log("\n[GET SSE] Status:", res.statusCode);
      console.log("[GET SSE] Headers:", res.headers);
      console.log("[GET SSE] -------- STREAM START --------");

      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        console.log("[GET SSE EVENT]", chunk.toString());
      });

      res.on("end", () => {
        console.log("[GET SSE] -------- STREAM END --------");
      });
    }
  );

  req.on("error", console.error);
  req.end();
}

// -------------------- MAIN FLOW --------------------

(async () => {
  console.log("\n=== 1) INITIALIZE ===");

  const initBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "node-test-client", version: "0.1.0" },
    },
  };

  const initRes = await postJson("/mcp", initBody);
  console.log("INIT Status:", initRes.status);
  console.log("INIT Headers:", initRes.headers);
  console.log("INIT Body:", initRes.body);

  const SID = initRes.headers["mcp-session-id"];
  if (!SID) {
    console.error("❌ No Mcp-Session-Id returned! initialize failed.");
    process.exit(1);
  }
  console.log("\nSESSION ID:", SID);

  // 2) notifications/initialized (like the curl notification → 202)
  console.log("\n=== 2) notifications/initialized ===");

  const notifBody = {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  };

  const notifRes = await postJson("/mcp", notifBody, {
    "Mcp-Session-Id": SID,
  });
  console.log("NOTIF Status:", notifRes.status); // typically 202, with empty body

  // 3) tools/list in SSE mode (like curl -N -X POST ... Accept: text/event-stream)
  console.log("\n=== 3) POST tools/list (SSE MODE) ===");

  await postSse(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
    { "Mcp-Session-Id": SID }
  );

  // 4) tools/call: echo
  console.log("\n=== 4) tools/call: echo ===");

  const echoBody = {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "echo",
      arguments: { text: "Hello from test-mcp-full.js!" },
    },
  };

  const echoRes = await postJson("/mcp", echoBody, {
    "Mcp-Session-Id": SID,
  });
  console.log("ECHO Status:", echoRes.status);
  console.log("ECHO Body:", echoRes.body);

  // 5) tools/call: sum
  console.log("\n=== 5) tools/call: sum ===");

  const sumBody = {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "sum",
      arguments: { values: [10, 20, 5] },
    },
  };

  const sumRes = await postJson("/mcp", sumBody, {
    "Mcp-Session-Id": SID,
  });
  console.log("SUM Status:", sumRes.status);
  console.log("SUM Body:", sumRes.body);

  // 6) GET SSE: long-lived server → client stream (like curl -N GET /mcp ...)
  console.log("\n=== 6) GET SSE STREAM ===");

  getSse("/mcp", { "Mcp-Session-Id": SID });

  // Keep the process alive a bit so you can see some SSE events (logging + keepalive).
  setTimeout(() => {
    console.log("\nClosing test script.");
    process.exit(0);
  }, 8000);
})();
