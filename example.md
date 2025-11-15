Try it with curl

Initialize (creates a session, returns JSON one-shot):

curl -i -X POST 'http://127.0.0.1:3333/mcp' \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'


Note the Mcp-Session-Id header in the 200 response. Save it to $SID.

Tell server we’re initialized (notification → 202):

curl -i -X POST 'http://127.0.0.1:3333/mcp' \
  -H "Mcp-Session-Id: $SID" \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'


List tools with a streamed response (SSE):

curl -N -X POST 'http://127.0.0.1:3333/mcp' \
  -H "Mcp-Session-Id: $SID" \
  -H 'Origin: http://localhost' \
  -H 'Accept: text/event-stream, application/json' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'


You’ll see one or more data: { ... } events, ending with the final JSON-RPC response.

Open a long-lived server → client stream (GET):

curl -N 'http://127.0.0.1:3333/mcp' \
  -H "Mcp-Session-Id: $SID" \
  -H 'Origin: http://localhost' \
  -H 'Accept: text/event-stream'


The server can now push notifications (you’ll immediately see a logging/message).