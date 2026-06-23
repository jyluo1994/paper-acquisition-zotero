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
```

Then click `Start service`, or enable `Start the local service automatically when needed`.

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

## Automatic Acquisition

Automatic acquisition is off by default. Enable it in the plugin settings only after confirming the manual right-click flow works.

The automatic flow listens for newly added regular Zotero items, waits for the configured delay, then checks whether a PDF attachment already exists before enqueueing a job. This delay helps avoid conflicts with Zotero's built-in associated-file download or other PDF-acquisition plugins. If `Pause automatic acquisition while Zotero's built-in associated-file download is enabled` is on and Zotero's `downloadAssociatedFiles` preference is enabled, automatic acquisition stays paused.

## Security Boundary

The Zotero plugin must not store raw cookies, proxy passwords, SSO tokens, or request headers. Zotero receives only:

- item metadata
- job status
- final local PDF path
- non-sensitive route/provider metadata
