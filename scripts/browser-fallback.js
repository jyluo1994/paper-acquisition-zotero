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
 *   PAA_BROWSER_MODE background（默认，headless）| existing（复用已打开浏览器）| visible
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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
  let h = "";
  try {
    h = new URL(url).hostname.toLowerCase();
  }
  catch {
    return "generic";
  }
  if (h.includes("rsna.org")) return "rsna";
  if (h.includes("springer") || h.includes("nature")) return "springer";
  if (h.includes("wiley")) return "wiley";
  if (h.includes("sciencedirect") || h.includes("elsevier")) return "sciencedirect";
  return "generic";
}

async function connectBrowser() {
  const proxyServer = normalizeProxyServer(process.env.PAA_PROXY_SERVER || process.env.CHROME_PROXY_SERVER || "");
  const proxyBypassList = String(process.env.PAA_PROXY_BYPASS_LIST || process.env.CHROME_PROXY_BYPASS_LIST || "").trim();
  const proxyAuth = proxyAuthCredentials();
  const browserMode = String(process.env.PAA_BROWSER_MODE || "background").trim().toLowerCase();
  const preferExisting = truthy(process.env.PAA_USE_EXISTING_BROWSER) ||
    ["existing", "visible", "foreground"].includes(browserMode);
  const visibleLaunch = ["visible", "foreground"].includes(browserMode);

  if (preferExisting) {
    const existing = await connectExistingBrowser(proxyServer, proxyAuth);
    if (existing) return existing;
    console.error(`[connect] No browser at ${BROWSER_URL}, trying to launch...`);
  }

  // 如果指定了 CHROME_BIN，自动启动一个
  const chromeBin = process.env.CHROME_BIN;
  if (chromeBin && fs.existsSync(chromeBin)) {
    const userDataDir = browserUserDataDir(visibleLaunch || preferExisting);
    fs.mkdirSync(userDataDir, { recursive: true });

    const chromeArgs = [
      "--no-first-run",
      "--no-default-browser-check",
    ];
    if (visibleLaunch) {
      chromeArgs.push(`--remote-debugging-port=${CDP_PORT}`);
    }
    if (process.env.CHROME_PROFILE_DIRECTORY) {
      chromeArgs.push(`--profile-directory=${process.env.CHROME_PROFILE_DIRECTORY}`);
    }
    if (proxyServer) {
      chromeArgs.push(`--proxy-server=${proxyServer}`);
    }
    if (proxyBypassList) {
      chromeArgs.push(`--proxy-bypass-list=${proxyBypassList}`);
    }
    console.error(proxyServer
      ? "[connect] Launching Chrome with command-line proxy."
      : "[connect] Launching Chrome without command-line proxy; browser profile may manage proxy."
    );
    try {
      const browser = await puppeteer.launch({
        executablePath: chromeBin,
        headless: !visibleLaunch,
        userDataDir,
        args: visibleLaunch ? [...chromeArgs, "--new-window", "about:blank"] : chromeArgs,
        defaultViewport: null
      });
      console.error(visibleLaunch
        ? `[connect] Launched visible Chrome at port ${CDP_PORT}`
        : "[connect] Launched headless Chrome for background acquisition."
      );
      return { browser, closeOnDone: true, headless: !visibleLaunch };
    }
    catch (err) {
      throw err;
    }
  }

  if (preferExisting) {
    const existing = await connectExistingBrowser(proxyServer, proxyAuth);
    if (existing) return existing;
  }

  throw new Error(
    "No browser available. Start Chrome with:\n" +
    "  google-chrome --remote-debugging-port=9222 --user-data-dir=$HOME/.openclaw/browser-clone\n" +
    "Or set CHROME_BIN env var for auto-launch."
  );
}

function browserUserDataDir(useVisibleProfile) {
  const configured = process.env.CHROME_USER_DATA_DIR
    ? path.resolve(process.env.CHROME_USER_DATA_DIR.replace(/^~(?=$|\/)/, process.env.HOME || ""))
    : path.join(OUTPUT, "..", ".browser-profile");
  if (useVisibleProfile) return configured;

  const background = process.env.PAA_BACKGROUND_USER_DATA_DIR
    ? path.resolve(process.env.PAA_BACKGROUND_USER_DATA_DIR.replace(/^~(?=$|\/)/, process.env.HOME || ""))
    : path.join(path.dirname(configured), "headless");
  return background;
}

async function connectExistingBrowser(proxyServer, proxyAuth) {
  try {
    const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
    console.error(`[connect] Connected to existing browser at ${BROWSER_URL}`);
    if (proxyServer) {
      console.error("[connect] Proxy setting is only applied when launching a new browser.");
    }
    if (proxyAuth) {
      console.error("[connect] Proxy authentication will be applied to new pages.");
    }
    return { browser, closeOnDone: false, headless: false };
  }
  catch {
    return null;
  }
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
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
    info.accessMode = /open access/i.test(body) ? "open_access" : /access provided by/i.test(body) ? "institutional" : "unknown";
    const inst = body.match(/access provided by\s+([^\n]+)/i);
    if (inst) info.institution = inst[1].trim();
  } catch {}

  // 查找 PDF 链接
  info.pdfUrl = await page.evaluate((prov) => {
    const absolutize = (value) => {
      try {
        return new URL(value, document.baseURI).href;
      }
      catch {
        return value || "";
      }
    };
    const links = Array.from(document.querySelectorAll("a[href]")).map(a => ({
      text: (a.innerText || "").trim().toLowerCase(),
      href: absolutize(a.getAttribute("href") || a.href)
    }));

    const iframes = Array.from(document.querySelectorAll("iframe[src], embed[src], object[data]"))
      .map(el => absolutize(el.getAttribute("src") || el.getAttribute("data") || ""));

    const all = [...links.map(l => l.href), ...iframes];

    // 按出版商匹配
    const patterns = {
      springer: [/\/content\/pdf\//i, /download.*pdf/i],
      wiley: [/\/doi\/pdf\//i, /\/doi\/epdf\//i, /\/doi\/pdfdirect\//i, /\.pdf(\?|$)/i],
      sciencedirect: [/\/pdfft\?/i, /view.*pdf/i],
      rsna: [/\/doi\/pdf\//i, /\/doi\/epdf\//i, /\.pdf(\?|#|$)/i],
      generic: [/\.pdf(\?|#|$)/i, /\/doi\/pdf\//i, /\/doi\/epdf\//i, /\/doi\/pdfdirect\//i, /\/pdf(?:[/?#]|$)/i, /download.*pdf/i],
    };
    const pats = patterns[prov] || patterns.generic;
    const textPatterns = [/\bpdf\b/i, /full\s+text\s+pdf/i, /download\s+pdf/i, /view\s+pdf/i];

    // 1. 按链接文本匹配
    for (const l of links) {
      if (textPatterns.some(p => p.test(l.text))) return l.href;
    }
    // 2. 按 href 匹配
    for (const href of all) {
      if (pats.some(p => p.test(href))) return href;
    }
    return null;
  }, provider);

  if (!info.pdfUrl) {
    try {
      const body = await page.evaluate(() => document.body?.innerText || "");
      info.humanVerification = isHumanVerificationPage(body, info.title, info.currentUrl);
    } catch {}
  }

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
    "automated access has been blocked",
    "automated access is temporarily blocked"
  ].some((needle) => text.includes(needle));
}

function isPDFCandidateURL(url) {
  const value = String(url || "");
  return /\.pdf(?:[?#].*)?$/i.test(value) ||
    /\/doi\/(?:e)?pdf\//i.test(value) ||
    /\/doi\/pdfdirect\//i.test(value) ||
    /\/pdfft\?/i.test(value);
}

function outputName(doi, articleUrl) {
  if (doi) {
    return `doi-${doi.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}.pdf`;
  }
  return `url-${crypto.createHash("md5").update(articleUrl).digest("hex").slice(0, 12)}.pdf`;
}

async function downloadPdf(page, pdfUrl, dir, name, depth = 0) {
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
      if (isPDFBuffer(buffer)) {
        const filePath = path.join(dir, name);
        fs.writeFileSync(filePath, buffer);
        console.error(`[download] CDP direct: ${filePath} (${buffer.length} bytes)`);
        return { filePath, size: buffer.length };
      }
      console.error(`[download] Ignoring non-PDF Chrome viewer response (${buffer.length} bytes).`);
    }
  }

  const fetched = await fetchPdfInPage(page, pdfUrl);
  if (fetched) {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, fetched.buffer);
    console.error(`[download] Page fetch: ${filePath} (${fetched.buffer.length} bytes)`);
    return { filePath, size: fetched.buffer.length };
  }

  if (depth < 2) {
    await page.waitForSelector('a[href*="/doi/pdf/"]', { timeout: 10000 }).catch(() => {});
    const directUrl = await findPDFDownloadURL(page, pdfUrl);
    if (directUrl && directUrl !== pdfUrl) {
      console.error(`[download] Found nested PDF download URL: ${directUrl}`);
      return await downloadPdf(page, directUrl, dir, name, depth + 1);
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

function isPDFBuffer(buffer) {
  return Buffer.isBuffer(buffer) &&
    buffer.length >= 5 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d;
}

async function fetchPdfInPage(page, pdfUrl) {
  try {
    const result = await page.evaluate(async (url) => {
      const response = await fetch(url, { credentials: "include" });
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      const arrayBuffer = await response.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const isPdf = bytes[0] === 0x25 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x44 &&
        bytes[3] === 0x46 &&
        bytes[4] === 0x2d;
      if (!response.ok || !isPdf) {
        return {
          ok: false,
          status: response.status,
          contentType,
          size: bytes.byteLength
        };
      }

      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      return {
        ok: true,
        contentType,
        size: bytes.byteLength,
        base64: btoa(binary)
      };
    }, pdfUrl);

    if (!result || !result.ok || !result.base64) return null;
    return { buffer: Buffer.from(result.base64, "base64"), contentType: result.contentType };
  }
  catch {
    return null;
  }
}

async function findPDFDownloadURL(page, currentUrl) {
  try {
    return await page.evaluate((current) => {
      const absolutize = (value) => {
        try {
          return new URL(value, document.baseURI).href;
        }
        catch {
          return value || "";
        }
      };
      const links = Array.from(document.querySelectorAll("a[href]")).map((a) => ({
        text: (a.innerText || a.getAttribute("aria-label") || a.getAttribute("title") || "").trim().toLowerCase(),
        href: absolutize(a.getAttribute("href") || a.href)
      }));
      const preferred = links.find((link) => /\/doi\/pdf\//i.test(link.href) && /[?&]download=true/i.test(link.href));
      if (preferred) return preferred.href;
      const pdfLink = links.find((link) => /\/doi\/pdf\//i.test(link.href) && link.href !== current);
      if (pdfLink) return pdfLink.href;
      const textDownload = links.find((link) => /download|pdf|get_app/i.test(`${link.text} ${link.href}`) && link.href !== current);
      return textDownload ? textDownload.href : "";
    }, currentUrl);
  }
  catch {
    return "";
  }
}

async function main() {
  const input = String(process.argv[2] || "").trim();
  if (!input) {
    console.error("Usage: node browser-fallback.js <doi-or-url>");
    process.exit(2);
  }

  const inputIsURL = /^https?:\/\//i.test(input);
  const doi = inputIsURL ? null : normalizeDoi(input);
  const connection = await connectBrowser();
  const browser = connection.browser;

  let page = null;
  let keepPageOpen = false;
  let articleUrl = "";
  let provider = "generic";
  let info = null;
  try {
    articleUrl = doi ? await resolveDoi(browser, doi) : input;
    page = await newPage(browser);

    if (isPDFCandidateURL(articleUrl)) {
      provider = inferProvider(articleUrl);
      const result = await downloadPdf(page, articleUrl, OUTPUT, outputName(doi, articleUrl));
      console.log(JSON.stringify({
        status: "ok",
        doi,
        title: "",
        provider,
        pdf_path: result.filePath,
        size: result.size,
        access_mode: "direct_pdf"
      }));
      return;
    }

    await page.setDefaultNavigationTimeout(120000);
    await page.goto(articleUrl, { waitUntil: "domcontentloaded" });
    provider = inferProvider(page.url() || articleUrl);
    await waitForArticleReady(page, provider);

    provider = inferProvider(page.url() || articleUrl);
    info = await inspectPage(page, provider);
    console.error(`[inspect] provider=${provider} access=${info.accessMode} pdf=${info.pdfUrl || ""} url=${info.currentUrl || articleUrl}`);

    if (info.unavailable && !info.pdfUrl) {
      console.log(JSON.stringify({ status: "article_unavailable", title: info.title, url: info.currentUrl || articleUrl, article_url: articleUrl }));
      return;
    }
    if (!info.pdfUrl) {
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
    const result = await downloadPdf(page, info.pdfUrl, OUTPUT, outputName(doi, articleUrl));

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
    if (status === "download_failed") {
      keepPageOpen = true;
    }
    console.log(JSON.stringify({
      status,
      error: err.message,
      title: info && info.title,
      url: page ? page.url() : articleUrl,
      article_url: articleUrl,
      pdf_url: info && info.pdfUrl,
      provider,
      access_mode: info && info.accessMode
    }));
    process.exitCode = 1;
  } finally {
    if (page && (!keepPageOpen || connection.closeOnDone)) await page.close().catch(() => {});
    if (connection.closeOnDone) {
      await browser.close().catch(() => {});
    }
    else {
      await browser.disconnect().catch(() => {});
    }
  }
}

async function waitForArticleReady(page, provider) {
  const selectors = [
    'a[href*="/doi/pdf/"]',
    'a[href*="/doi/epdf/"]',
    'a[href*="/doi/pdfdirect/"]',
    'a[href$=".pdf"]',
    'iframe[src*=".pdf"], embed[src*=".pdf"], object[data*=".pdf"]'
  ];
  const timeout = provider === "rsna" ? 15000 : 8000;
  try {
    await page.waitForSelector(selectors.join(","), { timeout });
  }
  catch {
    await sleep(3000);
  }
}

main();
