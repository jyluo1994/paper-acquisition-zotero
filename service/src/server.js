#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const HOST = process.env.PAA_HOST || "127.0.0.1";
const PORT = Number(process.env.PAA_PORT || 24372);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_DOWNLOAD_DIR = path.join(os.homedir(), ".paper-acquisition", "downloads");
const DOWNLOAD_DIR = path.resolve(process.env.PAA_DOWNLOAD_DIR || DEFAULT_DOWNLOAD_DIR);
const PROFILES_DIR = path.resolve(process.env.PAA_PROFILES_DIR || path.join(os.homedir(), ".paper-acquisition", "profiles"));
const BROWSER_FALLBACK = path.resolve(process.env.PAA_BROWSER_FALLBACK || path.join(REPO_ROOT, "scripts", "browser-fallback.js"));
const FAST_COMMAND = process.env.PAA_FAST_COMMAND || "";
const PROFILE_CONFIG = loadProfileConfig();

const jobs = new Map();

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function notFound(res) {
  json(res, 404, { status: "not_found" });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      }
      catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

function cleanIdentifier(body) {
  const url = String(body.url || "").trim();
  const doi = String(body.doi || "").trim();
  const identifier = String(body.identifier || "").trim();
  const candidates = [];
  if (doi) candidates.push(doi);
  if (url && isNonDoiHttpURL(url)) candidates.push(url);
  if (url) candidates.push(url);
  if (identifier) candidates.push(identifier);
  for (const value of candidates) {
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return "";
}

function isNonDoiHttpURL(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return /^https?:$/i.test(url.protocol) && host !== "doi.org" && host !== "dx.doi.org";
  }
  catch {
    return false;
  }
}

function makeJob(body) {
  const id = `job_${crypto.randomBytes(12).toString("hex")}`;
  const now = new Date().toISOString();
  const job = {
    jobId: id,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    request: sanitizeRequest(body)
  };
  jobs.set(id, job);
  return job;
}

function sanitizeRequest(body) {
  return {
    zoteroItemKey: body.zoteroItemKey || "",
    doi: body.doi || "",
    title: body.title || "",
    url: body.url || "",
    profile: body.profile || "auto",
    mode: body.mode || "manual"
  };
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

async function runAcquireJob(job, body) {
  updateJob(job, { status: "running" });
  const profileName = safeProfileName(body.profile || "auto");
  const profileConfig = getProfile(profileName);
  const proxyMode = resolveProxyMode(body, profileConfig);
  const proxyServer = proxyMode === "local" ? resolveProxyServer(body, profileConfig) : "";
  const proxyBypassList = proxyMode === "local" ? resolveProxyBypassList(body, profileConfig) : "";
  const proxyAuth = proxyMode === "local" ? resolveProxyAuth(body, profileConfig) : {};

  const identifier = cleanIdentifier(body);
  if (!identifier) {
    updateJob(job, {
      status: "missing_metadata",
      error: "No DOI, URL, or identifier was provided. Title-only acquisition needs a scansci-pdf search adapter."
    });
    return;
  }

  if (!fs.existsSync(BROWSER_FALLBACK)) {
    updateJob(job, {
      status: "failed",
      error: `Browser fallback script not found: ${BROWSER_FALLBACK}`
    });
    return;
  }

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  if (FAST_COMMAND) {
    const fast = await runFastCommand(identifier, body, profileConfig);
    if (fast.terminal) {
      updateJob(job, fast.patch);
      return;
    }
    updateJob(job, {
      fastAttempt: fast.patch
    });
  }

  const browserMode = body.useExistingBrowser ? "existing" : "background";
  const env = {
    ...process.env,
    OUTPUT_DIR: DOWNLOAD_DIR,
    BROWSER_URL: profileConfig.browserURL || process.env.BROWSER_URL || "http://127.0.0.1:9222",
    CDP_PORT: String(profileConfig.cdpPort || process.env.CDP_PORT || 9222),
    CHROME_BIN: process.env.CHROME_BIN || detectChrome(),
    CHROME_USER_DATA_DIR: browserUserDataDirFor(profileName, profileConfig),
    CHROME_PROFILE_DIRECTORY: profileConfig.chromeProfileDirectory || process.env.CHROME_PROFILE_DIRECTORY || "",
    PAA_BROWSER_MODE: browserMode,
    PAA_USE_EXISTING_BROWSER: body.useExistingBrowser ? "1" : "",
    ...proxyEnv(proxyServer, proxyBypassList, proxyAuth)
  };

  const result = await spawnJSON(process.execPath, [BROWSER_FALLBACK, identifier], {
    cwd: REPO_ROOT,
    env,
    timeoutMS: Number(process.env.PAA_JOB_TIMEOUT_MS || 600000)
  });

  if (result.exitCode !== 0 && !result.json) {
    updateJob(job, {
      status: "failed",
      error: result.stderr || result.stdout || `Acquisition command exited with ${result.exitCode}`
    });
    return;
  }

  const data = result.json || {};
  const status = normalizeStatus(data.status || (result.exitCode === 0 ? "ok" : "failed"));

  updateJob(job, {
    ...data,
    originalStatus: data.status || "",
    status,
    pdfPath: data.pdf_path || data.pdfPath || "",
    downloadDir: DOWNLOAD_DIR,
    stderr: trimLog(result.stderr)
  });
}

async function runFastCommand(identifier, body, profileConfig) {
  const command = renderFastCommand(FAST_COMMAND, identifier, body);
  const proxyMode = resolveProxyMode(body, profileConfig);
  const proxyServer = proxyMode === "local" ? resolveProxyServer(body, profileConfig) : "";
  const proxyBypassList = proxyMode === "local" ? resolveProxyBypassList(body, profileConfig) : "";
  const proxyAuth = proxyMode === "local" ? resolveProxyAuth(body, profileConfig) : {};
  const result = await spawnJSON("/bin/sh", ["-lc", command], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PAA_IDENTIFIER: identifier,
      PAA_DOWNLOAD_DIR: DOWNLOAD_DIR,
      ...proxyEnv(proxyServer, proxyBypassList, proxyAuth)
    },
    timeoutMS: Number(process.env.PAA_FAST_TIMEOUT_MS || 180000)
  });

  const data = result.json || {};
  const status = normalizeStatus(data.status || data.error_type || "");
  const pdfPath = data.pdf_path || data.pdfPath || data.path || "";

  if (result.exitCode === 0 && status === "ok" && pdfPath && fs.existsSync(pdfPath)) {
    return {
      terminal: true,
      patch: {
        ...data,
        status: "ok",
        route: data.route || "fast-command",
        pdfPath,
        downloadDir: DOWNLOAD_DIR,
        stderr: trimLog(result.stderr)
      }
    };
  }

  if (["human_verification_required", "captcha_stop", "cooldown"].includes(status)) {
    return {
      terminal: true,
      patch: {
        ...data,
        status,
        route: data.route || "fast-command",
        stderr: trimLog(result.stderr)
      }
    };
  }

  return {
    terminal: false,
    patch: {
      status: status || "fallback_to_browser",
      route: "fast-command",
      exitCode: result.exitCode,
      stdout: trimLog(result.stdout),
      stderr: trimLog(result.stderr)
    }
  };
}

function renderFastCommand(template, identifier, body) {
  return template
    .replace(/\{identifier\}/g, shellQuote(identifier))
    .replace(/\{doi\}/g, shellQuote(body.doi || ""))
    .replace(/\{url\}/g, shellQuote(body.url || ""))
    .replace(/\{title\}/g, shellQuote(body.title || ""))
    .replace(/\{profile\}/g, shellQuote(body.profile || "auto"))
    .replace(/\{downloadDir\}/g, shellQuote(DOWNLOAD_DIR));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function normalizeStatus(status) {
  if (status === "no_institutional_access") return "login_required";
  if (status === "human_verification_required") return "human_verification_required";
  return status || "failed";
}

function spawnJSON(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
    }, options.timeoutMS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: trimLog(stdout),
        stderr: trimLog(stderr),
        json: parseLastJSON(stdout)
      });
    });
    child.on("error", (err) => {
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout: trimLog(stdout),
        stderr: `${stderr}\n${err.message}`.trim(),
        json: null
      });
    });
  });
}

function parseLastJSON(stdout) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    }
    catch {
      // Continue scanning for the last JSON line.
    }
  }
  return null;
}

function trimLog(value) {
  return String(value || "").slice(-8000);
}

function safeProfileName(profile) {
  const safe = String(profile || "default").replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "");
  return safe || "default";
}

function loadProfileConfig() {
  const configured = process.env.PAA_PROFILES_FILE || path.join(REPO_ROOT, "service", "profiles.json");
  const fallback = path.join(REPO_ROOT, "service", "profiles.example.json");
  for (const filePath of [configured, fallback]) {
    try {
      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return parsed.profiles || {};
      }
    }
    catch (err) {
      console.error(`[profiles] Failed to load ${filePath}: ${err.message}`);
    }
  }
  return {};
}

function getProfile(profile) {
  return PROFILE_CONFIG[safeProfileName(profile)] || {};
}

function resolveProxyServer(body = {}, profileConfig = {}) {
  if (Object.prototype.hasOwnProperty.call(body, "proxyServer")) {
    return normalizeProxyServer(body.proxyServer);
  }
  return normalizeProxyServer(
    profileConfig.proxyServer ||
    process.env.PAA_PROXY_SERVER ||
    process.env.CHROME_PROXY_SERVER ||
    ""
  );
}

function resolveProxyMode(body = {}, profileConfig = {}) {
  const bodyMode = String(body.proxyMode || "").trim().toLowerCase();
  const raw = bodyMode && bodyMode !== "profile"
    ? bodyMode
    : String(profileConfig.proxyMode || process.env.PAA_PROXY_MODE || "browser-profile").trim().toLowerCase();
  return raw === "local" ? "local" : "browser-profile";
}

function resolveProxyBypassList(body = {}, profileConfig = {}) {
  return String(
    body.proxyBypassList ||
    profileConfig.proxyBypassList ||
    process.env.PAA_PROXY_BYPASS_LIST ||
    process.env.CHROME_PROXY_BYPASS_LIST ||
    ""
  ).trim();
}

function resolveProxyAuth(body = {}, profileConfig = {}) {
  if (Object.prototype.hasOwnProperty.call(body, "proxyUsername") ||
      Object.prototype.hasOwnProperty.call(body, "proxyPassword")) {
    return {
      username: String(body.proxyUsername || ""),
      password: String(body.proxyPassword || "")
    };
  }
  return {
    username: String(profileConfig.proxyUsername || process.env.PAA_PROXY_USERNAME || process.env.CHROME_PROXY_USERNAME || ""),
    password: String(profileConfig.proxyPassword || process.env.PAA_PROXY_PASSWORD || process.env.CHROME_PROXY_PASSWORD || "")
  };
}

function normalizeProxyServer(value) {
  const proxy = String(value || "").trim();
  if (!proxy) return "";
  if (/^(https?|socks4|socks5|socks5h):\/\//i.test(proxy)) return proxy;
  if (/^[a-z][a-z0-9+.-]*=/i.test(proxy) || proxy.includes(";")) return proxy;
  if (/^\[[^\]]+\]:\d+$/.test(proxy) || /^[^:/\s]+:\d+$/.test(proxy)) {
    return `http://${proxy}`;
  }
  return proxy;
}

function proxyEnv(proxyServer, proxyBypassList = "", proxyAuth = {}) {
  if (!proxyServer) return {};
  const env = {
    PAA_PROXY_SERVER: proxyServer,
    CHROME_PROXY_SERVER: proxyServer
  };
  if (proxyAuth.username || proxyAuth.password) {
    env.PAA_PROXY_USERNAME = proxyAuth.username || "";
    env.PAA_PROXY_PASSWORD = proxyAuth.password || "";
    env.CHROME_PROXY_USERNAME = proxyAuth.username || "";
    env.CHROME_PROXY_PASSWORD = proxyAuth.password || "";
  }
  if (proxyBypassList) {
    env.PAA_PROXY_BYPASS_LIST = proxyBypassList;
    env.CHROME_PROXY_BYPASS_LIST = proxyBypassList;
  }
  if (/^(https?|socks4|socks5|socks5h):\/\//i.test(proxyServer)) {
    const authenticatedProxy = authenticatedProxyURL(proxyServer, proxyAuth);
    env.HTTP_PROXY = authenticatedProxy;
    env.HTTPS_PROXY = authenticatedProxy;
    env.ALL_PROXY = authenticatedProxy;
  }
  return env;
}

function authenticatedProxyURL(proxyServer, proxyAuth = {}) {
  if (!proxyServer || (!proxyAuth.username && !proxyAuth.password)) return proxyServer;
  try {
    const url = new URL(proxyServer);
    url.username = proxyAuth.username || "";
    url.password = proxyAuth.password || "";
    return url.toString();
  }
  catch {
    return proxyServer;
  }
}

function maskProxyServer(proxyServer) {
  if (!proxyServer) return "";
  const masked = String(proxyServer).replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@;:\s]+):([^/@;\s]+)@/gi, "$1***:***@");
  try {
    const url = new URL(masked);
    if (url.username || url.password) {
      url.username = url.username ? "***" : "";
      url.password = url.password ? "***" : "";
      return url.toString();
    }
  }
  catch {
    // Chrome proxy mapping strings are not always URLs.
  }
  return masked;
}

function sanitizeProfiles(profiles) {
  const out = {};
  for (const [name, config] of Object.entries(profiles || {})) {
    out[name] = { ...config };
    if (out[name].proxyServer) {
      out[name].proxyServer = maskProxyServer(normalizeProxyServer(out[name].proxyServer));
    }
    if (out[name].proxyPassword) {
      out[name].proxyPassword = "***";
    }
  }
  return out;
}

function expandPath(value) {
  if (!value) return "";
  return String(value)
    .replace(/^~(?=$|\/)/, os.homedir())
    .replace(/\$\{HOME\}/g, os.homedir())
    .replace(/\$HOME/g, os.homedir());
}

function browserUserDataDirFor(profile, profileConfig = {}) {
  if (profileConfig.browserUserDataDir) {
    return expandPath(profileConfig.browserUserDataDir);
  }
  if (process.env.CHROME_USER_DATA_DIR) {
    return expandPath(process.env.CHROME_USER_DATA_DIR);
  }
  const profileDir = safeProfileName(profileConfig.profileDir || profile || "auto");
  return path.join(PROFILES_DIR, profileDir, "chrome");
}

async function startLoginProfile(profile, body) {
  const safeProfile = safeProfileName(profile);
  const profileConfig = getProfile(safeProfile);
  const chrome = process.env.CHROME_BIN || detectChrome();
  if (!chrome) {
    throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to enable profile login.");
  }

  const userDataDir = browserUserDataDirFor(safeProfile, profileConfig);
  fs.mkdirSync(userDataDir, { recursive: true });

  const port = Number(body.cdpPort || profileConfig.cdpPort || process.env.CDP_PORT || 9222);
  const startURL = body.loginUrl || profileConfig.loginUrl || "about:blank";
  const proxyMode = resolveProxyMode(body, profileConfig);
  const proxyServer = proxyMode === "local" ? resolveProxyServer(body, profileConfig) : "";
  const proxyBypassList = proxyMode === "local" ? resolveProxyBypassList(body, profileConfig) : "";
  const proxyAuth = proxyMode === "local" ? resolveProxyAuth(body, profileConfig) : {};
  const cdpURL = `http://127.0.0.1:${port}`;

  if (body.reuseOpenPage && startURL && startURL !== "about:blank") {
    const openPage = await findOpenPage(cdpURL, startURL);
    if (openPage) {
      await activateOpenPage(cdpURL, openPage.id);
      return loginProfileResult({
        safeProfile,
        profileConfig,
        cdpURL,
        userDataDir,
        startURL,
        proxyMode,
        proxyServer,
        proxyAuth,
        reusedOpenPage: true,
        openPageURL: openPage.url || ""
      });
    }
  }

  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check"
  ];
  if (profileConfig.chromeProfileDirectory) {
    chromeArgs.push(`--profile-directory=${profileConfig.chromeProfileDirectory}`);
  }
  if (proxyServer) {
    chromeArgs.push(`--proxy-server=${proxyServer}`);
  }
  if (proxyBypassList) {
    chromeArgs.push(`--proxy-bypass-list=${proxyBypassList}`);
  }
  chromeArgs.push("--new-window", startURL);

  const child = spawn(chrome, chromeArgs, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  const cdpReady = await waitForCDP(cdpURL, 10000);
  if (!cdpReady) {
    throw new Error(
      `Chrome did not expose remote debugging at ${cdpURL}. ` +
      "If this profile is already open in Chrome, close Chrome and retry, or use local proxy mode."
    );
  }

  return loginProfileResult({
    safeProfile,
    profileConfig,
    cdpURL,
    userDataDir,
    startURL,
    proxyMode,
    proxyServer,
    proxyAuth
  });
}

function loginProfileResult({
  safeProfile,
  profileConfig,
  cdpURL,
  userDataDir,
  startURL,
  proxyMode,
  proxyServer,
  proxyAuth,
  reusedOpenPage = false,
  openPageURL = ""
}) {
  return {
    status: "ok",
    profile: safeProfile,
    label: profileConfig.label || safeProfile,
    cdpURL,
    userDataDir,
    loginUrl: startURL,
    chromeProfileDirectory: profileConfig.chromeProfileDirectory || "",
    zeroOmegaProfile: profileConfig.zeroOmegaProfile || "",
    proxyMode,
    proxyServer: maskProxyServer(proxyServer),
    proxyAuthConfigured: !!(proxyAuth.username || proxyAuth.password),
    reusedOpenPage,
    openPageURL
  };
}

async function findOpenPage(cdpURL, targetURL) {
  const pages = await readCDPPages(cdpURL);
  return pages.find((page) => page.type === "page" && samePageURL(page.url, targetURL)) || null;
}

async function readCDPPages(cdpURL) {
  const pages = await readJSON(`${cdpURL.replace(/\/+$/, "")}/json/list`);
  return Array.isArray(pages) ? pages : [];
}

function samePageURL(openURL, targetURL) {
  const open = comparableURL(openURL);
  const target = comparableURL(targetURL);
  if (!open || !target) return false;
  return open === target || open.replace(/\/+$/, "") === target.replace(/\/+$/, "");
}

function comparableURL(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  }
  catch {
    return String(value || "").trim().replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

async function activateOpenPage(cdpURL, pageId) {
  if (!pageId) return false;
  return requestOK(`${cdpURL.replace(/\/+$/, "")}/json/activate/${encodeURIComponent(pageId)}`);
}

async function waitForCDP(cdpURL, timeoutMS) {
  const deadline = Date.now() + timeoutMS;
  while (Date.now() < deadline) {
    if (await canReadJSON(`${cdpURL.replace(/\/+$/, "")}/json/version`)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function canReadJSON(url) {
  return readJSON(url).then((data) => !!data);
}

function readJSON(url) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          finish(null);
          return;
        }
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        }
        catch {
          finish(null);
        }
      });
    });
    req.setTimeout(1000, () => {
      req.destroy();
      finish(null);
    });
    req.on("error", () => finish(null));
  });
}

function requestOK(url) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get(url, (res) => {
      res.resume();
      finish(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.setTimeout(1000, () => {
      req.destroy();
      finish(false);
    });
    req.on("error", () => finish(false));
  });
}

function detectChrome() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function resolverResponse(doi) {
  const safe = String(doi || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) return null;
  const expected = path.join(DOWNLOAD_DIR, `doi-${safe}.pdf`);
  if (!fs.existsSync(expected)) return null;
  return {
    status: "ok",
    pdfPath: expected,
    pdfURL: `file://${expected}`
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, {
      status: "ok",
      service: "paper-acquisition-zotero-service",
      browserFallback: BROWSER_FALLBACK,
      downloadDir: DOWNLOAD_DIR,
      proxyMode: resolveProxyMode(),
      proxyConfigured: resolveProxyMode() === "local" && !!resolveProxyServer(),
      profiles: Object.keys(PROFILE_CONFIG)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/profiles") {
    json(res, 200, {
      status: "ok",
      profiles: sanitizeProfiles(PROFILE_CONFIG)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/acquire") {
    try {
      const body = await readBody(req);
      const job = makeJob(body);
      json(res, 202, { status: "queued", jobId: job.jobId });
      runAcquireJob(job, body).catch((err) => {
        updateJob(job, { status: "failed", error: err.message });
      });
    }
    catch (err) {
      json(res, 400, { status: "failed", error: err.message });
    }
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === "GET" && jobMatch) {
    const job = jobs.get(decodeURIComponent(jobMatch[1]));
    if (!job) {
      notFound(res);
      return;
    }
    json(res, 200, job);
    return;
  }

  const loginMatch = url.pathname.match(/^\/api\/login\/([^/]+)$/);
  if (req.method === "POST" && loginMatch) {
    try {
      const body = await readBody(req);
      const result = await startLoginProfile(decodeURIComponent(loginMatch[1]), body);
      json(res, 200, result);
    }
    catch (err) {
      json(res, 500, { status: "failed", error: err.message });
    }
    return;
  }

  const resolverMatch = url.pathname.match(/^\/api\/resolver\/(.+)$/);
  if (req.method === "GET" && resolverMatch) {
    const result = resolverResponse(decodeURIComponent(resolverMatch[1]));
    if (!result) {
      json(res, 404, { status: "not_found" });
      return;
    }
    json(res, 200, result);
    return;
  }

  notFound(res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    json(res, 500, { status: "failed", error: err.message });
  });
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({
    status: "ok",
    service: "paper-acquisition-zotero-service",
    url: `http://${HOST}:${PORT}`,
    downloadDir: DOWNLOAD_DIR
  }));
});
