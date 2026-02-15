import test from "node:test";
import assert from "node:assert/strict";
import {
  parseServeImageBuildMode,
  parseServeRefreshMinutes,
  parseServeReusePorts,
  shouldBuildDashboardImage,
  redactCliErrorMessage,
} from "../../src/installer-cli/index";

test("parseServeImageBuildMode accepts supported values", () => {
  assert.equal(parseServeImageBuildMode("auto"), "auto");
  assert.equal(parseServeImageBuildMode("always"), "always");
  assert.equal(parseServeImageBuildMode("never"), "never");
});

test("parseServeReusePorts normalizes truthy and falsey flags", () => {
  assert.equal(parseServeReusePorts("true"), true);
  assert.equal(parseServeReusePorts("yes"), true);
  assert.equal(parseServeReusePorts("0"), false);
  assert.equal(parseServeReusePorts("off"), false);
});

test("parseServeRefreshMinutes validates numeric values", () => {
  assert.equal(parseServeRefreshMinutes("60"), 60);
  assert.equal(parseServeRefreshMinutes("0"), 0);
});

test("shouldBuildDashboardImage skips GHCR auto-build and redacts CLI secrets", () => {
  assert.equal(
    shouldBuildDashboardImage({
      mode: "auto",
      image: "ghcr.io/intelligentcode-ai/ica-installer-dashboard:main",
      imageExists: false,
      defaultImage: "ghcr.io/intelligentcode-ai/ica-installer-dashboard:main",
    }),
    false,
  );

  assert.equal(
    shouldBuildDashboardImage({
      mode: "auto",
      image: "ica-dashboard:local",
      imageExists: false,
      defaultImage: "ghcr.io/intelligentcode-ai/ica-installer-dashboard:main",
    }),
    false,
  );

  const redacted = redactCliErrorMessage(
    "ICA_API_KEY=abc123 --api-key=xyz789 x-ica-api-key: secret",
  );
  assert.match(redacted, /ICA_API_KEY=\[REDACTED\]/);
  assert.match(redacted, /--api-key=\[REDACTED\]/);
  assert.match(redacted, /x-ica-api-key: \[REDACTED\]/i);
});
