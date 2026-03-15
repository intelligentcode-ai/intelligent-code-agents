import test from "node:test";
import assert from "node:assert/strict";
import {
  createNewSourceDraft,
  createSourcePublishDraft,
  type NewSourceDraft,
} from "../../src/installer-dashboard/web/src/source-management-state";

test("createSourcePublishDraft derives publish defaults from an existing source", () => {
  const draft = createSourcePublishDraft({
    publishDefaultMode: "branch-only",
    defaultBaseBranch: "dev",
    providerHint: "gitlab",
    officialContributionEnabled: true,
  });

  assert.deepEqual(draft, {
    publishDefaultMode: "branch-only",
    defaultBaseBranch: "dev",
    providerHint: "gitlab",
    officialContributionEnabled: true,
  });
});

test("createSourcePublishDraft falls back to the desktop publish defaults", () => {
  assert.deepEqual(createSourcePublishDraft(), {
    publishDefaultMode: "branch-pr",
    defaultBaseBranch: "main",
    providerHint: "unknown",
    officialContributionEnabled: false,
  });
});

test("new source draft state is independent from selected-source publish settings", () => {
  const newDraft: NewSourceDraft = createNewSourceDraft();
  newDraft.publishDefaultMode = "direct-push";
  newDraft.defaultBaseBranch = "release";
  newDraft.providerHint = "github";
  newDraft.officialContributionEnabled = true;
  newDraft.repoUrl = "https://github.com/example/repo.git";

  const selectedSourceDraft = createSourcePublishDraft({
    publishDefaultMode: "branch-only",
    defaultBaseBranch: "dev",
    providerHint: "gitlab",
    officialContributionEnabled: false,
  });

  assert.equal(selectedSourceDraft.publishDefaultMode, "branch-only");
  assert.equal(selectedSourceDraft.defaultBaseBranch, "dev");
  assert.equal(selectedSourceDraft.providerHint, "gitlab");
  assert.equal(selectedSourceDraft.officialContributionEnabled, false);
  assert.equal(newDraft.repoUrl, "https://github.com/example/repo.git");
});
