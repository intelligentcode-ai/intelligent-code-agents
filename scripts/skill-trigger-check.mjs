#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function printHelp() {
  process.stdout.write(
    [
      "skill-trigger-check",
      "",
      "Usage:",
      "  node scripts/skill-trigger-check.mjs --skill /path/to/SKILL.md [--skill /path/to/other/SKILL.md] [--json]",
      "  node scripts/skill-trigger-check.mjs --all /path/to/skills-root [--json]",
      "",
      "Options:",
      "  --skill <path>    Check a single SKILL.md file (repeatable).",
      "  --all <dir>       Recursively scan directory for SKILL.md files.",
      "  --json            Emit machine-readable JSON report.",
      "  --help            Show this help.",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const skillPaths = [];
  let allDir = "";
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--skill") {
      const next = argv[i + 1];
      if (!next) throw new Error("--skill requires a path value");
      skillPaths.push(next);
      i += 1;
      continue;
    }
    if (token.startsWith("--skill=")) {
      skillPaths.push(token.split("=", 2)[1]);
      continue;
    }
    if (token === "--all") {
      const next = argv[i + 1];
      if (!next) throw new Error("--all requires a directory value");
      allDir = next;
      i += 1;
      continue;
    }
    if (token.startsWith("--all=")) {
      allDir = token.split("=", 2)[1];
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return { skillPaths, allDir, json, help };
}

function collectSkillFiles(rootDir) {
  const results = [];
  const ignore = new Set([".git", "node_modules", "dist", ".idea", ".vscode"]);

  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        results.push(path.join(dir, entry.name));
      }
    }
  }

  walk(rootDir);
  return results.sort((a, b) => a.localeCompare(b));
}

function extractSection(text, heading) {
  const lines = text.split(/\r?\n/);
  const headingRe = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");

  let startIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headingRe.test(lines[i].trim())) {
      startIndex = i + 1;
      break;
    }
  }

  if (startIndex === -1) return "";

  let endIndex = lines.length;
  for (let i = startIndex; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i].trim())) {
      endIndex = i;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join("\n").trim();
}

function parseAcceptanceRows(sectionText) {
  const lines = sectionText.split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 6) continue;
    const testId = cells[1];
    const type = cells[2];
    const prompt = cells[3];
    const expected = cells[4];
    if (!testId || /^-+$/.test(testId) || /test id/i.test(testId)) continue;
    rows.push({ testId, type, prompt, expected });
  }
  return rows;
}

function parseTriggeringCues(sectionText) {
  const lines = sectionText.split(/\r?\n/);
  const positive = [];
  const negative = [];
  let mode = "none";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith("use this skill")) {
      mode = "positive";
      continue;
    }
    if (lower.startsWith("do not use this skill")) {
      mode = "negative";
      continue;
    }
    if (!line.startsWith("-")) continue;
    const cue = line.replace(/^-+\s*/, "").trim();
    if (!cue) continue;
    if (mode === "positive") positive.push(cue);
    if (mode === "negative") negative.push(cue);
  }

  return { positive, negative };
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "use",
  "when",
  "with",
  "work",
  "skill",
  "requested",
  "only",
]);

const GENERIC_ACTION_TOKENS = new Set([
  "add",
  "apply",
  "audit",
  "build",
  "create",
  "fix",
  "improve",
  "make",
  "refactor",
  "update",
  "validate",
  "write",
]);

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, "")
    .replace(/[^a-z0-9+\-./\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text) {
  return normalize(text)
    .replace(/[/-]/g, " ")
    .split(" ")
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function cueMatchesPrompt(cue, prompt, kind) {
  const nCue = normalize(cue);
  const nPrompt = normalize(prompt);
  if (!nCue || !nPrompt) return false;
  if (nPrompt.includes(nCue)) return true;

  const promptTokenSet = new Set(tokens(prompt));
  const rawCueTokens = tokens(cue);
  const specificCueTokens = rawCueTokens.filter((token) => !GENERIC_ACTION_TOKENS.has(token));
  const cueTokens = specificCueTokens.length > 0 ? specificCueTokens : rawCueTokens;
  if (cueTokens.length === 0 || promptTokenSet.size === 0) return false;

  let overlap = 0;
  for (const token of cueTokens) {
    if (promptTokenSet.has(token)) overlap += 1;
  }
  if (kind === "negative") {
    const ratio = overlap / cueTokens.length;
    return overlap >= 2 && ratio >= 0.5;
  }

  const threshold = cueTokens.length <= 2 ? cueTokens.length : cueTokens.length <= 4 ? 2 : 1;
  return overlap >= threshold;
}

function evaluateRows(rows, cues) {
  const checks = [];
  for (const row of rows) {
    const rowType = row.type.toLowerCase();
    const positiveMatch = cues.positive.some((cue) => cueMatchesPrompt(cue, row.prompt, "positive"));
    const negativeMatch = cues.negative.some((cue) => cueMatchesPrompt(cue, row.prompt, "negative"));
    const predictedTrigger = positiveMatch && !negativeMatch;

    if (rowType.includes("positive trigger")) {
      checks.push({
        testId: row.testId,
        type: row.type,
        pass: predictedTrigger,
        reason: predictedTrigger ? "Positive prompt matched triggering cues" : "Positive prompt did not match triggering cues",
      });
      continue;
    }
    if (rowType.includes("negative trigger")) {
      const pass = !predictedTrigger;
      checks.push({
        testId: row.testId,
        type: row.type,
        pass,
        reason: pass ? "Negative prompt avoided trigger cues" : "Negative prompt still matches triggering cues",
      });
      continue;
    }
    if (rowType.includes("behavior")) {
      const pass = Boolean(row.prompt) && Boolean(row.expected);
      checks.push({
        testId: row.testId,
        type: row.type,
        pass,
        reason: pass ? "Behavior row is well-formed" : "Behavior row is missing prompt or expected result",
      });
      continue;
    }

    checks.push({
      testId: row.testId,
      type: row.type,
      pass: false,
      reason: `Unrecognized acceptance test type: ${row.type}`,
    });
  }
  return checks;
}

function analyzeSkillFile(filePath) {
  const errors = [];
  const checks = [];
  let text = "";

  if (!fs.existsSync(filePath)) {
    return {
      file: filePath,
      errors: [`File not found: ${filePath}`],
      checks: [],
      summary: { pass: 0, fail: 1 },
    };
  }

  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return {
      file: filePath,
      errors: [`Unable to read file: ${String(error)}`],
      checks: [],
      summary: { pass: 0, fail: 1 },
    };
  }

  const triggering = extractSection(text, "Triggering");
  const acceptance = extractSection(text, "Acceptance Tests");
  const outputContract = extractSection(text, "Output Contract");

  if (!triggering) errors.push("Missing required section: Triggering");
  if (!acceptance) errors.push("Missing required section: Acceptance Tests");
  if (!outputContract) errors.push("Missing required section: Output Contract");

  if (acceptance) {
    const rows = parseAcceptanceRows(acceptance);
    const positives = rows.filter((row) => row.type.toLowerCase().includes("positive trigger"));
    const negatives = rows.filter((row) => row.type.toLowerCase().includes("negative trigger"));
    const behaviors = rows.filter((row) => row.type.toLowerCase().includes("behavior"));

    if (positives.length === 0) errors.push("Acceptance Tests must include at least one Positive trigger row");
    if (negatives.length === 0) errors.push("Acceptance Tests must include at least one Negative trigger row");
    if (behaviors.length === 0) errors.push("Acceptance Tests must include at least one Behavior row");

    if (triggering) {
      const cues = parseTriggeringCues(triggering);
      if (cues.positive.length === 0) errors.push("Triggering section must include positive bullet cues under 'Use this skill...'");
      checks.push(...evaluateRows(rows, cues));
    }
  }

  const failFromChecks = checks.filter((check) => !check.pass).length;
  const fail = failFromChecks + errors.length;
  const pass = checks.filter((check) => check.pass).length;

  return {
    file: filePath,
    errors,
    checks,
    summary: { pass, fail },
  };
}

function toConsole(results) {
  for (const result of results) {
    process.stdout.write(`\n${result.file}\n`);
    for (const error of result.errors) {
      process.stdout.write(`  ERROR ${error}\n`);
    }
    for (const check of result.checks) {
      process.stdout.write(`  ${check.pass ? "PASS" : "FAIL"} ${check.testId} (${check.type}) - ${check.reason}\n`);
    }
    process.stdout.write(`  Summary: ${result.summary.pass} pass, ${result.summary.fail} fail\n`);
  }
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  if (parsed.help) {
    printHelp();
    return;
  }

  const files = new Set();
  for (const skillPath of parsed.skillPaths) {
    files.add(path.resolve(skillPath));
  }
  if (parsed.allDir) {
    const allSkills = collectSkillFiles(path.resolve(parsed.allDir));
    for (const file of allSkills) files.add(file);
  }
  if (files.size === 0) {
    const defaultSkill = path.join(process.cwd(), "SKILL.md");
    if (fs.existsSync(defaultSkill)) files.add(defaultSkill);
  }
  if (files.size === 0) {
    process.stderr.write("No skill files provided. Use --skill <path> or --all <dir>.\n");
    process.exit(1);
  }

  const results = Array.from(files).map((filePath) => analyzeSkillFile(filePath));
  const failedFiles = results.filter((result) => result.summary.fail > 0).length;
  const totalFiles = results.length;
  const summary = {
    totalFiles,
    failedFiles,
    passedFiles: totalFiles - failedFiles,
    results,
  };

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    toConsole(results);
    process.stdout.write(`\nOverall: ${summary.passedFiles}/${summary.totalFiles} passed, ${summary.failedFiles} failed\n`);
  }

  if (failedFiles > 0) {
    process.exit(1);
  }
}

main();
