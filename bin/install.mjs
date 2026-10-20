#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "browser-operator";
const dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(dirname, "..");
const sourceSkillRoot = path.join(packageRoot, "skills", SKILL_NAME);

function usage() {
  console.log(`BrowserOperator installer

Usage:
  npx @learnaihubc/browser-operator [options]

Options:
  --force          Replace an existing BrowserOperator skill installation
  --dest <dir>     Install into a custom skills directory
  --no-bin         Do not create the browser-operator launcher
  --help           Show this help
`);
}

function parseArgs(argv) {
  const opts = { force: false, bin: true };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--force") {
      opts.force = true;
      continue;
    }
    if (arg === "--no-bin") {
      opts.bin = false;
      continue;
    }
    if (arg === "--dest") {
      if (i + 1 >= argv.length) throw new Error("Missing value for --dest");
      opts.dest = argv[++i];
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function defaultSkillsDir() {
  return path.join(dshHome(), "skills");
}

function ensurePackageLooksLikeSkill() {
  const skillMd = path.join(sourceSkillRoot, "SKILL.md");
  if (!fs.existsSync(skillMd)) {
    throw new Error(`SKILL.md not found in package skill root: ${sourceSkillRoot}`);
  }
}

function isBrowserOperatorInstall(dir) {
  const skillMd = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillMd)) return false;
  const body = fs.readFileSync(skillMd, "utf8");
  return /^name:\s*browser-operator\s*$/m.test(body);
}

function isCompleteInstall(dir) {
  const scriptsDir = path.join(dir, "scripts");
  if (!fs.existsSync(path.join(scriptsDir, "browser.mjs"))) return false;
  return fs.existsSync(path.join(scriptsDir, "node_modules", "playwright-core", "package.json"));
}

function copyFromRoot(name, destRoot) {
  const src = path.join(packageRoot, name);
  const dest = path.join(destRoot, name);
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true, force: true, verbatimSymlinks: false });
}

function copyFromSkill(name, destRoot) {
  const src = path.join(sourceSkillRoot, name);
  const dest = path.join(destRoot, name);
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true, force: true, verbatimSymlinks: false });
}

function installDependencies(dest) {
  const scriptsDir = path.join(dest, "scripts");
  const npmArgs = ["install", "--omit=dev", "--prefix", scriptsDir];
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath && process.platform === "win32") {
    throw new Error("npm CLI path not found; run the installer with npm or npx");
  }
  const command = npmExecPath ? process.execPath : "npm";
  const args = npmExecPath ? [npmExecPath, ...npmArgs] : npmArgs;
  console.log("Installing BrowserOperator Node dependencies...");
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm install failed with exit code ${result.status}`);
  }
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function writeLauncher(skillsDir, dest) {
  const binDir = path.join(path.dirname(skillsDir), "bin");
  const target = path.join(dest, "bin", "browser");
  fs.mkdirSync(binDir, { recursive: true });
  const launcher = path.join(binDir, SKILL_NAME);
  fs.writeFileSync(launcher, `#!/bin/sh\nexec ${shQuote(target)} "$@"\n`);
  fs.chmodSync(launcher, 0o755);

  if (process.platform === "win32") {
    const cmdLauncher = path.join(binDir, `${SKILL_NAME}.cmd`);
    fs.writeFileSync(cmdLauncher, `@echo off\r\nbash "${target}" %*\r\n`);
    return cmdLauncher;
  }

  return launcher;
}

function pathContains(dir) {
  const resolved = path.resolve(dir);
  return String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => path.resolve(entry) === resolved);
}

function install(opts) {
  ensurePackageLooksLikeSkill();
  const skillsDir = path.resolve(opts.dest || defaultSkillsDir());
  const dest = path.join(skillsDir, SKILL_NAME);
  fs.mkdirSync(skillsDir, { recursive: true });

  if (fs.existsSync(dest)) {
    if (!isBrowserOperatorInstall(dest)) {
      throw new Error(`Destination exists and does not look like BrowserOperator: ${dest}`);
    }
    if (!opts.force && isCompleteInstall(dest)) {
      console.log(`BrowserOperator is already installed at ${dest}`);
      console.log("Run again with --force to replace it with this package version.");
      return;
    }
    if (!opts.force) {
      console.log(`Incomplete BrowserOperator installation found at ${dest}; reinstalling.`);
    }
    fs.rmSync(dest, { recursive: true, force: true });
  }

  fs.mkdirSync(dest, { recursive: true });
  try {
    for (const name of ["SKILL.md", "bin", "references", "scripts"]) {
      copyFromSkill(name, dest);
    }
    for (const name of ["README.md", "README_CN.md", "LICENSE"]) {
      copyFromRoot(name, dest);
    }
    installDependencies(dest);
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw err;
  }

  const launcher = opts.bin ? writeLauncher(skillsDir, dest) : null;

  console.log(`BrowserOperator installed to ${dest}`);
  if (launcher) {
    console.log(`Launcher installed to ${launcher}`);
    if (pathContains(path.dirname(launcher))) {
      console.log("Run: browser-operator open https://example.com --profile example");
    } else {
      console.log(`Run: ${launcher} open https://example.com --profile example`);
      console.log(`Optional: add ${path.dirname(launcher)} to PATH to use browser-operator directly.`);
    }
  }
  console.log("Restart your agent, then use the browser-operator skill.");
}

try {
  install(parseArgs(process.argv));
} catch (err) {
  console.error(`BrowserOperator install failed: ${err.message || err}`);
  process.exit(1);
}
