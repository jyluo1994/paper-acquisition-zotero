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
  const candidates = [body.doi, body.url, body.identifier].filter(Boolean);
  for (const value of candidates) {
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return "";
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
  const profileConfig = getProfile(body.profile || "auto");
  const proxyServer = resolveProxyServer(body, profileConfig);
  const proxyBypassList = resolveProxyBypassList(body, profileConfig);

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

  const env = {
    ...process.env,
    OUTPUT_DIR: DOWNLOAD_DIR,
    BROWSER_URL: profileConfig.browserURL || process.env.BROWSER_URL || "http://127.0.0.1:9222",
    CDP_PORT: String(profileConfig.cdpPort || process.env.CDP_PORT || 9222),
    CHROME_BIN: process.env.CHROME_BIN || detectChrome(),
    CHROME_USER_DATA_DIR: expandPath(profileConfig.browserUserDataDir || process.env.CHROME_USER_DATA_DIR || ""),
    CHROME_PROFILE_DIRECTORY: profileConfig.chromeProfileDirectory || process.env.CHROME_PROFILE_DIRECTORY || "",
    ...proxyEnv(proxyServer, proxyBypassList)
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
    stderr: trimLog(result.stderr)
  });
}

async function runFastCommand(identifier, body, profileConfig) {
  const command = renderFastCommand(FAST_COMMAND, identifier, body);
  const proxyServer = resolveProxyServer(body, profileConfig);
  const proxyBypassList = resolveProxyBypassList(body, profileConfig);
  const result = await spawnJSON("/bin/sh", ["-lc", command], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PAA_IDENTIFIER: identifier,
      PAA_DOWNLOAD_DIR: DOWNLOAD_DIR,
      ...proxyEnv(proxyServer, proxyBypassList)
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

function resolveProxyBypassList(body = {}, profileConfig = {}) {
  return String(
    body.proxyBypassList ||
    profileConfig.proxyBypassList ||
    process.env.PAA_PROXY_BYPASS_LIST ||
    process.env.CHROME_PROXY_BYPASS_LIST ||
    ""
  ).trim();
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

function proxyEnv(proxyServer, proxyBypassList = "") {
  if (!proxyServer) return {};
  const env = {
    PAA_PROXY_SERVER: proxyServer,
    CHROME_PROXY_SERVER: proxyServer
  };
  if (proxyBypassList) {
    env.PAA_PROXY_BYPASS_LIST = proxyBypassList;
    env.CHROME_PROXY_BYPASS_LIST = proxyBypassList;
  }
  if (/^(https?|socks4|socks5|socks5h):\/\//i.test(proxyServer)) {
    env.HTTP_PROXY = proxyServer;
    env.HTTPS_PROXY = proxyServer;
    env.ALL_PROXY = proxyServer;
  }
  return env;
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

async function startLoginProfile(profile, body) {
  const safeProfile = safeProfileName(profile);
  const profileConfig = getProfile(safeProfile);
  const chrome = process.env.CHROME_BIN || detectChrome();
  if (!chrome) {
    throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to enable profile login.");
  }

  const profileDir = safeProfileName(profileConfig.profileDir || safeProfile);
  const userDataDir = profileConfig.browserUserDataDir
    ? expandPath(profileConfig.browserUserDataDir)
    : path.join(PROFILES_DIR, profileDir, "chrome");
  fs.mkdirSync(userDataDir, { recursive: true });

  const port = Number(body.cdpPort || profileConfig.cdpPort || process.env.CDP_PORT || 9222);
  const startURL = body.loginUrl || profileConfig.loginUrl || "about:blank";
  const proxyServer = resolveProxyServer(body, profileConfig);
  const proxyBypassList = resolveProxyBypassList(body, profileConfig);
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

  return {
    status: "ok",
    profile: safeProfile,
    label: profileConfig.label || safeProfile,
    cdpURL: `http://127.0.0.1:${port}`,
    userDataDir,
    loginUrl: startURL,
    chromeProfileDirectory: profileConfig.chromeProfileDirectory || "",
    zeroOmegaProfile: profileConfig.zeroOmegaProfile || "",
    proxyServer: maskProxyServer(proxyServer)
  };
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
      proxyConfigured: !!resolveProxyServer(),
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
