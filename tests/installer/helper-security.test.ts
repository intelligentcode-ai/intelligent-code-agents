import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import { MAX_JSON_BODY_BYTES, readJsonBody, RequestError, resolveDashboardImage } from "../../src/installer-helper/server";

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

test("resolveDashboardImage prefers explicit request image over inspected image", () => {
  const resolved = resolveDashboardImage("ghcr.io/intelligentcode-ai/ica-installer-dashboard:main", "ica-dashboard:local", "ica-dashboard:local");
  assert.equal(resolved, "ghcr.io/intelligentcode-ai/ica-installer-dashboard:main");
});

test("resolveDashboardImage falls back to inspected image when request image is empty", () => {
  const resolved = resolveDashboardImage("   ", "ica-dashboard:local", "ghcr.io/intelligentcode-ai/ica-installer-dashboard:main");
  assert.equal(resolved, "ica-dashboard:local");
});
