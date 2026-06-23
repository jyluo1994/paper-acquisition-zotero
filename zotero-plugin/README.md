# Zotero Plugin

This directory contains a Zotero plugin for Zotero 7 through 10 that adds right-click commands to Zotero items:

```text
获取 PDF (Paper Acquisition)
获取 PDF（选择机构配置）...
刷新机构登录配置...
Paper Acquisition 设置...
```

The plugin does not store institutional cookies, proxy credentials, or browser sessions in Zotero. It sends item metadata to a local service bound to `127.0.0.1`, waits for the service to acquire the PDF, and imports the returned local PDF path as a child attachment.

The plugin also registers a Zotero settings pane named `Paper Acquisition`. Use it to configure:

- local service URL
- optional service auto-start command
- default institutional profile
- progress window display
- automatic acquisition for newly added regular items
- duplicate-prevention behavior

## Build

From the repository root:

```bash
bash scripts/build-zotero-plugin.sh
```

The XPI is written to:

```text
dist/paper-acquisition-zotero.xpi
```

Install it in Zotero 7 from:

```text
Tools -> Add-ons -> Install Add-on From File...
```

## Required Local Service

The plugin can start the service for you if `Start the local service automatically when needed` is enabled in its settings pane. Configure:

```text
Service directory: /path/to/paper-acquisition-zotero
Start command: npm start
```

You can also start the service manually:

```bash
npm start
```

The default service URL is:

```text
http://127.0.0.1:24372
```

`Proxy mode` controls routing. Use `profile` when the local service profile
contains the proxy settings. Use `browser-profile` when Chrome or an extension
such as ZeroOmega manages the proxy. Use `local` when the plugin should inject
`Acquisition proxy` from Zotero settings into the helper browser. None of these
modes changes system proxy settings.

Institution-specific profile names, login URLs, proxy notes, and browser
profile details should live in the local service configuration rather than in
public docs.

Use `Refresh login profile` to open the acquisition browser profile and log in
to publisher, institutional, WebVPN, or SSO pages. In `browser-profile` mode,
Chrome profile settings and extensions handle the proxy route.

During manual acquisition, publisher CAPTCHA, human verification, login walls,
or missing PDF links can trigger a human-in-the-loop prompt. Complete the page
in the acquisition browser, then click OK in Zotero to retry once.

Automatic acquisition is disabled by default. If enabled, it waits before processing new items and checks again for existing PDF attachments, so Zotero's own associated-file download and other plugins get a chance to finish first.
