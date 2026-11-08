import assert from "node:assert/strict";
import { test } from "node:test";
import { Limiter, LimitedTransport } from "../src/forge-limit.ts";
import type { ForgeRequest, ForgeResponse, Transport } from "../src/forge/transport.ts";

test("a limiter runs at most its limit at once, first come first served", async () => {
  const limiter = new Limiter(4);
  const order: number[] = [];
  let running = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 10 }, (_, n) =>
      limiter.run(async () => {
        order.push(n);
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
      }),
    ),
  );
  assert.equal(peak, 4);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(limiter.running, 0);
});

test("a failing task frees its place", async () => {
  const limiter = new Limiter(1);
  await assert.rejects(limiter.run(async () => Promise.reject(new Error("no"))));
  assert.equal(await limiter.run(async () => "next"), "next");
  assert.equal(limiter.running, 0);
});

test("a limited transport sends at most four requests at once by default", async () => {
  let running = 0;
  let peak = 0;
  const inner: Transport = {
    async request(_request: ForgeRequest): Promise<ForgeResponse> {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return { status: 200, headers: {}, body: "[]" };
    },
  };
  const transport = new LimitedTransport(inner, new Limiter());
  await Promise.all(Array.from({ length: 9 }, () => transport.request({ host: "github.com", method: "GET", path: "user" })));
  assert.equal(peak, 4);
});
