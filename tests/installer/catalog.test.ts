import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildLocalCatalog } from "../../src/installer-core/catalog";

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
