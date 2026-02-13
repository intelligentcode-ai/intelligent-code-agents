const BLOCKED_SKILLS = new Set(["ica-get-setting", "ica-version"]);

export function isSkillBlocked(skillName: string): boolean {
  return BLOCKED_SKILLS.has(skillName.trim().toLowerCase());
}

