import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import { escapeAppleScriptString, MAX_JSON_BODY_BYTES, readJsonBody, RequestError } from "../../src/installer-helper/server";

function mockRequest(body: string, headers: Record<string, string> = {}): http.IncomingMessage {
  const stream = Readable.from([body]) as unknown as http.IncomingMessage;
  (stream as unknown as { headers: Record<string, string> }).headers = headers;
  return stream;
}

test("readJsonBody rejects content-length above maximum", async () => {
  const req = mockRequest("{}", { "content-length": String(MAX_JSON_BODY_BYTES + 1) });
  await assert.rejects(
    readJsonBody(req),
    (error: unknown) => error instanceof RequestError && error.status === 413,
  );
});

test("readJsonBody rejects malformed JSON", async () => {
  const req = mockRequest("{oops", { "content-length": "5" });
  await assert.rejects(
    readJsonBody(req),
    (error: unknown) => error instanceof RequestError && error.status === 400,
  );
});

test("escapeAppleScriptString escapes quotes and backslashes", () => {
  const escaped = escapeAppleScriptString(String.raw`/tmp/path"with\chars`);
  assert.equal(escaped, String.raw`/tmp/path\"with\\chars`);
});
