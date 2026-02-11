import { InstallState, PlannerDelta } from "./types";

export function computePlannerDelta(
  selectedSkills: string[],
  state: InstallState | null,
  removeUnselected = false,
): PlannerDelta {
  const selected = new Set(selectedSkills);
  const installed = new Set((state?.managedSkills || []).map((skill) => skill.name));

  const toInstall = Array.from(selected).filter((skill) => !installed.has(skill));
  const alreadyInstalled = Array.from(selected).filter((skill) => installed.has(skill));
  const toRemove = removeUnselected
    ? Array.from(installed).filter((skill) => !selected.has(skill))
    : [];

  return {
    toInstall: toInstall.sort(),
    toRemove: toRemove.sort(),
    alreadyInstalled: alreadyInstalled.sort(),
  };
}
