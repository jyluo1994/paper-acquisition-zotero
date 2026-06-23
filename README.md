# Paper Acquisition Zotero

Standalone Zotero plugin plus local helper service for acquiring PDFs from selected Zotero items.

This repository was split out from `jyluo1994/paper-acquisition-anti-scrape` so the Zotero integration can be developed and released independently.

## What It Provides

- Zotero context-menu command for one or more selected items
- Zotero settings pane: `Tools -> Paper Acquisition 设置...`
- Progress window showing the item currently being processed
- Queueing and duplicate prevention
- Optional auto-acquisition for newly imported regular items
- Optional local service auto-start from Zotero
- Institutional profile support, including external browser profile reuse
- Optional Camoufox background acquisition before Chrome fallback
- Optional allowlisted cookie sync from the visible login browser to one background acquisition job
- Human-in-the-loop confirmation for login, CAPTCHA, and publisher verification pages

The Zotero plugin does not store institutional cookies, SSO tokens, or request headers. Browser profiles and cookies stay outside Zotero. If cookie sync is enabled, the local service copies only allowlisted-domain cookies from the visible login browser into a temporary per-job cookie file, then deletes it after the job. If proxy credentials are configured, they are stored as normal Zotero preferences; prefer the separate username/password fields over embedding credentials in the proxy URL.

## Install

Install dependencies:

```bash
npm install
```

Build the XPI:

```bash
npm run build
```

The XPI is written to:

```text
dist/paper-acquisition-zotero.xpi
```

Install it in Zotero:

```text
Tools -> Add-ons -> Install Add-on From File...
```

## Configure In Zotero

Open:

```text
Tools -> Paper Acquisition 设置...
```

Recommended settings:

```text
Service directory: /path/to/paper-acquisition-zotero
Start command: npm start
Default profile: your-local-profile
Browser engine: chrome-first
Cookie sync domains: optional, comma-separated
Proxy mode: profile
Acquisition proxy: optional
Proxy username: optional
Proxy password: optional
```

Enable `Start the local service automatically when needed` if you want Zotero to start the helper service for you.

`Proxy mode` controls where proxy routing happens. Use `profile` to read proxy settings from the local service profile. Use `browser-profile` when a Chrome profile or extension such as ZeroOmega manages routing. Use `local` when the plugin should inject `Acquisition proxy` from Zotero settings into the helper browser. None of these modes change macOS system proxy settings.

Proxy username/password are optional and are stored as Zotero preferences. Prefer a localhost proxy that already handles remote-node credentials when possible.

Automatic acquisition is off by default. Enable it only after manual right-click acquisition works. The automatic queue waits before starting and checks again for existing PDF attachments, so Zotero's built-in associated-file download and other PDF plugins get a chance to finish first.

## Camoufox

Camoufox is optional. `Browser engine` supports `chrome-first`, `chrome`, `camoufox`, and `auto`. The recommended `chrome-first` mode tries the existing Chrome backend first, then escalates to Camoufox only when Chrome hits a likely anti-bot or browser-download failure. `auto` currently behaves like `chrome-first`; `camoufox` keeps the Camoufox-first behavior for difficult publishers.

Install Camoufox following the official Python installation flow:

```bash
pip install -U camoufox[geoip]
python3 -m camoufox fetch
```

To keep dependencies local to this repository, you can also install it in
`.venv`; the service automatically prefers `.venv/bin/python` when it exists:

```bash
python3 -m venv .venv
.venv/bin/pip install -U camoufox[geoip]
.venv/bin/python -m camoufox fetch
```

The `geoip` extra is optional but useful with proxies. Set `PAA_CAMOUFOX_GEOIP=1` if you want the service to ask Camoufox to match geolocation metadata to the proxy IP.

## Manual Service

You can also start the service yourself:

```bash
npm start
```

Health check:

```bash
curl http://127.0.0.1:24372/health
```

## Profiles

Copy the example profile config for local customization:

```bash
cp service/profiles.example.json service/profiles.json
```

`service/profiles.json` is ignored by git.

Keep institution-specific profile names, login URLs, proxy notes, and browser
profile details in your local `service/profiles.json`.

Use `Refresh login profile` to open the acquisition browser profile and log in
to publisher, institutional, WebVPN, or SSO pages. These browser cookies are
stored outside Zotero under the local acquisition browser profile. When using
`browser-profile` mode, Chrome profile settings and extensions handle the proxy
route. When using `local` mode, copy the proxy host, port, username, and
password into the plugin settings or into local service configuration instead.

`Cookie sync domains` is an advanced opt-in setting. Enter only domains where
you want the background browser to receive login cookies, for example
`example.edu,publisher.com`. Cookie values are not logged or returned to Zotero.
If the visible login browser is closed or the allowlist has no matching cookies,
the acquisition continues without synced cookies.

If acquisition hits a publisher verification page, CAPTCHA, missing PDF link,
or institutional login wall during manual right-click acquisition, Zotero opens
the acquisition browser profile and asks you to complete the page manually.
After you click OK in Zotero, the same item is retried once.

## Development

Run checks:

```bash
npm run check
xmllint --noout zotero-plugin/preferences.xhtml
```

Build:

```bash
npm run build
```

The Zotero add-on ID intentionally remains:

```text
paper-acquisition-anti-scrape@jyluo1994.github.io
```

Keeping the ID stable lets Zotero upgrade existing installations instead of installing a duplicate add-on.
