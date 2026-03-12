import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("dashboard production build emits relative asset references for Electron file loading", () => {
  execFileSync("npm", ["run", "build:dashboard:web"], {
    cwd: process.cwd(),
    stdio: "pipe",
  });

  const htmlPath = path.resolve(process.cwd(), "dist/installer-dashboard/web-build/index.html");
  const html = fs.readFileSync(htmlPath, "utf8");

  assert.doesNotMatch(html, /(src|href)="\/assets\//, "Dashboard build should not emit root-absolute asset URLs.");
  assert.match(html, /(src|href)="\.\/assets\//, "Dashboard build should emit relative asset URLs for file:// loading.");
});
