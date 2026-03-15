export type SourceTransport = "https" | "ssh";
export type SourcePublishMode = "direct-push" | "branch-only" | "branch-pr";
export type SourceProviderHint = "github" | "gitlab" | "bitbucket" | "unknown";

export interface SourceManagementSource {
  publishDefaultMode?: SourcePublishMode;
  defaultBaseBranch?: string;
  providerHint?: SourceProviderHint;
  officialContributionEnabled?: boolean;
}

export interface SourcePublishDraft {
  publishDefaultMode: SourcePublishMode;
  defaultBaseBranch: string;
  providerHint: SourceProviderHint;
  officialContributionEnabled: boolean;
}

export interface NewSourceDraft extends SourcePublishDraft {
  name: string;
  repoUrl: string;
  transport: SourceTransport;
  token: string;
}

export function createSourcePublishDraft(source?: SourceManagementSource | null): SourcePublishDraft {
  return {
    publishDefaultMode: source?.publishDefaultMode || "branch-pr",
    defaultBaseBranch: source?.defaultBaseBranch || "main",
    providerHint: source?.providerHint || "unknown",
    officialContributionEnabled: Boolean(source?.officialContributionEnabled),
  };
}

export function createNewSourceDraft(): NewSourceDraft {
  return {
    name: "",
    repoUrl: "",
    transport: "https",
    token: "",
    ...createSourcePublishDraft(),
  };
}
