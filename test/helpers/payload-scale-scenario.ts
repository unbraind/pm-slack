/** Shared adversarial contract for source, CLI and captured npm/Bun consumers. */
import assert from "node:assert/strict";
import type { compileSlackPayload, validateSlackWirePayload } from "../../payload-compilation.ts";

/** Valid near-limit inputs exercise element trimming, action protection, byte removal and structural omissions. */
export function assertPayloadScale(compile: typeof compileSlackPayload, validate: typeof validateSlackWirePayload, onlyByteBudget = false) {
  const measurements: { blocks: number; leaves: number; input_bytes: number; losses: number; bytes: number; callbacks: number; serialized_bytes: number; elapsed_ms: number }[] = [];
  for (const [count, type] of [[200, "section"], [500, "section"], [200, "context"], [500, "divider"], [50, "byte-budget"]] as const) {
    if (onlyByteBudget && type !== "byte-budget") continue;
    const blocks = Array.from({ length: count }, (_value, i) => type === "byte-budget" ? { type: "section", fields: Array.from({ length: 10 }, () => ({ type: "plain_text", text: "x".repeat(1800) })) } : type === "divider"
      ? (i % 2 ? { type: "divider" } : { type: "section", text: { type: "mrkdwn", text: "漢".repeat(2000) } })
      : { type, [type === "section" ? "fields" : "elements"]: Array.from({ length: 100 }, () => ({ type: "mrkdwn", text: "x" })) });
    const source = { payload: { text: "fallback", blocks }, item: "scale", link: "https://example.com/items/scale", preserve: [] };
    const input_bytes = Buffer.byteLength(JSON.stringify(source));
    assert.ok(input_bytes < 2097152);
    const leaves = type === "divider" ? count / 2 : type === "byte-budget" ? count * 10 : count * 100;
    let callbacks = 0, serialized_bytes = 0;
    const originalFilter = Array.prototype.filter, originalSome = Array.prototype.some, originalStringify = JSON.stringify;
    /** Count actual collection callbacks, rather than relying on a machine-speed benchmark alone. */
    const inspect = () => { callbacks++; assert.ok(callbacks <= 16 * (leaves + count) + 4096, "non-linear collection work budget exceeded"); };
    Array.prototype.filter = function<T>(this: T[], predicate: (value: T, index: number, array: T[]) => unknown, context?: unknown): T[] {
      return Reflect.apply(originalFilter, this, [(value: T, index: number, array: T[]) => { inspect(); return predicate.call(context, value, index, array); }]) as T[];
    } as typeof Array.prototype.filter;
    Array.prototype.some = function<T>(this: T[], predicate: (value: T, index: number, array: T[]) => unknown, context?: unknown): boolean {
      return Reflect.apply(originalSome, this, [(value: T, index: number, array: T[]) => { inspect(); return predicate.call(context, value, index, array); }]) as boolean;
    };
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      const result = Reflect.apply(originalStringify, JSON, args) as string | undefined;
      serialized_bytes += result === undefined ? 0 : Buffer.byteLength(result);
      assert.ok(serialized_bytes <= 8 * input_bytes + 262144, "non-linear serialization work budget exceeded");
      return result;
    }) as typeof JSON.stringify;
    const started = performance.now();
    let result;
    try { result = compile(source); }
    finally { Array.prototype.filter = originalFilter; Array.prototype.some = originalSome; JSON.stringify = originalStringify; }
    assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(result.payload)));
    assert.ok(result.bytes <= 65536);
    assert.deepEqual(validate(result.payload), result.payload);
    assert.equal(new Set(result.losses.map((row) => row.path)).size, result.losses.length);
    if (type === "section" || type === "context") assert.equal(result.losses.length, leaves - 50 * 10);
    assert.equal(result.losses.every((row) => row.start === 0 && row.end === (type === "divider" ? 2000 : type === "byte-budget" ? 1800 : 1) || row.path.match(/^\/blocks\/[0-9]+$/)), true);
    measurements.push({ blocks: count, leaves, input_bytes, losses: result.losses.length, bytes: result.bytes, callbacks, serialized_bytes, elapsed_ms: Math.round(performance.now() - started) });
  }
  return measurements;
}
