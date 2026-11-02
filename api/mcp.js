import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CanvasMCPServer, loadConfigFromEnvironment } from '../build/index.js';

export default async function handler(req, res) {
  const secret = process.env.MCP_SECRET;
  if (!secret) {
    res.statusCode = 503;
    return res.end('Server authentication is not configured');
  }
  const supplied = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    res.statusCode = 401;
    return res.end('Unauthorized');
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    return res.end('Method Not Allowed');
  }
  let server;
  let transport;
  try {
    const config = loadConfigFromEnvironment(process.env);
    server = new CanvasMCPServer(config);
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connectHttpTransport(transport);
    let body = req.body;
    if (body === undefined) {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      body = Buffer.concat(chunks).toString('utf8');
    }
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      try { body = JSON.parse(body.toString()); }
      catch {
        res.statusCode = 400;
        return res.end('Invalid JSON');
      }
    }
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error('MCP request failed:', error instanceof Error ? error.message : 'Unknown error');
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal server error');
    }
  } finally {
    await transport?.close();
    await server?.close();
  }
}
