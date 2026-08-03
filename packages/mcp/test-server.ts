import http from "http";

const mcpTools = [
  {
    name: "echo",
    description: "Echo back the input message",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to echo" },
      },
      required: ["message"],
    },
  },
  {
    name: "add",
    description: "Add two numbers",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  },
  {
    name: "get_time",
    description: "Get current server time",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

let requestId = 0;

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const id = json.id ?? ++requestId;

  if (json.method === "initialize") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "test-mcp-server", version: "1.0.0" },
        },
      }),
    );
  } else if (json.method === "tools/list") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { tools: mcpTools },
      }),
    );
  } else if (json.method === "tools/call") {
    const { name, arguments: args } = json.params ?? {};
    const content: { type: string; text: string }[] = [];

    if (name === "echo") {
      content.push({ type: "text", text: `Echo: ${args?.message ?? ""}` });
    } else if (name === "add") {
      const sum = (args?.a ?? 0) + (args?.b ?? 0);
      content.push({ type: "text", text: `Result: ${sum}` });
    } else if (name === "get_time") {
      content.push({ type: "text", text: `Current time: ${new Date().toISOString()}` });
    } else {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not found" },
        }),
      );
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { content, isError: false },
      }),
    );
  } else {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      }),
    );
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`MCP Test Server running on http://localhost:${PORT}`);
  console.log(`Use: curl -X POST http://localhost:${PORT} -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'`);
});