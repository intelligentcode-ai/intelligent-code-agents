import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildLocalCatalog, loadCatalogFromSources } from "../../src/installer-core/catalog";

test("buildLocalCatalog defaults to deterministic generatedAt", () => {
  const catalog = buildLocalCatalog(process.cwd(), "1.0.0");
  assert.equal(catalog.generatedAt, "1970-01-01T00:00:00.000Z");
});

test("buildLocalCatalog honors SOURCE_DATE_EPOCH when numeric", () => {
  const catalog = buildLocalCatalog(process.cwd(), "1.0.0", "1735689600");
  assert.equal(catalog.generatedAt, "2025-01-01T00:00:00.000Z");
});

test("buildLocalCatalog falls back when SOURCE_DATE_EPOCH is invalid", () => {
  const catalog = buildLocalCatalog(process.cwd(), "1.0.0", "not-a-number");
  assert.equal(catalog.generatedAt, "1970-01-01T00:00:00.000Z");
});

test("buildLocalCatalog resource discovery ignores directories and sorts files", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-catalog-test-"));
  const skillRoot = path.join(tmpRoot, "src", "skills", "demo");
  const scriptsDir = path.join(skillRoot, "scripts");
  fs.mkdirSync(path.join(scriptsDir, "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, "SKILL.md"), "---\nname: demo\n---\n", "utf8");
  fs.writeFileSync(path.join(scriptsDir, "zeta.py"), "# z\n", "utf8");
  fs.writeFileSync(path.join(scriptsDir, "alpha.py"), "# a\n", "utf8");

  const catalog = buildLocalCatalog(tmpRoot, "1.0.0");
  assert.equal(catalog.skills.length, 1);
  assert.deepEqual(catalog.skills[0].resources, [
    { type: "scripts", path: "skills/demo/scripts/alpha.py" },
    { type: "scripts", path: "skills/demo/scripts/zeta.py" },
  ]);
  assert.match(String(catalog.skills[0].contentDigest || ""), /^sha256:[a-f0-9]{64}$/);
  assert.equal(typeof catalog.skills[0].contentFileCount, "number");
});

test("buildLocalCatalog excludes blocked ICA command skills", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-catalog-test-"));
  const skillsRoot = path.join(tmpRoot, "src", "skills");
  const blockedSkill = path.join(skillsRoot, "ica-version");
  const normalSkill = path.join(skillsRoot, "reviewer");

  fs.mkdirSync(blockedSkill, { recursive: true });
  fs.mkdirSync(normalSkill, { recursive: true });
  fs.writeFileSync(path.join(blockedSkill, "SKILL.md"), "---\nname: ica-version\n---\n", "utf8");
  fs.writeFileSync(path.join(normalSkill, "SKILL.md"), "---\nname: reviewer\n---\n", "utf8");

  const catalog = buildLocalCatalog(tmpRoot, "1.0.0");
  assert.equal(catalog.skills.length, 1);
  assert.equal(catalog.skills[0].name, "reviewer");
});

test("buildLocalCatalog parses scope/subcategory/tags from skill frontmatter", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-catalog-test-"));
  const skillRoot = path.join(tmpRoot, "src", "skills", "demo");
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(
    path.join(skillRoot, "SKILL.md"),
    `---
name: demo
description: Demo skill
category: command
scope: system-management
subcategory: setup
tags:
  - onboarding
  - bootstrap
---

# Demo
`,
    "utf8",
  );

  const catalog = buildLocalCatalog(tmpRoot, "1.0.0");
  assert.equal(catalog.skills.length, 1);
  assert.equal(catalog.skills[0].scope, "system-management");
  assert.equal(catalog.skills[0].subcategory, "setup");
  assert.deepEqual(catalog.skills[0].tags, ["onboarding", "bootstrap"]);
});

test("loadCatalogFromSources falls back to bundled snapshot with stale diagnostics when sources are unavailable", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-catalog-fallback-test-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-catalog-state-test-"));
  const previous = process.env.ICA_STATE_HOME;
  process.env.ICA_STATE_HOME = stateRoot;

  try {
    fs.mkdirSync(path.join(tempRoot, "src", "catalog"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "VERSION"), "1.2.3\n", "utf8");
    fs.writeFileSync(
      path.join(tempRoot, "src", "catalog", "skills.catalog.json"),
      JSON.stringify(
        {
          generatedAt: "2026-01-01T00:00:00.000Z",
          source: "multi-source",
          version: "1.2.3",
          sources: [],
          skills: [
            {
              skillId: "official-skills/snapshot-demo",
              sourceId: "official-skills",
              sourceName: "official",
              sourceUrl: "https://github.com/intelligentcode-ai/skills.git",
              skillName: "snapshot-demo",
              name: "snapshot-demo",
              description: "bundled snapshot",
              category: "process",
              dependencies: [],
              compatibleTargets: ["claude", "codex", "cursor", "gemini", "antigravity"],
              resources: [],
              sourcePath: "/tmp/snapshot-demo",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(
      path.join(stateRoot, "sources.json"),
      JSON.stringify(
        {
          sources: [
            {
              id: "official-skills",
              name: "official",
              repoUrl: "https://github.com/intelligentcode-ai/skills.git",
              transport: "https",
              official: true,
              enabled: false,
              skillsRoot: "/skills",
              removable: true,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const catalog = await loadCatalogFromSources(tempRoot, true);
    assert.equal(catalog.skills.length, 1);
    assert.equal(catalog.skills[0].skillName, "snapshot-demo");
    assert.equal(catalog.catalogSource, "snapshot");
    assert.equal(catalog.stale, true);
    assert.match(String(catalog.staleReason || ""), /snapshot/i);
  } finally {
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  }
});

test("loadCatalogFromSources prefers runtime cache over bundled snapshot when live catalog is unavailable", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-catalog-cache-test-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-catalog-state-test-"));
  const previous = process.env.ICA_STATE_HOME;
  process.env.ICA_STATE_HOME = stateRoot;

  try {
    fs.mkdirSync(path.join(tempRoot, "src", "catalog"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "VERSION"), "2.0.0\n", "utf8");
    fs.writeFileSync(
      path.join(tempRoot, "src", "catalog", "skills.catalog.json"),
      JSON.stringify(
        {
          generatedAt: "2026-01-01T00:00:00.000Z",
          source: "multi-source",
          version: "2.0.0",
          sources: [],
          skills: [
            {
              skillId: "official-skills/snapshot-only",
              sourceId: "official-skills",
              sourceName: "official",
              sourceUrl: "https://github.com/intelligentcode-ai/skills.git",
              skillName: "snapshot-only",
              name: "snapshot-only",
              description: "snapshot-only",
              category: "process",
              dependencies: [],
              compatibleTargets: ["claude", "codex", "cursor", "gemini", "antigravity"],
              resources: [],
              sourcePath: "/tmp/snapshot-only",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateRoot, "sources.json"),
      JSON.stringify(
        {
          sources: [
            {
              id: "official-skills",
              name: "official",
              repoUrl: "https://github.com/intelligentcode-ai/skills.git",
              transport: "https",
              official: true,
              enabled: false,
              skillsRoot: "/skills",
              removable: true,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.mkdirSync(path.join(stateRoot, "catalog"), { recursive: true });
    fs.writeFileSync(
      path.join(stateRoot, "catalog", "skills.catalog.json"),
      JSON.stringify(
        {
          generatedAt: "2026-02-14T00:00:00.000Z",
          source: "multi-source",
          version: "2.0.0",
          sources: [],
          skills: [
            {
              skillId: "official-skills/cache-demo",
              sourceId: "official-skills",
              sourceName: "official",
              sourceUrl: "https://github.com/intelligentcode-ai/skills.git",
              skillName: "cache-demo",
              name: "cache-demo",
              description: "cached",
              category: "process",
              dependencies: [],
              compatibleTargets: ["claude", "codex", "cursor", "gemini", "antigravity"],
              resources: [],
              sourcePath: "/tmp/cache-demo",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const catalog = await loadCatalogFromSources(tempRoot, true);
    assert.equal(catalog.skills.length, 1);
    assert.equal(catalog.skills[0].skillName, "cache-demo");
    assert.equal(catalog.catalogSource, "cache");
    assert.equal(catalog.stale, true);
    assert.ok(typeof catalog.cacheAgeSeconds === "number");
  } finally {
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  }
});

test("loadCatalogFromSources tolerates live refresh exceptions and serves snapshot fallback", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-catalog-exception-test-"));
  const badStateRoot = path.join(tempRoot, "state-file");
  const previous = process.env.ICA_STATE_HOME;
  process.env.ICA_STATE_HOME = badStateRoot;

  try {
    fs.writeFileSync(badStateRoot, "not-a-directory", "utf8");
    fs.mkdirSync(path.join(tempRoot, "src", "catalog"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "VERSION"), "3.0.0\n", "utf8");
    fs.writeFileSync(
      path.join(tempRoot, "src", "catalog", "skills.catalog.json"),
      JSON.stringify(
        {
          generatedAt: "2026-01-01T00:00:00.000Z",
          source: "multi-source",
          version: "3.0.0",
          sources: [],
          skills: [
            {
              skillId: "official-skills/snapshot-rescue",
              sourceId: "official-skills",
              sourceName: "official",
              sourceUrl: "https://github.com/intelligentcode-ai/skills.git",
              skillName: "snapshot-rescue",
              name: "snapshot-rescue",
              description: "snapshot fallback",
              category: "process",
              dependencies: [],
              compatibleTargets: ["claude", "codex", "cursor", "gemini", "antigravity"],
              resources: [],
              sourcePath: "/tmp/snapshot-rescue",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const catalog = await loadCatalogFromSources(tempRoot, true);
    assert.equal(catalog.catalogSource, "snapshot");
    assert.equal(catalog.stale, true);
    assert.equal(catalog.skills[0].skillName, "snapshot-rescue");
  } finally {
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  }
});
