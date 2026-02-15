import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function readCssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "m");
  const match = css.match(regex);
  assert.ok(match, `Expected CSS rule for selector: ${selector}`);
  return match[1];
}

test("source action buttons enforce equal height contract", () => {
  const stylesheet = path.resolve(process.cwd(), "src/installer-dashboard/web/src/styles.css");
  const css = fs.readFileSync(stylesheet, "utf8");
  const rule = readCssRule(css, ".source-actions .btn-inline");

  assert.match(rule, /display:\s*inline-flex\s*;/);
  assert.match(rule, /justify-content:\s*center\s*;/);
  assert.match(rule, /align-items:\s*center\s*;/);
  assert.match(rule, /min-block-size:\s*2\.6rem\s*;/);
});

test("publish quick-action buttons enforce equal height contract", () => {
  const stylesheet = path.resolve(process.cwd(), "src/installer-dashboard/web/src/styles.css");
  const css = fs.readFileSync(stylesheet, "utf8");
  const rule = readCssRule(css, ".publish-quick-actions .btn");

  assert.match(rule, /display:\s*inline-flex\s*;/);
  assert.match(rule, /align-items:\s*center\s*;/);
  assert.match(rule, /justify-content:\s*center\s*;/);
  assert.match(rule, /min-block-size:\s*2\.7rem\s*;/);
});
