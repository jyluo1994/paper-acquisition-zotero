# Zotero Plugin Integration

This repository now includes a Zotero plugin MVP for Zotero 7 through 10 plus a local helper service.

## What Works In This MVP

- Adds a Zotero item context-menu command: `Acquire PDF via Paper Acquisition`.
- Adds profile-specific commands:
  - `Acquire PDF using profile...`
  - `Refresh institution login profile...`
- Adds a `Paper Acquisition` Zotero settings pane.
- Adds a Zotero Tools menu shortcut to the settings pane.
- Supports queued manual acquisition for one or more selected items.
- Shows a Zotero progress window with the current item title and final status.
- Optionally auto-acquires PDFs for newly added regular items.
- Avoids duplicate work by skipping items that already have PDFs, already have active/queued jobs, or are tagged as already acquired/acquiring.
- Can pause automatic acquisition while Zotero's built-in associated-file download is enabled.
- Can optionally start the local service from a configured working directory and shell command.
- Can pause manual acquisition for human verification, open the acquisition
  browser profile, then retry after the user confirms completion.
- Sends selected Zotero item metadata to `http://127.0.0.1:24372/api/acquire`.
- Polls the local job endpoint.
- Imports a returned local PDF path as a child attachment.
- Writes non-sensitive status tags:
  - `pdf:acquiring`
  - `pdf:acquired`
  - `pdf:login-required`
  - `pdf:cooldown`
  - `pdf:captcha-stop`
  - `pdf:failed`
  - `pdf:missing-metadata`
- Keeps institutional cookies outside Zotero.

## Start The Local Service

From the Zotero settings pane:

```text
Tools -> Paper Acquisition 设置...
```

Set:

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

Then click `Start service`, or enable `Start the local service automatically when needed`.

`Proxy mode` controls whether proxy routing is owned by the local service
profile, browser profile, or plugin settings. Use `profile` to read proxy
settings from `service/profiles.json`. Use `browser-profile` for
Chrome/ZeroOmega-managed browser routes. Use `local` when the plugin should
inject `Acquisition proxy` from Zotero settings into the helper browser.
Proxy username/password in Zotero settings are stored as Zotero preferences.

`Browser engine` can be `chrome-first`, `chrome`, `camoufox`, or `auto`.
`chrome-first` is recommended: it tries the existing Chrome backend first, then
escalates to Camoufox only when Chrome hits a likely anti-bot or
browser-download failure. `auto` currently behaves like `chrome-first`;
`camoufox` keeps the Camoufox-first behavior for difficult publishers.
Install Camoufox with:

```bash
pip install -U camoufox[geoip]
python3 -m camoufox fetch
```

For a repository-local install, use `.venv`; the service automatically prefers
`.venv/bin/python` when it exists:

```bash
python3 -m venv .venv
.venv/bin/pip install -U camoufox[geoip]
.venv/bin/python -m camoufox fetch
```

`Cookie sync domains` is advanced and opt-in. The service copies only matching
domain cookies from the visible login browser into a temporary per-job file,
applies them to the background browser, and deletes the file after the job.
Cookie values are not logged or returned to Zotero.

Manual terminal startup still works:

```bash
npm start
```

Health check:

```bash
curl http://127.0.0.1:24372/health
```

List configured institutional profiles:

```bash
curl http://127.0.0.1:24372/api/profiles
```

To customize local-only profiles, copy `service/profiles.example.json` to `service/profiles.json`. The local file is ignored by git.

The service wraps the existing browser fallback script:

```text
scripts/browser-fallback.js
```

Optionally configure a fast command that runs before browser fallback:

```bash
PAA_FAST_COMMAND='scansci-pdf download --strategy fastest --output-dir {downloadDir} {identifier}' \
  npm start
```

Supported placeholders:

- `{identifier}`
- `{doi}`
- `{url}`
- `{title}`
- `{profile}`
- `{downloadDir}`

The command should print a JSON line with either `{"status":"ok","pdf_path":"/path/to/file.pdf"}` or a controlled failure status such as `paywall`, `login_required`, `human_verification_required`, or `cooldown`.

Downloaded PDFs default to:

```text
~/.paper-acquisition/downloads
```

## Build The Zotero XPI

```bash
bash scripts/build-zotero-plugin.sh
```

Output:

```text
dist/paper-acquisition-zotero.xpi
```

Install in Zotero:

```text
Tools -> Add-ons -> Install Add-on From File...
```

## Institution Sessions

From the Zotero settings pane, click `Refresh login profile` after choosing the default profile.

Use the login endpoint to start a dedicated browser profile:

```bash
curl -X POST http://127.0.0.1:24372/api/login/sysu-webvpn \
  -H 'Content-Type: application/json' \
  -d '{"loginUrl":"about:blank"}'
```

Profiles are stored under:

```text
~/.paper-acquisition/profiles
```

Use separate local profile names for separate institutional routes. Keep
institution-specific profile names, login URLs, proxy notes, and browser profile
details in `service/profiles.json`, and do not export or commit browser profile
directories.

Use `Refresh login profile` to open the acquisition browser profile and log in
to publisher, institutional, WebVPN, or SSO pages. These cookies are stored in
the acquisition browser profile, not in Zotero item data.

For Chrome/ZeroOmega routes, use `browser-profile` mode so the browser profile
continues to manage proxy routing and credentials. For a direct helper-browser
proxy, use `local` mode and put the proxy host, port, username, and password in
the plugin settings or local `service/profiles.json`.

## Human Verification Flow

Manual right-click acquisition can stop and ask for human action when the
browser fallback detects a CAPTCHA, human verification page, institutional
login wall, missing PDF link, or publisher confirmation page. The browser tab
is left open when possible. Zotero then asks you to complete the page manually
and click OK to retry the same item once.

The plugin does not automate CAPTCHA solving or bypass publisher protections;
it only provides a human-in-the-loop pause and retry.

## Automatic Acquisition

Automatic acquisition is off by default. Enable it in the plugin settings only after confirming the manual right-click flow works.

The automatic flow listens for newly added regular Zotero items, waits for the configured delay, then checks whether a PDF attachment already exists before enqueueing a job. This delay helps avoid conflicts with Zotero's built-in associated-file download or other PDF-acquisition plugins. If `Pause automatic acquisition while Zotero's built-in associated-file download is enabled` is on and Zotero's `downloadAssociatedFiles` preference is enabled, automatic acquisition stays paused.

## Proxy Modes

`profile` is the default. In this mode, the plugin does not send proxy
credentials and the service reads proxy settings from the selected local
profile.

`browser-profile` mode tells the service not to pass
`--proxy-server` to Chrome; proxy routing is handled by the Chrome profile,
including extensions such as ZeroOmega.

`local` mode is scoped to this plugin's PDF acquisition flow. It sends
`Acquisition proxy` with `/api/acquire` and `/api/login` requests and injects
it into the helper browser.

Accepted examples:

```text
127.0.0.1:7890
http://127.0.0.1:7890
socks5://127.0.0.1:1080
```

The service converts bare `host:port` values to `http://host:port` before
launching Chrome. This does not change system proxy settings. HTTP proxy
username/password are passed to the browser fallback with Puppeteer page
authentication.

## Security Boundary

The Zotero plugin must not store raw cookies, SSO tokens, or request headers.
Cookie sync, when enabled, is performed by the local service through a
temporary allowlisted per-job file that is deleted after acquisition. Proxy
username/password are stored as normal Zotero preferences if configured.
Zotero receives only:

- item metadata
- job status
- final local PDF path
- non-sensitive route/provider metadata
