import assert from "node:assert/strict";
import test from "node:test";

import { ToolExecutionGate } from "../src/execution.js";
import { BackpressureError } from "../src/errors.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("ToolExecutionGate serializes mutating operations for the same presentation", async () => {
  const gate = new ToolExecutionGate(8, 4, 8);
  const firstStarted = deferred();
  const finishFirst = deferred();
  const order: string[] = [];

  const first = gate.runMutating(async () => {
    order.push("first-start");
    firstStarted.resolve();
    await finishFirst.promise;
    order.push("first-end");
    return "first";
  }, "presentation-1");

  await firstStarted.promise;

  const second = gate.runMutating(async () => {
    order.push("second-start");
    return "second";
  }, "presentation-1");

  await Promise.resolve();
  assert.deepEqual(order, ["first-start"]);

  finishFirst.resolve();
  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

test("ToolExecutionGate respects global mutating concurrency across presentations", async () => {
  const gate = new ToolExecutionGate(1, 1, 8);
  const firstStarted = deferred();
  const finishFirst = deferred();
  const order: string[] = [];

  const first = gate.runMutating(async () => {
    order.push("first-start");
    firstStarted.resolve();
    await finishFirst.promise;
    order.push("first-end");
    return "first";
  }, "presentation-1");

  await firstStarted.promise;

  const second = gate.runMutating(async () => {
    order.push("second-start");
    return "second";
  }, "presentation-2");

  await Promise.resolve();
  assert.deepEqual(order, ["first-start"]);

  finishFirst.resolve();
  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

test("ToolExecutionGate limits read-only concurrency", async () => {
  const gate = new ToolExecutionGate(1, 1, 8);
  const firstStarted = deferred();
  const finishFirst = deferred();
  const order: string[] = [];

  const first = gate.runReadOnly(async () => {
    order.push("first-start");
    firstStarted.resolve();
    await finishFirst.promise;
    order.push("first-end");
    return "first";
  });

  await firstStarted.promise;

  const second = gate.runReadOnly(async () => {
    order.push("second-start");
    return "second";
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first-start"]);

  finishFirst.resolve();
  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

test("ToolExecutionGate coalesces identical read-only operations", async () => {
  const gate = new ToolExecutionGate(1, 1, 8);
  let invocationCount = 0;
  const release = deferred();

  const operation = async () => {
    invocationCount += 1;
    await release.promise;
    return "shared-result";
  };

  const first = gate.runReadOnly(operation, "same-read");
  const second = gate.runReadOnly(operation, "same-read");

  await Promise.resolve();
  assert.equal(invocationCount, 1);

  release.resolve();
  assert.equal(await first, "shared-result");
  assert.equal(await second, "shared-result");
  assert.equal(invocationCount, 1);
});

test("ToolExecutionGate rejects when local queue is saturated", async () => {
  const gate = new ToolExecutionGate(1, 1, 1);
  const release = deferred();

  const first = gate.runReadOnly(async () => {
    await release.promise;
    return "first";
  });
  const second = gate.runReadOnly(async () => "second");

  await assert.rejects(
    () => gate.runReadOnly(async () => "third"),
    (error: unknown) => {
      assert.ok(error instanceof BackpressureError);
      assert.match(error.message, /locally saturated/i);
      return true;
    }
  );

  release.resolve();
  assert.equal(await first, "first");
  assert.equal(await second, "second");
});
