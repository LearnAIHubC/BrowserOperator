#!/usr/bin/env node
/**
 * browser-operator — persistent headed Chrome + real mouse automation.
 *
 * The CLI talks to a per-profile daemon. The daemon owns one persistent
 * Chrome profile (cookies/localStorage/login survive restarts) and one HTTP
 * endpoint on 127.0.0.1. Commands never dump cookies or profile contents.
 *
 * Real click path: Playwright locator.click(), which scrolls into view,
 * checks actionability/hit target, and dispatches trusted CDP mouse input.
 * --js is an explicit, untrusted fallback and is never used automatically.
 */

import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, release as osRelease } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const SELF = fileURLToPath(import.meta.url);
const HOME = process.env.BROWSER_OPERATOR_HOME || join(homedir(), ".dsh", "browser-operator");
const PROFILES = join(HOME, "profiles");
const SHOTS = join(HOME, "screenshots");
const EXPERIENCES = join(HOME, "experiences");
const RECIPES = join(HOME, "脚本");
const LOGS = join(HOME, "logs");
const SKILL_CONFIG = join(HOME, "config.json");
const DEFAULT_PROFILE = "default";
const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_SNAPSHOT_CHARS = 30_000;

// ── small utilities ───────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensureHome() {
  mkdirSync(PROFILES, { recursive: true, mode: 0o700 });
  mkdirSync(SHOTS, { recursive: true, mode: 0o700 });
  mkdirSync(EXPERIENCES, { recursive: true, mode: 0o700 });
}

function readSkillConfig() {
  if (!existsSync(SKILL_CONFIG)) return { annotationEnabled: true };
  const config = JSON.parse(readFileSync(SKILL_CONFIG, "utf8"));
  if (config.annotationEnabled !== undefined && typeof config.annotationEnabled !== "boolean") {
    throw fail("bad-config", "skill 配置 annotationEnabled 必须是 true 或 false");
  }
  return config;
}

function setAnnotationEnabled(enabled) {
  ensureHome();
  writeJson(SKILL_CONFIG, { ...readSkillConfig(), annotationEnabled: enabled });
}

function profileDir(profile) {
  return join(PROFILES, profile);
}

function profilePaths(profile) {
  const dir = profileDir(profile);
  return {
    dir,
    chrome: join(dir, "chrome-profile"),
    daemon: join(dir, "daemon.json"),
    meta: join(dir, "meta.json"),
    error: join(dir, "error.json"),
    log: join(dir, "daemon.log"),
    settings: join(dir, "settings.json"),
  };
}

function readSettings(profile) {
  try {
    return JSON.parse(readFileSync(profilePaths(profile).settings, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeSettings(profile, patch) {
  ensureProfileDirs(profile);
  const next = { ...readSettings(profile), ...patch };
  writeFileSync(profilePaths(profile).settings, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

function ensureProfileDirs(profile) {
  ensureHome();
  const paths = profilePaths(profile);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.chrome, { recursive: true, mode: 0o700 });
  return paths;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function removeFile(path) {
  try {
    unlinkSync(path);
  } catch {}
}

function maskUrl(value) {
  const text = String(value || "");
  try {
    const url = new URL(text);
    for (const key of ["token", "access_token", "refresh_token", "code", "secret", "key", "password"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "***");
    }
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return text.replace(/(token|access_token|refresh_token|code|secret|key|password)=[^&]+/gi, "$1=***");
  }
}

function firstLine(value) {
  return String(value || "").split("\n").map((line) => line.trim()).find(Boolean) || "unknown error";
}

class ActionError extends Error {
  constructor(code, message, diagnosis = undefined) {
    super(message);
    this.name = "ActionError";
    this.code = code;
    this.diagnosis = diagnosis;
  }
}

function fail(code, message, diagnosis) {
  return new ActionError(code, message, diagnosis);
}

// ── Chrome discovery ─────────────────────────────────────────────

function findChrome() {
  const explicit = process.env.CHROME_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    );
  } else if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    );
  }

  // Playwright's bundled Chromium, if present.
  const cacheRoots = [
    join(homedir(), "Library", "Caches", "ms-playwright"),
    join(homedir(), ".cache", "ms-playwright"),
    join(process.env.LOCALAPPDATA || "", "ms-playwright"),
  ];
  for (const root of cacheRoots) {
    if (!existsSync(root)) continue;
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries.filter((name) => name.startsWith("chromium-")).sort().reverse()) {
      if (process.platform === "darwin") {
        candidates.push(
          join(root, entry, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
          join(root, entry, "chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
        );
      } else if (process.platform === "win32") {
        candidates.push(join(root, entry, "chrome-win64", "chrome.exe"));
      } else {
        candidates.push(join(root, entry, "chrome-linux", "chrome"));
      }
    }
  }

  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) {
    throw new Error(
      "未找到 Chrome。请安装 Google Chrome，或设置 CHROME_PATH 指向 chrome 可执行文件。",
    );
  }
  return found;
}

// ── fingerprint ──────────────────────────────────────────────────

function detectChromeVersion(executablePath) {
  try {
    const out = spawnSync(executablePath, ["--version"], { encoding: "utf8", timeout: 5000 });
    const match = String(out.stdout || out.stderr || "").match(/(\d+\.\d+\.\d+\.\d+)/);
    if (match) return match[1];
  } catch {}
  // Windows GUI builds usually print nothing for --version. The installed
  // Chrome keeps the version as a directory name, so read it from there.
  const candidates = [];
  try {
    const base = dirname(executablePath);
    const dirs = process.platform === "win32"
      ? [base]
      : process.platform === "darwin"
        ? [resolve(base, "..", "Frameworks", "Google Chrome Framework.framework", "Versions")]
        : [];
    for (const dir of dirs) {
      try {
        for (const name of readdirSync(dir)) {
          if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) candidates.push(name);
        }
      } catch {}
    }
  } catch {}
  if (!candidates.length) return "";
  candidates.sort((a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 4; i += 1) {
      if (pa[i] !== pb[i]) return pb[i] - pa[i];
    }
    return 0;
  });
  return candidates[0];
}

function detectGpu() {
  if (process.platform === "darwin") {
    try {
      const out = spawnSync("system_profiler", ["SPDisplaysDataType"], { encoding: "utf8", timeout: 8000 });
      const chip = String(out.stdout || "").match(/Chipset Model:\s*(.+)/)?.[1]?.trim();
      if (chip) {
        return {
          vendor: "Google Inc. (Apple)",
          renderer: `ANGLE (Apple, ANGLE Metal Renderer: ${chip}, Unspecified Version)`,
        };
      }
    } catch {}
    return {
      vendor: "Google Inc. (Apple)",
      renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)",
    };
  }
  if (process.platform === "win32") {
    return {
      vendor: "Google Inc. (Intel)",
      renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    };
  }
  return {
    vendor: "Google Inc. (Intel)",
    renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 630, OpenGL 4.6)",
  };
}

function platformName() {
  if (process.platform === "darwin") return "MacIntel";
  if (process.platform === "win32") return "Win32";
  return "Linux x86_64";
}

function buildUserAgent(chromeVersion) {
  const platform = process.platform === "darwin"
    ? "Macintosh; Intel Mac OS X 10_15_7"
    : process.platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : "X11; Linux x86_64";
  // Real Chrome reduces the UA to MAJOR.0.0.0; the full build only appears in
  // User-Agent Client Hints. Keep the same shape so UA and UA-CH agree.
  const major = String(chromeVersion || "124").split(".")[0] || "124";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function normalizeLocale(raw) {
  const parts = String(raw || "").replace(/_/g, "-").split("-").filter(Boolean);
  const lang = (parts[0] || "").toLowerCase();
  if (!lang) return "";
  const script = parts.find((part) => /^[A-Z][a-z]{3}$/.test(part));
  const region = parts.find((part) => /^[A-Z]{2}$/.test(part) || /^[0-9]{3}$/.test(part));
  if (lang === "zh") {
    if (script === "Hant" || ["TW", "HK", "MO"].includes(region)) return "zh-TW";
    return "zh-CN";
  }
  if (script) return region ? `${lang}-${script}-${region}` : `${lang}-${script}`;
  return region ? `${lang}-${region}` : lang;
}

function chromeMajor(version) {
  return String(version || "124").split(".")[0] || "124";
}

function osPlatformVersion() {
  if (process.platform === "darwin") {
    try {
      const out = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 3000 });
      const value = String(out.stdout || "").trim();
      if (value) return value;
    } catch {}
    return "";
  }
  if (process.platform === "win32") {
    const parts = osRelease().split(".").map(Number);
    // Chrome reports Windows 11 as 19.0.0 (build >= 22000), Windows 10 as 10.0.0.
    return parts[0] === 10 && parts[2] >= 22000 ? "19.0.0" : "10.0.0";
  }
  return "";
}

function buildUaMetadata(version) {
  const major = chromeMajor(version);
  const full = version || `${major}.0.0.0`;
  const platform = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
  return {
    brands: [
      { brand: "Chromium", version: major },
      { brand: "Google Chrome", version: major },
      { brand: "Not(A:Brand", version: "24" },
    ],
    fullVersionList: [
      { brand: "Chromium", version: full },
      { brand: "Google Chrome", version: full },
      { brand: "Not(A:Brand", version: "24.0.0.0" },
    ],
    platform,
    platformVersion: osPlatformVersion(),
    architecture: process.arch === "arm64" ? "arm" : "x86",
    model: "",
    mobile: false,
    bitness: "64",
    wow64: false,
  };
}

function systemLocale() {
  // Node's Intl locale often reports en-US even when the OS/Chrome is zh-CN,
  // so prefer the OS setting (macOS AppleLocale) or the POSIX locale env.
  if (process.platform === "darwin") {
    try {
      const out = spawnSync("defaults", ["read", "-g", "AppleLocale"], { encoding: "utf8", timeout: 3000 });
      const normalized = normalizeLocale(String(out.stdout || "").trim());
      if (normalized) return normalized;
    } catch {}
  }
  const envLocale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  const match = envLocale.match(/^([a-zA-Z]{2,3}(?:[-_][a-zA-Z]{2,4})?)/);
  if (match) return match[1].replace("_", "-");
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  } catch {
    return "en-US";
  }
}

function systemTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
}

/**
 * The fingerprint is created once per profile and persisted in settings.json,
 * so every run looks like the same physical machine. Chrome version in the UA
 * is derived from the installed binary on each launch (never "HeadlessChrome").
 */
function ensureFingerprint(profile) {
  const settings = readSettings(profile);
  const currentPlatform = platformName();
  const existing = settings.fingerprint;
  // Keep a profile's fingerprint stable on the same OS, but rebuild it when the
  // profile is used on a different OS (a MacIntel/Apple GPU on Windows is a
  // guaranteed mismatch).
  if (existing && existing.seed && existing.platform === currentPlatform) return existing;
  const gpu = detectGpu();
  const fingerprint = {
    seed: randomBytes(16).toString("hex"),
    platform: currentPlatform,
    vendor: "Google Inc.",
    webglVendor: gpu.vendor,
    webglRenderer: gpu.renderer,
    canvasNoise: true,
    audioNoise: true,
    webgl: "auto", // "auto" uses the real GPU; "spoof" pins it; "off" disables WebGL
    navigator: false, // JS navigator overrides are detectable; native values are already correct
    devtoolsFix: true, // defer console.table so CDP serialization is not mistaken for DevTools
  };
  writeSettings(profile, { fingerprint });
  return fingerprint;
}

function buildFingerprintScript(fingerprint, userAgent, locale) {
  const appVersion = userAgent.replace(/^Mozilla\//, "");
  const languages = [locale, String(locale).split("-")[0], "en-US", "en"];
  const seed = JSON.stringify(fingerprint.seed);
  const ua = JSON.stringify(userAgent);
  const av = JSON.stringify(appVersion);
  const pf = JSON.stringify(fingerprint.platform || platformName());
  const vendor = JSON.stringify(fingerprint.vendor || "Google Inc.");
  const langs = JSON.stringify(Array.from(new Set(languages)));
  const glVendor = JSON.stringify(fingerprint.webglVendor || "Google Inc. (Apple)");
  const glRenderer = JSON.stringify(fingerprint.webglRenderer || "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)");
  const webglMode = fingerprint.webgl || "auto";
  const webglOff = webglMode === "off";
  const navigatorOverride = fingerprint.navigator === true;
  const canvasNoise = fingerprint.canvasNoise !== false;
  const audioNoise = fingerprint.audioNoise !== false;
  const devtoolsFix = fingerprint.devtoolsFix !== false;

  const webglBlock = webglMode === "auto"
    ? ""
    : webglOff
    ? `
  try {
    var __getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = __spoof(function (type) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
      return __getContext.apply(this, arguments);
    });
  } catch (e) {}`
    : `
  try {
    var __hookGL = function (proto) {
      if (!proto || !proto.getParameter) return;
      var __origGetParameter = proto.getParameter;
      proto.getParameter = __spoof(function (param) {
        if (param === 0x9245) return ${glVendor};
        if (param === 0x9246) return ${glRenderer};
        return __origGetParameter.apply(this, arguments);
      });
    };
    if (typeof WebGLRenderingContext !== 'undefined') __hookGL(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') __hookGL(WebGL2RenderingContext.prototype);
  } catch (e) {}`;

  const canvasBlock = canvasNoise
    ? `
  try {
    var __oTDU = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = __spoof(function () {
      try {
        var c = this.getContext('2d');
        if (c) {
          var w = Math.min(this.width, 16), h = Math.min(this.height, 16);
          if (w > 0 && h > 0) {
            var d = c.getImageData(0, 0, w, h);
            for (var i = 0; i < d.data.length; i += 4) {
              d.data[i] = Math.max(0, Math.min(255, d.data[i] + (__h(i) > 0.5 ? 1 : -1)));
            }
            c.putImageData(d, 0, 0);
          }
        }
      } catch (e) {}
      return __oTDU.apply(this, arguments);
    });
    var __oTDB = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = __spoof(function () {
      try {
        var c = this.getContext('2d');
        if (c) {
          var w = Math.min(this.width, 16), h = Math.min(this.height, 16);
          if (w > 0 && h > 0) {
            var d = c.getImageData(0, 0, w, h);
            for (var i = 0; i < d.data.length; i += 4) {
              d.data[i] = Math.max(0, Math.min(255, d.data[i] + (__h(i + 500) > 0.5 ? 1 : -1)));
            }
            c.putImageData(d, 0, 0);
          }
        }
      } catch (e) {}
      return __oTDB.apply(this, arguments);
    });
  } catch (e) {}`
    : "";

  const audioBlock = audioNoise
    ? `
  try {
    if (typeof AudioBuffer !== 'undefined') {
      var __oGCD = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = __spoof(function (ch) {
        var data = __oGCD.call(this, ch);
        var k = '__fpn_' + ch;
        if (!this[k]) {
          this[k] = true;
          for (var i = 0; i < data.length; i++) data[i] += (__h(i + ch * 99999 + 3000) - 0.5) * 0.001;
        }
        return data;
      });
      var __oCFC = AudioBuffer.prototype.copyFromChannel;
      AudioBuffer.prototype.copyFromChannel = __spoof(function (dest, ch, start) {
        __oCFC.call(this, dest, ch, start || 0);
        var k = '__fpcn_' + ch;
        if (!this[k]) {
          this[k] = true;
          for (var i = 0; i < dest.length; i++) dest[i] += (__h(i + ch * 77777 + 4000) - 0.5) * 0.001;
        }
      });
    }
  } catch (e) {}`
    : "";

  const devtoolsBlock = devtoolsFix
    ? `
  try {
    var __origTable = console.table;
    console.table = __spoof(function () {
      var __args = arguments;
      var __self = this;
      setTimeout(function () { try { __origTable.apply(__self, __args); } catch (e) {} }, 0);
    });
  } catch (e) {}`
    : "";

  const navigatorBlock = navigatorOverride
    ? `  try {
    Object.defineProperty(Navigator.prototype, 'userAgent', { get: __spoof(function () { return ${ua}; }), configurable: true });
    Object.defineProperty(Navigator.prototype, 'appVersion', { get: __spoof(function () { return ${av}; }), configurable: true });
    Object.defineProperty(Navigator.prototype, 'platform', { get: __spoof(function () { return ${pf}; }), configurable: true });
    Object.defineProperty(Navigator.prototype, 'vendor', { get: __spoof(function () { return ${vendor}; }), configurable: true });
    Object.defineProperty(Navigator.prototype, 'languages', { get: __spoof(function () { return ${langs}; }), configurable: true });
  } catch (e) {}`
    : "";

  return `(function () {
  'use strict';
  var __seed = ${seed};
  function __h(o) {
    var h = 0x811c9dc5, s = __seed + ':' + o;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return (h & 0x7fffffff) / 0x7fffffff;
  }
  var __native = 'function () { [native code] }';
  function __spoof(fn) {
    try { fn.toString = function () { return __native; }; } catch (e) {}
    return fn;
  }
  ${navigatorBlock}
  ${webglBlock}
  ${canvasBlock}
  ${audioBlock}
  ${devtoolsBlock}
})();`;
}

// ── window focus (macOS) ─────────────────────────────────────────
// Headed Chrome takes the foreground when it launches or when a page is
// brought to front, which interrupts whatever the user is doing. Capture the
// app that was frontmost before launch and hand focus back; headed windows
// stay behind until someone runs `browser focus`.
const CHROME_BUNDLE = /^com\.(google\.chrome|google\.chrome\.canary|chromium)/i;

function macFrontmostBundleId() {
  if (process.platform !== "darwin") return null;
  try {
    const front = spawnSync("lsappinfo", ["front"], { encoding: "utf8" });
    const asn = String(front.stdout || "").trim();
    if (!asn) return null;
    const info = spawnSync("lsappinfo", ["info", "-only", "bundleid", asn], { encoding: "utf8" });
    const match = String(info.stdout || "").match(/bundleID="([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function reactivateApp(bundleId) {
  if (process.platform !== "darwin" || !bundleId || CHROME_BUNDLE.test(bundleId)) return;
  try {
    spawnSync("open", ["-b", bundleId], { stdio: "ignore" });
  } catch {}
}

// Chrome can grab the foreground for a few seconds after a headed launch
// (window creation, page autofocus, heavy first paint). Check a few times and
// give focus back, but only while Chrome itself is frontmost.
function scheduleFocusRestore(bundleId) {
  if (process.platform !== "darwin" || !bundleId || CHROME_BUNDLE.test(bundleId)) return;
  for (const delay of [0, 600, 1500, 3000]) {
    setTimeout(() => {
      const front = macFrontmostBundleId();
      if (front && CHROME_BUNDLE.test(front)) reactivateApp(bundleId);
    }, delay).unref?.();
  }
}

// Bring the page forward only in headless mode. In headed mode the window is
// left where the user put it; `browser focus` is the explicit override.
async function foregroundPage(page) {
  if (!currentHeadless) return;
  await page.bringToFront().catch(() => {});
}

// ── browser launch ───────────────────────────────────────────────

async function launchBrowser(profile, headless) {
  const paths = ensureProfileDirs(profile);
  const executablePath = findChrome();
  const settings = readSettings(profile);
  const fingerprint = ensureFingerprint(profile);
  // Prefer the installed binary version; fall back to the version the browser
  // reported on the previous launch (covers platforms where `chrome --version`
  // prints nothing, e.g. Windows GUI builds).
  const chromeVersion = detectChromeVersion(executablePath) || settings.chromeVersion || "";
  const userAgent = settings.userAgent || buildUserAgent(chromeVersion);
  const locale = settings.locale || null;
  const timezoneId = settings.timezone || null;
  const frontApp = headless ? null : macFrontmostBundleId();
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-infobars",
    "--disable-dev-shm-usage",
    "--ignore-certificate-errors",
  ];
  // Session cookies (e.g. Tomcat JSESSIONID) are only reloaded when Chrome is
  // restoring a session. This per-profile switch makes logins survive a
  // browser restart (headed/headless switch, daemon stop, crash).
  if (settings.restoreSession) args.push("--restore-last-session");
  logLine(`fingerprint profile=${profile} platform=${fingerprint.platform} webgl=${String(fingerprint.webglRenderer).slice(0, 60)}`);
  // Headed Chrome already sends a normal UA; overlaying anything would only
  // damage UA-CH. Headless needs the "HeadlessChrome" token removed, so only
  // there we use Playwright's userAgent option (a normal Chrome UA).
  const context = await chromium.launchPersistentContext(paths.chrome, {
    headless,
    executablePath,
    // Visible windows must resize with the user so fixed controls stay in view.
    viewport: headless ? { width: 1440, height: 900 } : null,
    acceptDownloads: true,
    ...(locale ? { locale } : {}),
    ...(timezoneId ? { timezoneId } : {}),
    ignoreHTTPSErrors: true,
    args,
  });
  await context.exposeBinding("__browserOperatorAnnotationEnabled", () => readSkillConfig().annotationEnabled !== false);
  await context.addInitScript({
    content: `if (window.top === window) window.__browserOperatorAnnotationEnabled().then((enabled) => {
      if (enabled) (${annotationLauncher.toString()})();
    });`,
  });
  // Remember the version the running browser reports; it is used as a
  // fallback for platforms where the binary cannot be queried.
  let actualVersion = "";
  try {
    actualVersion = context.browser()?.version?.() || "";
  } catch {}
  const effectiveVersion = actualVersion || chromeVersion;
  const effectiveUserAgent = settings.userAgent || buildUserAgent(effectiveVersion);
  // Use the same UA/UA-CH identity in both modes so switching headed/headless
  // never changes the fingerprint. Headless is the default; headed is only for
  // manual login or verification.
  try {
    const metadata = buildUaMetadata(effectiveVersion);
    const applyUserAgent = async (page) => {
      try {
        const session = await context.newCDPSession(page);
        await session.send("Emulation.setUserAgentOverride", {
          userAgent: effectiveUserAgent,
          userAgentMetadata: metadata,
        });
      } catch {}
    };
    for (const page of context.pages()) await applyUserAgent(page);
    context.on("page", (page) => { applyUserAgent(page).catch(() => {}); });
  } catch {}
  await context.addInitScript(buildFingerprintScript(fingerprint, effectiveUserAgent, locale || systemLocale()));
  if (actualVersion && actualVersion !== settings.chromeVersion) {
    try {
      writeSettings(profile, { chromeVersion: actualVersion });
    } catch {}
  }

  for (const existing of context.pages()) attachDiagnostics(existing);
  context.on("page", (newPage) => attachDiagnostics(newPage));
  const launchedPages = context.pages().filter((candidate) => !candidate.isClosed());
  // With --restore-last-session Chrome reopens last session's tabs on top of
  // the about:blank page. Keep exactly one page so tabs do not pile up on
  // every restart; the caller restores the URL afterwards.
  let page = launchedPages[launchedPages.length - 1];
  if (!page) page = await context.newPage();
  for (const extra of launchedPages) {
    if (extra !== page) await extra.close().catch(() => {});
  }
  if (readSkillConfig().annotationEnabled !== false) await page.evaluate(annotationLauncher);
  attachDiagnostics(page);
  if (headless) {
    await page.bringToFront().catch(() => {});
  } else {
    // Hand the foreground back to whatever the user was using. Chrome — and
    // heavy pages that call focus() — can re-activate well after launch, so
    // keep checking for a few seconds and only correct it while Chrome is
    // actually frontmost (never fight a deliberate user switch).
    scheduleFocusRestore(frontApp);
  }
  return { context, page };
}

// ── page helpers ─────────────────────────────────────────────────

let context;
let activePage;

const diagnostics = {
  console: [],
  network: [],
  dialog: [],
};
const MAX_CONSOLE = 300;
const MAX_NETWORK = 500;
const MAX_DIALOG = 100;
const requestStarts = new WeakMap();

function pushDiagnostic(kind, entry) {
  const list = diagnostics[kind];
  const item = { ts: Date.now(), ...entry };
  list.push(item);
  const max = kind === "console" ? MAX_CONSOLE : kind === "network" ? MAX_NETWORK : MAX_DIALOG;
  if (list.length > max) list.splice(0, list.length - max);
  return item;
}

function attachDiagnostics(page) {
  if (!page || page.__boDiagnostics) return;
  page.__boDiagnostics = true;

  page.on("console", (message) => {
    try {
      pushDiagnostic("console", {
        page: maskUrl(page.url()),
        type: message.type(),
        text: String(message.text() || "").slice(0, 2000),
        location: message.location ? message.location() : undefined,
      });
    } catch {}
  });
  page.on("pageerror", (error) => {
    try {
      pushDiagnostic("console", {
        page: maskUrl(page.url()),
        type: "pageerror",
        text: String(error?.stack || error?.message || error).slice(0, 4000),
      });
    } catch {}
  });
  // Never handled automatically: the dialog stays open until the agent runs
  // `dialog accept` or `dialog dismiss` (see dialogAction).
  page.on("dialog", (dialog) => {
    const record = pushDiagnostic("dialog", {
      page: maskUrl(page.url()),
      type: dialog.type(),
      message: String(dialog.message() || "").slice(0, 1000),
      decision: "pending",
    });
    pendingDialogs.push({ dialog, page, record });
    const signal = dialogSignal;
    dialogSignal = deferred();
    signal.resolve();
  });
  // Also fires when the user clicks the dialog in the headed window.
  page.on("dialogclosed", (dialog) => {
    const index = pendingDialogs.findIndex((entry) => entry.dialog === dialog);
    if (index < 0) return;
    const [entry] = pendingDialogs.splice(index, 1);
    if (entry.record.decision !== "pending") return;
    entry.record.decision = "closed-in-browser";
    if (!pendingDialogs.length) blockedAction = null; // it resumes on its own
  });
  page.on("request", (request) => {
    requestStarts.set(request, Date.now());
  });
  page.on("response", (response) => {
    try {
      const request = response.request();
      const start = requestStarts.get(request) || Date.now();
      pushDiagnostic("network", {
        page: maskUrl(page.url()),
        method: request.method(),
        url: maskUrl(response.url()),
        resourceType: request.resourceType(),
        status: response.status(),
        ok: response.ok(),
        durationMs: Date.now() - start,
      });
    } catch {}
  });
  page.on("requestfailed", (request) => {
    try {
      const start = requestStarts.get(request) || Date.now();
      pushDiagnostic("network", {
        page: maskUrl(page.url()),
        method: request.method(),
        url: maskUrl(request.url()),
        resourceType: request.resourceType(),
        status: 0,
        ok: false,
        failed: request.failure()?.errorText || "request failed",
        durationMs: Date.now() - start,
      });
    } catch {}
  });
}

function getPage() {
  if (activePage && !activePage.isClosed()) return activePage;
  const pages = context ? context.pages().filter((page) => !page.isClosed()) : [];
  if (pages.length === 0) throw fail("no-page", "没有可用页面");
  activePage = pages[0];
  return activePage;
}

async function getRoot(frameSelector) {
  const page = getPage();
  return frameSelector ? page.frameLocator(frameSelector) : page;
}

async function getFrame(frameSelector) {
  if (!frameSelector) return null;
  const page = getPage();
  const element = await page.$(frameSelector);
  if (!element) throw fail("frame-not-found", `iframe 不存在: ${frameSelector}`);
  const frame = await element.contentFrame();
  if (!frame) throw fail("frame-unavailable", `iframe 不可访问: ${frameSelector}`);
  return frame;
}

async function loginHints(page) {
  try {
    const hints = await page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const reasons = [];
      const url = location.href;
      if (/(?:^|[/?#])(?:login|signin|sign-in|auth|passport|sso)(?:[/?#._-]|$)/i.test(url)) reasons.push("url");

      const passwords = Array.from(document.querySelectorAll('input[type="password"]')).filter(visible);
      if (passwords.length > 0) reasons.push("password-input");

      const bodyText = (document.body?.innerText || "").slice(0, 12000);
      const loggedIn =
        /退出登录|个人中心|我的简历|我的申请|账号设置|我的收藏|我的投递|在线简历|简历快推|谁对我感兴趣|竞争力分析|我的求职意向|Hi[，,]\s*\S+|欢迎你/.test(bodyText) ||
        Boolean(document.querySelector('[class*="avatar"], [class*="user-name"], [class*="userName"], [class*="userInfo"]'));
      const loggedOut = /登录\/注册|登录\s*\|\s*注册|请登录|登录后查看/.test(bodyText);
      if (loggedOut && !loggedIn) reasons.push("logged-out-text");
      if (/登录超时|扫码登录|重新登录|账号登录|密码登录/.test(bodyText) && !loggedIn) reasons.push("login-text");
      if (/scan (the )?qr|sign in with|log in with|continue with/i.test(bodyText) && !loggedIn) reasons.push("login-text");
      if (/sign in|log in/i.test(bodyText) && passwords.length > 0 && !loggedIn) reasons.push("login-text");

      return { likely: reasons.length > 0, reasons, loggedIn, loggedOut, url };
    });
    return { ...hints, url: maskUrl(hints.url) };
  } catch {
    return { likely: false, reasons: [], url: maskUrl(getPage().url()) };
  }
}

async function challengeHints(page) {
  try {
    return await page.evaluate(() => {
      const title = document.title || "";
      const text = (document.body?.innerText || "").slice(0, 6000);
      const reasons = [];
      if (/滑动验证|访问验证|安全验证|人机验证|验证中|请完成验证/.test(title) || /滑动验证|访问验证|安全验证|人机验证|请完成验证/.test(text)) {
        reasons.push("verification-text");
      }
      if (/captcha|verify you are human|just a moment|checking your browser/i.test(title + " " + text)) {
        reasons.push("captcha");
      }
      return { likely: reasons.length > 0, reasons, title };
    });
  } catch {
    return { likely: false, reasons: [], title: "" };
  }
}

async function manualAuthHints(page) {
  const challenge = await challengeHints(page);
  if (challenge.likely) {
    return { required: true, kind: "verification", reasons: challenge.reasons, title: challenge.title };
  }
  const login = await loginHints(page);
  if (login.likely) {
    return { required: true, kind: "login", reasons: login.reasons };
  }
  return { required: false, kind: null, reasons: [] };
}

// 默认：遇到登录页时 agent 不做任何输入，交给用户在可见浏览器完成。
// 例外：用户在当前对话里明确要求「帮我输入账号密码登录 / 帮我点登录」时，调用方才显式传 --allow-auth。
// 该例外只覆盖 kind=login；滑块/CAPTCHA 等 verification 永远不放开。
function authOverrideAllowed(body, manualAuth) {
  return Boolean(body && body.allowAuth) && manualAuth && manualAuth.kind === "login";
}

async function stateAction() {
  const page = getPage();
  const all = context.pages().filter((candidate) => !candidate.isClosed());
  const pages = [];
  for (let index = 0; index < all.length; index++) {
    const candidate = all[index];
    pages.push({
      index,
      active: candidate === page,
      url: maskUrl(candidate.url()),
      title: await candidate.title().catch(() => ""),
    });
  }
  const login = await loginHints(page);
  const challenge = await challengeHints(page);
  const manualAuth = challenge.likely
    ? { required: true, kind: "verification", reasons: challenge.reasons }
    : login.likely
      ? { required: true, kind: "login", reasons: login.reasons }
      : { required: false, kind: null, reasons: [] };
  const state = {
    ok: true,
    profile: currentProfile,
    headless: currentHeadless,
    url: maskUrl(page.url()),
    title: await page.title().catch(() => ""),
    pages,
    activeIndex: pages.find((entry) => entry.active)?.index ?? 0,
    login,
    challenge,
    manualAuth,
  };
  updateMeta(state);
  return state;
}

function updateMeta(state) {
  try {
    writeJson(profilePaths(currentProfile).meta, {
      profile: currentProfile,
      lastUrl: state.url,
      lastTitle: state.title,
      loginLikely: Boolean(state.login?.likely),
      updatedAt: Date.now(),
    });
  } catch {}
}

// ── snapshots ────────────────────────────────────────────────────

function snapshotFunction({ mode, selector, maxChars }) {
  const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim();
  const cssEscape = (value) =>
    typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
  const unique = (candidate) => {
    try {
      return document.querySelectorAll(candidate).length === 1;
    } catch {
      return false;
    }
  };
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") return false;
    if (Number.parseFloat(style.opacity || "1") === 0) return false;
    try {
      if (typeof el.checkVisibility === "function") {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
    } catch {}
    return true;
  };
  const inViewport = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  };
  const suggest = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.id) {
      const candidate = `#${cssEscape(el.id)}`;
      if (unique(candidate)) return candidate;
    }
    for (const attr of ["data-testid", "data-test", "name", "aria-label", "placeholder", "title"]) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const candidate = `${tag}[${attr}="${String(value).replace(/"/g, '\\"')}"]`;
      if (unique(candidate)) return candidate;
    }
    const text = normalize(el.innerText || el.textContent).slice(0, 60);
    if (text && ["button", "a", "span", "div", "li", "label"].includes(tag)) {
      return `${tag}:has-text(${JSON.stringify(text)})`;
    }
    const parts = [];
    let current = el;
    while (current && current.nodeType === 1 && current !== document.body) {
      const currentTag = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`#${cssEscape(current.id)}`);
        break;
      }
      let part = currentTag;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      const candidate = parts.join(" > ");
      if (unique(candidate)) return candidate;
      current = parent;
    }
    return parts.join(" > ") || tag;
  };
  const rectOf = (el) => {
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  };
  const attrsOf = (el) => {
    const result = {};
    for (const attr of ["id", "class", "name", "type", "placeholder", "aria-label", "role", "href", "title", "data-testid"]) {
      const value = el.getAttribute(attr);
      if (value) result[attr] = String(value).slice(0, 160);
    }
    if ("checked" in el) result.checked = Boolean(el.checked);
    if ("disabled" in el) result.disabled = Boolean(el.disabled);
    if ("readOnly" in el) result.readonly = Boolean(el.readOnly);
    if (el.tagName === "SELECT") {
      result.options = Array.from(el.options).slice(0, 30).map((option) => ({ value: option.value, label: normalize(option.textContent), selected: option.selected }));
    }
    return result;
  };

  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return { error: `selector not found: ${selector}` };

  if (mode === "text") {
    return {
      mode,
      url: location.href,
      title: document.title,
      text: normalize(root.innerText || root.textContent || "").slice(0, maxChars),
    };
  }

  if (mode === "full") {
    return {
      mode,
      url: location.href,
      title: document.title,
      text: String(root.outerHTML || "").slice(0, maxChars),
    };
  }

  if (mode === "forms") {
    const fields = Array.from(root.querySelectorAll("input, textarea, select, button, [contenteditable=true]"))
      .filter(isVisible)
      .slice(0, 150)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        selector: suggest(el),
        text: normalize(el.innerText || el.value || el.getAttribute("placeholder") || "").slice(0, 120),
        rect: rectOf(el),
        inViewport: inViewport(el),
        attrs: attrsOf(el),
      }));
    return { mode, url: location.href, title: document.title, fields };
  }

  const selectorList = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "[role=button]",
    "[role=menuitem]",
    "[role=tab]",
    "[contenteditable=true]",
    "[onclick]",
  ].join(",");
  const items = Array.from(root.querySelectorAll(selectorList))
    .filter(isVisible)
    .slice(0, 220)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      selector: suggest(el),
      text: normalize(
        el.innerText ||
          el.value ||
          el.getAttribute("placeholder") ||
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          "",
      ).slice(0, 160),
      rect: rectOf(el),
      inViewport: inViewport(el),
      attrs: attrsOf(el),
    }));
  return {
    mode: "interactive",
    url: location.href,
    title: document.title,
    items,
    text: normalize(root.innerText || "").slice(0, Math.min(maxChars, 8000)),
  };
}

async function snapshotAction({ mode = "interactive", selector = "", frame = "", maxChars = DEFAULT_SNAPSHOT_CHARS } = {}) {
  const page = getPage();
  let result;
  if (frame) {
    const targetFrame = await getFrame(frame);
    result = await targetFrame.evaluate(snapshotFunction, { mode, selector, maxChars });
  } else {
    result = await page.evaluate(snapshotFunction, { mode, selector, maxChars });
  }
  if (result?.error) throw fail("snapshot-failed", result.error);
  if (result?.url) result.url = maskUrl(result.url);
  const login = await loginHints(page);
  const challenge = await challengeHints(page);
  const manualAuth = challenge.likely
    ? { required: true, kind: "verification", reasons: challenge.reasons }
    : login.likely
      ? { required: true, kind: "login", reasons: login.reasons }
      : { required: false, kind: null, reasons: [] };
  return {
    ok: true,
    profile: currentProfile,
    url: maskUrl(page.url()),
    title: await page.title().catch(() => ""),
    login,
    challenge,
    manualAuth,
    snapshot: result,
  };
}

// ── real click ───────────────────────────────────────────────────


async function locatorVisibility(locator) {
  return locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    let check = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    try {
      if (typeof el.checkVisibility === "function") {
        check = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
    } catch {}
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    const root = el.getRootNode ? el.getRootNode() : null;
    const host = root && root.host ? root.host : null;
    const hit = Boolean(top) && (top === el || el.contains(top) || (host && top === host));
    return {
      visible: Boolean(check) && rect.width > 0 && rect.height > 0 && style.pointerEvents !== "none",
      inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
      hit,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
  }).catch(() => null);
}

/**
 * Pick a real, visible match instead of blindly trusting locator.first().
 * Hidden duplicate menus are common (opacity:0 / off-screen copies); Playwright's
 * visible filter only checks the element's own box, not ancestor opacity.
 */
async function pickVisibleLocator(locator, timeout, nth = null) {
  const all = (await locator.all()).slice(0, 100);
  if (all.length === 0) throw fail("not-found", "selector 没有匹配元素");
  if (nth !== null && nth !== undefined) {
    const index = Number(nth);
    if (!Number.isInteger(index) || index < 0 || index >= all.length) {
      throw fail("not-found", `第 ${index + 1} 个匹配不存在（共 ${all.length} 个）`);
    }
    const candidate = all[index];
    const info = await locatorVisibility(candidate);
    if (!info?.visible) throw fail("hidden", `第 ${index + 1} 个匹配不可见`, info);
    await candidate.scrollIntoViewIfNeeded({ timeout: Math.min(timeout, 5000) }).catch(() => {});
    return { locator: candidate, info };
  }
  let firstVisible = null;
  let firstInViewport = null;
  for (const candidate of all) {
    const info = await locatorVisibility(candidate);
    if (!info?.visible) continue;
    if (!firstVisible) firstVisible = candidate;
    if (info.inViewport) {
      if (!firstInViewport) firstInViewport = candidate;
      if (info.hit) return { locator: candidate, info };
    }
  }
  if (firstInViewport) {
    await firstInViewport.scrollIntoViewIfNeeded({ timeout: Math.min(timeout, 5000) }).catch(() => {});
    return { locator: firstInViewport, info: await locatorVisibility(firstInViewport) };
  }
  if (firstVisible) {
    await firstVisible.scrollIntoViewIfNeeded({ timeout: Math.min(timeout, 5000) }).catch(() => {});
    const info = await locatorVisibility(firstVisible);
    return { locator: firstVisible, info };
  }
  await all[0].waitFor({ state: "visible", timeout: Math.min(timeout, 5000) }).catch(() => {});
  const info = await locatorVisibility(all[0]);
  if (info?.visible) return { locator: all[0], info };
  throw fail("hidden", `元素存在但不可见（display/visibility/opacity/尺寸）`, info);
}

async function describeLocator(locator) {
  try {
    return await locator.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const top = document.elementFromPoint(x, y);
      const root = el.getRootNode ? el.getRootNode() : null;
      const host = root && root.host ? root.host : null;
      const hit = Boolean(top) && (top === el || el.contains(top) || (host && top === host));
      return {
        tag: el.tagName,
        id: el.id || "",
        className: String(el.className || "").slice(0, 160),
        text: String(el.innerText || el.textContent || el.value || "").replace(/\s+/g, " ").trim().slice(0, 160),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number.parseFloat(style.opacity || "1") !== 0,
        pointerEvents: style.pointerEvents,
        disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
        covered: !hit,
        topTag: top ? top.tagName : "",
        topText: top ? String(top.innerText || top.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120) : "",
      };
    });
  } catch {
    return null;
  }
}

function classifyClickError(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("intercepts pointer events")) return "covered";
  if (text.includes("element is not visible") || text.includes("not visible")) return "hidden";
  if (text.includes("outside of the viewport")) return "offscreen";
  if (text.includes("strict mode violation")) return "ambiguous";
  if (text.includes("timeout")) return "timeout";
  if (text.includes("not found") || text.includes("no element") || text.includes("failed to find")) return "not-found";
  return "click-failed";
}

async function installProbe(page) {
  await page.evaluate(() => {
    window.__boClickEvents = [];
    if (!window.__boClickProbe) {
      window.__boClickProbe = true;
      document.addEventListener(
        "click",
        (event) => {
          const target = event.target;
          window.__boClickEvents.push({
            trusted: Boolean(event.isTrusted),
            x: event.clientX,
            y: event.clientY,
            tag: target && target.tagName ? target.tagName : "",
            text: target ? String(target.innerText || target.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100) : "",
          });
          if (window.__boClickEvents.length > 30) window.__boClickEvents.shift();
        },
        true,
      );
    }
    window.__boMutations = 0;
    if (window.__boObserver) window.__boObserver.disconnect();
    window.__boObserver = new MutationObserver((records) => {
      window.__boMutations = (window.__boMutations || 0) + records.length;
    });
    window.__boObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  }).catch(() => {});
}

async function drainProbe(page) {
  try {
    return await page.evaluate(() => {
      const events = window.__boClickEvents || [];
      window.__boClickEvents = [];
      const mutations = window.__boMutations || 0;
      window.__boMutations = 0;
      if (window.__boObserver) {
        window.__boObserver.disconnect();
        window.__boObserver = null;
      }
      return { events, mutations };
    });
  } catch {
    return { events: [], mutations: 0 };
  }
}

async function evalAction(body) {
  const page = getPage();
  const manualAuth = await manualAuthHints(page);
  if (manualAuth.required) {
    throw fail(
      "manual-auth-required",
      "页面需要用户登录或完成验证；eval 不会绕过登录/验证，请先在可见浏览器完成。",
      manualAuth,
    );
  }
  const expression = String(body.expression || "").trim();
  if (!expression) throw fail("bad-request", "eval 需要 expression");
  const result = await page.evaluate((source) => (0, eval)(source), expression);
  return {
    ok: true,
    action: "eval",
    profile: currentProfile,
    url: maskUrl(page.url()),
    result,
  };
}

async function clickAction(body) {
  const page = getPage();
  const selector = String(body.selector || "").trim();
  if (!selector) throw fail("bad-request", "click 需要 selector");
  const manualAuth = await manualAuthHints(page);
  const authOverride = authOverrideAllowed(body, manualAuth);
  if (manualAuth.required && !authOverride) {
    throw fail(
      "manual-auth-required",
      `页面需要用户${manualAuth.kind === "verification" ? "完成验证" : "登录"}；agent 不执行登录/验证操作。请先运行 mode headed，让用户在可见浏览器完成后重试；若用户已明确要求由你代填账号密码或代点登录，再加 --allow-auth。`,
      manualAuth,
    );
  }
  const frame = String(body.frame || "").trim();
  const timeout = Number(body.timeout) || DEFAULT_TIMEOUT;
  const realOnly = body.realOnly !== false;
  const useJs = Boolean(body.js);
  const force = Boolean(body.force);
  if (useJs && realOnly) {
    // --js is an explicit override; never combine it with realOnly silently.
    if (!body.allowJs) {
      throw fail("real-only", "realOnly 模式下不允许 --js；请显式传 --allow-js 或去掉 --js");
    }
  }

  const root = await getRoot(frame);
  const locator = root.locator(selector);
  const total = await locator.count();
  if (total === 0) {
    throw fail("not-found", `selector 没有匹配元素: ${selector}`);
  }

  const picked = await pickVisibleLocator(locator, timeout, body.nth);
  const target = picked.locator;
  const beforePages = context.pages().filter((candidate) => !candidate.isClosed());
  const dialogCountBefore = diagnostics.dialog.length;
  const beforeUrl = page.url();
  const targetInfo = await describeLocator(target);

  if (useJs) {
    await installProbe(page);
    const popupPromise = page.waitForEvent("popup", { timeout: 1500 }).catch(() => null);
    await target.evaluate((el) => el.click());
    const popup = await Promise.race([popupPromise, sleep(700).then(() => null)]);
    const current = popup || page;
    if (popup) {
      activePage = popup;
      await popup.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
      await foregroundPage(popup);
    }
    const probe = frame ? { events: [], mutations: 0 } : await drainProbe(page);
    return {
      ok: true,
      action: "click",
      profile: currentProfile,
      method: "js-dom-click",
      trusted: false,
      warning: "这是 DOM click（isTrusted=false），不是真实鼠标点击；只在页面本身无法接受真实输入时使用。",
      target: targetInfo,
      effect: {
        urlChanged: current.url() !== beforeUrl,
        newPage: Boolean(popup),
        clickEvents: probe.events.length,
        trustedEvents: probe.events.filter((event) => event.trusted).length,
        mutations: probe.mutations,
      },
      url: maskUrl(current.url()),
      title: await current.title().catch(() => ""),
    };
  }

  await installProbe(page);
  const popupPromise = page.waitForEvent("popup", { timeout: 1500 }).catch(() => null);
  const navigations = [];
  const onFrameNavigated = (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  };
  page.on("framenavigated", onFrameNavigated);

  try {
    await target.scrollIntoViewIfNeeded({ timeout: Math.min(timeout, 5000) }).catch(() => {});
    await target.click({
      timeout,
      button: body.button || "left",
      clickCount: Number(body.clickCount) || 1,
      force,
    });
  } catch (error) {
    page.off("framenavigated", onFrameNavigated);
    const diagnosis = (await describeLocator(target)) || targetInfo;
    const code = classifyClickError(error.message);
    const extra = diagnosis?.covered
      ? `；中心点被 <${diagnosis.topTag || "unknown"}> 遮挡`
      : diagnosis?.visible === false
        ? "；元素不可见"
        : "";
    throw fail(code, `${firstLine(error.message)}${extra}`, diagnosis);
  }
  page.off("framenavigated", onFrameNavigated);

  const popup = await Promise.race([popupPromise, sleep(900).then(() => null)]);
  let current = popup || page;
  if (!popup) {
    const fresh = context.pages().filter((candidate) => !candidate.isClosed() && !beforePages.includes(candidate));
    if (fresh.length > 0) current = fresh[0];
  }
  if (current !== page) {
    activePage = current;
    await current.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    await foregroundPage(current);
  }

  const probe = frame ? { events: [], mutations: 0 } : await drainProbe(page);
  const effect = {
    urlChanged: current.url() !== beforeUrl,
    newPage: current !== page,
    navigated: navigations.length > 0,
    clickEvents: probe.events.length,
    trustedEvents: probe.events.filter((event) => event.trusted).length,
    mutations: probe.mutations,
  };

  let waitWarning = "";
  if (body.waitFor) {
    try {
      await root.locator(String(body.waitFor)).first().waitFor({ state: "visible", timeout });
    } catch {
      waitWarning = `等待 ${body.waitFor} 出现超时`;
    }
  }

  if (body.waitForNavigation && !effect.urlChanged && !effect.newPage) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && !effect.urlChanged && !effect.newPage) {
      await sleep(200);
      const fresh = context.pages().filter((candidate) => !candidate.isClosed() && !beforePages.includes(candidate));
      if (fresh.length > 0) {
        current = fresh[0];
        activePage = current;
        effect.newPage = true;
      }
      effect.urlChanged = current.url() !== beforeUrl;
    }
    if (!effect.urlChanged && !effect.newPage) waitWarning = `等待跳转超时（${timeout}ms）`;
  }

  let warning = "";
  if (force) warning = "force=true 跳过了可操作性检查，仍使用真实鼠标坐标；可能点到遮挡层。";
  if (!frame && effect.clickEvents === 0 && !effect.navigated) {
    warning = warning || "已发送真实鼠标事件，但页面没有收到 click 事件；可能落在空白处或被遮挡。";
  } else if (!frame && !effect.urlChanged && !effect.newPage && !effect.navigated && effect.mutations === 0) {
    warning = warning || "点击成功但没有观察到页面变化；请重新 snapshot 确认。";
  }
  if (waitWarning) warning = warning ? `${warning} ${waitWarning}` : waitWarning;

  return {
    ok: true,
    action: "click",
    profile: currentProfile,
    method: force ? "playwright-mouse-force" : "playwright-mouse",
    trusted: true,
    authOverride: authOverride || undefined,
    target: targetInfo,
    effect,
    warning: warning || undefined,
    dialogs: diagnostics.dialog.slice(dialogCountBefore),
    url: maskUrl(current.url()),
    title: await current.title().catch(() => ""),
  };
}

// ── console / network / debug ─────────────────────────────────────

// A native dialog freezes the page: evaluate, snapshot and screenshot hang
// until it is handled. So the daemon keeps the dialog open, reports it to the
// agent, and refuses page commands until `dialog accept` or `dialog dismiss`.
const pendingDialogs = []; // { dialog, page, record }
let dialogSignal = deferred(); // resolves when the next dialog opens
let blockedAction = null; // the action a dialog interrupted, still running

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pendingDialog() {
  for (let index = pendingDialogs.length - 1; index >= 0; index--) {
    if (pendingDialogs[index].page.isClosed()) pendingDialogs.splice(index, 1);
  }
  return pendingDialogs[0] || null;
}

function dialogInfo({ dialog, record }) {
  return {
    type: record.type,
    message: record.message,
    defaultValue: record.type === "prompt" ? dialog.defaultValue() : undefined,
    page: record.page,
  };
}

function dialogPendingResult(action, extra = {}) {
  const entry = pendingDialog();
  return {
    ok: true,
    action,
    status: "dialog-pending",
    ...extra,
    pendingDialog: dialogInfo(entry),
    next: "看清 message 再决定：dialog accept（prompt 用 --text 填内容）或 dialog dismiss；处理前其他页面命令会被拒绝",
    url: maskUrl(entry.page.url()),
  };
}

// If a dialog opens before the action finishes, answer right away and leave the
// action waiting behind the dialog. A timeout it hits later only measures how
// long the agent took to decide, so its outcome is not reported as an error.
async function untilDialog(action, promise) {
  const outcome = await Promise.race([
    promise.then((value) => ({ value })),
    dialogSignal.promise.then(() => null),
  ]);
  if (outcome) return outcome.value;
  promise.catch(() => {});
  blockedAction = promise;
  return dialogPendingResult(action);
}

async function dialogAction(body = {}) {
  const action = String(body.action || "status").toLowerCase();
  if (action === "status") {
    const entry = pendingDialog();
    return {
      ok: true,
      action: "dialog",
      pending: entry ? dialogInfo(entry) : null,
      recent: diagnostics.dialog.slice(-20),
      url: maskUrl(getPage().url()),
    };
  }
  if (action !== "accept" && action !== "dismiss") {
    throw fail("bad-request", "dialog 需要 accept、dismiss 或 status");
  }
  const entry = pendingDialog();
  if (!entry) {
    throw fail(
      "no-pending-dialog",
      "现在没有等处理的弹窗。弹窗不会按预设自动处理：先执行会弹窗的操作，返回 status=dialog-pending 后再 dialog accept 或 dismiss",
      { recent: diagnostics.dialog.slice(-5) },
    );
  }
  const { dialog, record } = entry;
  pendingDialogs.splice(pendingDialogs.indexOf(entry), 1);
  record.decision = action;
  if (action === "accept" && record.type === "prompt") {
    // Accepting without --text is pressing OK on the prefilled value.
    record.promptText = typeof body.text === "string" && body.text !== "" ? body.text : dialog.defaultValue();
  }
  const handled = { type: record.type, message: record.message, decision: action, promptText: record.promptText };
  const nextDialog = dialogSignal.promise.then(() => ({}));
  const blocked = blockedAction;
  blockedAction = null;
  try {
    if (action === "accept") await dialog.accept(record.promptText);
    else await dialog.dismiss();
  } catch (error) {
    record.decision = "closed-in-browser";
    throw fail("dialog-gone", `弹窗已经不在了，可能已在有头窗口里被手动关掉：${firstLine(error?.message || error)}`);
  }

  // Give the interrupted action a moment to finish, or the next dialog to open.
  const outcome = await Promise.race([
    blocked ? blocked.then((value) => ({ value }), () => ({})) : Promise.resolve({}),
    nextDialog,
    sleep(5000).then(() => ({})),
  ]);
  if (!outcome.value) await sleep(500);
  if (pendingDialog()) {
    if (!outcome.value) blockedAction = blocked;
    return dialogPendingResult("dialog", { handled });
  }
  const current = getPage();
  await current.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  return {
    ok: true,
    action: "dialog",
    handled,
    resumed: outcome.value,
    url: maskUrl(current.url()),
    title: await current.title().catch(() => ""),
  };
}

async function consoleAction(body = {}) {
  const limit = Math.max(1, Math.min(Number(body.limit) || 50, MAX_CONSOLE));
  const filter = String(body.filter || "").toLowerCase();
  let entries = diagnostics.console;
  if (filter) entries = entries.filter((entry) => `${entry.type} ${entry.text} ${entry.page}`.toLowerCase().includes(filter));
  const result = {
    ok: true,
    action: "console",
    entries: entries.slice(-limit),
    total: entries.length,
    url: maskUrl(getPage().url()),
  };
  if (body.clear) diagnostics.console.length = 0;
  return result;
}

async function networkAction(body = {}) {
  const limit = Math.max(1, Math.min(Number(body.limit) || 50, MAX_NETWORK));
  const filter = String(body.filter || "").toLowerCase();
  const type = String(body.type || "").toLowerCase();
  let entries = diagnostics.network;
  if (type) entries = entries.filter((entry) => String(entry.resourceType || "").toLowerCase() === type);
  if (body.errors) entries = entries.filter((entry) => entry.ok === false || Number(entry.status) >= 400 || entry.failed);
  if (filter) entries = entries.filter((entry) => `${entry.method} ${entry.url} ${entry.status} ${entry.failed || ""}`.toLowerCase().includes(filter));
  const result = {
    ok: true,
    action: "network",
    entries: entries.slice(-limit),
    total: entries.length,
    url: maskUrl(getPage().url()),
  };
  if (body.clear) diagnostics.network.length = 0;
  return result;
}

async function queryAction(body = {}) {
  const selector = String(body.selector || "").trim();
  if (!selector) throw fail("bad-request", "query 需要 selector");
  const limit = Math.max(1, Math.min(Number(body.limit) || 50, 500));
  const includeHtml = Boolean(body.html);
  const allAttrs = Boolean(body.allAttrs);
  const page = getPage();
  const root = await getRoot(String(body.frame || ""));
  const locator = root.locator(selector);
  const total = await locator.count();
  const matches = (await locator.all()).slice(0, limit);
  const items = [];
  for (const match of matches) {
    const item = await match.evaluate((el, options) => {
      const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim();
      const rect = el.getBoundingClientRect();
      const attrs = {};
      for (const attr of ["id", "class", "name", "type", "href", "title", "role", "aria-label"]) {
        const value = el.getAttribute(attr);
        if (value) attrs[attr] = String(value).slice(0, 300);
      }
      for (const attr of Array.from(el.attributes || [])) {
        if (attr.name === "style") continue;
        if ((attr.name.startsWith("data-") || options.allAttrs) && !attrs[attr.name]) {
          attrs[attr.name] = String(attr.value).slice(0, 1500);
        }
      }
      return {
        tag: el.tagName.toLowerCase(),
        text: normalize(el.innerText || el.textContent || "").slice(0, 1000),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
        attrs,
        ...(options.includeHtml ? { html: String(el.outerHTML || "").slice(0, 5000) } : {}),
      };
    }, { includeHtml, allAttrs });
    items.push(item);
  }
  return {
    ok: true,
    action: "query",
    selector,
    count: total,
    items,
    url: maskUrl(page.url()),
  };
}

async function debugAction(body = {}) {
  const state = await stateAction();
  const shot = await screenshotAction({ fullPage: false }).catch(() => null);
  return {
    ok: true,
    action: "debug",
    state,
    console: diagnostics.console.slice(-(Number(body.consoleLimit) || 20)),
    network: diagnostics.network.slice(-(Number(body.networkLimit) || 20)),
    dialogs: diagnostics.dialog.slice(-(Number(body.dialogLimit) || 20)),
    screenshot: shot?.path || null,
  };
}

// ── other actions ────────────────────────────────────────────────

async function openAction(body) {
  if (body.mode === "headed" || body.mode === "headless") {
    if ((body.mode === "headless") !== currentHeadless) {
      await switchModeAction({ mode: body.mode, preserveUrl: false });
    }
  }
  const page = getPage();
  const url = String(body.url || "").trim();
  if (!url) throw fail("bad-request", "open 需要 url");
  const dialogCountBefore = diagnostics.dialog.length;
  await page.goto(url, {
    waitUntil: body.waitUntil || "domcontentloaded",
    timeout: Number(body.timeout) || 45_000,
  });
  await sleep(500);
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
  activePage = page;
  await foregroundPage(page);
  let state = await stateAction();
  state.dialogs = diagnostics.dialog.slice(dialogCountBefore);
  if (state.manualAuth?.required && currentHeadless && body.autoHeaded !== false) {
    await switchModeAction({ mode: "headed" });
    state = await stateAction();
    state.autoHeaded = true;
    state.autoHeadedReason = state.manualAuth;
  }
  if (body.snapshot) {
    state.snapshot = (await snapshotAction({ mode: body.snapshotMode || "interactive", maxChars: body.maxChars })).snapshot;
  }
  return state;
}

async function gotoAction(body) {
  return openAction({ ...body, snapshot: false });
}

async function dragAction(body) {
  const page = getPage();
  const manualAuth = await manualAuthHints(page);
  if (manualAuth.required) {
    throw fail(
      "manual-auth-required",
      "页面需要用户登录或完成验证；drag 不会绕过登录/验证，请先在可见浏览器完成。",
      manualAuth,
    );
  }

  const sourceSelector = String(body.sourceSelector || "").trim();
  const targetSelector = String(body.targetSelector || "").trim();
  if (!sourceSelector || !targetSelector) {
    throw fail("bad-request", "drag 需要 source 和 target selector");
  }

  const frame = String(body.frame || "").trim();
  const timeout = Number(body.timeout) || DEFAULT_TIMEOUT;
  const force = Boolean(body.force);
  const method = body.js ? "js" : String(body.method || "auto");
  const useJs = method === "js";
  if (!["auto", "dragTo", "mouse", "js"].includes(method)) {
    throw fail("bad-request", `未知 drag method: ${method}；可选 auto|dragTo|mouse|js`);
  }
  if (useJs && !body.allowJs) {
    throw fail("real-only", "js drag 需要显式传 --allow-js，或直接用 --method mouse");
  }

  const root = await getRoot(frame);
  const sourceLocator = root.locator(sourceSelector);
  const targetLocator = root.locator(targetSelector);
  const sourceCount = await sourceLocator.count();
  const targetCount = await targetLocator.count();
  if (sourceCount === 0) throw fail("not-found", `source selector 没有匹配元素: ${sourceSelector}`);
  if (targetCount === 0) throw fail("not-found", `target selector 没有匹配元素: ${targetSelector}`);

  const sourcePicked = await pickVisibleLocator(sourceLocator, timeout, body.sourceNth);
  const targetPicked = await pickVisibleLocator(targetLocator, timeout, body.targetNth);
  const sourceInfo = await describeLocator(sourcePicked.locator);
  const targetInfo = await describeLocator(targetPicked.locator);

  const sourceBox = await sourcePicked.locator.boundingBox();
  const targetBox = await targetPicked.locator.boundingBox();
  if (!sourceBox || !targetBox) {
    throw fail("hidden", "source 或 target 没有可拖拽的 bounding box", { source: sourceInfo, target: targetInfo });
  }

  const beforeUrl = page.url();
  await installProbe(page);
  const sx = sourceBox.x + sourceBox.width / 2;
  const sy = sourceBox.y + sourceBox.height / 2;
  const tx = targetBox.x + targetBox.width / 2;
  const ty = targetBox.y + targetBox.height / 2;
  const steps = Math.max(1, Math.min(60, Number(body.steps) || 12));
  let usedMethod = method;
  let dragError = null;
  let effect = { urlChanged: false, mutations: 0, steps };

  const readEffect = async () => {
    const probe = frame ? { events: [], mutations: 0 } : await drainProbe(page);
    const currentUrl = page.url();
    effect = {
      urlChanged: currentUrl !== beforeUrl,
      mutations: probe.mutations || 0,
      steps,
    };
    return effect;
  };

  try {
    if (method === "auto" || method === "mouse") {
      usedMethod = "mouse";
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      for (let i = 1; i <= steps; i += 1) {
        const ratio = i / steps;
        await page.mouse.move(sx + (tx - sx) * ratio, sy + (ty - sy) * ratio);
        await sleep(10);
      }
      await page.mouse.up();
      await sleep(250);
      await readEffect();
    }
    if (method === "dragTo" || (method === "auto" && !effect.urlChanged && effect.mutations === 0)) {
      usedMethod = "dragTo";
      await sourcePicked.locator.dragTo(targetPicked.locator, { force, timeout: Math.min(timeout, 5000) });
      await sleep(250);
      await readEffect();
    }
    if (method === "js") {
      usedMethod = "js-drag";
      const sourceHandle = await sourcePicked.locator.elementHandle();
      const targetHandle = await targetPicked.locator.elementHandle();
      if (!sourceHandle || !targetHandle) {
        throw new Error("无法取得 source/target element handle");
      }
      await page.evaluate(({ source, target }) => {
        const dataTransfer = new DataTransfer();
        const options = { bubbles: true, cancelable: true, dataTransfer };
        source.dispatchEvent(new DragEvent("dragstart", options));
        target.dispatchEvent(new DragEvent("dragenter", options));
        target.dispatchEvent(new DragEvent("dragover", options));
        target.dispatchEvent(new DragEvent("drop", options));
        source.dispatchEvent(new DragEvent("dragend", options));
      }, { source: sourceHandle, target: targetHandle });
      await sleep(250);
      await readEffect();
    }
  } catch (error) {
    dragError = firstLine(error?.message || error);
  }

  const moved = effect.urlChanged || effect.mutations > 0;
  return {
    ok: !dragError,
    action: "drag",
    profile: currentProfile,
    method: usedMethod,
    trusted: usedMethod !== "js-drag",
    source: sourceInfo,
    target: targetInfo,
    effect,
    ...(dragError ? { error: { code: "drag-failed", message: dragError } } : {}),
    ...(!moved
      ? { warning: "拖拽动作已执行，但没有观察到 URL 或 DOM 变化；请检查 source/target、drop 位置，必要时改用 --method dragTo 或 --method js --allow-js。" }
      : {}),
    url: maskUrl(page.url()),
  };
}

async function fillAction(body) {
  const selector = String(body.selector || "").trim();
  if (!selector) throw fail("bad-request", "fill 需要 selector");
  const page = getPage();
  const manualAuth = await manualAuthHints(page);
  const authOverride = authOverrideAllowed(body, manualAuth);
  if (manualAuth.required && !authOverride) {
    throw fail(
      "manual-auth-required",
      `页面需要用户${manualAuth.kind === "verification" ? "完成验证" : "登录"}；agent 不填写登录/验证字段。请先运行 mode headed，让用户在可见浏览器完成后重试；若用户已明确要求由你代填账号密码，再加 --allow-auth。`,
      manualAuth,
    );
  }
  const root = await getRoot(String(body.frame || ""));
  const locator = root.locator(selector);
  const target = (await pickVisibleLocator(locator, Number(body.timeout) || 5000)).locator;
  const timeout = Number(body.timeout) || DEFAULT_TIMEOUT;
  let value = String(body.value ?? "");
  if (body.append) {
    const existing = await target.inputValue().catch(() => "");
    value = existing + value;
  }
  if (body.type) {
    await target.click({ timeout });
    if (body.clear !== false) await target.fill("");
    await target.pressSequentially(value, { timeout });
  } else {
    await target.fill(value, { timeout });
  }
  return { ok: true, action: "fill", authOverride: authOverride || undefined, profile: currentProfile, target: await describeLocator(target), url: maskUrl(getPage().url()) };
}

async function uploadAction(body) {
  const selector = String(body.selector || "").trim();
  if (!selector) throw fail("bad-request", "upload 需要 selector");
  const files = Array.isArray(body.files) ? body.files.map(String) : [];
  if (!files.length) throw fail("bad-request", "upload 需要至少一个文件");
  const manualAuth = await manualAuthHints(getPage());
  if (manualAuth.required) {
    throw fail(
      "manual-auth-required",
      `页面需要用户${manualAuth.kind === "verification" ? "完成验证" : "登录"}；upload 不在登录/验证页面上传文件，请先让用户在可见浏览器完成。`,
      manualAuth,
    );
  }
  const root = await getRoot(String(body.frame || ""));
  // File inputs are often hidden behind a styled button, so no visibility check here.
  await root.locator(selector).first().setInputFiles(files, { timeout: Number(body.timeout) || DEFAULT_TIMEOUT });
  return {
    ok: true,
    action: "upload",
    profile: currentProfile,
    selector,
    files: files.map((file) => ({ name: basename(file), size: statSync(file).size })),
    url: maskUrl(getPage().url()),
  };
}

async function pressAction(body) {
  const key = String(body.key || "").trim();
  if (!key) throw fail("bad-request", "press 需要 key");
  const page = getPage();
  const manualAuth = await manualAuthHints(page);
  const authOverride = authOverrideAllowed(body, manualAuth);
  if (manualAuth.required && !authOverride) {
    throw fail("manual-auth-required", "页面需要用户登录/验证；agent 不发送可能提交登录或验证的按键。请先运行 mode headed；若用户已明确要求由你代按登录，再加 --allow-auth。", manualAuth);
  }
  await page.keyboard.press(key);
  return { ok: true, action: "press", key, authOverride: authOverride || undefined, url: maskUrl(getPage().url()) };
}

async function hoverAction(body) {
  const selector = String(body.selector || "").trim();
  if (!selector) throw fail("bad-request", "hover 需要 selector");
  const root = await getRoot(String(body.frame || ""));
  const target = (await pickVisibleLocator(root.locator(selector), Number(body.timeout) || DEFAULT_TIMEOUT)).locator;
  await target.hover({ timeout: Number(body.timeout) || DEFAULT_TIMEOUT });
  await sleep(Number(body.wait) || 150);
  return { ok: true, action: "hover", profile: currentProfile, target: await describeLocator(target), url: maskUrl(getPage().url()) };
}

async function selectAction(body) {
  const selector = String(body.selector || "").trim();
  if (!selector) throw fail("bad-request", "select 需要 selector");
  const manualAuth = await manualAuthHints(getPage());
  const authOverride = authOverrideAllowed(body, manualAuth);
  if (manualAuth.required && !authOverride) {
    throw fail("manual-auth-required", "页面需要用户登录/验证；agent 不执行登录/验证操作。", manualAuth);
  }
  const root = await getRoot(String(body.frame || ""));
  const target = (await pickVisibleLocator(root.locator(selector), Number(body.timeout) || DEFAULT_TIMEOUT)).locator;
  const value = body.label
    ? { label: String(body.value ?? "") }
    : String(body.value ?? "");
  await target.selectOption(value, { timeout: Number(body.timeout) || DEFAULT_TIMEOUT });
  return { ok: true, action: "select", authOverride: authOverride || undefined, profile: currentProfile, target: await describeLocator(target), url: maskUrl(getPage().url()) };
}

async function waitAction(body) {
  const page = getPage();
  const timeout = Number(body.timeout) || DEFAULT_TIMEOUT;
  if (body.selector) {
    const root = await getRoot(String(body.frame || ""));
    await root.locator(String(body.selector)).first().waitFor({ state: "visible", timeout });
  } else if (body.url) {
    await page.waitForURL(String(body.url), { timeout });
  } else {
    await sleep(Math.min(timeout, 10_000));
  }
  return { ok: true, action: "wait", url: maskUrl(page.url()), title: await page.title().catch(() => "") };
}

async function screenshotAction(body) {
  const page = getPage();
  const file = resolve(
    String(body.path || join(SHOTS, `${currentProfile}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`)),
  );
  mkdirSync(resolve(file, ".."), { recursive: true, mode: 0o700 });
  await page.screenshot({ path: file, fullPage: Boolean(body.fullPage) });
  const stat = statSync(file);
  return { ok: true, action: "screenshot", profile: currentProfile, path: file, bytes: stat.size, url: maskUrl(page.url()) };
}

// ── annotation: the user boxes a region, the agent reads its elements ──

const ANNOTATION_LAUNCHER_ID = "__browser_operator_annotate_launcher__";
const ANNOTATION_LAYER_ID = "__browser_operator_annotate__";

/**
 * Installs a small persistent launcher in the corner of the page. The user clicks
 * it, drags a rectangle with the real mouse, and the crosshair layer records the
 * region; `read` returns the underlying elements, selectors and coordinates.
 *
 * Shadow DOM and inline styles only: page CSS cannot restyle it and a CSP that
 * blocks inline <style> does not affect it. The layer covers the viewport with
 * pointer-events:auto, so the page never sees the drag.
 */
function annotationLauncher() {
  // Installed as an init script too, so it must not run inside sub-frames and must
  // stay gone after the agent removed it on purpose.
  if (window.top !== window || window.__browserOperatorAnnotationDisabled) return;
  // Runs at document-start as an init script, where <html> may not exist yet.
  if (!document.documentElement) {
    document.addEventListener("DOMContentLoaded", () => annotationLauncher(), { once: true });
    return;
  }
  const LAYER_ID = "__browser_operator_annotate__";
  const LAUNCHER_ID = "__browser_operator_annotate_launcher__";
  window.__browserOperatorAnnotation?.dispose?.();
  for (const id of [LAUNCHER_ID, LAYER_ID]) document.getElementById(id)?.remove();

  const listeners = new AbortController();

  const api = (window.__browserOperatorAnnotation = {
    results: [],
    marks: [],
    closed: false,
    drawing: false,
  });
  const mount = document.documentElement;
  const FONT = "font:13px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;";

  const launcher = document.createElement("div");
  launcher.id = LAUNCHER_ID;
  launcher.style.cssText = "all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;pointer-events:none;";
  const lshadow = launcher.attachShadow({ mode: "open" });
  const pill = document.createElement("button");
  pill.type = "button";
  pill.style.cssText =
    "pointer-events:auto;display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none;white-space:nowrap;border:0;" +
    FONT +
    "font-size:14px;background:#111827;color:#fff;padding:12px 18px;border-radius:999px;" +
    "box-shadow:0 6px 20px rgba(0,0,0,.28),0 0 0 3px rgba(59,130,246,.35);";
  const pillLabel = document.createElement("span");
  pillLabel.textContent = "✎ 圈选标注";
  const badge = document.createElement("span");
  badge.style.cssText =
    "display:none;min-width:18px;text-align:center;background:#3b82f6;border-radius:999px;padding:2px 6px;font-size:11px;font-weight:600;";
  pill.append(pillLabel, badge);
  const hint = document.createElement("div");
  hint.style.cssText =
    "pointer-events:none;position:absolute;right:0;bottom:58px;width:210px;white-space:normal;" +
    FONT +
    "background:#fff;color:#111827;padding:10px 12px;border-radius:10px;border:1px solid #e5e7eb;" +
    "box-shadow:0 8px 24px rgba(0,0,0,.16);";
  hint.textContent = "点这个按钮，然后在页面上按住左键，拖出要标注的矩形框。";
  const bubble = document.createElement("div");
  bubble.style.cssText = "position:relative;pointer-events:none;";
  bubble.append(hint, pill);
  lshadow.append(bubble);
  mount.append(launcher);

  const MARKS_ID = "__browser_operator_annotate_marks__";
  document.getElementById(MARKS_ID)?.remove();

  const marksHost = document.createElement("div");
  marksHost.id = MARKS_ID;
  marksHost.style.cssText =
    "all:initial;position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;";
  const marksSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  marksSvg.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;";
  const marksButtons = document.createElement("div");
  marksButtons.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;";
  const marksShadow = marksHost.attachShadow({ mode: "open" });
  marksShadow.append(marksSvg, marksButtons);
  mount.append(marksHost);

  setTimeout(() => hint.remove(), 12000);

  let layer = null;
  let drawing = false;
  let points = [];

  const syncBadge = () => {
    // Count what is on screen (marks), not what is still unread: the user clears
    // them with the ×, the agent reading them must not make the number jump.
    const count = api.marks.length;
    badge.style.display = count ? "inline-block" : "none";
    badge.textContent = String(count);
    pillLabel.textContent = count ? "清空标注" : layer ? "请选择" : "✎ 圈选标注";
    pill.title = count ? "清除全部标注并退出标注模式" : layer ? "请按住左键拖出矩形框" : "开始圈选标注";
  };

  // Recorded boxes stay on the page until the user clears them, so nothing they
  // already pointed at silently disappears.
  const dropMark = (mark) => {
    const at = api.marks.indexOf(mark);
    if (at >= 0) api.marks.splice(at, 1);
    const pending = api.results.indexOf(mark);
    if (pending >= 0) api.results.splice(pending, 1);
    renderMarks();
    syncBadge();
  };

  const renderMarks = () => {
    const svgns = "http://www.w3.org/2000/svg";
    while (marksSvg.firstChild) marksSvg.removeChild(marksSvg.firstChild);
    while (marksButtons.firstChild) marksButtons.removeChild(marksButtons.firstChild);
    api.marks.forEach((mark, index) => {
      const frame = document.createElementNS(svgns, "rect");
      frame.setAttribute("x", String(mark.x));
      frame.setAttribute("y", String(mark.y));
      frame.setAttribute("width", String(mark.width));
      frame.setAttribute("height", String(mark.height));
      frame.setAttribute("rx", "6");
      frame.setAttribute("fill", "rgba(59,130,246,0.10)");
      frame.setAttribute("stroke", "#3b82f6");
      frame.setAttribute("stroke-width", "1.5");
      frame.setAttribute("stroke-dasharray", "6 4");
      marksSvg.appendChild(frame);
      const dot = document.createElementNS(svgns, "circle");
      dot.setAttribute("cx", String(mark.x + 12));
      dot.setAttribute("cy", String(mark.y + 12));
      dot.setAttribute("r", "10");
      dot.setAttribute("fill", "#3b82f6");
      const label = document.createElementNS(svgns, "text");
      label.setAttribute("x", String(mark.x + 12));
      label.setAttribute("y", String(mark.y + 12));
      label.setAttribute("fill", "#fff");
      label.setAttribute("font-size", "11");
      label.setAttribute("font-family", "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif");
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("dominant-baseline", "central");
      label.textContent = String(index + 1);
      marksSvg.append(dot, label);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.title = `删除标注 ${index + 1}`;
      remove.setAttribute("aria-label", remove.title);
      remove.style.cssText =
        `pointer-events:auto;position:absolute;left:${Math.max(0, Math.round(mark.x + mark.width - 9))}px;` +
        `top:${Math.max(0, Math.round(mark.y - 9))}px;width:20px;height:20px;padding:0;border-radius:50%;` +
        "border:1px solid #3b82f6;background:#fff;color:#3b82f6;cursor:pointer;" +
        "font:14px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.2);";
      remove.addEventListener("pointerdown", (event) => event.stopPropagation());
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        dropMark(mark);
      });
      marksButtons.appendChild(remove);
    });

  };
  api.refresh = syncBadge;

  const paintRect = () => {
    if (!layer || !points.length) return;
    const [start, end = start] = points;
    layer.preview.setAttribute("x", String(Math.min(start[0], end[0])));
    layer.preview.setAttribute("y", String(Math.min(start[1], end[1])));
    layer.preview.setAttribute("width", String(Math.abs(end[0] - start[0])));
    layer.preview.setAttribute("height", String(Math.abs(end[1] - start[1])));
  };

  const closeLayer = () => {
    layer?.host.remove();
    layer = null;
    drawing = false;
    points = [];
    api.drawing = false;
    syncBadge();
  };

  api.dispose = () => {
    closeLayer();
    listeners.abort();
    launcher.remove();
    marksHost.remove();
    api.marks.length = 0;
    api.results.length = 0;
  };

  const clearAll = () => {
    api.marks.length = 0;
    api.results.length = 0;
    renderMarks();
    closeLayer();
  };

  const openLayer = () => {
    const host = document.createElement("div");
    host.id = LAYER_ID;
    host.style.cssText =
      "all:initial;position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483646;cursor:crosshair;touch-action:none;";
    const shadow = host.attachShadow({ mode: "open" });

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;";
    const preview = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    preview.setAttribute("fill", "rgba(59,130,246,0.10)");
    preview.setAttribute("stroke", "#3b82f6");
    preview.setAttribute("stroke-width", "1.5");
    preview.setAttribute("stroke-dasharray", "6 4");
    preview.setAttribute("rx", "6");
    svg.append(preview);
    shadow.append(svg);
    (document.body || mount).append(host);

    layer = { host, preview };
    api.drawing = true;
    api.closed = false;
    syncBadge();
  };

  pill.addEventListener("pointerdown", (event) => event.stopPropagation());
  pill.addEventListener("click", (event) => {
    event.stopPropagation();
    if (api.marks.length) clearAll();
    else if (layer) closeLayer();
    else openLayer();
  });

  // One set of window-level listeners for the lifetime of the launcher: a page
  // handler on document capture would otherwise be able to swallow the drag.
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (!layer || event.button !== 0 || event.composedPath()[0] !== layer.host) return;
      event.preventDefault();
      event.stopPropagation();
      drawing = true;
      points = [[event.clientX, event.clientY]];
      try {
        layer.host.setPointerCapture(event.pointerId);
      } catch {}
      paintRect();
    },
    { capture: true, signal: listeners.signal },
  );

  window.addEventListener(
    "pointermove",
    (event) => {
      if (!drawing) return;
      event.preventDefault();
      event.stopPropagation();
      points[1] = [event.clientX, event.clientY];
      paintRect();
    },
    { capture: true, signal: listeners.signal },
  );

  window.addEventListener(
    "pointerup",
    (event) => {
      if (!drawing || !layer) return;
      drawing = false;
      event.preventDefault();
      event.stopPropagation();
      points[1] = [event.clientX, event.clientY];
      layer.preview.setAttribute("width", "0");
      layer.preview.setAttribute("height", "0");
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      let left = Math.min(...xs);
      let top = Math.min(...ys);
      let right = Math.max(...xs);
      let bottom = Math.max(...ys);
      left = Math.max(0, left);
      top = Math.max(0, top);
      right = Math.min(window.innerWidth, right);
      bottom = Math.min(window.innerHeight, bottom);
      if (right - left < 4 || bottom - top < 4) return;

      api.results.push({
        x: Math.round(left),
        y: Math.round(top),
        width: Math.round(right - left),
        height: Math.round(bottom - top),
        scroll: { x: window.scrollX, y: window.scrollY },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        devicePixelRatio: window.devicePixelRatio,
        at: Date.now(),
      });
      const mark = api.results[api.results.length - 1];
      api.marks.push(mark);
      renderMarks();
      syncBadge();
    },
    { capture: true, signal: listeners.signal },
  );

  window.addEventListener(
    "keydown",
    (event) => {
      if (!layer || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeLayer();
    },
    { capture: true, signal: listeners.signal },
  );
}

/** Resolve a drawn region into concrete elements the agent can act on. */
function pickRegion({ rect, maxElements = 6 }) {
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const cssEscape = (value) =>
    typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
  const unique = (candidate) => {
    try {
      return document.querySelectorAll(candidate).length === 1;
    } catch {
      return false;
    }
  };
  const suggest = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.id && unique(`#${cssEscape(el.id)}`)) return `#${cssEscape(el.id)}`;
    for (const attr of ["data-testid", "data-test", "name", "aria-label", "placeholder", "title"]) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const candidate = `${tag}[${attr}="${String(value).replace(/"/g, '\\"')}"]`;
      if (unique(candidate)) return candidate;
    }
    const parts = [];
    let current = el;
    while (current && current.nodeType === 1 && current !== document.body) {
      const currentTag = current.tagName.toLowerCase();
      if (current.id && unique(`#${cssEscape(current.id)}`)) {
        parts.unshift(`#${cssEscape(current.id)}`);
        break;
      }
      let part = currentTag;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      const candidate = parts.join(" > ");
      if (unique(candidate)) return candidate;
      current = parent;
    }
    return parts.join(" > ") || tag;
  };

  const skip = (el) =>
    !el || el.nodeType !== 1 || el.id.startsWith("__browser_operator_annotate") || el.tagName === "HTML" || el.tagName === "BODY";
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const bounds = el.getBoundingClientRect();
    const role = el.getAttribute("role") || "";
    const name = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || "";
    return {
      tag,
      selector: suggest(el),
      role: role || undefined,
      name: name ? normalize(name).slice(0, 80) : undefined,
      text: normalize(el.innerText ?? el.value ?? "").slice(0, 200),
      rect: {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      },
      center: {
        x: Math.round(bounds.left + bounds.width / 2),
        y: Math.round(bounds.top + bounds.height / 2),
      },
      interactive: ["a", "button", "input", "select", "textarea", "label", "summary"].includes(tag) || Boolean(role),
    };
  };

  // Sample a grid, not just the center: a box around a card usually has its
  // center on a child, while the card itself is what the user means.
  const cols = 5;
  const rows = 4;
  const points = [];
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      points.push([rect.x + (rect.width * (col + 0.5)) / cols, rect.y + (rect.height * (row + 0.5)) / rows]);
    }
  }
  points.push([rect.x + rect.width / 2, rect.y + rect.height / 2]);

  // Vote over every element under each sample point, not just the topmost one:
  // the card the user selected is an ancestor of whatever pixel is on top there.
  const regionArea = Math.max(1, rect.width * rect.height);
  const votes = new Map();
  let iframe = false;
  for (const [px, py] of points) {
    const x = Math.min(window.innerWidth - 1, Math.max(0, px));
    const y = Math.min(window.innerHeight - 1, Math.max(0, py));
    const stack = document.elementsFromPoint(x, y);
    if (stack.some((el) => el && el.tagName === "IFRAME")) iframe = true;
    for (const el of stack) {
      if (skip(el)) continue;
      votes.set(el, (votes.get(el) || 0) + 1);
    }
  }

  // Rank: a block that sits fully inside the drawn box beats a page wrapper that
  // merely covers it; then most sample points; then the more enclosing one.
  const areaOf = (el) => {
    const b = el.getBoundingClientRect();
    return Math.max(1, b.width * b.height);
  };
  const candidates = [...votes.entries()].map(([el, count]) => {
    const bounds = el.getBoundingClientRect();
    const enclosed =
      bounds.left >= rect.x - 2 &&
      bounds.top >= rect.y - 2 &&
      bounds.right <= rect.x + rect.width + 2 &&
      bounds.bottom <= rect.y + rect.height + 2;
    const oversized = areaOf(el) > regionArea * 4;
    return {
      el,
      count,
      rank: oversized ? 2 : enclosed ? 0 : 1,
      entry: { ...describe(el), votes: count, coverage: Math.round((count / points.length) * 100) / 100, enclosed },
    };
  });
  candidates.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (b.count !== a.count) return b.count - a.count;
    return areaOf(b.el) - areaOf(a.el);
  });
  const ranked = candidates.slice(0, maxElements).map((item) => item.entry);

  const dominant = ranked[0] || null;
  const ancestors = [];
  let parent = candidates[0]?.el.parentElement || null;
  for (let depth = 0; parent && depth < 3 && parent !== document.body; depth++) {
    ancestors.push({ tag: parent.tagName.toLowerCase(), selector: suggest(parent), text: normalize(parent.innerText || "").slice(0, 80) });
    parent = parent.parentElement;
  }

  return {
    iframe,
    dominant,
    elements: ranked,
    ancestors,
    text: dominant ? normalize(dominant.text).slice(0, 400) : "",
  };
}

/** Install the launcher; returns immediately so the user can draw whenever. */
async function annotateStart() {
  setAnnotationEnabled(true);
  let switchedToHeaded = false;
  if (currentHeadless) {
    await switchModeAction({ mode: "headed", preserveUrl: true });
    switchedToHeaded = true;
  }
  const page = getPage();
  for (const candidate of context.pages()) {
    await candidate.evaluate(() => { window.__browserOperatorAnnotationDisabled = false; });
    const present = await candidate.evaluate(() => Boolean(document.getElementById("__browser_operator_annotate_launcher__")));
    if (!present) await candidate.evaluate(annotationLauncher);
  }
  return {
    ok: true,
    action: "annotate",
    mode: "start",
    enabled: true,
    profile: currentProfile,
    switchedToHeaded,
    url: maskUrl(page.url()),
    title: await page.title().catch(() => ""),
    launcher: "右下角「✎ 圈选标注」",
    hint: "用户点右下角按钮后拖出矩形框；框选后用 browser annotate read 取结果",
  };
}

async function annotateRead() {
  const page = getPage();
  const state = await page
    .evaluate(() => {
      const api = window.__browserOperatorAnnotation;
      const present = Boolean(document.getElementById("__browser_operator_annotate_launcher__"));
      return {
        present,
        closed: Boolean(api && api.closed),
        drawing: Boolean(api && api.drawing),
        results: api ? api.results.slice() : [],
      };
    })
    .catch(() => ({ present: false, closed: false, drawing: false, results: [] }));

  const base = { ok: true, action: "annotate", mode: "read", profile: currentProfile, active: state.present, coordinateSpace: "viewport" };

  if (!state.results.length) {
    if (!state.present) {
      return {
        ...base,
        results: [],
        hint: state.closed
          ? "用户已点「完成」结束标注，但没有留下圈选结果；重新 annotate start 可再开一个入口"
          : "浮层不在页面上（页面跳转过，或标注入口被移除），重新 annotate start",
      };
    }
    return { ...base, results: [], pending: true, hint: "入口还在，用户还没画" };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(HOME, "annotations");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const results = [];

  for (const item of state.results) {
    const rect = { x: item.x, y: item.y, width: item.width, height: item.height };
    const region = await page.evaluate(pickRegion, { rect }).catch((error) => ({ error: firstLine(error?.message || error) }));

    results.push({
      region: { ...rect, scroll: item.scroll, viewport: item.viewport, devicePixelRatio: item.devicePixelRatio },
      dominant: region.dominant || null,
      elements: region.elements || [],
      ancestors: region.ancestors || [],
      text: region.text || "",
      insideFrame: Boolean(region.iframe),
      ...(region.error ? { error: region.error } : {}),
    });
  }

  await page
    .evaluate(() => {
      const api = window.__browserOperatorAnnotation;
      if (!api) return;
      api.results.length = 0;
      api.refresh?.();
    })
    .catch(() => {});

  const record = join(dir, `${currentProfile}-${stamp}.json`);
  const result = {
    ...base,
    url: maskUrl(page.url()),
    title: await page.title().catch(() => ""),
    count: results.length,
    results,
    record,
  };
  writeJson(record, result);
  return result;
}

/** Blocking variant: wait for the first circle, then read it. */
async function annotateWait(body = {}) {
  const timeout = Math.max(5_000, Number(body.timeout) || 150_000);
  await annotateStart();
  const page = getPage();
  try {
    await page.waitForFunction(
      () => {
        const api = window.__browserOperatorAnnotation;
        return Boolean(api && api.results.length);
      },
      undefined,
      { timeout, polling: 200 },
    );
  } catch {
    throw fail("annotate-timeout", `等不到圈选结果（${Math.round(timeout / 1000)}s）。用户没有画，或者页面跳转把入口清掉了。`);
  }
  return annotateRead();
}

async function annotateCancel() {
  setAnnotationEnabled(false);
  await Promise.all(context.pages().map((page) => page.evaluate(() => {
    window.__browserOperatorAnnotationDisabled = true;
    window.__browserOperatorAnnotation?.dispose?.();
  }).catch(() => {})));
  return { ok: true, action: "annotate", mode: "cancel", enabled: false, profile: currentProfile, removed: true };
}

async function annotateAction(body = {}) {
  const mode = String(body.mode || "start").toLowerCase();
  if (mode === "start") return annotateStart();
  if (mode === "read") return annotateRead();
  if (mode === "wait") return annotateWait(body);
  if (mode === "cancel") return annotateCancel();
  throw fail("bad-mode", "annotate 的 mode 必须是 start / read / wait / cancel");
}

function bindContext(ctx) {
  const serial = ++contextSerial;
  ctx.on("page", (page) => {
    logLine(`new page ${maskUrl(page.url())}`);
    attachDiagnostics(page);
    if (!activePage || activePage.isClosed()) activePage = page;
  });
  ctx.on("close", () => {
    if (switchingMode || serial !== contextSerial) return;
    logLine("browser context closed");
    void shutdown(0);
  });
}

async function switchModeAction(body = {}) {
  const mode = String(body.mode || "").toLowerCase();
  if (mode !== "headed" && mode !== "headless") {
    throw fail("bad-mode", "mode 必须是 headed 或 headless");
  }
  const targetHeadless = mode === "headless";
  if (targetHeadless === currentHeadless) {
    return { ok: true, action: "mode", mode, headless: currentHeadless, switched: false, state: await stateAction() };
  }

  const preserveUrl = body.preserveUrl !== false;
  const url = preserveUrl && activePage && !activePage.isClosed() ? activePage.url() : "";
  const previousHeadless = currentHeadless;
  switchingMode = true;
  try {
    await context?.close();
    const launched = await launchBrowser(currentProfile, targetHeadless);
    context = launched.context;
    activePage = launched.page;
    currentHeadless = targetHeadless;
    bindContext(context);
    if (url && url !== "about:blank") {
      await activePage.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((error) => {
        logLine(`mode switch restore URL failed: ${firstLine(error?.message || error)}`);
      });
      await activePage.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    }
    const daemonPath = profilePaths(currentProfile).daemon;
    const info = readJson(daemonPath);
    if (info) {
      info.headless = targetHeadless;
      writeJson(daemonPath, info);
    }
    const state = await stateAction();
    logLine(`mode switched to ${mode}`);
    return { ...state, ok: true, action: "mode", mode, headless: targetHeadless, switched: true };
  } catch (error) {
    logLine(`mode switch failed: ${firstLine(error?.message || error)}`);
    try {
      const restored = await launchBrowser(currentProfile, previousHeadless);
      context = restored.context;
      activePage = restored.page;
      currentHeadless = previousHeadless;
      bindContext(context);
      if (url && url !== "about:blank") {
        await activePage.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      }
    } catch {}
    throw fail("mode-switch-failed", firstLine(error?.message || error));
  } finally {
    switchingMode = false;
  }
}

async function closeAction() {
  const pages = context.pages().filter((candidate) => !candidate.isClosed());
  if (pages.length <= 1) throw fail("cannot-close", "只剩一个标签页，不能关闭；需要停止浏览器请用 stop");
  const page = getPage();
  const closedUrl = maskUrl(page.url());
  await page.close();
  const remaining = context.pages().filter((candidate) => !candidate.isClosed());
  activePage = remaining[0] || null;
  if (activePage) await foregroundPage(activePage);
  return { ok: true, action: "close", closedUrl, state: await stateAction() };
}

async function switchAction(body) {
  const pages = context.pages().filter((candidate) => !candidate.isClosed());
  let page = null;
  if (typeof body.index === "number") page = pages[body.index] || null;
  else if (body.urlIncludes) page = pages.find((candidate) => candidate.url().includes(String(body.urlIncludes))) || null;
  if (!page) throw fail("page-not-found", "没有匹配的标签页");
  activePage = page;
  await foregroundPage(page);
  return stateAction();
}

// Explicit "bring the headed window to front". Headed launches deliberately
// stay behind so automation never interrupts the user; use this when the user
// needs to log in or verify something.
async function focusAction() {
  const page = getPage();
  await page.bringToFront().catch(() => {});
  if (process.platform === "darwin") {
    try {
      spawnSync("open", ["-b", "com.google.Chrome"], { stdio: "ignore" });
    } catch {}
  }
  return { ok: true, action: "focus", headless: currentHeadless, state: await stateAction() };
}

async function waitLoginAction(body) {
  const timeout = Number(body.timeout) || 300_000;
  const deadline = Date.now() + timeout;
  const initial = await stateAction();
  if (initial.login?.likely && currentHeadless) {
    await switchModeAction({ mode: "headed" }).catch(() => {});
  }
  while (Date.now() < deadline) {
    const state = await stateAction();
    if (!state.login?.likely) {
      return { ok: true, action: "wait-login", loggedIn: true, state };
    }
    await sleep(1000);
  }
  return { ok: false, action: "wait-login", error: { code: "login-timeout", message: `等待登录超时（${timeout}ms）` }, state: await stateAction() };
}

async function waitVerificationAction(body = {}) {
  const timeout = Number(body.timeout) || 120_000;
  const deadline = Date.now() + timeout;
  const initial = await stateAction();
  if (initial.challenge?.likely && currentHeadless) {
    await switchModeAction({ mode: "headed" }).catch(() => {});
  }
  while (Date.now() < deadline) {
    const state = await stateAction();
    if (!state.challenge?.likely) {
      return { ok: true, action: "wait-verification", verified: true, state };
    }
    await sleep(1000);
  }
  return {
    ok: false,
    action: "wait-verification",
    error: { code: "verification-timeout", message: `等待页面验证超时（${timeout}ms）；请在有头窗口中手动完成验证` },
    state: await stateAction(),
  };
}

// ── experience memory ────────────────────────────────────────────

function normalizeDomain(value) {
  let input = String(value || "").trim();
  if (!input) throw fail("bad-request", "experience 需要 domain 或 URL");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    input = input.includes("/") ? `https://${input}` : `https://${input}`;
  }
  let host;
  try {
    host = new URL(input).hostname;
  } catch {
    throw fail("bad-domain", `无法解析域名: ${value}`);
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  if (!/^[a-z0-9.-]+$/.test(host)) throw fail("bad-domain", `非法域名: ${host}`);
  return host;
}

function experiencePath(value) {
  ensureHome();
  return join(EXPERIENCES, `${normalizeDomain(value)}.md`);
}

function parseMetaList(value) {
  let raw = String(value || "").trim();
  if (raw.startsWith("[") && raw.endsWith("]")) raw = raw.slice(1, -1);
  return raw
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function parseExperienceMeta(text) {
  const meta = {};
  const match = String(text || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return meta;
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = key === "aliases" ? parseMetaList(value) : value;
  }
  return meta;
}

const EXPERIENCE_ENV_ORDER = ["local", "dev", "sit", "test", "stage", "uat", "prod", "other"];
const EXPERIENCE_ENV_LABEL = /^(?:dev|development|sit|uat|test|testing|stage|staging|qa|prod|production|local|demo|sandbox)\d*$/i;

function domainKey(value) {
  let host;
  try {
    host = normalizeDomain(value);
  } catch {
    return "";
  }
  const envToken = "(?:dev|development|sit|uat|test|testing|stage|staging|qa|prod|production|local|demo|sandbox)\\d*";
  return host
    .split(".")
    .map((label) => {
      if (!label || EXPERIENCE_ENV_LABEL.test(label)) return "";
      let cleaned = label.replace(new RegExp(`(^|[-_])${envToken}(?=[-_]|$)`, "ig"), "$1");
      cleaned = cleaned.replace(/[-_]{2,}/g, "-").replace(/^[-_]+|[-_]+$/g, "");
      return cleaned;
    })
    .filter(Boolean)
    .join(".");
}

function safeNormalizeDomain(value) {
  try {
    return normalizeDomain(value);
  } catch {
    return "";
  }
}

function experienceEntries() {
  ensureHome();
  const experiences = [];
  for (const entry of readdirSync(EXPERIENCES, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = join(EXPERIENCES, entry.name);
    const meta = parseExperienceMeta(readFileSync(path, "utf8"));
    const aliases = Array.isArray(meta.aliases) ? meta.aliases.map(safeNormalizeDomain).filter(Boolean) : [];
    experiences.push({
      domain: safeNormalizeDomain(meta.domain) || entry.name.replace(/\.md$/, ""),
      site: meta.site || "",
      updated: meta.updated || "",
      confidence: meta.confidence || "",
      app: meta.app || "",
      environment: meta.environment || "",
      aliases,
      meta,
      path,
    });
  }
  return experiences;
}

function relatedExperiences(domain, experiences) {
  const primary = experiences.find((entry) => entry.domain === domain);
  const app = String(primary?.app || "").trim().toLowerCase();
  const primaryAliases = new Set([...(primary?.aliases || []), domain]);
  const key = domainKey(domain);
  return experiences
    .filter((entry) => entry.domain !== domain)
    .map((entry) => {
      let match = "";
      if (app && String(entry.app || "").trim().toLowerCase() === app) match = "app";
      else if (primaryAliases.has(entry.domain) || entry.aliases.includes(domain)) match = "alias";
      else if (key && domainKey(entry.domain) === key) match = "normalized-domain";
      if (!match) return null;
      return {
        domain: entry.domain,
        site: entry.site,
        updated: entry.updated,
        confidence: entry.confidence,
        app: entry.app,
        environment: entry.environment,
        match,
        path: entry.path,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const ai = EXPERIENCE_ENV_ORDER.indexOf(String(a.environment).toLowerCase());
      const bi = EXPERIENCE_ENV_ORDER.indexOf(String(b.environment).toLowerCase());
      const ar = ai < 0 ? EXPERIENCE_ENV_ORDER.length : ai;
      const br = bi < 0 ? EXPERIENCE_ENV_ORDER.length : bi;
      return ar - br || String(b.updated).localeCompare(String(a.updated));
    });
}

function experienceListAction() {
  const experiences = experienceEntries()
    .map(({ meta, aliases, ...entry }) => entry)
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  return { ok: true, action: "experience-list", directory: EXPERIENCES, experiences };
}

function experienceShowAction(value) {
  const domain = normalizeDomain(value);
  const path = experiencePath(domain);
  const experiences = experienceEntries();
  const related = relatedExperiences(domain, experiences);
  if (!existsSync(path)) {
    return { ok: true, action: "experience-show", found: false, path, domain, related };
  }
  const content = readFileSync(path, "utf8");
  return {
    ok: true,
    action: "experience-show",
    found: true,
    path,
    domain,
    meta: parseExperienceMeta(content),
    related,
    content,
  };
}

function experienceRelatedAction(value) {
  const domain = normalizeDomain(value);
  const experiences = experienceEntries();
  const primary = experiences.find((entry) => entry.domain === domain);
  return {
    ok: true,
    action: "experience-related",
    domain,
    found: Boolean(primary),
    app: primary?.app || "",
    environment: primary?.environment || "",
    related: relatedExperiences(domain, experiences),
  };
}

function experiencePathAction(value) {
  return { ok: true, action: "experience-path", path: experiencePath(value), domain: normalizeDomain(value) };
}

function experienceValidateAction(value) {
  const path = experiencePath(value);
  if (!existsSync(path)) {
    return { ok: false, action: "experience-validate", path, errors: ["experience file not found"] };
  }
  const text = readFileSync(path, "utf8");
  const meta = parseExperienceMeta(text);
  const errors = [];
  for (const key of ["site", "domain", "updated", "confidence"]) {
    if (!meta[key]) errors.push(`missing frontmatter: ${key}`);
  }
  for (const heading of ["快速路径", "选择器", "陷阱", "空页面/异常兜底"]) {
    if (!text.includes(`## ${heading}`)) errors.push(`missing section: ## ${heading}`);
  }
  return { ok: errors.length === 0, action: "experience-validate", path, meta, errors };
}

// ── operation recipes (脚本) ─────────────────────────────────────
//
// One Markdown file per site under ~/.dsh/browser-operator/脚本/, mirroring
// the experience files: an LLM can read and hand-edit it. Each task is an
// `##` section with a counter and a fenced ```steps block of CLI commands;
// dynamic values use {{placeholders}} and are supplied with --var at run time.
// Steps never carry stored credentials or --allow-auth; explicit one-off
// authorization stays on the run command.

const RECIPE_ACTIONS = new Set([
  "open",
  "goto",
  "state",
  "focus",
  "snapshot",
  "query",
  "click",
  "eval",
  "drag",
  "fill",
  "press",
  "hover",
  "select",
  "wait",
  "screenshot",
  "switch",
  "close",
  "mode",
  "dialog",
  "console",
  "network",
  "debug",
  "wait-login",
  "wait-verification",
  "upload",
]);
const RECIPE_AUTH_ACTIONS = new Set(["click", "fill", "press", "select"]);

function ensureRecipesDir() {
  ensureHome();
  mkdirSync(RECIPES, { recursive: true, mode: 0o700 });
}

function recipePath(value) {
  ensureRecipesDir();
  return join(RECIPES, `${normalizeDomain(value)}.md`);
}

function recipeSlug(value) {
  return (
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "task"
  );
}

function recipeTaskKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[`"'*_]/g, "")
    .replace(/[\s:：]+/g, "")
    .trim();
}

function parseRecipeParams(value) {
  return String(value || "")
    .split(/[;；]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const at = item.indexOf("=");
      if (at <= 0) return { name: item, description: "" };
      return { name: item.slice(0, at).trim(), description: item.slice(at + 1).trim() };
    })
    .filter((param) => param.name);
}

function recipeTasks(text) {
  const lines = String(text || "").split(/\r?\n/);
  const tasks = [];
  let current = null;
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = line.match(/^\s*```([A-Za-z0-9_-]*)\s*$/);
    if (marker) {
      if (!fence) {
        fence = { collecting: null };
        if (current && /^(steps|bash|sh)$/i.test(marker[1])) fence.collecting = [];
      } else {
        if (fence.collecting && current) {
          current.steps = fence.collecting.filter((item) => item.trim());
        }
        fence = null;
      }
      continue;
    }
    if (fence) {
      if (fence.collecting) fence.collecting.push(line);
      continue;
    }
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = {
        title: heading[1].replace(/\s*#+\s*$/, "").trim(),
        headingIndex: index,
        endIndex: lines.length,
        count: 0,
        params: [],
        steps: [],
      };
      tasks.push(current);
      continue;
    }
    if (!current) continue;
    const count = line.match(/^\s*[-*]\s*次数\s*[:：]\s*(\d+)/);
    if (count) current.count = Number(count[1]);
    const params = line.match(/^\s*[-*]\s*参数\s*[:：]\s*(.+)$/);
    if (params) current.params = parseRecipeParams(params[1]);
  }
  tasks.forEach((task, index) => {
    task.endIndex = index + 1 < tasks.length ? tasks[index + 1].headingIndex : lines.length;
  });
  return tasks;
}

function pickRecipeTask(tasks, wanted) {
  const target = String(wanted || "").trim();
  if (!target) return tasks.length === 1 ? tasks[0] : null;
  const exact = tasks.find((task) => task.title === target);
  if (exact) return exact;
  const key = recipeTaskKey(target);
  const byKey = tasks.find((task) => recipeTaskKey(task.title) === key);
  if (byKey) return byKey;
  const slug = recipeSlug(target);
  return tasks.find((task) => recipeSlug(task.title) === slug) || null;
}

function tokenizeRecipeStep(line) {
  const tokens = [];
  let current = "";
  let quote = "";
  let started = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) {
        quote = "";
        continue;
      }
      if (char === "\\" && quote === '"') {
        current += line[index + 1] ?? "";
        index += 1;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (quote) throw new Error("引号未闭合");
  if (started || current) tokens.push(current);
  return tokens;
}

function substituteRecipeToken(token, vars, missing, used) {
  return String(token).replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, name) => {
    used?.add(name);
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    missing.add(name);
    return match;
  });
}

function parseRecipeVars(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const vars = {};
  for (const item of list) {
    const at = String(item).indexOf("=");
    if (at <= 0) continue;
    vars[String(item).slice(0, at).trim()] = String(item).slice(at + 1);
  }
  return vars;
}

function compactRecipeResult(value) {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (text.length <= 4000) return value;
  return { truncated: true, bytes: text.length, preview: text.slice(0, 2000) };
}

function captureRecipeFailure(domain, title, profile) {
  try {
    ensureHome();
    const file = join(SHOTS, `recipe-${recipeSlug(domain)}-${recipeSlug(title)}-${Date.now()}.png`);
    const args = [SELF, "screenshot", file];
    if (profile) args.push("--profile", String(profile));
    const child = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30_000, env: process.env });
    return child.status === 0 && existsSync(file) ? file : "";
  } catch {
    return "";
  }
}

// ── recipe index (脚本/<domain>.md) maintained lines ─────────────

const RECIPE_TASK_NAME = /^[a-z][a-z0-9_]*$/;
const RECIPE_FIELD_LINE = /^\s*[-*]\s*([^\s:：]+)\s*[:：]\s*(.*)$/;

function recipeToday() {
  return logNow().slice(0, 10);
}

// Sets one `- key: value` line of a task section (section[0] is the heading).
// An empty value removes the line; a missing line goes after the leading field lines.
function setRecipeSectionField(section, key, value) {
  const text = value === undefined || value === null || value === "" ? "" : `- ${key}: ${value}`;
  const index = section.findIndex((line, at) => at > 0 && line.match(RECIPE_FIELD_LINE)?.[1] === key);
  if (index >= 0) {
    if (text) section[index] = text;
    else section.splice(index, 1);
    return;
  }
  if (!text) return;
  let at = 1;
  while (at < section.length && !section[at].trim()) at += 1;
  if (at < section.length && RECIPE_FIELD_LINE.test(section[at])) {
    while (at < section.length && RECIPE_FIELD_LINE.test(section[at])) at += 1;
  } else {
    at = 1;
  }
  section.splice(at, 0, text);
}

function recipeSectionFields(section) {
  const fields = {};
  for (const line of section.slice(1)) {
    const match = line.match(RECIPE_FIELD_LINE);
    if (match && !(match[1] in fields)) fields[match[1]] = match[2].trim();
  }
  return fields;
}

function recipeIndexHeader(domain, site) {
  return ["---", ...(site ? [`site: ${site}`] : []), `domain: ${domain}`, `updated: ${recipeToday()}`, "---", "", `# ${domain} 操作脚本`, ""].join("\n");
}

// Applies edit(fields) -> { key: value } to the `## <task>` section of the
// index, creating the file and the section when missing.
function editRecipeIndex(domain, task, edit, init = {}) {
  const path = recipePath(domain);
  const fileExisted = existsSync(path);
  const text = fileExisted ? readFileSync(path, "utf8") : recipeIndexHeader(domain, init.site);
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  let found = recipeTasks(lines.join("\n")).find((item) => item.title === task);
  const created = !found;
  if (!found) {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    lines.push("", `## ${task}`);
    if (init.desc) lines.push(`- 说明: ${String(init.desc).replace(/\s+/g, " ").trim()}`);
    lines.push("- 次数: 0");
    found = recipeTasks(lines.join("\n")).find((item) => item.title === task);
  }
  const section = lines.slice(found.headingIndex, found.endIndex);
  const fields = recipeSectionFields(section);
  const updates = (edit && edit(fields)) || {};
  for (const [key, value] of Object.entries(updates)) setRecipeSectionField(section, key, value);
  lines.splice(found.headingIndex, found.endIndex - found.headingIndex, ...section);
  writeRecipeIndex(path, lines);
  return { path, created, fileCreated: !fileExisted, fields: { ...fields, ...updates } };
}

// Writes the index back with exactly one trailing newline, so repeated runs do not pile up blank lines.
function writeRecipeIndex(path, lines) {
  writeFileSync(path, `${lines.join("\n").replace(/\s+$/, "")}\n`);
}

function recipeScriptNames(domain) {
  const dir = join(RECIPES, domain);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs") && !entry.name.startsWith("_"))
    .map((entry) => entry.name.slice(0, -4))
    .sort();
}

function recipeTaskNames(domain) {
  const path = join(RECIPES, `${domain}.md`);
  const titles = existsSync(path) ? recipeTasks(readFileSync(path, "utf8")).map((task) => task.title) : [];
  return [...new Set([...titles, ...recipeScriptNames(domain)])];
}

function experienceSite(domain) {
  try {
    return parseExperienceMeta(readFileSync(join(EXPERIENCES, `${domain}.md`), "utf8")).site || "";
  } catch {
    return "";
  }
}

// ── recipe scripts (脚本/<domain>/<task>.mjs) ─────────────────────

function recipeScriptHash(file) {
  const hash = createHash("sha256").update(readFileSync(file));
  const dir = dirname(file);
  for (const name of readdirSync(dir).filter((item) => item.startsWith("_") && item.endsWith(".mjs")).sort()) {
    hash.update(readFileSync(join(dir, name)));
  }
  return hash.digest("hex").slice(0, 8);
}

async function loadRecipeScript(file) {
  try {
    const module = await import(pathToFileURL(file).href);
    if (!module.meta || typeof module.meta.desc !== "string" || !module.meta.desc.trim()) {
      return { error: { code: "bad-script", message: "脚本要导出 meta，且 meta.desc 必填" } };
    }
    if (typeof module.run !== "function") {
      return { error: { code: "bad-script", message: "脚本要导出 async function run(b, vars)" } };
    }
    return { meta: module.meta, run: module.run };
  } catch (error) {
    return { error: { code: "script-load-failed", message: firstLine(error?.message || error) } };
  }
}

function recipeParamList(meta) {
  const params = meta?.params && typeof meta.params === "object" ? meta.params : {};
  return Object.entries(params).map(([name, spec]) => {
    const item = spec && typeof spec === "object" ? spec : { desc: String(spec ?? "") };
    return {
      name,
      desc: String(item.desc || ""),
      required: item.default === undefined,
      default: item.default === undefined ? undefined : String(item.default),
      enum: Array.isArray(item.enum) ? item.enum.map(String) : undefined,
      pattern: item.pattern ? String(item.pattern) : undefined,
    };
  });
}

// Defaults are filled in but not checked against enum/pattern: only values the caller typed are.
function recipeResolveVars(meta, list) {
  const params = recipeParamList(meta);
  const given = {};
  const problems = [];
  for (const item of Array.isArray(list) ? list : list ? [list] : []) {
    const at = String(item).indexOf("=");
    if (at <= 0) {
      problems.push(`--var ${item} 要写成 名字=值`);
      continue;
    }
    given[String(item).slice(0, at).trim()] = String(item).slice(at + 1);
  }
  for (const name of Object.keys(given)) {
    if (!params.some((param) => param.name === name)) problems.push(`没有声明的参数: ${name}`);
  }
  const vars = {};
  for (const param of params) {
    const value = given[param.name];
    if (value === undefined) {
      if (param.required) problems.push(`缺少参数: --var ${param.name}=…${param.desc ? `（${param.desc}）` : ""}`);
      else vars[param.name] = param.default;
      continue;
    }
    if (param.enum && !param.enum.includes(value)) problems.push(`${param.name}=${value} 不在可选值里: ${param.enum.join(" / ")}`);
    if (param.pattern) {
      try {
        if (!new RegExp(param.pattern).test(value)) problems.push(`${param.name}=${value} 不匹配 ${param.pattern}`);
      } catch {
        problems.push(`参数 ${param.name} 的 pattern 写错了: ${param.pattern}`);
      }
    }
    vars[param.name] = value;
  }
  return { vars, problems };
}

function recipeRunsDir(domain) {
  return join(LOGS, domain, "runs");
}

// Unfinished runs of a task (not done / abandoned), oldest first.
function recipeOpenRuns(domain, task) {
  const dir = recipeRunsDir(domain);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(join(dir, name)))
    .filter((record) => record && record.task === task && record.status !== "done" && record.status !== "abandoned")
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

function createRecipeRun(domain, task, profile, vars) {
  const dir = recipeRunsDir(domain);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let run = `${stamp}-${task}`;
  for (let n = 2; existsSync(join(dir, `${run}.json`)); n += 1) run = `${stamp}-${task}-${n}`;
  return {
    run,
    domain,
    task,
    profile,
    vars,
    status: "running",
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    current: null,
    steps: [],
    approved: [],
    pausedBefore: null,
    pausedAfter: null,
    notes: [],
    result: null,
    error: null,
  };
}

function saveRecipeRun(record) {
  record.updatedAt = new Date().toISOString();
  writeJson(join(recipeRunsDir(record.domain), `${record.run}.json`), record);
}

function recipeShellQuote(value) {
  return /[^\w./=:-]/.test(value) ? `'${value.replace(/'/g, "'\\''")}'` : value;
}

function recipeCliPrefix() {
  const launcher = join(dirname(dirname(SELF)), "bin", "browser");
  return existsSync(launcher) ? recipeShellQuote(launcher) : `node ${recipeShellQuote(SELF)}`;
}

function recipeCli(argv, timeoutMs = 300_000) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SELF, ...argv], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ ok: false, error: { code: "spawn-failed", message: firstLine(error?.message || error) } });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed && typeof parsed === "object") return done(parsed);
      } catch {}
      const message = timedOut ? `命令超过 ${timeoutMs / 1000} 秒没有结束` : (stderr.trim() || stdout.trim() || `exit ${code}`).slice(0, 800);
      done({ ok: false, error: { code: timedOut ? "command-timeout" : "bad-output", message } });
    });
  });
}

const RECIPE_SCRIPT_COMMANDS = [
  "open", "goto", "state", "focus", "snapshot", "query", "click", "drag", "fill", "press", "hover", "select",
  "wait", "screenshot", "switch", "close", "mode", "dialog", "console", "network", "debug", "upload",
];

function recipeAuthCode(manualAuth) {
  return manualAuth?.kind === "verification" ? "needs-verification" : "needs-login";
}

function recipeCommandError(error) {
  const code = error?.code === "manual-auth-required" ? recipeAuthCode(error.diagnosis) : String(error?.code || "command-failed");
  const wrapped = fail(code, String(error?.message || code));
  if (error?.screenshot) wrapped.screenshot = error.screenshot;
  return wrapped;
}

function recipeErrorInfo(error) {
  const info = {
    code: error instanceof ActionError || typeof error?.code === "string" ? String(error.code) : "script-error",
    message: firstLine(error?.message || error),
  };
  if (error?.screenshot) info.screenshot = error.screenshot;
  return info;
}

function recipeJson(value, what) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw fail("bad-value", `${what}的返回值不能 JSON 序列化: ${firstLine(error?.message || error)}`);
  }
}

// Runs one browser command for a script: positional args go after `--`, a
// trailing plain object becomes --kebab-flags; `dialog`/`dialogText` stay here.
async function recipeCommand(ctx, name, args) {
  if (ctx.halted) throw ctx.halt;
  if (!ctx.active) throw fail("outside-step", `b.${name}() 必须写在 b.step(...) 里面`);
  const list = [...args];
  const last = list.at(-1);
  const options = last && typeof last === "object" && Object.getPrototypeOf(last) === Object.prototype ? list.pop() : {};
  for (const item of list) {
    if (typeof item !== "string" && typeof item !== "number") {
      throw fail("bad-argument", `b.${name}() 的位置参数只能是字符串或数字，最后一个参数才可以是选项对象`);
    }
  }
  const { dialog: expected, dialogText, ...rest } = options;
  if ("profile" in rest || "allowAuth" in rest) {
    throw fail("bad-option", "脚本里不能写 profile 或 allowAuth：profile 由 recipe run 决定，代登录授权只能在 recipe run 命令行上加 --allow-auth");
  }
  const argv = [name];
  for (const [key, value] of Object.entries(rest)) {
    if (value === false || value === null || value === undefined) continue;
    const flag = `--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
    if (value === true) argv.push(flag);
    else argv.push(flag, String(value));
  }
  if (ctx.allowAuth && RECIPE_AUTH_ACTIONS.has(name)) argv.push("--allow-auth");
  argv.push("--profile", ctx.profile, "--", ...list.map(String));
  ctx.browserUsed = true;

  const result = await recipeCli(argv);
  if (result.ok === false) throw recipeCommandError(result.error);
  if (result.status === "dialog-pending") {
    const pending = result.pendingDialog || {};
    const message = String(pending.message ?? "");
    if (expected === undefined) {
      throw fail("unexpected-dialog", `出现了没预料的 ${pending.type || ""} 弹窗：「${message}」；弹窗还开着，没有替你处理`);
    }
    const matched = expected instanceof RegExp ? expected.test(message) : message.includes(String(expected));
    if (!matched) {
      await recipeCli(["dialog", "dismiss", "--profile", ctx.profile]);
      throw fail("dialog-mismatch", `弹窗内容和预期「${expected}」对不上，已取消：「${message}」`);
    }
    const accept = ["dialog", "accept", "--profile", ctx.profile];
    if (dialogText !== undefined && dialogText !== null) accept.push("--text", String(dialogText));
    const accepted = await recipeCli(accept);
    if (accepted.ok === false) throw recipeCommandError(accepted.error);
    if (accepted.status === "dialog-pending") {
      const next = accepted.pendingDialog || {};
      throw fail("unexpected-dialog", `确认弹窗后又弹出 ${next.type || ""} 弹窗：「${next.message ?? ""}」；弹窗还开着，没有替你处理`);
    }
    return accepted;
  }
  if (expected !== undefined) throw fail("dialog-missing", `预期会弹出「${expected}」的弹窗，但没有弹窗`);
  if (result.manualAuth?.required === true) {
    throw fail(recipeAuthCode(result.manualAuth), `页面需要用户${result.manualAuth.kind === "verification" ? "完成验证" : "登录"}`);
  }
  return result;
}

// Pause / stop / finish all end in the same internal exception (ctx.halt);
// once ctx.halted is set every b.* call throws it again, so a script's own
// try/catch cannot carry on past the stop.
function haltRecipe(ctx, state) {
  ctx.halted = state;
  const record = ctx.record;
  if (state.kind === "pause") {
    record.status = "paused";
    record.pausedBefore = state.before || null;
    record.pausedAfter = state.after || null;
  } else if (state.kind === "stop") {
    record.status = "stopped";
    record.everStopped = true;
    record.error = { code: state.error.code, message: state.error.message };
  }
  saveRecipeRun(record);
  throw ctx.halt;
}

function recordRecipeStep(record, entry) {
  const index = record.steps.findIndex((item) => item.name === entry.name);
  if (index >= 0) record.steps[index] = entry;
  else record.steps.push(entry);
}

function recipeSummary(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function withRecipeDeadline(ctx, promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(fail("run-timeout", `整次运行超过 ${ctx.maxMinutes} 分钟（--max-minutes）`)),
      Math.max(0, ctx.deadline - Date.now()),
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runRecipeStep(ctx, name, fn, opts) {
  const record = ctx.record;
  if (ctx.halted) throw ctx.halt;
  if (typeof name !== "string" || !name.trim()) throw fail("bad-step", "b.step 需要非空的步骤名");
  if (typeof fn !== "function") throw fail("bad-step", `步骤「${name}」的第二个参数要是函数`);
  if (ctx.active) throw fail("nested-step", `步骤「${ctx.active}」里不能再开步骤「${name}」`);
  if (ctx.seen.has(name)) throw fail("duplicate-step", `步骤名重复: ${name}（循环里把序号写进名字）`);
  ctx.seen.add(name);
  const commit = opts?.commit === true;
  const previous = record.steps.find((item) => item.name === name);
  if (previous && (previous.status === "done" || previous.status === "skipped")) {
    console.log(`· ${name}（已完成，沿用）`);
    return previous.value;
  }
  if (commit) {
    // A commit step done earlier in this run that the replay never reached was
    // probably renamed; running the new name could submit a second time.
    const missing = record.steps
      .filter((item) => item.commit && !item.orphan && (item.status === "done" || item.status === "failed") && !ctx.seen.has(item.name))
      .map((item) => item.name);
    if (missing.length) {
      const error = {
        code: "commit-step-missing",
        message: `记录里的提交步骤${missing.map((item) => `『${item}』`).join("、")}在脚本里找不到了，可能改了名；这一步也许已经做过`,
      };
      recordRecipeStep(record, { name, status: "failed", commit, ms: 0, value: null, hash: ctx.hash, error, missing });
      record.current = name;
      record.currentCommit = commit;
      console.log(`✗ ${name} ${error.code}: ${error.message}`);
      haltRecipe(ctx, { kind: "stop", step: name, commit, error });
    }
  }
  if (commit && !ctx.verified && !record.approved.includes(name)) haltRecipe(ctx, { kind: "pause", before: name });

  ctx.active = name;
  record.current = name;
  record.currentCommit = commit;
  saveRecipeRun(record);
  const started = Date.now();
  let value;
  try {
    const raw = await withRecipeDeadline(ctx, Promise.resolve().then(fn));
    if (ctx.halted) throw ctx.halt;
    value = recipeJson(raw, `步骤「${name}」`);
  } catch (error) {
    ctx.active = null;
    const ms = Date.now() - started;
    if (error === ctx.halt && ctx.halted?.kind === "finish") {
      value = ctx.halted.result;
      recordRecipeStep(record, { name, status: "done", commit, ms, value, hash: ctx.hash });
      record.current = null;
      saveRecipeRun(record);
      console.log(`✓ ${name} (${(ms / 1000).toFixed(1)}s) ${recipeSummary(value)}`.trimEnd());
      throw ctx.halt;
    }
    if (ctx.halted) throw ctx.halt;
    const info = recipeErrorInfo(error);
    recordRecipeStep(record, { name, status: "failed", commit, ms, value: null, hash: ctx.hash, error: { code: info.code, message: info.message } });
    console.log(`✗ ${name} ${info.code}: ${info.message}`);
    haltRecipe(ctx, { kind: "stop", step: name, commit, error: info });
  }
  ctx.active = null;
  const ms = Date.now() - started;
  recordRecipeStep(record, { name, status: "done", commit, ms, value, hash: ctx.hash });
  record.current = null;
  saveRecipeRun(record);
  console.log(`✓ ${name} (${(ms / 1000).toFixed(1)}s) ${recipeSummary(value)}`.trimEnd());
  if (ctx.stepMode) haltRecipe(ctx, { kind: "pause", after: name });
  return value;
}

function createRecipeApi(ctx) {
  const check = () => {
    if (ctx.halted) throw ctx.halt;
  };
  const b = {
    domain: ctx.domain,
    origin: ctx.origin,
    profile: ctx.profile,
    vars: Object.freeze({ ...ctx.vars }),
    step: (name, fn, opts = {}) => runRecipeStep(ctx, name, fn, opts),
    waitLogin: (...args) => recipeCommand(ctx, "wait-login", args),
    waitVerification: (...args) => recipeCommand(ctx, "wait-verification", args),
    async eval(source, arg) {
      const expression = typeof source === "function" ? `(${source.toString()})(${JSON.stringify(arg ?? null)})` : String(source);
      return (await recipeCommand(ctx, "eval", [expression])).result;
    },
    expect(condition, message) {
      check();
      if (!condition) throw fail("expect-failed", String(message || "核对不成立"));
    },
    async until(fn, { every = 30, max = 600 } = {}) {
      check();
      const started = Date.now();
      for (;;) {
        const value = await fn();
        check();
        if (value) return value;
        const left = max * 1000 - (Date.now() - started);
        if (left <= 0) throw fail("until-timeout", `等了 ${max} 秒仍没等到`);
        await b.sleep(Math.min(every, left / 1000));
      }
    },
    log(text) {
      check();
      const line = String(text);
      if (line === ctx.lastLog) return;
      ctx.lastLog = line;
      console.log(`… ${line}`);
      ctx.record.notes.push(line);
      if (ctx.record.notes.length > 200) ctx.record.notes.splice(0, ctx.record.notes.length - 200);
      saveRecipeRun(ctx.record);
    },
    finish(result) {
      check();
      ctx.halted = { kind: "finish", result: recipeJson(result, "b.finish") };
      throw ctx.halt;
    },
    async sleep(seconds) {
      check();
      await sleep(Math.max(0, Number(seconds) || 0) * 1000);
      check();
    },
  };
  for (const name of RECIPE_SCRIPT_COMMANDS) b[name] = (...args) => recipeCommand(ctx, name, args);
  return b;
}

function recipeIndexInfo(domain, task) {
  const path = join(RECIPES, `${domain}.md`);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = text.split(/\r?\n/);
  const section = recipeTasks(text).find((item) => item.title === task);
  return {
    path,
    meta: parseExperienceMeta(text),
    section,
    lines: section ? lines.slice(section.headingIndex, section.endIndex) : [],
    fields: section ? recipeSectionFields(lines.slice(section.headingIndex, section.endIndex)) : {},
  };
}

// Prepares a stopped / paused / interrupted run for --resume. Returns an error or null.
function prepareRecipeResume(record, flags) {
  if (flags.skip && flags.retry) return { code: "bad-request", message: "--skip 和 --retry 只能带一个" };
  if (record.status === "paused") {
    if (record.pausedBefore && !record.approved.includes(record.pausedBefore)) record.approved.push(record.pausedBefore);
    return null;
  }
  // stopped, or still "running": the previous process died inside `current`.
  // An interrupted process counts as a stop, so this run will not be marked 已验证.
  if (record.status === "running") record.everStopped = true;
  const name = record.current;
  if (!name) return null;
  const entry = record.steps.find((item) => item.name === name);
  const commit = entry ? Boolean(entry.commit) : Boolean(record.currentCommit);
  if (commit && !flags.skip && !flags.retry) {
    return {
      code: "commit-ambiguous",
      message: `「${name}」是提交步骤，可能已经生效：先到页面确认，已生效用 --resume --skip（需要时带 --value '<json>'），没生效用 --resume --retry`,
    };
  }
  // The user has now decided about the renamed commit step; stop matching the old names.
  if (entry?.error?.code === "commit-step-missing") {
    for (const item of record.steps) if (entry.missing?.includes(item.name)) item.orphan = true;
  }
  if (flags.skip) {
    let value = null;
    if (flags.value !== undefined) {
      try {
        value = JSON.parse(String(flags.value));
      } catch {
        return { code: "bad-value", message: `--value 需要合法的 JSON: ${flags.value}` };
      }
    }
    recordRecipeStep(record, { name, status: "skipped", commit, ms: 0, value, hash: null });
  } else {
    record.steps = record.steps.filter((item) => item.name !== name);
  }
  record.current = null;
  return null;
}

async function recipeScriptRun(domain, task, file, flags) {
  const base = { action: "recipe-run", domain, task };
  const loaded = await loadRecipeScript(file);
  if (loaded.error) return { ok: false, ...base, file, error: loaded.error };
  const { meta } = loaded;
  const index = recipeIndexInfo(domain, task);
  const hash = recipeScriptHash(file);
  const verified = index.fields["状态"] === `已验证 (${hash})`;

  let record = null;
  let vars;
  if (flags.resume) {
    if (flags.var) return { ok: false, ...base, error: { code: "bad-vars", message: "续跑沿用记录里的参数，不能再带 --var" } };
    record = recipeOpenRuns(domain, task).at(-1) || null;
    if (!record) return { ok: false, ...base, error: { code: "nothing-to-resume", message: "这个任务没有停下或暂停的运行记录可以续跑" } };
    vars = record.vars || {};
  } else {
    const resolved = recipeResolveVars(meta, flags.var);
    if (resolved.problems.length) {
      return { ok: false, ...base, error: { code: "bad-vars", message: resolved.problems.join("；") }, params: recipeParamList(meta) };
    }
    vars = resolved.vars;
  }
  const profile = String(record?.profile || flags.profile || index.meta.profile || "");
  if (flags["dry-run"]) {
    const output = { ok: true, ...base, dryRun: true, desc: meta.desc, scope: meta.scope || "", params: vars, profile: profile || null, state: verified ? "已验证" : "未验证", file };
    if (!profile) output.warning = "没有 profile：实跑时要加 --profile，或在索引 frontmatter 写 profile";
    return output;
  }
  if (!profile) {
    return { ok: false, ...base, error: { code: "no-profile", message: `没有 profile：加 --profile，或在 ${index.path} 的 frontmatter 写 profile` } };
  }
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(profile)) {
    return { ok: false, ...base, error: { code: "bad-profile", message: "profile 只允许字母、数字、点、下划线和连字符" } };
  }

  if (record) {
    const problem = prepareRecipeResume(record, flags);
    if (problem) return { ok: false, ...base, error: problem, run: record.run, status: record.status, step: record.current || undefined };
  } else {
    const open = recipeOpenRuns(domain, task);
    const latest = open.at(-1);
    // Whatever the vars, a run that may have submitted must be resumed or explicitly dropped.
    const submitted =
      latest &&
      (latest.steps.some((item) => item.commit && (item.status === "done" || item.status === "failed")) ||
        (latest.status === "running" && latest.currentCommit));
    if (submitted && !flags.new) {
      const command = `${recipeCliPrefix()} recipe run ${domain} ${task}`;
      const typed = (Array.isArray(flags.var) ? flags.var : []).map((item) => `--var ${recipeShellQuote(String(item))}`);
      if (flags.profile) typed.push(`--profile ${recipeShellQuote(String(flags.profile))}`);
      const step = latest.current || latest.pausedBefore || latest.pausedAfter || null;
      return {
        ok: false,
        ...base,
        error: {
          code: "unfinished-run",
          message: `上一次运行（${latest.run}）提交过但没跑完${step ? `，停在「${step}」` : ""}：接着那一次做用 --resume；确认那一次作废、从头再来用 --new。不管这次参数和上次是否相同都会拦`,
        },
        run: latest.run,
        status: latest.status,
        step,
        vars: latest.vars,
        resume: `${command} --resume`,
        new: [command, ...typed, "--new"].join(" "),
      };
    }
    for (const old of open) {
      old.status = "abandoned";
      saveRecipeRun(old);
    }
    record = createRecipeRun(domain, task, profile, vars);
  }
  record.status = "running";
  record.error = null;
  record.pausedBefore = null;
  record.pausedAfter = null;
  saveRecipeRun(record);

  const maxMinutes = Math.max(0.1, numberFlag(flags["max-minutes"], 60));
  const ctx = {
    domain,
    origin: index.meta.origin || `https://${domain}`,
    profile,
    vars,
    record,
    hash,
    verified,
    stepMode: Boolean(flags.step),
    allowAuth: Boolean(flags["allow-auth"]),
    maxMinutes,
    deadline: Date.now() + maxMinutes * 60_000,
    halt: Object.assign(new Error("脚本已暂停或停止"), { code: "recipe-halted" }),
    halted: null,
    active: null,
    seen: new Set(),
    lastLog: null,
    browserUsed: false,
  };
  const started = Date.now();
  try {
    const value = await loaded.run(createRecipeApi(ctx), { ...vars });
    if (!ctx.halted) ctx.halted = { kind: "finish", result: recipeJson(value, "run()") };
  } catch (error) {
    if (!ctx.halted) {
      const info = recipeErrorInfo(error);
      console.log(`✗ （步骤外） ${info.code}: ${info.message}`);
      record.current = null;
      ctx.halted = { kind: "stop", step: null, commit: false, error: info };
      record.status = "stopped";
      record.everStopped = true;
      record.error = { code: info.code, message: info.message };
      saveRecipeRun(record);
    }
  }
  return finishRecipeRun(ctx, meta, flags, Date.now() - started);
}

function recipeVarsNote(vars) {
  const text = Object.entries(vars || {})
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, " ").slice(0, 40)}`)
    .join(" ");
  return `[脚本] ${text}`.trim().slice(0, 200);
}

function finishRecipeRun(ctx, meta, flags, ms) {
  const { domain, record, hash, profile } = ctx;
  const task = record.task;
  const base = { action: "recipe-run", domain, task };
  const halted = ctx.halted;
  const today = recipeToday();
  const init = { desc: meta.desc, site: experienceSite(domain) };
  const resume = `${recipeCliPrefix()} recipe run ${domain} ${task} --resume`;
  // Only screenshot a browser that is already up; a script bug before any
  // browser command should not launch Chrome just for a blank picture.
  const screenshotNow = () => (existsSync(profilePaths(profile).daemon) ? captureRecipeFailure(domain, task, profile) : "");

  if (halted.kind === "finish") {
    record.status = "done";
    record.result = halted.result;
    record.current = null;
    saveRecipeRun(record);
    // Pauses before a commit step and --step pauses do not count; any stop (even if resumed later) does.
    const verifiedNow = !record.everStopped && record.steps.every((item) => item.status === "done" && item.hash === hash);
    editRecipeIndex(
      domain,
      task,
      (fields) => ({
        次数: (Number(fields["次数"]) || 0) + 1,
        最近: today,
        上次失败: "",
        ...(verifiedNow ? { 状态: `已验证 (${hash})` } : {}),
      }),
      init,
    );
    appendLogLine(domain, task, "ok", recipeVarsNote(record.vars));
    return { ok: true, ...base, result: halted.result, ms, run: record.run, state: verifiedNow || ctx.verified ? "已验证" : "未验证" };
  }

  if (halted.kind === "pause") {
    const screenshot = screenshotNow();
    const output = { ok: false, ...base, status: "paused" };
    if (halted.before) {
      output.before = halted.before;
      output.reason = `脚本还没验证过，「${halted.before}」是提交步骤，执行前先停下：看截图和前面各步打出来的情况，确认没问题再续跑`;
    } else {
      output.after = halted.after;
      output.reason = `--step 模式：「${halted.after}」已完成，看截图和输出确认后再续跑`;
    }
    if (screenshot) output.screenshot = screenshot;
    output.run = record.run;
    output.resume = `${resume}${flags.step ? " --step" : ""}`;
    return output;
  }

  const { step, commit, error } = halted;
  const where = step || "步骤外";
  const screenshot = error.screenshot || screenshotNow();
  editRecipeIndex(domain, task, () => ({ 上次失败: `${today}「${where}」${error.code}` }), init);
  appendLogLine(domain, task, "failed", `[脚本] 停在「${where}」：${error.code}`);
  const authHint = {
    "needs-login": "页面要登录：请用户在可见窗口登录（mode headed，再 wait-login），登录好以后再续跑",
    "needs-verification": "页面要做验证（滑块、验证码等）：请用户在可见窗口完成验证（mode headed，再 wait-verification），完成后再续跑",
  }[error.code];
  let hint;
  if (error.code === "commit-step-missing") {
    hint = `${error.message}。先到页面确认：如果只是改了名，把步骤名改回去，再 ${resume} --retry，会沿用原来的结果；确认这件事已经做过用 ${resume} --skip；确认还没做用 ${resume} --retry；或者用 --new 放弃这次从头来`;
  } else if (commit) {
    hint = `「${step}」是提交步骤，这一步可能已经生效，先到页面确认：确认已生效用 ${resume} --skip（后面要用这一步的返回值时加 --value '<json>'），确认没生效用 ${resume} --retry；单独 --resume 会被拒绝`;
    if (authHint) hint = `${authHint}。${hint}`;
  } else if (authHint) {
    hint = `${authHint}：执行 resume 里的命令`;
  } else if (error.code === "unexpected-dialog") {
    hint = "弹窗还开着：读内容后自己决定 dialog accept 还是 dialog dismiss，处理完再续跑；以后预期会弹的，在脚本里给这条命令加 dialog 选项";
  } else if (!step) {
    hint = "脚本在步骤外出错，多半是脚本本身的问题：改好脚本后执行 resume 里的命令，已完成的步骤会沿用";
  } else {
    hint = `查清「${step}」失败的原因：页面状态的问题处理掉后用 resume 里的命令重做这一步；脚本的问题改好脚本再续跑；这一步已经手动做完就加 --skip`;
  }
  const output = {
    ok: false,
    ...base,
    status: "stopped",
    step,
    error: { code: error.code, message: error.message },
    committed: record.steps.filter((item) => item.commit && item.status === "done").map((item) => item.name),
  };
  if (screenshot) output.screenshot = screenshot;
  output.run = record.run;
  output.resume = resume;
  output.hint = hint;
  return output;
}

// Field lines shown as structured values, so `notes` leaves them out.
const RECIPE_MAINTAINED_FIELDS = new Set(["说明", "次数", "最近", "状态", "上次失败", "不写脚本"]);

// Tasks of one domain: the union of index sections and 脚本/<domain>/*.mjs.
// A script that fails to load only marks its own task as 加载失败.
async function recipeTaskEntries(domain) {
  const path = join(RECIPES, `${domain}.md`);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = text.split(/\r?\n/);
  const sections = recipeTasks(text);
  const names = [...new Set([...sections.map((task) => task.title), ...recipeScriptNames(domain)])];
  const entries = [];
  for (const name of names) {
    const section = sections.find((task) => task.title === name);
    const sectionLines = section ? lines.slice(section.headingIndex, section.endIndex) : [];
    const fields = recipeSectionFields(sectionLines);
    const file = join(RECIPES, domain, `${name}.mjs`);
    const scripted = existsSync(file);
    const entry = {
      task: name,
      desc: fields["说明"] || "",
      scope: "",
      params: [],
      usage: null,
      count: section ? section.count : 0,
      last: fields["最近"] || null,
      state: "计数中",
      lastFailure: fields["上次失败"] || null,
      legacySteps: Boolean(section?.steps.length),
      file: scripted ? file : null,
    };
    if (scripted) {
      const loaded = await loadRecipeScript(file);
      if (loaded.error) {
        entry.state = "加载失败";
        entry.error = loaded.error;
      } else {
        entry.desc = loaded.meta.desc;
        entry.scope = loaded.meta.scope || "";
        entry.params = recipeParamList(loaded.meta).map((param) => ({
          name: param.name,
          desc: param.desc,
          required: param.required,
          ...(param.default !== undefined ? { default: param.default } : {}),
          ...(param.enum ? { enum: param.enum } : {}),
        }));
        entry.state = fields["状态"] === `已验证 (${recipeScriptHash(file)})` ? "已验证" : "未验证";
      }
    } else if (entry.legacySteps) {
      entry.state = "未验证";
      entry.params = section.params.map((param) => ({ name: param.name, desc: param.description, required: true }));
    }
    if (!scripted && fields["不写脚本"]) {
      entry.state = "不写脚本";
      entry.noScript = fields["不写脚本"];
    }
    if ((scripted && !entry.error) || (!scripted && entry.legacySteps)) {
      const vars = entry.params.filter((param) => param.required).map((param) => `--var ${param.name}=…`);
      entry.usage = [`${recipeCliPrefix()} recipe run ${domain} ${name}`, ...vars].join(" ");
    }
    const notes = sectionLines.slice(1).filter((line) => !RECIPE_MAINTAINED_FIELDS.has(line.match(RECIPE_FIELD_LINE)?.[1]));
    entries.push({ entry, notes: notes.join("\n").trim(), steps: section?.steps || [] });
  }
  return { path, text, meta: parseExperienceMeta(text), sections, entries };
}

async function recipeListAction(filter) {
  ensureRecipesDir();
  const needle = String(filter || "").toLowerCase();
  const domains = new Set();
  for (const item of readdirSync(RECIPES, { withFileTypes: true })) {
    if (item.isFile() && item.name.endsWith(".md")) domains.add(item.name.slice(0, -3));
    else if (item.isDirectory()) domains.add(item.name);
  }
  const recipes = [];
  for (const domain of [...domains].sort()) {
    if (!/^[a-z0-9.-]+$/.test(domain)) continue;
    if (needle && !domain.includes(needle)) continue;
    const info = await recipeTaskEntries(domain);
    recipes.push({
      domain,
      path: info.path,
      site: info.meta.site || "",
      app: info.meta.app || "",
      environment: info.meta.environment || "",
      updated: info.meta.updated || "",
      tasks: info.entries.map(({ entry }) => ({
        task: entry.task,
        state: entry.state,
        count: entry.count,
        params: entry.params.map((param) => param.name),
      })),
    });
  }
  return { ok: true, action: "recipe-list", directory: RECIPES, recipes };
}

async function recipeShowAction(domainInput, wanted) {
  const domain = normalizeDomain(domainInput);
  ensureRecipesDir();
  const info = await recipeTaskEntries(domain);
  const { path } = info;
  if (!info.entries.length) {
    return { ok: true, action: "recipe-show", found: false, domain, path, tasks: [] };
  }
  if (!wanted) {
    return { ok: true, action: "recipe-show", found: true, domain, path, meta: info.meta, tasks: info.entries.map(({ entry }) => entry) };
  }
  // Exact name first; old-style section titles still match loosely.
  let found = info.entries.find(({ entry }) => entry.task === wanted);
  if (!found) {
    const legacy = pickRecipeTask(info.sections, wanted);
    if (legacy) found = info.entries.find(({ entry }) => entry.task === legacy.title);
  }
  if (!found) {
    return {
      ok: false,
      action: "recipe-show",
      domain,
      path,
      error: { code: "recipe-task-not-found", message: `没有找到任务: ${wanted}` },
      available: info.entries.map(({ entry }) => entry.task),
    };
  }
  const task = { ...found.entry, notes: found.notes };
  if (found.entry.legacySteps) task.steps = found.steps;
  return { ok: true, action: "recipe-show", found: true, domain, path, meta: info.meta, task };
}

function recipeLogAction(domainInput, wanted) {
  const domain = normalizeDomain(domainInput);
  const path = recipePath(domain);
  if (!existsSync(path)) {
    return {
      ok: false,
      action: "recipe-log",
      domain,
      path,
      error: { code: "recipe-not-found", message: `还没有脚本文件: ${path}；先按 references/recipe-template.md 创建` },
    };
  }
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  const tasks = recipeTasks(text);
  const task = pickRecipeTask(tasks, wanted);
  if (!task) {
    return {
      ok: false,
      action: "recipe-log",
      domain,
      path,
      error: { code: "recipe-task-not-found", message: `没有找到任务: ${wanted || "(未指定)"}` },
      available: tasks.map((item) => item.title),
    };
  }
  const section = lines.slice(task.headingIndex, task.endIndex);
  const count = task.count + 1;
  const today = recipeToday();
  setRecipeSectionField(section, "次数", count);
  setRecipeSectionField(section, "最近", today);
  lines.splice(task.headingIndex, task.endIndex - task.headingIndex, ...section);
  writeRecipeIndex(path, lines);

  const recorded = task.steps.length > 0;
  const result = { ok: true, action: "recipe-log", domain, path, task: task.title, count, recorded, updated: today };
  if (recorded) result.hint = "已有脚本：先 recipe run，成功后再 log 记一次";
  else if (count >= 3) result.hint = "已到第 3 次：把这次操作写进该任务的 ```steps 代码块，动态值用 {{占位符}} 并在参数行声明";
  else result.hint = `再做 ${3 - count} 次即可录制脚本`;
  return result;
}

async function recipeRunAction(domainInput, wanted, flags) {
  const domain = normalizeDomain(domainInput);
  const path = recipePath(domain);
  const scriptFile = RECIPE_TASK_NAME.test(String(wanted || "")) ? join(RECIPES, domain, `${wanted}.mjs`) : "";
  if (scriptFile && existsSync(scriptFile)) return recipeScriptRun(domain, String(wanted), scriptFile, flags);
  if (!existsSync(path)) {
    return { ok: false, action: "recipe-run", domain, path, error: { code: "recipe-not-found", message: `还没有脚本文件: ${path}` } };
  }
  const content = readFileSync(path, "utf8");
  const tasks = recipeTasks(content);
  const meta = parseExperienceMeta(content);
  const task = pickRecipeTask(tasks, wanted);
  if (!task) {
    return {
      ok: false,
      action: "recipe-run",
      domain,
      path,
      error: { code: "recipe-task-not-found", message: `没有找到任务: ${wanted || "(未指定)"}` },
      available: tasks.map((item) => item.title),
    };
  }
  if (!task.steps.length) {
    return {
      ok: false,
      action: "recipe-run",
      domain,
      path,
      task: task.title,
      error: { code: "recipe-empty", message: "该任务还没有 steps 代码块" },
      hint: "先手动操作，成功后把稳定步骤写进该任务的 ```steps 代码块",
    };
  }

  const vars = parseRecipeVars(flags.var);
  const missing = new Set();
  const problems = [];
  const steps = [];

  // A recipe should not have to repeat --profile on every line. Prefer an
  // explicit --profile on the run command, then frontmatter `profile`, then
  // the profile named on the first open/goto step.
  let recipeProfile = String(meta.profile || "");
  for (const raw of task.steps) {
    try {
      const tokens = tokenizeRecipeStep(raw.trim());
      if (tokens[0] === "open" || tokens[0] === "goto") {
        const at = tokens.indexOf("--profile");
        if (at >= 0 && tokens[at + 1]) {
          recipeProfile = tokens[at + 1];
          break;
        }
      }
    } catch {
      // A broken line is reported by the main parse loop below.
    }
  }
  const effectiveProfile = String(flags.profile || recipeProfile || "");

  for (const raw of task.steps) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let tokens;
    try {
      tokens = tokenizeRecipeStep(line);
    } catch (error) {
      problems.push(`无法解析「${line}」: ${error.message}`);
      continue;
    }
    if (!tokens.length) continue;
    const action = tokens[0];
    if (!RECIPE_ACTIONS.has(action)) {
      problems.push(`不支持的命令: ${action}（${line}）`);
      continue;
    }
    if (tokens.includes("--allow-auth") && !flags["allow-auth"]) {
      problems.push(`脚本不得内置 --allow-auth（${line}）；用户本次明确授权代登录时，在 run 上加 --allow-auth`);
      continue;
    }
    const used = new Set();
    const argv = tokens.map((token) => substituteRecipeToken(token, vars, missing, used));
    if (flags["allow-auth"] && RECIPE_AUTH_ACTIONS.has(action) && !argv.includes("--allow-auth")) {
      argv.push("--allow-auth");
    }
    if (effectiveProfile && !argv.includes("--profile")) argv.push("--profile", effectiveProfile);
    steps.push({ action, source: line, argv, params: [...used] });
  }
  if (missing.size) problems.push(`缺少参数: ${[...missing].map((name) => `--var ${name}=...`).join(" ")}`);
  if (problems.length) {
    return {
      ok: false,
      action: "recipe-run",
      domain,
      path,
      task: task.title,
      error: { code: "recipe-invalid", message: problems.join("；") },
      declaredParams: task.params,
    };
  }
  if (flags["dry-run"]) {
    return {
      ok: true,
      action: "recipe-run",
      dryRun: true,
      domain,
      path,
      task: task.title,
      params: Object.keys(vars),
      steps: steps.map((step, index) => ({ index: index + 1, action: step.action, source: step.source, params: step.params })),
    };
  }

  const results = [];
  let failed = null;
  for (const [index, step] of steps.entries()) {
    const started = Date.now();
    const child = spawnSync(process.execPath, [SELF, ...step.argv], {
      encoding: "utf8",
      timeout: 300_000,
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    let parsed;
    try {
      parsed = JSON.parse(String(child.stdout || "").trim());
    } catch {
      parsed = undefined;
    }
    const ok = child.status === 0 && parsed?.ok !== false;
    const entry = { index: index + 1, action: step.action, command: step.source, ok, ms: Date.now() - started };
    if (parsed !== undefined) entry.result = compactRecipeResult(parsed);
    if (!ok) {
      entry.error =
        parsed?.error || {
          code: "step-failed",
          message: (String(child.stderr || "").trim() || `exit ${child.status}`).slice(0, 800),
        };
      results.push(entry);
      failed = entry;
      break;
    }
    results.push(entry);
  }

  const output = {
    ok: !failed,
    action: "recipe-run",
    domain,
    path,
    task: task.title,
    profile: effectiveProfile || undefined,
    params: Object.keys(vars),
    steps: results,
  };
  if (failed) {
    output.failedStep = failed.index;
    const screenshot = captureRecipeFailure(domain, task.title, effectiveProfile);
    if (screenshot) output.screenshot = screenshot;
    output.hint = "脚本已中断并保留现场；先接管手动完成，成功后修正该任务的 steps，再重跑验证";
  }
  return output;
}

// ── verification logs (logs/<domain>/log.md) ────────────────────
//
// Verification notes used to pile up in each experience file. They now live
// in one append-only log per domain. New lines have a fixed shape so the
// agent and `log show` can read them without guessing:
//   - YYYY-MM-DD HH:mm | task | ok|failed|partial | note

const LOG_RESULTS = new Map([
  ["ok", "ok"],
  ["success", "ok"],
  ["成功", "ok"],
  ["failed", "failed"],
  ["fail", "failed"],
  ["failure", "failed"],
  ["失败", "failed"],
  ["partial", "partial"],
  ["部分", "partial"],
  ["部分成功", "partial"],
]);
const LOG_ENTRY = /^- (\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))? \| ([^|]*?) \| (ok|failed|partial)(?: \| (.*))?$/;

function ensureLogsDir() {
  ensureHome();
  mkdirSync(LOGS, { recursive: true, mode: 0o700 });
}

function logPath(value) {
  return join(LOGS, normalizeDomain(value), "log.md");
}

function logHeader(domain) {
  return [
    `# ${domain} 验证日志`,
    "",
    "> 固定格式（一行一次）：`- YYYY-MM-DD HH:mm | 任务 | 结果(ok|failed|partial) | 备注`",
    '> 只追加，不改历史行；命令：`browser log add <domain> "<任务>" --result ok (--task <任务名> | --one-off) [--note "..."]`',
    "> 历史记录从 `experiences/<domain>.md` 的「验证记录」迁入，原样保留。",
    "",
    "## 记录",
    "",
    "",
  ].join("\n");
}

function logNow() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function parseLogEntries(text) {
  const entries = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(LOG_ENTRY);
    if (!match) continue;
    entries.push({
      at: match[2] ? `${match[1]} ${match[2]}` : match[1],
      task: match[3].trim(),
      result: match[4],
      note: match[5] ? match[5].trim() : "",
    });
  }
  return entries;
}

function logAddAction(domainInput, taskText, flags) {
  const domain = normalizeDomain(domainInput);
  const task = String(taskText || "").replace(/\s+/g, " ").trim();
  if (!task) {
    return {
      ok: false,
      action: "log-add",
      domain,
      error: { code: "bad-request", message: 'log add 需要任务描述: log add <domain> "<任务>" --result ok' },
    };
  }
  const result = LOG_RESULTS.get(String(flags.result || "").toLowerCase());
  if (!result) {
    return { ok: false, action: "log-add", domain, error: { code: "bad-result", message: "--result 需要 ok、failed 或 partial" } };
  }
  const recipeTask = typeof flags.task === "string" ? flags.task.trim() : "";
  if (Boolean(recipeTask) === Boolean(flags["one-off"])) {
    return {
      ok: false,
      action: "log-add",
      domain,
      error: {
        code: "need-task",
        message: recipeTask
          ? "--task 和 --one-off 只能带一个"
          : "log add 需要 --task <任务名> 或 --one-off（二选一）：会重复做的操作给任务名（小写字母、数字、下划线，如 deploy_tag），一次性的操作用 --one-off",
      },
    };
  }
  if (recipeTask && !RECIPE_TASK_NAME.test(recipeTask)) {
    return { ok: false, action: "log-add", domain, error: { code: "bad-task", message: `任务名只能用小写字母、数字、下划线，且以字母开头: ${recipeTask}` } };
  }
  let note = String(flags.note || "").replace(/\s+/g, " ").trim();
  if (recipeTask) note = `[${recipeTask}] ${note}`.trim();
  const { path, at } = appendLogLine(domain, task, result, note);
  const output = { ok: true, action: "log-add", domain, path, entry: { at, task, result, note } };
  if (!recipeTask || result !== "ok") return output;

  const otherTasks = recipeTaskNames(domain).filter((name) => name !== recipeTask);
  const scripted = existsSync(join(RECIPES, domain, `${recipeTask}.mjs`));
  const today = recipeToday();
  const index = editRecipeIndex(domain, recipeTask, (fields) => ({ 次数: (Number(fields["次数"]) || 0) + 1, 最近: today }), {
    desc: task,
    site: experienceSite(domain),
  });
  const count = Number(index.fields["次数"]);
  const isNew = index.created && !scripted;
  const noScript = index.fields["不写脚本"];
  let hint;
  if (scripted) {
    hint = `已有脚本 脚本/${domain}/${recipeTask}.mjs：下次先 recipe run ${domain} ${recipeTask}；这次要是脚本覆盖不了的用法，就在原脚本上加参数，不要另起任务`;
  } else if (noScript) {
    hint = `这个任务标了不写脚本：${noScript}`;
  } else if (count >= 3) {
    hint = `已做 ${count} 次：现在把这次的步骤写成 脚本/${domain}/${recipeTask}.mjs（模板在 references/recipe-template.mjs），写完先 recipe run ${domain} ${recipeTask} --dry-run；只读的任务当场实跑一次核对`;
  } else {
    hint = `已记 ${count} 次，再做 ${3 - count} 次就该写成脚本`;
  }
  if (isNew && otherTasks.length) hint += `。确认不是这些已有任务的另一种说法：${otherTasks.join("、")}`;
  output.recipe = { task: recipeTask, count, scripted, isNew, otherTasks };
  output.recipePath = index.path;
  output.hint = hint;
  return output;
}

function appendLogLine(domain, task, result, note) {
  ensureLogsDir();
  const dir = join(LOGS, domain);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "log.md");
  if (!existsSync(path)) writeFileSync(path, logHeader(domain), { mode: 0o600 });
  const at = logNow();
  appendFileSync(path, `- ${at} | ${task} | ${result}${note ? ` | ${note}` : ""}\n`);
  return { path, at };
}

function logShowAction(domainInput, flags) {
  const domain = normalizeDomain(domainInput);
  const path = join(LOGS, domain, "log.md");
  if (!existsSync(path)) return { ok: true, action: "log-show", domain, path, found: false, count: 0, entries: [] };
  const text = readFileSync(path, "utf8");
  const entries = parseLogEntries(text);
  const limit = Math.max(1, numberFlag(flags.limit, 20));
  return {
    ok: true,
    action: "log-show",
    domain,
    path,
    found: true,
    count: entries.length,
    entries: entries.slice(-limit),
    history: /^## 历史记录/m.test(text),
    bytes: text.length,
  };
}

function logListAction() {
  ensureLogsDir();
  const logs = [];
  for (const entry of readdirSync(LOGS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(LOGS, entry.name, "log.md");
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const entries = parseLogEntries(text);
    logs.push({
      domain: entry.name,
      path,
      count: entries.length,
      history: /^## 历史记录/m.test(text),
      last: entries.at(-1) || null,
    });
  }
  logs.sort((a, b) => String(b.last?.at || "").localeCompare(String(a.last?.at || "")));
  return { ok: true, action: "log-list", directory: LOGS, logs };
}

// ── daemon ───────────────────────────────────────────────────────

let currentProfile = DEFAULT_PROFILE;
let currentHeadless = true;
let daemonServer = null;
let shuttingDown = false;
let switchingMode = false;
let contextSerial = 0;

function logLine(message) {
  try {
    const paths = profilePaths(currentProfile);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    appendFileSync(paths.log, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
  } catch {}
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const paths = profilePaths(currentProfile);
  removeFile(paths.daemon);
  try {
    await Promise.race([context?.close(), sleep(5000)]);
  } catch {}
  try {
    daemonServer?.close();
  } catch {}
  logLine("daemon stopped");
  process.exit(code);
}

async function runAction(path, body) {
  switch (path) {
    case "/state": return stateAction();
    case "/open": return openAction(body);
    case "/goto": return gotoAction(body);
    case "/snapshot": return snapshotAction(body);
    case "/click": return clickAction(body);
    case "/eval": return evalAction(body);
    case "/drag": return dragAction(body);
    case "/fill": return fillAction(body);
    case "/upload": return uploadAction(body);
    case "/press": return pressAction(body);
    case "/hover": return hoverAction(body);
    case "/select": return selectAction(body);
    case "/wait": return waitAction(body);
    case "/annotate": return annotateAction(body);
    case "/screenshot": return screenshotAction(body);
    case "/switch": return switchAction(body);
    case "/close": return closeAction();
    case "/focus": return focusAction();
    case "/mode": return switchModeAction(body);
    case "/wait-login": return waitLoginAction(body);
    case "/console": return consoleAction(body);
    case "/network": return networkAction(body);
    case "/debug": return debugAction(body);
    case "/query": return queryAction(body);
    case "/wait-verification": return waitVerificationAction(body);
    default:
      throw fail("unknown-command", `unknown command: ${path}`);
  }
}

async function runDaemon(flags) {
  currentProfile = String(flags.profile || DEFAULT_PROFILE);
  currentHeadless = !(flags.headed === true || flags.headed === "true" || process.env.BROWSER_OPERATOR_HEADED === "1");
  const idleMinutes = Math.max(1, Number(flags["idle-minutes"] || 30));
  const paths = ensureProfileDirs(currentProfile);
  removeFile(paths.error);
  removeFile(paths.daemon);
  let lastActivity = Date.now();

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  process.on("uncaughtException", (error) => {
    logLine(`uncaught: ${error?.stack || error}`);
    writeJson(paths.error, { error: firstLine(error?.message || error), at: Date.now() });
    void shutdown(1);
  });

  try {
    logLine(`launching profile=${currentProfile} headless=${currentHeadless} chrome=${findChrome()}`);
    const launched = await launchBrowser(currentProfile, currentHeadless);
    context = launched.context;
    activePage = launched.page;
    bindContext(context);

    const token = randomBytes(24).toString("hex");
    daemonServer = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json; charset=utf-8");
      if (request.method === "GET" && request.url === "/health") {
        response.end(JSON.stringify({
          ok: true,
          profile: currentProfile,
          headless: currentHeadless,
          pendingDialog: pendingDialog() ? dialogInfo(pendingDialog()) : null,
          pid: process.pid,
          url: maskUrl(getPage().url()),
          title: await getPage().title().catch(() => ""),
        }));
        return;
      }
      if (request.headers["x-browser-token"] !== token) {
        response.statusCode = 401;
        response.end(JSON.stringify({ ok: false, error: { code: "unauthorized", message: "invalid token" } }));
        return;
      }
      lastActivity = Date.now();
      let body = {};
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw) body = JSON.parse(raw);
      } catch (error) {
        response.statusCode = 400;
        response.end(JSON.stringify({ ok: false, error: { code: "bad-json", message: error.message } }));
        return;
      }

      const path = request.url || "/";
      if (path === "/stop") {
        response.end(JSON.stringify({ ok: true, action: "stop" }));
        setTimeout(() => void shutdown(0), 100);
        return;
      }
      try {
        let result;
        const waiting = pendingDialog();
        if (path === "/dialog") {
          result = await dialogAction(body);
        } else if (waiting && path !== "/console" && path !== "/network") {
          throw fail(
            "dialog-pending",
            `页面上有 ${waiting.record.type} 弹窗在等处理：「${waiting.record.message}」。先 dialog accept（prompt 用 --text）或 dialog dismiss，再做别的操作`,
            dialogInfo(waiting),
          );
        } else {
          result = await untilDialog(path.slice(1), runAction(path, body));
        }
        response.end(JSON.stringify(result));
      } catch (error) {
        let screenshot = null;
        // With a dialog open the screenshot would hang the response.
        if (!pendingDialog()) {
          try {
            const shot = await screenshotAction({
              path: join(SHOTS, `error-${currentProfile}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`),
            });
            screenshot = shot.path;
          } catch {}
        }
        const recent = {
          recentConsole: diagnostics.console.slice(-15),
          recentNetwork: diagnostics.network.slice(-20),
          screenshot,
        };
        const payload = error instanceof ActionError
          ? { ok: false, error: { code: error.code, message: error.message, diagnosis: error.diagnosis, ...recent } }
          : { ok: false, error: { code: "internal", message: firstLine(error?.message || error), ...recent } };
        response.end(JSON.stringify(payload));
      }
    });

    await new Promise((resolveListen, rejectListen) => {
      daemonServer.once("error", rejectListen);
      daemonServer.listen(0, "127.0.0.1", resolveListen);
    });
    const port = daemonServer.address().port;
    writeJson(paths.daemon, {
      pid: process.pid,
      port,
      token,
      profile: currentProfile,
      headless: currentHeadless,
      startedAt: Date.now(),
    });
    logLine(`daemon ready port=${port}`);

    setInterval(() => {
      if (Date.now() - lastActivity > idleMinutes * 60_000) {
        logLine(`idle > ${idleMinutes}m, stopping`);
        void shutdown(0);
      }
    }, 30_000).unref();
  } catch (error) {
    logLine(`startup failed: ${error?.stack || error}`);
    writeJson(paths.error, { error: firstLine(error?.message || error), at: Date.now() });
    await shutdown(1);
  }
}

// ── CLI / daemon client ─────────────────────────────────────────

async function healthCheck(info) {
  if (!info?.port || !info?.token) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { "x-browser-token": info.token },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.ok ? data : null;
  } catch {
    return null;
  }
}

async function requestDaemon(info, path, body = {}) {
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-browser-token": info.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: { code: "bad-response", message: text.slice(0, 500) } };
  }
}

async function ensureDaemon(profile, flags) {
  const paths = ensureProfileDirs(profile);
  const existing = readJson(paths.daemon);
  if (existing) {
    if (await healthCheck(existing)) return existing;
    removeFile(paths.daemon);
  }

  removeFile(paths.error);
  const logFd = openSync(paths.log, "a", 0o600);
  const args = [
    SELF,
    "__daemon",
    "--profile",
    profile,
    "--idle-minutes",
    String(flags["idle-minutes"] || 30),
  ];
  if (flags.headed) args.push("--headed");
  else args.push("--headless");
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", logFd, logFd] });
  child.unref();
  closeSync(logFd);

  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    if (existsSync(paths.error)) {
      const error = readJson(paths.error);
      throw new Error(error?.error || "浏览器启动失败");
    }
    const info = readJson(paths.daemon);
    if (info && (await healthCheck(info))) return info;
    await sleep(300);
  }
  throw new Error(`浏览器启动超时，查看日志: ${paths.log}`);
}

function print(result) {
  console.log(JSON.stringify(result, null, 2));
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const booleanFlags = new Set([
    "headless",
    "headed",
    "no-auto-headed",
    "snapshot",
    "full-page",
    "wait-nav",
    "force",
    "js",
    "type",
    "label",
    "append",
    "allow-js",
    "allow-auth",
    "reset",
    "clear",
    "errors",
    "html",
    "all-attrs",
    "dry-run",
    "no-focus",
    "step",
    "resume",
    "skip",
    "retry",
    "new",
    "one-off",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals >= 0) {
      const key = arg.slice(2, equals);
      const value = arg.slice(equals + 1);
      if (key === "var") (flags.var ||= []).push(value);
      else flags[key] = value;
      continue;
    }
    const key = arg.slice(2);
    if (key === "var") {
      (flags.var ||= []).push(argv[index + 1]);
      index++;
      continue;
    }
    if (booleanFlags.has(key)) {
      flags[key] = true;
      continue;
    }
    flags[key] = argv[index + 1];
    index++;
  }
  return { positional, flags };
}

function numberFlag(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  if (positional[0] === "__daemon") {
    await runDaemon(flags);
    return;
  }

  const command = positional.shift();
  if (!command) {
    console.error("用法: browser <open|state|snapshot|query|click|eval|drag|fill|upload|press|hover|select|wait|screenshot|annotate|switch|wait-login|console|network|debug|wait-verification|mode|focus|close|experience|recipe|log|restore-session|fingerprint|stop|status|profiles> ...");
    console.error("  upload <selector> <file> [file2 ...] [--frame CSS] [--timeout ms]");
    console.error("  recipe <list|show|log|run> <domain> [task]；recipe run 另有 --var k=v --dry-run --step --resume [--skip [--value json] | --retry] --new --max-minutes N");
    console.error('  log add <domain> "<描述>" --result ok|failed|partial (--task <任务名> | --one-off) [--note ...]');
    process.exit(2);
  }

  if (command === "experience") {
    const sub = positional.shift();
    const value = positional[0] || flags.domain || flags.site || "";
    let result;
    if (sub === "list") result = experienceListAction();
    else if (sub === "path") result = experiencePathAction(value);
    else if (sub === "show") result = experienceShowAction(value);
    else if (sub === "validate") result = experienceValidateAction(value);
    else if (sub === "related") result = experienceRelatedAction(value);
    else if (sub === "current") {
      const profile = String(flags.profile || DEFAULT_PROFILE);
      const info = await ensureDaemon(profile, flags);
      const state = await requestDaemon(info, "/state");
      if (!state.url) throw new Error("当前没有页面 URL，无法解析 experience domain");
      const domain = new URL(state.url).hostname;
      if (!domain) throw new Error("当前页面没有 hostname（例如 file://），请直接 experience show <domain>");
      result = { ...experienceShowAction(domain), resolvedFrom: maskUrl(state.url) };
    }
    else result = { ok: false, action: "experience", error: { code: "unknown-command", message: "用法: experience <list|path|show|related|validate|current> [domain]" } };
    print(result);
    if (result.ok === false) process.exit(1);
    return;
  }

  if (command === "recipe") {
    const sub = positional.shift();
    const value = positional[0] || flags.domain || "";
    const wanted = positional[1] || flags.task || "";
    let result;
    if (sub === "list") result = await recipeListAction(value);
    else if (sub === "show") result = await recipeShowAction(value, wanted);
    else if (sub === "log") result = recipeLogAction(value, wanted);
    else if (sub === "run") result = await recipeRunAction(value, wanted, flags);
    else
      result = {
        ok: false,
        action: "recipe",
        error: {
          code: "unknown-command",
          message:
            "用法: recipe <list|show|log|run> <domain> [task]；recipe run <domain> <task> [--var k=v]... [--profile p] [--dry-run] [--step] [--allow-auth] [--max-minutes N] [--new]，续跑: recipe run <domain> <task> --resume [--skip [--value json] | --retry] [--step]",
        },
      };
    print(result);
    if (result.ok === false) process.exit(1);
    return;
  }

  if (command === "log") {
    const sub = positional.shift();
    const value = positional[0] || flags.domain || "";
    let result;
    if (sub === "list") result = logListAction();
    else if (sub === "show") result = logShowAction(value, flags);
    else if (sub === "add") result = logAddAction(value, positional.slice(1).join(" "), flags);
    else
      result = {
        ok: false,
        action: "log",
        error: { code: "unknown-command", message: '用法: log <add|show|list> <domain> [任务]（add 需要 --result ok|failed|partial，以及 --task <任务名> 或 --one-off 二选一）' },
      };
    print(result);
    if (result.ok === false) process.exit(1);
    return;
  }

  if (command === "profiles") {
    ensureHome();
    const profiles = [];
    for (const entry of readdirSync(PROFILES, { withFileTypes: true }).filter((item) => item.isDirectory())) {
      const meta = readJson(join(PROFILES, entry.name, "meta.json")) || {};
      profiles.push({
        profile: entry.name,
        lastUrl: meta.lastUrl ? maskUrl(meta.lastUrl) : "",
        lastTitle: meta.lastTitle || "",
        loginLikely: Boolean(meta.loginLikely),
        updatedAt: meta.updatedAt || null,
      });
    }
    print({ ok: true, profiles });
    return;
  }

  const profile = String(flags.profile || DEFAULT_PROFILE);
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(profile)) {
    print({ ok: false, error: { code: "bad-profile", message: "profile 只允许字母、数字、点、下划线和连字符" } });
    process.exit(2);
  }

  if (command === "status") {
    const paths = profilePaths(profile);
    const info = readJson(paths.daemon);
    const health = info ? await healthCheck(info) : null;
    print({ ok: true, profile, running: Boolean(health), daemon: info ? { pid: info.pid, port: info.port, headless: info.headless, startedAt: info.startedAt } : null, health });
    return;
  }

  if (command === "stop") {
    const paths = profilePaths(profile);
    const info = readJson(paths.daemon);
    if (!info || !(await healthCheck(info))) {
      removeFile(paths.daemon);
      print({ ok: true, profile, alreadyStopped: true });
      return;
    }
    const result = await requestDaemon(info, "/stop").catch((error) => ({ ok: false, error: { code: "stop-failed", message: error.message } }));
    print(result);
    return;
  }

  if (command === "restore-session") {
    const paths = profilePaths(profile);
    const current = readSettings(profile);
    const arg = String(positional[0] || "").toLowerCase();
    if (!arg) {
      print({
        ok: true,
        profile,
        restoreSession: Boolean(current.restoreSession),
        hint: "restore-session on|off；切换后 daemon 会被停止，下次 open 生效",
      });
      return;
    }
    if (arg !== "on" && arg !== "off") {
      print({ ok: false, error: { code: "bad-arg", message: "restore-session 需要 on 或 off" } });
      process.exit(2);
    }
    const restoreSession = arg === "on";
    writeSettings(profile, { restoreSession });
    const info = readJson(paths.daemon);
    const running = Boolean(info && (await healthCheck(info)));
    if (running) {
      await requestDaemon(info, "/stop").catch(() => {});
    }
    print({
      ok: true,
      profile,
      restoreSession,
      daemonStopped: running,
      note: "下次 open 会用新设置启动；已关闭的浏览器已把 cookie 落盘，能否恢复还取决于服务端 session 是否仍有效",
    });
    return;
  }

  if (command === "fingerprint") {
    const paths = profilePaths(profile);
    if (flags.reset) {
      const settings = readSettings(profile);
      delete settings.fingerprint;
      ensureProfileDirs(profile);
      writeFileSync(paths.settings, JSON.stringify(settings, null, 2), { mode: 0o600 });
      const info = readJson(paths.daemon);
      if (info && (await healthCheck(info))) await requestDaemon(info, "/stop").catch(() => {});
    }
    const fingerprint = ensureFingerprint(profile);
    const info = readJson(paths.daemon);
    const running = Boolean(info && (await healthCheck(info)));
    print({
      ok: true,
      profile,
      fingerprint: { ...fingerprint, seed: `${String(fingerprint.seed).slice(0, 8)}...` },
      daemonRunning: running,
      note: "指纹保存在该 profile 的 settings.json，固定不变；--reset 会重新生成并停止 daemon",
    });
    return;
  }

  const info = await ensureDaemon(profile, flags);
  const timeout = numberFlag(flags.timeout, DEFAULT_TIMEOUT);
  let result;

  switch (command) {
    case "open":
    case "goto": {
      const url = positional[0];
      if (!url) throw new Error("open 需要 URL");
      // Only switch modes when explicitly requested. Implicitly forcing
      // headless would restart Chrome and drop session cookies.
      const explicitMode = flags.headed ? "headed" : flags.headless ? "headless" : undefined;
      result = await requestDaemon(info, "/open", {
        url,
        mode: explicitMode,
        autoHeaded: !flags["no-auto-headed"],
        waitUntil: flags["wait-until"] || "domcontentloaded",
        timeout: numberFlag(flags["nav-timeout"], 45_000),
        snapshot: Boolean(flags.snapshot),
        snapshotMode: flags["snapshot-mode"] || "interactive",
        maxChars: numberFlag(flags["max-chars"], DEFAULT_SNAPSHOT_CHARS),
      });
      break;
    }
    case "state":
      result = await requestDaemon(info, "/state");
      break;
    case "focus":
      result = await requestDaemon(info, "/focus");
      break;
    case "snapshot":
      result = await requestDaemon(info, "/snapshot", {
        mode: flags.mode || "interactive",
        selector: flags.selector || "",
        frame: flags.frame || "",
        maxChars: numberFlag(flags["max-chars"], DEFAULT_SNAPSHOT_CHARS),
      });
      break;
    case "eval": {
      const expression = positional.join(" ").trim();
      if (!expression) throw new Error("eval 需要 expression");
      result = await requestDaemon(info, "/eval", { expression });
      break;
    }
    case "drag": {
      const sourceSelector = positional[0];
      const targetSelector = positional[1];
      if (!sourceSelector || !targetSelector) throw new Error("drag 需要 source selector 和 target selector");
      const jsDrag = Boolean(flags.js) || flags.method === "js";
      result = await requestDaemon(info, "/drag", {
        sourceSelector,
        targetSelector,
        frame: flags.frame || "",
        timeout,
        sourceNth: flags.nth !== undefined ? Math.max(0, numberFlag(flags.nth, 1) - 1) : undefined,
        targetNth: flags["target-nth"] !== undefined ? Math.max(0, numberFlag(flags["target-nth"], 1) - 1) : undefined,
        steps: numberFlag(flags.steps, 12),
        method: flags.method || "auto",
        force: Boolean(flags.force),
        js: Boolean(flags.js),
        allowJs: Boolean(flags["allow-js"]),
        realOnly: !jsDrag,
      });
      break;
    }
    case "click": {
      const selector = positional[0];
      if (!selector) throw new Error("click 需要 selector");
      result = await requestDaemon(info, "/click", {
        selector,
        frame: flags.frame || "",
        timeout,
        button: flags.button || "left",
        clickCount: numberFlag(flags["click-count"], 1),
        nth: flags.nth !== undefined ? Math.max(0, numberFlag(flags.nth, 1) - 1) : undefined,
        force: Boolean(flags.force),
        js: Boolean(flags.js),
        allowJs: Boolean(flags["allow-js"]),
        allowAuth: Boolean(flags["allow-auth"]),
        realOnly: !flags.js,
        waitFor: flags["wait-for"] || "",
        waitForNavigation: Boolean(flags["wait-nav"]),
      });
      break;
    }
    case "fill": {
      const selector = positional[0];
      const value = positional.slice(1).join(" ");
      if (!selector) throw new Error("fill 需要 selector 和 value");
      result = await requestDaemon(info, "/fill", {
        selector,
        value,
        frame: flags.frame || "",
        type: Boolean(flags.type),
        append: Boolean(flags.append),
        clear: !flags.append,
        allowAuth: Boolean(flags["allow-auth"]),
        timeout,
      });
      break;
    }
    case "upload": {
      const selector = positional[0];
      if (!selector || positional.length < 2) throw new Error("upload 需要 selector 和至少一个文件");
      const files = positional.slice(1).map((file) => resolve(file));
      const missing = files.filter((file) => !existsSync(file) || !statSync(file).isFile());
      if (missing.length) {
        result = { ok: false, action: "upload", error: { code: "file-not-found", message: `文件不存在或不是普通文件: ${missing.join(", ")}` } };
        break;
      }
      result = await requestDaemon(info, "/upload", { selector, files, frame: flags.frame || "", timeout });
      break;
    }
    case "press": {
      const key = positional[0];
      if (!key) throw new Error("press 需要 key");
      result = await requestDaemon(info, "/press", { key, allowAuth: Boolean(flags["allow-auth"]) });
      break;
    }
    case "hover": {
      const selector = positional[0];
      if (!selector) throw new Error("hover 需要 selector");
      result = await requestDaemon(info, "/hover", { selector, frame: flags.frame || "", timeout, wait: numberFlag(flags.wait, 150) });
      break;
    }
    case "select": {
      const selector = positional[0];
      const value = positional.slice(1).join(" ");
      if (!selector) throw new Error("select 需要 selector 和 value/label");
      result = await requestDaemon(info, "/select", {
        selector,
        value,
        label: Boolean(flags.label),
        frame: flags.frame || "",
        allowAuth: Boolean(flags["allow-auth"]),
        timeout,
      });
      break;
    }
    case "wait": {
      result = await requestDaemon(info, "/wait", {
        selector: positional[0] || flags.selector || "",
        url: flags.url || "",
        frame: flags.frame || "",
        timeout,
      });
      break;
    }
    case "annotate":
    case "mark": {
      const mode = positional[0] || "start";
      if (!["start", "read", "wait", "cancel"].includes(mode)) {
        throw new Error("annotate 需要 start | read | wait | cancel");
      }
      result = await requestDaemon(info, "/annotate", { mode, timeout: numberFlag(flags.timeout, 150_000) });
      // A launcher the user cannot see is useless: bring Chrome forward unless told not to.
      if (mode !== "cancel" && !flags["no-focus"]) await requestDaemon(info, "/focus").catch(() => {});
      break;
    }
    case "screenshot": {
      result = await requestDaemon(info, "/screenshot", {
        path: positional[0] || flags.path || "",
        fullPage: Boolean(flags["full-page"]),
      });
      break;
    }
    case "close": {
      result = await requestDaemon(info, "/close");
      break;
    }
    case "dialog": {
      const action = positional[0] || "status";
      result = await requestDaemon(info, "/dialog", { action, text: flags.text || "" });
      break;
    }
    case "mode": {
      const mode = positional[0];
      if (mode !== "headed" && mode !== "headless") throw new Error("mode 需要 headed 或 headless");
      result = await requestDaemon(info, "/mode", { mode });
      break;
    }
    case "headed":
    case "headless": {
      result = await requestDaemon(info, "/mode", { mode: command });
      break;
    }
    case "switch": {
      result = await requestDaemon(info, "/switch", {
        index: flags.index !== undefined ? numberFlag(flags.index, 0) : undefined,
        urlIncludes: flags.url || "",
      });
      break;
    }
    case "wait-login": {
      result = await requestDaemon(info, "/wait-login", { timeout: numberFlag(flags.timeout, 300_000) });
      break;
    }
    case "console": {
      result = await requestDaemon(info, "/console", {
        limit: numberFlag(flags.limit, 50),
        filter: flags.filter || "",
        clear: Boolean(flags.clear),
      });
      break;
    }
    case "network": {
      result = await requestDaemon(info, "/network", {
        limit: numberFlag(flags.limit, 50),
        filter: flags.filter || "",
        type: flags.type || "",
        errors: Boolean(flags.errors),
        clear: Boolean(flags.clear),
      });
      break;
    }
    case "wait-verification": {
      result = await requestDaemon(info, "/wait-verification", { timeout: numberFlag(flags.timeout, 120_000) });
      break;
    }
    case "query": {
      const selector = positional[0];
      if (!selector) throw new Error("query 需要 selector");
      result = await requestDaemon(info, "/query", {
        selector,
        limit: numberFlag(flags.limit, 50),
        html: Boolean(flags.html),
        allAttrs: Boolean(flags["all-attrs"]),
        frame: flags.frame || "",
      });
      break;
    }
    case "debug": {
      result = await requestDaemon(info, "/debug", {
        consoleLimit: numberFlag(flags["console-limit"], 20),
        networkLimit: numberFlag(flags["network-limit"], 20),
      });
      break;
    }
    default:
      throw new Error(`未知命令: ${command}`);
  }

  print(result);
  if (result?.ok === false) process.exit(1);
}

main().catch((error) => {
  print({ ok: false, error: { code: "cli-error", message: firstLine(error?.message || error) } });
  process.exit(1);
});
