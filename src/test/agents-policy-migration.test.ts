/** Existing PR314 workspaces must receive policy changes through pull-self's
 * section merge, preserving unrelated local sections. Fixtures were generated
 * with PR314's production provisioner/templates (see fixtures/pr314-agents). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { FleetSchema } from "../config/schema.js";
import { provisionAgent } from "../runtime/provisioner.js";
import { fleetmindPackageRoot } from "../runtime/resolver.js";
import { computeConfiguredFleetSkillGaps } from "../runtime/skills-manifest.js";
import { applyDiff, mergeMarkdownSections, parseMarkdownSections } from "../cli/commands/pull-self.js";

const customSections = "## Local operator preferences\n\nKeep the MemPalace review notes.  \nUse /opt/work/author for local artifacts.\n\n### Local incident notes\n\nOwner: 🧭 on-call\n| Event | Evidence |\n| --- | --- |\n| Restart | Preserve the original task reference. |\n";

describe("PR314 AGENTS policy migration through pull-self", () => {
  for (const role of ["pm", "worker", "backend-worker", "frontend-worker"] as const) {
    for (const enabled of [false, true]) {
      test(`${role}: delegation=${enabled} replaces old policy and preserves local sections`, async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fm-policy-migration-"));
        try {
          const fleet = FleetSchema.parse({
            fleet: { name: "migration-fixture" },
            targets: { box: { provider: "local", os: "linux" } },
            agents: { defaults: { target: "box" }, list: [
              { id: "author", name: "Author", emoji: "🛠", role, skills: [] },
              { id: "peer", name: "Peer", emoji: "🧭", role: "worker", skills: [], channels: [{
                provider: "slack", account_id: "peer", bot_user_id: "U_FIXTURE_PEER",
                bot_token: "fixture-only-bot-token", app_token: "fixture-only-app-token", channels: ["C_FIXTURE_ROOM"],
              }] },
            ] },
            delegation: { enabled, ...(enabled ? { table_name: "fixture-tasks", s3_bucket: "fixture-narratives" } : {}) },
          });
          const agent = fleet.agents.list[0];
          // Exercise bundled protocol installation, never external skill registries.
          agent.skills.push(...computeConfiguredFleetSkillGaps(fleet)[0].missing.filter((skill) => skill.source === "fleetmind"));
          await provisionAgent(fleet, agent, false, directory);
          const incomingDir = path.join(directory, "rendered/workspaces/author");
          const incoming = fs.readFileSync(path.join(incomingDir, "AGENTS.md"), "utf8");
          const fixture = fs.readFileSync(path.join(fleetmindPackageRoot(), "src/test/fixtures/pr314-agents", `${role}.md`), "utf8");
          // Also represent a stale local instruction within the existing review
          // section, separate from genuinely bot-owned sections appended below.
          const legacy = role === "pm" ? fixture.replace("### PR Review Workflow\n", "### PR Review Workflow\n\nEvery child must post publicly and end with NO_REPLY.\n") : fixture;
          const local = legacy + "\n" + customSections;
          const legacyKeys = parseMarkdownSections(legacy).sections.map((section) => section.headingKey);
          assert.ok(legacyKeys.includes("skills first"));
          assert.ok(legacyKeys.includes("delegation protocol"));
          const merged = mergeMarkdownSections(local, incoming);
          assert.ok(merged !== null);

          // Exercise the real applyDiff callsite too, with a modified local file.
          const workspace = path.join(directory, "existing-workspace");
          fs.mkdirSync(workspace);
          fs.writeFileSync(path.join(workspace, "AGENTS.md"), local);
          const diff = { added: [], deleted: [], modified: [{
            incoming: { path: "AGENTS.md", size: Buffer.byteLength(incoming), mode: 0o644,
              sha256: createHash("sha256").update(incoming).digest("hex") },
            currentSize: Buffer.byteLength(local),
          }] };
          applyDiff(incomingDir, workspace, diff);
          const result = fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8");
          assert.equal(result, merged);
          const sections = parseMarkdownSections(result).sections;
          const keys = sections.map((section) => section.headingKey);
          assert.equal(keys.filter((key) => key.startsWith("skills first")).length, 1, "stale Skills First must not survive beside its replacement");
          assert.equal(keys.filter((key) => /^(?:independent fleet )?delegation protocol$/.test(key)).length, 1, "stale worker protocol must not survive beside its replacement");
          assert.equal(keys.filter((key) => key === "slack conventions" || key === "channel routing").length, role === "pm" ? 1 : 0);
          assert.equal(new Set(keys).size, keys.length, "no duplicate heading keys");
          assert.match(result, /Direct work/);
          assert.match(result, /focused coding/);
          assert.match(result, /report privately to the parent/);
          assert.match(result, /parent owns user-facing closeout/);
          assert.ok(result.includes(`Fleet delegation is **${enabled ? "enabled" : "disabled"}**`));
          if (!enabled) assert.match(result, /skip independent fleet ledger, notices and protocol steps/);
          assert.doesNotMatch(result, /NO_REPLY|Every child must post publicly|Sub-agent posts the review request|signoff-watchdog mode|nudges the reviewer every 4h|Every reply that needs to land in a specific delegation thread MUST/);
          assert.ok(result.includes(customSections), "custom section bytes, spacing and Unicode must survive");
          assert.match(result, /Peer/);
          assert.match(result, /<@U_FIXTURE_PEER>/);
          if (role === "pm") {
            for (const key of ["pr review workflow", "definition of done", "close-the-loop routing"]) {
              assert.equal(sections.find((section) => section.headingKey === key)?.autoTagged, true, `${key} is independently operator-owned`);
            }
            assert.match(result, /Human signoff is required/);
            assert.match(result, /Envelopes contain \*what\*, \*why\*, and a definition of done/);
            assert.match(result, /task does not\nclose until `fleetmind task merge`/);
          }
          assert.equal(fs.existsSync(path.join(incomingDir, "skills/worker-self-start")), enabled);
          assert.equal(mergeMarkdownSections(result, incoming), result, "second merge is byte-idempotent");
          applyDiff(incomingDir, workspace, diff);
          assert.equal(fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8"), result, "second applyDiff is byte-idempotent");
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
      });
    }
  }
});
