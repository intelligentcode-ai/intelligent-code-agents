import test from "node:test";
import assert from "node:assert/strict";
import { parseServeImageBuildMode, parseServeReusePorts, redactCliErrorMessage, shouldBuildDashboardImage } from "../../src/installer-cli/index";

test("parseServeImageBuildMode accepts auto/always/never", () => {
  assert.equal(parseServeImageBuildMode("auto"), "auto");
  assert.equal(parseServeImageBuildMode("always"), "always");
  assert.equal(parseServeImageBuildMode("never"), "never");
});

test("parseServeImageBuildMode rejects unsupported values", () => {
  assert.throws(
    () => parseServeImageBuildMode("sometimes"),
    /Invalid --build-image value/,
  );
});

test("parseServeReusePorts accepts true/false style values", () => {
  assert.equal(parseServeReusePorts("true"), true);
  assert.equal(parseServeReusePorts("false"), false);
  assert.equal(parseServeReusePorts("1"), true);
  assert.equal(parseServeReusePorts("0"), false);
});

test("parseServeReusePorts rejects unsupported values", () => {
  assert.throws(
    () => parseServeReusePorts("maybe"),
    /Invalid --reuse-ports value/,
  );
});

test("shouldBuildDashboardImage applies auto behavior for default local image", () => {
  assert.equal(
    shouldBuildDashboardImage({
      mode: "auto",
      image: "ica-dashboard:local",
      imageExists: false,
      defaultImage: "ica-dashboard:local",
    }),
    true,
  );

  assert.equal(
    shouldBuildDashboardImage({
      mode: "auto",
      image: "ica-dashboard:local",
      imageExists: true,
      defaultImage: "ica-dashboard:local",
    }),
    false,
  );
});

test("shouldBuildDashboardImage does not auto-build custom images", () => {
  assert.equal(
    shouldBuildDashboardImage({
      mode: "auto",
      image: "ghcr.io/example/ica-dashboard:latest",
      imageExists: false,
      defaultImage: "ica-dashboard:local",
    }),
    false,
  );
});

test("shouldBuildDashboardImage honors always and never", () => {
  assert.equal(
    shouldBuildDashboardImage({
      mode: "always",
      image: "anything",
      imageExists: true,
      defaultImage: "ica-dashboard:local",
    }),
    true,
  );

  assert.equal(
    shouldBuildDashboardImage({
      mode: "never",
      image: "ica-dashboard:local",
      imageExists: false,
      defaultImage: "ica-dashboard:local",
    }),
    false,
  );
});

test("redactCliErrorMessage masks API keys and token flags", () => {
  const sample =
    "Command failed: docker run -e ICA_UI_API_KEY=abcdef123 --token=secret --api-key=topsecret x-ica-api-key: abc123";
  const redacted = redactCliErrorMessage(sample);
  assert.match(redacted, /ICA_UI_API_KEY=\[REDACTED\]/);
  assert.match(redacted, /--token=\[REDACTED\]/);
  assert.match(redacted, /--api-key=\[REDACTED\]/);
  assert.match(redacted, /x-ica-api-key: \[REDACTED\]/i);
  assert.doesNotMatch(redacted, /abcdef123|topsecret|abc123/);
});
