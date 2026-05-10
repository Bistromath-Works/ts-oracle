import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { GET, POST, DELETE } from "../api/server";

const PORT = Number(process.env["PORT"] ?? 3001);

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const url = `http://localhost:${PORT}${req.url ?? "/"}`;
  const init: RequestInit = {
    method: req.method ?? "GET",
    headers: req.headers as Record<string, string>,
  };
  if (body.length > 0) init.body = body;
  return new Request(url, init);
}

async function pipeWebResponse(webRes: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  webRes.headers.forEach((value, key) => { headers[key] = value; });
  res.writeHead(webRes.status, headers);
  if (webRes.body) {
    const reader = webRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  res.end();
}

const server = createServer(async (req, res) => {
  try {
    const webReq = await toWebRequest(req);
    let webRes: Response;
    if (req.method === "GET") webRes = await GET(webReq);
    else if (req.method === "POST") webRes = await POST(webReq);
    else if (req.method === "DELETE") webRes = await DELETE(webReq);
    else webRes = new Response("Method not allowed", { status: 405 });
    await pipeWebResponse(webRes, res);
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end("Internal server error");
  }
});

server.listen(PORT, () => {
  console.log(`ts-trainer MCP server listening on http://localhost:${PORT}`);
});
