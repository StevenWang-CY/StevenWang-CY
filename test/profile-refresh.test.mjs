import test from "node:test";
import assert from "node:assert/strict";
import { artworkWithFallback } from "../scripts/profile-design.mjs";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1kAAAAASUVORK5CYII=";
const poster = { kind: "static", mime: "image/png", base64: png };
const previous = `<svg><image href="data:image/png;base64,${png}"/></svg>`;
const unavailable = async () => { throw new Error("HTTP 404: artwork moved"); };

test("fresh project artwork replaces the previous poster", async () => {
  const fresh = { ...poster };
  assert.equal(await artworkWithFallback(async () => fresh, previous), fresh);
});

test("a moved or unavailable upstream image preserves the published poster", async () => {
  const warnings = [];
  assert.deepEqual(await artworkWithFallback(unavailable, previous, (message) => warnings.push(message)), poster);
  assert.match(warnings[0], /retaining the last published poster/);
});

test("an empty upstream result preserves the published poster", async () => {
  assert.deepEqual(await artworkWithFallback(async () => null, previous, () => {}), poster);
});

test("missing or untrusted cached artwork cannot block live metrics", async () => {
  for (const cache of ["", '<image href="https://example.com/image.png"/>', '<image href="data:image/png;base64,AAAA"/>']) {
    assert.equal(await artworkWithFallback(unavailable, cache, () => {}), null);
  }
});
