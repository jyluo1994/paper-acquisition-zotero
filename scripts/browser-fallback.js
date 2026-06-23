#!/usr/bin/env node
/**
 * browser-fallback.js — 浏览器兜底 PDF 下载脚本
 *
 * 当 scansci-pdf HTTP 下载因 TLS 指纹检测、Cloudflare 拦截、
 * 或出版商要求浏览器会话而失败时，通过真实 Chrome 浏览器获取 PDF。
 *
 * 依赖：npm install puppeteer-core
 * 前置：Chrome/Chromium 已启动并开放远程调试端口
 *
 * 用法：
 *   node scripts/browser-fallback.js "10.xxxx/xxxxx"
 *   node scripts/browser-fallback.js "https://doi.org/10.xxxx/xxxxx"
 *
 * 环境变量：
 *   BROWSER_URL     Chrome CDP 地址（默认 http://127.0.0.1:9222）
 *   OUTPUT_DIR      下载目录（默认 ./downloads）
 *   CHROME_BIN      Chrome 可执行文件路径（用于自动启动时）
 *   CHROME_USER_DATA_DIR Chrome user-data-dir（用于复用 ZeroOmega 等扩展配置）
 *   CHROME_PROFILE_DIRECTORY Chrome profile directory（例如 Default）
 *   PAA_PROXY_SERVER / CHROME_PROXY_SERVER 仅用于本次浏览器兜底获取的代理
 *   PAA_PROXY_BYPASS_LIST / CHROME_PROXY_BYPASS_LIST Chrome 代理绕过列表
 *   PAA_PROXY_USERNAME / PAA_PROXY_PASSWORD HTTP proxy authentication
 *   CDP_PORT        远程调试端口（默认 9222）
 */

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const {
  BROWSER_URL = "http://127.0.0.1:9222",
  OUTPUT_DIR = "./downloads",
  CDP_PORT = 9222,
} = process.env;

const OUTPUT = path.resolve(OUTPUT_DIR);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeDoi(raw) {
  if (!raw) return null;
  const m = String(raw).trim().match(/10\.\d{4,9}\/[A-Za-z0-9.()/_;:-]+/i);
  return m ? m[0].toLowerCase() : null;
}

function inferProvider(url) {
  const h = new URL(url).hostname.toLowerCase();
  if (h.includes("springer") || h.includes("nature")) return "springer";
  if (h.includes("wiley")) return "wiley";
  if (h.includes("sciencedirect") || h.includes("elsevier")) return "sciencedirect";
  return "generic";
}

async function connectBrowser() {
  const proxyServer = normalizeProxyServer(process.env.PAA_PROXY_SERVER || process.env.CHROME_PROXY_SERVER || "");
  const proxyBypassList = String(process.env.PAA_PROXY_BYPASS_LIST || process.env.CHROME_PROXY_BYPASS_LIST || "").trim();
  const proxyAuth = proxyAuthCredentials();

  // 先尝试连接已有浏览器
  try {
    const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
    console.error(`[connect] Connected to existing browser at ${BROWSER_URL}`);
    if (proxyServer) {
      console.error("[connect] Proxy setting is only applied when launching a new browser.");
    }
    if (proxyAuth) {
      console.error("[connect] Proxy authentication will be applied to new pages.");
    }
    return browser;
  } catch {
    console.error(`[connect] No browser at ${BROWSER_URL}, trying to launch...`);
  }

  // 如果指定了 CHROME_BIN，自动启动一个
  const chromeBin = process.env.CHROME_BIN;
  if (chromeBin && fs.existsSync(chromeBin)) {
    const userDataDir = process.env.CHROME_USER_DATA_DIR
      ? path.resolve(process.env.CHROME_USER_DATA_DIR.replace(/^~(?=$|\/)/, process.env.HOME || ""))
      : path.join(OUTPUT, "..", ".browser-profile");
    fs.mkdirSync(userDataDir, { recursive: true });

    const { spawn } = require("child_process");
    const chromeArgs = [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ];
    if (process.env.CHROME_PROFILE_DIRECTORY) {
      chromeArgs.push(`--profile-directory=${process.env.CHROME_PROFILE_DIRECTORY}`);
    }
    if (proxyServer) {
      chromeArgs.push(`--proxy-server=${proxyServer}`);
    }
    if (proxyBypassList) {
      chromeArgs.push(`--proxy-bypass-list=${proxyBypassList}`);
    }
    chromeArgs.push("--new-window", "about:blank");
    const child = spawn(chromeBin, chromeArgs, { detached: true, stdio: "ignore" });
    child.unref();

    for (let i = 0; i < 20; i++) {
      try {
        const b = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}` });
        console.error(`[connect] Launched Chrome at port ${CDP_PORT}`);
        return b;
      } catch { await sleep(1000); }
    }
    throw new Error("Timed out waiting for Chrome to start");
  }

  throw new Error(
    "No browser available. Start Chrome with:\n" +
    "  google-chrome --remote-debugging-port=9222 --user-data-dir=$HOME/.openclaw/browser-clone\n" +
    "Or set CHROME_BIN env var for auto-launch."
  );
}

function proxyAuthCredentials() {
  const username = String(process.env.PAA_PROXY_USERNAME || process.env.CHROME_PROXY_USERNAME || "");
  const password = String(process.env.PAA_PROXY_PASSWORD || process.env.CHROME_PROXY_PASSWORD || "");
  if (!username && !password) return null;
  return { username, password };
}

async function newPage(browser) {
  const page = await browser.newPage();
  const proxyAuth = proxyAuthCredentials();
  if (proxyAuth) {
    await page.authenticate(proxyAuth);
  }
  return page;
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

async function resolveDoi(browser, doi) {
  const page = await newPage(browser);
  page.setDefaultNavigationTimeout(120000);
  await page.goto(`https://doi.org/${doi}`, { waitUntil: "domcontentloaded" });
  await sleep(5000);
  const url = page.url();
  await page.close();
  console.error(`[resolve] ${doi} -> ${url}`);
  return url;
}

async function inspectPage(page, provider) {
  const info = {
    title: null,
    pdfUrl: null,
    accessMode: "unknown",
    institution: null,
    unavailable: false,
    humanVerification: false,
    currentUrl: page.url()
  };

  try {
    info.title = await page.title();
    const body = await page.evaluate(() => document.body?.innerText || "");
    info.unavailable = /page not found|does not exist|moved|looking for does not exist/i.test(body);
    info.humanVerification = isHumanVerificationPage(body, info.title, info.currentUrl);
    info.accessMode = /open access/i.test(body) ? "open_access" : /access provided by/i.test(body) ? "institutional" : "unknown";
    const inst = body.match(/access provided by\s+([^\n]+)/i);
    if (inst) info.institution = inst[1].trim();
  } catch {}

  // 查找 PDF 链接
  info.pdfUrl = await page.evaluate((prov) => {
    const links = Array.from(document.querySelectorAll("a[href]")).map(a => ({
      text: (a.innerText || "").trim().toLowerCase(),
      href: a.href
    }));

    const iframes = Array.from(document.querySelectorAll("iframe[src], embed[src], object[data]"))
      .map(el => el.getAttribute("src") || el.getAttribute("data") || "");

    const all = [...links.map(l => l.href), ...iframes];

    // 按出版商匹配
    const patterns = {
      springer: [/\/content\/pdf\//i, /download.*pdf/i],
      wiley: [/\/doi\/pdf\//i, /\/doi\/epdf\//i, /\/doi\/pdfdirect\//i, /\.pdf(\?|$)/i],
      sciencedirect: [/\/pdfft\?/i, /view.*pdf/i],
      generic: [/\.pdf(\?|#|$)/i],
    };
    const pats = patterns[prov] || patterns.generic;

    // 1. 按链接文本匹配
    for (const l of links) {
      if (pats.some(p => p.test(l.text))) return l.href;
    }
    // 2. 按 href 匹配
    for (const href of all) {
      if (pats.some(p => p.test(href))) return href;
    }
    return null;
  }, provider);

  return info;
}

function isHumanVerificationPage(body, title, url) {
  const text = `${title || ""}\n${url || ""}\n${body || ""}`.toLowerCase();
  return [
    "captcha",
    "cf-turnstile",
    "cloudflare",
    "checking your browser",
    "verify you are human",
    "are you a robot",
    "robot check",
    "human verification",
    "security check",
    "access denied",
    "unusual traffic",
    "suspicious traffic",
    "automated access"
  ].some((needle) => text.includes(needle));
}

async function downloadPdf(page, pdfUrl, dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const before = new Set(fs.readdirSync(dir));

  // 尝试 CDP 下载
  let response;
  try {
    response = await page.goto(pdfUrl, { waitUntil: "domcontentloaded" });
  } catch {}

  // 检查是否直接返回了 PDF 内容
  if (response) {
    const ct = (response.headers()["content-type"] || "").toLowerCase();
    if (ct.includes("application/pdf")) {
      const buffer = await response.buffer();
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, buffer);
      console.error(`[download] CDP direct: ${filePath} (${buffer.length} bytes)`);
      return { filePath, size: buffer.length };
    }
  }

  // 等待浏览器下载完成
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const files = fs.readdirSync(dir);
    const partials = files.filter(f => f.endsWith(".crdownload") || f.endsWith(".tmp"));
    const pdfs = files.filter(f => f.toLowerCase().endsWith(".pdf") && !before.has(f));
    if (pdfs.length > 0 && partials.length === 0) {
      const newest = pdfs.map(f => ({ name: f, stat: fs.statSync(path.join(dir, f)) }))
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
      const filePath = path.join(dir, newest.name);
      console.error(`[download] Browser manager: ${filePath} (${newest.stat.size} bytes)`);
      return { filePath, size: newest.stat.size };
    }
  }

  throw new Error("download_failed: timed out waiting for PDF");
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: node browser-fallback.js <doi-or-url>");
    process.exit(2);
  }

  const doi = normalizeDoi(input);
  const browser = await connectBrowser();

  let page = null;
  let keepPageOpen = false;
  try {
    const articleUrl = doi ? await resolveDoi(browser, doi) : input;
    const provider = inferProvider(articleUrl);

    page = await newPage(browser);
    await page.setDefaultNavigationTimeout(120000);
    await page.goto(articleUrl, { waitUntil: "domcontentloaded" });
    await sleep(6000);

    const info = await inspectPage(page, provider);

    if (info.unavailable) {
      console.log(JSON.stringify({ status: "article_unavailable", title: info.title, url: info.currentUrl || articleUrl, article_url: articleUrl }));
      return;
    }
    if (info.humanVerification) {
      keepPageOpen = true;
      console.log(JSON.stringify({
        status: "human_verification_required",
        title: info.title,
        url: info.currentUrl || articleUrl,
        article_url: articleUrl,
        provider,
        reason: "The browser page appears to require manual verification."
      }));
      return;
    }
    if (!info.pdfUrl) {
      keepPageOpen = true;
      console.log(JSON.stringify({
        status: "no_pdf_link_found",
        title: info.title,
        url: info.currentUrl || articleUrl,
        article_url: articleUrl,
        access_mode: info.accessMode,
        provider
      }));
      return;
    }
    if (info.accessMode === "unknown") {
      keepPageOpen = true;
      console.log(JSON.stringify({
        status: "no_institutional_access",
        title: info.title,
        url: info.currentUrl || articleUrl,
        article_url: articleUrl,
        pdf_url: info.pdfUrl,
        provider
      }));
      return;
    }

    const safeId = doi
      ? `doi-${doi.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`
      : `url-${require("crypto").createHash("md5").update(articleUrl).digest("hex").slice(0, 12)}`;

    const result = await downloadPdf(page, info.pdfUrl, OUTPUT, `${safeId}.pdf`);

    console.log(JSON.stringify({
      status: "ok",
      doi,
      title: info.title,
      provider,
      pdf_path: result.filePath,
      size: result.size,
      access_mode: info.accessMode,
      institution: info.institution,
    }));

  } catch (err) {
    const status = err.message.startsWith("download_failed") ? "download_failed"
      : err.message.includes("human_verification") ? "human_verification_required"
      : err.message;
    console.log(JSON.stringify({ status, error: err.message }));
    process.exitCode = 1;
  } finally {
    if (page && !keepPageOpen) await page.close().catch(() => {});
    await browser.disconnect().catch(() => {});
  }
}

main();
