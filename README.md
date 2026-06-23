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

The Zotero plugin does not store institutional cookies, proxy passwords, SSO tokens, or request headers. Browser profiles and cookies stay outside Zotero.

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
```

Enable `Start the local service automatically when needed` if you want Zotero to start the helper service for you.

Automatic acquisition is off by default. Enable it only after manual right-click acquisition works. The automatic queue waits before starting and checks again for existing PDF attachments, so Zotero's built-in associated-file download and other PDF plugins get a chance to finish first.

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
