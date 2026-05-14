import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, DEFAULT_HOMEPAGE_URL } from "../runtime/github-app-manifest.js";

describe("buildManifest", () => {
  it("uses the requested name, description, and redirect_url verbatim", () => {
    const m = buildManifest({
      name: "acme-pm",
      redirectUrl: "http://localhost:8765/callback",
      description: "PM bot for Acme fleet",
    });
    assert.equal(m.name, "acme-pm");
    assert.equal(m.redirect_url, "http://localhost:8765/callback");
    assert.equal(m.description, "PM bot for Acme fleet");
  });

  it("falls back to the fleetmind repo URL for homepage when not provided", () => {
    // GitHub rejects localhost URLs in the manifest's 'url' field with the
    // counter-intuitive error 'url wasn't supplied'. Default must be public.
    const m = buildManifest({ name: "x", redirectUrl: "http://localhost:8765/callback" });
    assert.equal(m.url, DEFAULT_HOMEPAGE_URL);
    assert.ok(m.url.startsWith("https://"), "default homepage must be https:// for GitHub");
    assert.ok(!m.url.includes("localhost"), "default homepage must not be a localhost URL");
  });

  it("respects an explicit homepage URL", () => {
    const m = buildManifest({
      name: "x",
      redirectUrl: "http://localhost:8765/callback",
      homepageUrl: "https://example.com",
    });
    assert.equal(m.url, "https://example.com");
  });

  it("includes the expected permission scopes", () => {
    const m = buildManifest({ name: "x", redirectUrl: "http://localhost:8765/callback" });
    assert.equal(m.default_permissions.contents, "write");
    assert.equal(m.default_permissions.pull_requests, "write");
    assert.equal(m.default_permissions.issues, "write");
    assert.equal(m.default_permissions.actions, "write");
    assert.equal(m.default_permissions.checks, "read");
    assert.equal(m.default_permissions.metadata, "read");
  });

  it("omits hook_attributes entirely (GitHub's schema only documents .url; { active: false } fails validation)", () => {
    const m = buildManifest({ name: "x", redirectUrl: "http://localhost:8765/callback" });
    assert.equal((m as unknown as Record<string, unknown>).hook_attributes, undefined);
  });

  it("subscribes to no events by default", () => {
    const m = buildManifest({ name: "x", redirectUrl: "http://localhost:8765/callback" });
    assert.deepEqual(m.default_events, []);
  });

  it("is private (not publishable to the GitHub Marketplace)", () => {
    const m = buildManifest({ name: "x", redirectUrl: "http://localhost:8765/callback" });
    assert.equal(m.public, false);
  });
});
