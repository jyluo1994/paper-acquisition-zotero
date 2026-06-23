#!/usr/bin/env python3
"""Acquire a paper PDF through Camoufox and emit one JSON result line."""

import asyncio
import base64
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


def print_json(payload, exit_code=0):
    print(json.dumps(payload, ensure_ascii=False), flush=True)
    raise SystemExit(exit_code)


try:
    from camoufox.async_api import AsyncCamoufox
except Exception as exc:
    print_json({
        "status": "camoufox_unavailable",
        "route": "camoufox",
        "browserEngine": "camoufox",
        "error": f"Camoufox is not installed or not ready: {exc}",
    }, 3)


OUTPUT = Path(os.environ.get("OUTPUT_DIR", "./downloads")).resolve()


def normalize_doi(raw):
    if not raw:
        return None
    match = re.search(r"10\.\d{4,9}/[A-Za-z0-9.()/_;:-]+", str(raw).strip(), re.I)
    return match.group(0).lower() if match else None


def infer_provider(url):
    try:
        host = urlparse(url).hostname or ""
    except Exception:
        return "generic"
    host = host.lower()
    if "rsna.org" in host:
        return "rsna"
    if "springer" in host or "nature" in host:
        return "springer"
    if "wiley" in host:
        return "wiley"
    if "sciencedirect" in host or "elsevier" in host:
        return "sciencedirect"
    return "generic"


def is_pdf_candidate_url(url):
    value = str(url or "")
    return bool(
        re.search(r"\.pdf(?:[?#].*)?$", value, re.I)
        or re.search(r"/doi/(?:e)?pdf/", value, re.I)
        or re.search(r"/doi/pdfdirect/", value, re.I)
        or re.search(r"/pdfft\?", value, re.I)
    )


def output_name(doi, article_url):
    if doi:
        safe = re.sub(r"[^a-z0-9]+", "-", doi.lower()).strip("-")
        return f"doi-{safe}.pdf"
    digest = hashlib.md5(article_url.encode("utf-8")).hexdigest()[:12]
    return f"url-{digest}.pdf"


def is_pdf_bytes(data):
    return data.startswith(b"%PDF-")


def normalize_proxy_server(value):
    proxy = str(value or "").strip()
    if not proxy:
        return ""
    if re.match(r"^(https?|socks4|socks5|socks5h)://", proxy, re.I):
        return proxy
    if re.match(r"^[^:/\s]+:\d+$", proxy) or re.match(r"^\[[^\]]+\]:\d+$", proxy):
        return f"http://{proxy}"
    return proxy


def truthy(value):
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


async def new_context():
    user_data_dir = Path(os.environ.get("CAMOUFOX_USER_DATA_DIR") or OUTPUT.parent / "camoufox").expanduser()
    user_data_dir.mkdir(parents=True, exist_ok=True)

    kwargs = {
        "headless": True,
        "persistent_context": True,
        "user_data_dir": str(user_data_dir),
    }

    proxy_server = normalize_proxy_server(os.environ.get("PAA_PROXY_SERVER") or os.environ.get("CHROME_PROXY_SERVER"))
    if proxy_server:
        proxy = {"server": proxy_server}
        username = os.environ.get("PAA_PROXY_USERNAME") or os.environ.get("CHROME_PROXY_USERNAME") or ""
        password = os.environ.get("PAA_PROXY_PASSWORD") or os.environ.get("CHROME_PROXY_PASSWORD") or ""
        if username or password:
            proxy["username"] = username
            proxy["password"] = password
        kwargs["proxy"] = proxy

    if truthy(os.environ.get("PAA_CAMOUFOX_GEOIP")):
        kwargs["geoip"] = True
    if truthy(os.environ.get("PAA_CAMOUFOX_HUMANIZE")):
        kwargs["humanize"] = True

    return AsyncCamoufox(**kwargs)


async def apply_cookie_jar(context):
    jar_path = os.environ.get("PAA_COOKIE_JAR", "").strip()
    if not jar_path:
        return
    try:
        data = json.loads(Path(jar_path).read_text("utf-8"))
        cookies = data.get("cookies") if isinstance(data, dict) else []
        if cookies:
            await context.add_cookies(cookies)
            print(f"[cookies] Applied {len(cookies)} allowlisted cookies.", file=sys.stderr)
    except Exception as exc:
        print(f"[cookies] Could not apply allowlisted cookies: {exc}", file=sys.stderr)


async def resolve_doi(context, doi):
    page = await context.new_page()
    page.set_default_navigation_timeout(120000)
    await page.goto(f"https://doi.org/{doi}", wait_until="domcontentloaded")
    await page.wait_for_timeout(5000)
    url = page.url
    await page.close()
    print(f"[resolve] {doi} -> {url}", file=sys.stderr)
    return url


async def wait_for_article_ready(page, provider):
    selectors = ",".join([
        'a[href*="/doi/pdf/"]',
        'a[href*="/doi/epdf/"]',
        'a[href*="/doi/pdfdirect/"]',
        'a[href$=".pdf"]',
        'iframe[src*=".pdf"], embed[src*=".pdf"], object[data*=".pdf"]',
    ])
    timeout = 15000 if provider == "rsna" else 8000
    try:
        await page.wait_for_selector(selectors, timeout=timeout)
    except Exception:
        await page.wait_for_timeout(3000)


def is_human_verification_page(body, title, url):
    text = f"{title or ''}\n{url or ''}\n{body or ''}".lower()
    needles = [
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
        "there was a problem providing the content you requested",
        "please contact our support team for more information",
        "cpe00001",
        "automated access has been blocked",
        "automated access is temporarily blocked",
    ]
    return any(needle in text for needle in needles)


async def inspect_page(page, provider):
    info = {
        "title": None,
        "pdfUrl": None,
        "accessMode": "unknown",
        "institution": None,
        "unavailable": False,
        "humanVerification": False,
        "currentUrl": page.url,
    }
    try:
        info["title"] = await page.title()
        body = await page.evaluate("() => document.body?.innerText || ''")
        info["unavailable"] = bool(re.search(r"page not found|does not exist|moved|looking for does not exist", body, re.I))
        if re.search(r"open access", body, re.I):
            info["accessMode"] = "open_access"
        elif re.search(r"access provided by", body, re.I):
            info["accessMode"] = "institutional"
        match = re.search(r"access provided by\s+([^\n]+)", body, re.I)
        if match:
            info["institution"] = match.group(1).strip()
    except Exception:
        body = ""

    info["pdfUrl"] = await page.evaluate(
        """(prov) => {
          const absolutize = (value) => {
            try { return new URL(value, document.baseURI).href; }
            catch { return value || ""; }
          };
          const links = Array.from(document.querySelectorAll("a[href]")).map(a => ({
            text: (a.innerText || a.getAttribute("aria-label") || a.getAttribute("title") || "").trim().toLowerCase(),
            href: absolutize(a.getAttribute("href") || a.href)
          }));
          const iframes = Array.from(document.querySelectorAll("iframe[src], embed[src], object[data]"))
            .map(el => absolutize(el.getAttribute("src") || el.getAttribute("data") || ""));
          const all = [...links.map(l => l.href), ...iframes];
          const patterns = {
            springer: [/\\/content\\/pdf\\//i, /download.*pdf/i],
            wiley: [/\\/doi\\/pdf\\//i, /\\/doi\\/epdf\\//i, /\\/doi\\/pdfdirect\\//i, /\\.pdf(\\?|$)/i],
            sciencedirect: [/\\/pdfft\\?/i, /view.*pdf/i],
            rsna: [/\\/doi\\/pdf\\//i, /\\/doi\\/epdf\\//i, /\\.pdf(\\?|#|$)/i],
            generic: [/\\.pdf(\\?|#|$)/i, /\\/doi\\/pdf\\//i, /\\/doi\\/epdf\\//i, /\\/doi\\/pdfdirect\\//i, /\\/pdf(?:[/?#]|$)/i, /download.*pdf/i],
          };
          const pats = patterns[prov] || patterns.generic;
          const textPatterns = [/\\bpdf\\b/i, /full\\s+text\\s+pdf/i, /download\\s+pdf/i, /view\\s+pdf/i];
          for (const l of links) {
            if (textPatterns.some(p => p.test(l.text))) return l.href;
          }
          for (const href of all) {
            if (pats.some(p => p.test(href))) return href;
          }
          return null;
        }""",
        provider,
    )

    if not info["pdfUrl"]:
        try:
            body = await page.evaluate("() => document.body?.innerText || ''")
            info["humanVerification"] = is_human_verification_page(body, info["title"], info["currentUrl"])
        except Exception:
            pass
    return info


async def fetch_pdf_in_page(page, pdf_url):
    result = await page.evaluate(
        """async (url) => {
          const response = await fetch(url, { credentials: "include" });
          const contentType = (response.headers.get("content-type") || "").toLowerCase();
          const arrayBuffer = await response.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
            bytes[3] === 0x46 && bytes[4] === 0x2d;
          if (!response.ok || !isPdf) {
            return { ok: false, status: response.status, contentType, size: bytes.byteLength };
          }
          let binary = "";
          const chunkSize = 0x8000;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
          }
          return { ok: true, contentType, size: bytes.byteLength, base64: btoa(binary) };
        }""",
        pdf_url,
    )
    if not result or not result.get("ok") or not result.get("base64"):
        return None
    return base64.b64decode(result["base64"])


async def download_pdf(page, pdf_url, name):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    response = None
    try:
        response = await page.goto(pdf_url, wait_until="domcontentloaded")
    except Exception:
        pass
    if response:
        content_type = (response.headers.get("content-type") or "").lower()
        if "application/pdf" in content_type:
            data = await response.body()
            if is_pdf_bytes(data):
                path = OUTPUT / name
                path.write_bytes(data)
                print(f"[download] Direct: {path} ({len(data)} bytes)", file=sys.stderr)
                return str(path), len(data)

    data = await fetch_pdf_in_page(page, pdf_url)
    if data and is_pdf_bytes(data):
        path = OUTPUT / name
        path.write_bytes(data)
        print(f"[download] Page fetch: {path} ({len(data)} bytes)", file=sys.stderr)
        return str(path), len(data)

    raise RuntimeError("download_failed: timed out waiting for PDF")


async def acquire(identifier):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    input_is_url = bool(re.match(r"^https?://", identifier, re.I))
    doi = None if input_is_url else normalize_doi(identifier)
    provider = "generic"
    page = None
    info = None
    article_url = ""

    async with await new_context() as context:
        await apply_cookie_jar(context)
        try:
            article_url = await resolve_doi(context, doi) if doi else identifier
            page = await context.new_page()
            page.set_default_navigation_timeout(120000)

            if is_pdf_candidate_url(article_url):
                provider = infer_provider(article_url)
                pdf_path, size = await download_pdf(page, article_url, output_name(doi, article_url))
                return {
                    "status": "ok",
                    "route": "camoufox",
                    "browserEngine": "camoufox",
                    "doi": doi,
                    "title": "",
                    "provider": provider,
                    "pdf_path": pdf_path,
                    "size": size,
                    "access_mode": "direct_pdf",
                }

            await page.goto(article_url, wait_until="domcontentloaded")
            provider = infer_provider(page.url or article_url)
            await wait_for_article_ready(page, provider)
            provider = infer_provider(page.url or article_url)
            info = await inspect_page(page, provider)
            print(
                f"[inspect] provider={provider} access={info['accessMode']} pdf={info['pdfUrl'] or ''} url={info['currentUrl'] or article_url}",
                file=sys.stderr,
            )

            if info["unavailable"] and not info["pdfUrl"]:
                return {
                    "status": "article_unavailable",
                    "route": "camoufox",
                    "browserEngine": "camoufox",
                    "title": info["title"],
                    "url": info["currentUrl"] or article_url,
                    "article_url": article_url,
                }
            if not info["pdfUrl"]:
                return {
                    "status": "human_verification_required" if info["humanVerification"] else "no_pdf_link_found",
                    "route": "camoufox",
                    "browserEngine": "camoufox",
                    "title": info["title"],
                    "url": info["currentUrl"] or article_url,
                    "article_url": article_url,
                    "provider": provider,
                    "access_mode": info["accessMode"],
                    "reason": "The Camoufox page appears to require manual verification." if info["humanVerification"] else "",
                }

            pdf_path, size = await download_pdf(page, info["pdfUrl"], output_name(doi, article_url))
            return {
                "status": "ok",
                "route": "camoufox",
                "browserEngine": "camoufox",
                "doi": doi,
                "title": info["title"],
                "provider": provider,
                "pdf_path": pdf_path,
                "size": size,
                "access_mode": info["accessMode"],
                "institution": info["institution"],
            }
        except Exception as exc:
            return {
                "status": "download_failed" if str(exc).startswith("download_failed") else "failed",
                "route": "camoufox",
                "browserEngine": "camoufox",
                "error": str(exc),
                "title": info and info.get("title"),
                "url": page.url if page else article_url,
                "article_url": article_url,
                "pdf_url": info and info.get("pdfUrl"),
                "provider": provider,
                "access_mode": info and info.get("accessMode"),
            }
        finally:
            if page:
                await page.close()


def main():
    identifier = sys.argv[1].strip() if len(sys.argv) > 1 else ""
    if not identifier:
        print_json({"status": "failed", "route": "camoufox", "error": "Usage: camoufox-acquire.py <doi-or-url>"}, 2)
    result = asyncio.run(acquire(identifier))
    print(json.dumps(result, ensure_ascii=False), flush=True)
    if result.get("status") == "ok":
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
