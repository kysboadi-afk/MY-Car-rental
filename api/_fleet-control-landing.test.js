import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(new URL(path, import.meta.url), "utf8");
}

test("landing pages keep Fleet Control walkthrough CTAs inside the funnel", () => {
  const rootLanding = read("../landing.html");
  const publicLanding = read("../public/landing.html");

  for (const html of [rootLanding, publicLanding]) {
    assert.ok(html.includes('href="#early-access" class="btn btn-ghost">Book Guided Walkthrough</a>'));
    assert.ok(html.includes('href="#early-access" class="btn btn-light">Book Guided Walkthrough</a>'));
    assert.ok(html.includes("fetch(API_BASE + '/api/operator-leads'"));
    assert.ok(!html.includes('href="/contact.html"'));
  }
});

test("demo banner routes live walkthrough requests back to Fleet Control intake", () => {
  const admin = read("../admin-v2/index.html");
  const publicAdmin = read("../public/admin-v2/index.html");

  for (const html of [admin, publicAdmin]) {
    assert.ok(html.includes('href="../landing.html#early-access"'));
  }
});
