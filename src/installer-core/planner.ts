import { InstallState, PlannerDelta } from "./types";

export function computePlannerDelta(
  selectedSkillIds: string[],
  state: InstallState | null,
  removeUnselected = false,
): PlannerDelta {
  const selected = new Set(selectedSkillIds);
  const installed = new Set((state?.managedSkills || []).map((skill) => skill.skillId || skill.name));

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
