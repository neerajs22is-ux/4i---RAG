// cors_test.ts — L-1: no wildcard reflection of browser origins.
import { assertEquals } from "jsr:@std/assert@1";
import { corsHeaders } from "./cors.ts";

function reqWithOrigin(origin: string | null): Request {
  const headers = new Headers();
  if (origin !== null) headers.set("Origin", origin);
  return new Request("https://x.test/functions/v1/ask", { headers });
}

Deno.test("https origin echoed when no allow-list", () => {
  const h = corsHeaders(reqWithOrigin("https://4i-rag.vercel.app"));
  assertEquals(h["Access-Control-Allow-Origin"], "https://4i-rag.vercel.app");
});

Deno.test("http origin is not reflected (no allow-list)", () => {
  const h = corsHeaders(reqWithOrigin("http://evil.example"));
  assertEquals(h["Access-Control-Allow-Origin"], "https://4i-rag.vercel.app");
});

Deno.test("localhost http allowed for local dev", () => {
  const h = corsHeaders(reqWithOrigin("http://localhost:3000"));
  assertEquals(h["Access-Control-Allow-Origin"], "http://localhost:3000");
});

Deno.test("no Origin keeps wildcard for non-browser callers", () => {
  const h = corsHeaders(reqWithOrigin(null));
  assertEquals(h["Access-Control-Allow-Origin"], "*");
});

Deno.test("never sends Allow-Credentials", () => {
  const h = corsHeaders(reqWithOrigin("https://4i-rag.vercel.app"));
  assertEquals("Access-Control-Allow-Credentials" in h, false);
});
