import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Create a mock IncomingMessage that emits the given body string.
 */
export function mockRequest(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  (req as any).headers = headers;
  (req as any).method = "POST";
  (req as any).url = "/v1/chat/completions";
  // Emit body chunks on next tick so readBody() can attach listeners
  process.nextTick(() => {
    req.emit("data", body);
    req.emit("end");
  });
  return req;
}

/**
 * Create a mock ServerResponse that captures writes.
 */
export function mockResponse(): ServerResponse & {
  statusCode: number;
  writtenHeaders: Record<string, string | number>;
  writtenBody: string;
  ended: boolean;
} {
  const res = new EventEmitter() as any;
  res.statusCode = 200;
  res.writtenHeaders = {};
  res.writtenBody = "";
  res.ended = false;
  res.headersSent = false;

  res.writeHead = (status: number, headers?: Record<string, string>) => {
    res.statusCode = status;
    if (headers) Object.assign(res.writtenHeaders, headers);
    res.headersSent = true;
    return res;
  };
  res.setHeader = (name: string, value: string) => {
    res.writtenHeaders[name] = value;
  };
  res.write = (chunk: string | Buffer) => {
    res.writtenBody += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  res.end = (chunk?: string | Buffer) => {
    if (chunk) res.writtenBody += typeof chunk === "string" ? chunk : chunk.toString();
    res.ended = true;
    return res;
  };

  return res;
}

/**
 * Parse the JSON body written to a mock response.
 */
export function responseJson(res: { writtenBody: string }) {
  return JSON.parse(res.writtenBody);
}
