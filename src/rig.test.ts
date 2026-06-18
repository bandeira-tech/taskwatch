/**
 * Regression tests for the URI-shape program wired into the taskwatch rig.
 *
 * Before this program existed, `rig.receive()` would resolve the
 * pipeline-ack with `accepted: true` *before* the per-route dispatch
 * ran. When the dispatched node later rejected a malformed URI, the
 * rejection arrived as a `route:error` event — not on the awaited
 * result — so MCP / HTTP callers saw `accepted: true` while no file
 * landed on disk. The program runs validation at the pipeline stage
 * so refuses propagate as `{ accepted: false, error }` on the awaited
 * result, which is what every caller actually wants.
 */

import { assertEquals } from "jsr:@std/assert@^1.0.15";
import { MemoryStore } from "@bandeira-tech/b3nd-save/memory";
import { createRig } from "./rig.ts";

async function freshRig() {
  const store = new MemoryStore();
  return await createRig({ store });
}

const TS = "20260618132114";
const SLUG = "regression-test-task";
const VALID_TITLE_URI = `taskwatch://task/${TS}/${SLUG}/title`;
const VALID_INDEX_URI = `taskwatch://index/${TS}-${SLUG}`;

Deno.test("valid task URI is accepted and persists", async () => {
  const { rig } = await freshRig();
  const [r] = await rig.receive([[VALID_TITLE_URI, "hello"]]);
  assertEquals(r.accepted, true, r.error);

  const [out] = await rig.read([VALID_TITLE_URI]);
  assertEquals(out[1], "hello");
});

Deno.test("valid index URI is accepted and persists", async () => {
  const { rig } = await freshRig();
  const [r] = await rig.receive([[VALID_INDEX_URI, "regression test task"]]);
  assertEquals(r.accepted, true, r.error);

  const [out] = await rig.read([VALID_INDEX_URI]);
  assertEquals(out[1], "regression test task");
});

Deno.test("malformed URI (hyphen between ts and slug) is refused at pipeline stage", async () => {
  const { rig } = await freshRig();
  // This is the shape that fooled the old pipeline-ack: ts and slug
  // joined with `-` instead of `/` looks index-like but lands under
  // the task/ tree where it would never parse cleanly.
  const badUri = `taskwatch://task/${TS}-${SLUG}/title`;
  const [r] = await rig.receive([[badUri, "this should be rejected"]]);
  assertEquals(r.accepted, false);
  assertEquals(typeof r.error, "string");
  // The error should explain why so callers can fix their URI.
  assertEquals(
    (r.error ?? "").includes("unsupported uri shape") ||
      (r.error ?? "").includes("bad-shape"),
    true,
    `expected shape-error, got: ${r.error}`,
  );
});

Deno.test("URI outside basepath is refused", async () => {
  const { rig } = await freshRig();
  const [r] = await rig.receive([["other://task/x/y/title", "nope"]]);
  assertEquals(r.accepted, false);
  assertEquals(
    (r.error ?? "").includes("outside basepath") ||
      (r.error ?? "").includes("No connection accepts"),
    true,
    `expected outside-basepath or no-route error, got: ${r.error}`,
  );
});

Deno.test("writing to a listing locator is refused", async () => {
  const { rig } = await freshRig();
  // The trailing slash makes this a listing locator.
  const [r] = await rig.receive([[`taskwatch://task/${TS}/${SLUG}/entries`, ""]]);
  assertEquals(r.accepted, false);
  assertEquals(
    (r.error ?? "").includes("listing locator"),
    true,
    `expected listing-locator error, got: ${r.error}`,
  );
});

Deno.test("batch with mixed valid + bad URIs reports per-entry results", async () => {
  const { rig } = await freshRig();
  const results = await rig.receive([
    [VALID_TITLE_URI, "ok"],
    [`taskwatch://task/${TS}-${SLUG}/title`, "bad"],
    [VALID_INDEX_URI, "ok index"],
  ]);
  assertEquals(results[0].accepted, true, results[0].error);
  assertEquals(results[1].accepted, false);
  assertEquals(results[2].accepted, true, results[2].error);
});
