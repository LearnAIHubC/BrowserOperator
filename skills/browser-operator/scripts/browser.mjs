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
import { randomBytes } from "node:crypto";
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
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const SELF = fileURLToPath(import.meta.url);
const HOME = process.env.BROWSER_OPERATOR_HOME || join(homedir(), ".dsh", "browser-operator");
const PROFILES = join(HOME, "profiles");
const SHOTS = join(HOME, "screenshots");
const EXPERIENCES = join(HOME, "experiences");
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
    return match ? match[1] : "124.0.0.0";
  } catch {
    return "124.0.0.0";
  }
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
  if (settings.fingerprint && settings.fingerprint.seed) return settings.fingerprint;
  const gpu = detectGpu();
  const fingerprint = {
    seed: randomBytes(16).toString("hex"),
    platform: platformName(),
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
  const locale = settings.locale || systemLocale();
  const timezoneId = settings.timezone || systemTimeZone();
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
  const context = await chromium.launchPersistentContext(paths.chrome, {
    headless,
    executablePath,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    userAgent,
    locale,
    timezoneId,
    ignoreHTTPSErrors: true,
    args,
  });
  await context.addInitScript(buildFingerprintScript(fingerprint, userAgent, locale));
  // Record the version the browser itself reports so future launches stay
  // consistent even if the binary cannot be queried.
  try {
    const actualVersion = context.browser()?.version?.();
    if (actualVersion && actualVersion !== settings.chromeVersion) {
      writeSettings(profile, { chromeVersion: actualVersion });
    }
  } catch {}

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
  attachDiagnostics(page);
  await page.bringToFront().catch(() => {});
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
  list.push({ ts: Date.now(), ...entry });
  const max = kind === "console" ? MAX_CONSOLE : kind === "network" ? MAX_NETWORK : MAX_DIALOG;
  if (list.length > max) list.splice(0, list.length - max);
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
  page.on("dialog", (dialog) => {
    try {
      pushDiagnostic("dialog", {
        page: maskUrl(page.url()),
        type: dialog.type(),
        message: String(dialog.message() || "").slice(0, 1000),
      });
    } catch {}
    // Auto-accept so confirm() gates do not silently cancel page actions.
    // The message is kept in `dialogs` so callers can still assert on it.
    dialog.accept().catch(() => {});
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

async function clickAction(body) {
  const page = getPage();
  const selector = String(body.selector || "").trim();
  if (!selector) throw fail("bad-request", "click 需要 selector");
  const manualAuth = await manualAuthHints(page);
  if (manualAuth.required) {
    throw fail(
      "manual-auth-required",
      `页面需要用户${manualAuth.kind === "verification" ? "完成验证" : "登录"}；agent 不执行登录/验证操作。请先运行 mode headed，让用户在可见浏览器完成后重试。`,
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
      await popup.bringToFront().catch(() => {});
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
    await current.bringToFront().catch(() => {});
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
    target: targetInfo,
    effect,
    warning: warning || undefined,
    dialogs: diagnostics.dialog.slice(dialogCountBefore),
    url: maskUrl(current.url()),
    title: await current.title().catch(() => ""),
  };
}

// ── console / network / debug ─────────────────────────────────────

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
  await page.goto(url, {
    waitUntil: body.waitUntil || "domcontentloaded",
    timeout: Number(body.timeout) || 45_000,
  });
  await sleep(500);
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
  activePage = page;
  await page.bringToFront().catch(() => {});
  let state = await stateAction();
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

async function fillAction(body) {
  const selector = String(body.selector || "").trim();
  if (!selector) throw fail("bad-request", "fill 需要 selector");
  const page = getPage();
  const manualAuth = await manualAuthHints(page);
  if (manualAuth.required) {
    throw fail(
      "manual-auth-required",
      `页面需要用户${manualAuth.kind === "verification" ? "完成验证" : "登录"}；agent 不填写登录/验证字段。请先运行 mode headed，让用户在可见浏览器完成后重试。`,
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
  return { ok: true, action: "fill", profile: currentProfile, target: await describeLocator(target), url: maskUrl(getPage().url()) };
}

async function pressAction(body) {
  const key = String(body.key || "").trim();
  if (!key) throw fail("bad-request", "press 需要 key");
  const page = getPage();
  const manualAuth = await manualAuthHints(page);
  if (manualAuth.required) {
    throw fail("manual-auth-required", "页面需要用户登录/验证；agent 不发送可能提交登录或验证的按键。请先运行 mode headed。", manualAuth);
  }
  await page.keyboard.press(key);
  return { ok: true, action: "press", key, url: maskUrl(getPage().url()) };
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
  if (manualAuth.required) {
    throw fail("manual-auth-required", "页面需要用户登录/验证；agent 不执行登录/验证操作。", manualAuth);
  }
  const root = await getRoot(String(body.frame || ""));
  const target = (await pickVisibleLocator(root.locator(selector), Number(body.timeout) || DEFAULT_TIMEOUT)).locator;
  const value = body.label
    ? { label: String(body.value ?? "") }
    : String(body.value ?? "");
  await target.selectOption(value, { timeout: Number(body.timeout) || DEFAULT_TIMEOUT });
  return { ok: true, action: "select", profile: currentProfile, target: await describeLocator(target), url: maskUrl(getPage().url()) };
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
  if (activePage) await activePage.bringToFront().catch(() => {});
  return { ok: true, action: "close", closedUrl, state: await stateAction() };
}

async function switchAction(body) {
  const pages = context.pages().filter((candidate) => !candidate.isClosed());
  let page = null;
  if (typeof body.index === "number") page = pages[body.index] || null;
  else if (body.urlIncludes) page = pages.find((candidate) => candidate.url().includes(String(body.urlIncludes))) || null;
  if (!page) throw fail("page-not-found", "没有匹配的标签页");
  activePage = page;
  await page.bringToFront().catch(() => {});
  return stateAction();
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
    meta[key] = value;
  }
  return meta;
}

function experienceListAction() {
  ensureHome();
  const experiences = [];
  for (const entry of readdirSync(EXPERIENCES, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = join(EXPERIENCES, entry.name);
    const text = readFileSync(path, "utf8");
    const meta = parseExperienceMeta(text);
    experiences.push({
      domain: meta.domain || entry.name.replace(/\.md$/, ""),
      site: meta.site || "",
      updated: meta.updated || "",
      confidence: meta.confidence || "",
      path,
    });
  }
  experiences.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  return { ok: true, action: "experience-list", directory: EXPERIENCES, experiences };
}

function experienceShowAction(value) {
  const path = experiencePath(value);
  if (!existsSync(path)) {
    return { ok: true, action: "experience-show", found: false, path, domain: normalizeDomain(value) };
  }
  const content = readFileSync(path, "utf8");
  return {
    ok: true,
    action: "experience-show",
    found: true,
    path,
    domain: normalizeDomain(value),
    meta: parseExperienceMeta(content),
    content,
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
      try {
        let result;
        switch (path) {
          case "/state": result = await stateAction(); break;
          case "/open": result = await openAction(body); break;
          case "/goto": result = await gotoAction(body); break;
          case "/snapshot": result = await snapshotAction(body); break;
          case "/click": result = await clickAction(body); break;
          case "/fill": result = await fillAction(body); break;
          case "/press": result = await pressAction(body); break;
          case "/hover": result = await hoverAction(body); break;
          case "/select": result = await selectAction(body); break;
          case "/wait": result = await waitAction(body); break;
          case "/screenshot": result = await screenshotAction(body); break;
          case "/switch": result = await switchAction(body); break;
          case "/close": result = await closeAction(); break;
          case "/mode": result = await switchModeAction(body); break;
          case "/wait-login": result = await waitLoginAction(body); break;
          case "/console": result = await consoleAction(body); break;
          case "/network": result = await networkAction(body); break;
          case "/debug": result = await debugAction(body); break;
          case "/query": result = await queryAction(body); break;
          case "/wait-verification": result = await waitVerificationAction(body); break;
          case "/stop":
            response.end(JSON.stringify({ ok: true, action: "stop" }));
            setTimeout(() => void shutdown(0), 100);
            return;
          default:
            throw fail("unknown-command", `unknown command: ${path}`);
        }
        response.end(JSON.stringify(result));
      } catch (error) {
        let screenshot = null;
        try {
          const shot = await screenshotAction({
            path: join(SHOTS, `error-${currentProfile}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`),
          });
          screenshot = shot.path;
        } catch {}
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
    "reset",
    "clear",
    "errors",
    "html",
    "all-attrs",
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
      flags[arg.slice(2, equals)] = arg.slice(equals + 1);
      continue;
    }
    const key = arg.slice(2);
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
    console.error("用法: browser <open|state|snapshot|query|click|fill|press|hover|select|wait|screenshot|switch|wait-login|console|network|debug|wait-verification|mode|close|experience|restore-session|fingerprint|stop|status|profiles> ...");
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
    else result = { ok: false, action: "experience", error: { code: "unknown-command", message: "用法: experience <list|path|show|validate> <domain>" } };
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
    case "snapshot":
      result = await requestDaemon(info, "/snapshot", {
        mode: flags.mode || "interactive",
        selector: flags.selector || "",
        frame: flags.frame || "",
        maxChars: numberFlag(flags["max-chars"], DEFAULT_SNAPSHOT_CHARS),
      });
      break;
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
        timeout,
      });
      break;
    }
    case "press": {
      const key = positional[0];
      if (!key) throw new Error("press 需要 key");
      result = await requestDaemon(info, "/press", { key });
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
