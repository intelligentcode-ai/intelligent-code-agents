import test from "node:test";
import assert from "node:assert/strict";
import { describeDesktopOperation } from "../../src/desktop-electron/controlPlane";

test("desktop control-plane classifies install and sync apply requests as operation events", () => {
  const install = describeDesktopOperation({
    pathname: "/api/v1/install/apply",
    method: "POST",
    body: {
      targets: ["codex"],
    },
  });
  const sync = describeDesktopOperation({
    pathname: "/api/v1/sync/apply",
    method: "POST",
    body: {
      targets: ["claude"],
    },
  });

  assert.equal(install?.payload.operation, "install");
  assert.deepEqual(install?.payload.targets, ["codex"]);
  assert.equal(sync?.payload.operation, "sync");
  assert.deepEqual(sync?.payload.targets, ["claude"]);
});

test("desktop control-plane classifies publish requests as operation events", () => {
  const publish = describeDesktopOperation({
    pathname: "/api/v1/skills/publish",
    method: "POST",
    body: {
      sourceId: "official",
    },
  });

  assert.equal(publish?.payload.operation, "publish");
  assert.equal(publish?.payload.sourceId, "official");
});
