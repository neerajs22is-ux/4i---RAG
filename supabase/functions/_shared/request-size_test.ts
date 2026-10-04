// request-size_test.ts — early-rejection helper: static, no I/O, no counters.
import { assertEquals } from "jsr:@std/assert@1";
import { MAX_REQUEST_BYTES, requestTooLarge } from "./request-size.ts";

function reqWithLength(value: string | null): Request {
  const headers = new Headers();
  if (value !== null) headers.set("Content-Length", value);
  return new Request("https://x.test/functions/v1/ask", {
    method: "POST",
    headers,
  });
}

Deno.test("64 KB ceiling constant", () => {
  assertEquals(MAX_REQUEST_BYTES, 65536);
});

Deno.test("missing Content-Length remains allowed", () => {
  assertEquals(requestTooLarge(reqWithLength(null)), false);
});

Deno.test("small and boundary bodies allowed", () => {
  assertEquals(requestTooLarge(reqWithLength("0")), false);
  assertEquals(requestTooLarge(reqWithLength("2048")), false);
  assertEquals(requestTooLarge(reqWithLength("65536")), false);
});

Deno.test("oversized Content-Length rejected", () => {
  assertEquals(requestTooLarge(reqWithLength("65537")), true);
  assertEquals(requestTooLarge(reqWithLength("10485760")), true);
});

Deno.test("unparsable or negative values fail open (availability)", () => {
  assertEquals(requestTooLarge(reqWithLength("garbage")), false);
  assertEquals(requestTooLarge(reqWithLength("")), false);
  assertEquals(requestTooLarge(reqWithLength("-1")), false);
});

Deno.test("legitimate ask-shaped body is far under the ceiling", () => {
  const body = JSON.stringify({
    tenant_id: "00000000-0000-0000-0000-000000000000",
    query: "x".repeat(1000),
  });
  assertEquals(new TextEncoder().encode(body).length < MAX_REQUEST_BYTES, true);
});
