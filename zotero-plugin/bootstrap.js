var PaperAcquisitionAntiScrape;

(function () {
  const MENU_ID = "paper-acquisition-anti-scrape-acquire";
  const MENU_PROFILE_ID = "paper-acquisition-anti-scrape-acquire-profile";
  const MENU_LOGIN_ID = "paper-acquisition-anti-scrape-login";
  const MENU_SETTINGS_ID = "paper-acquisition-anti-scrape-settings";
  const MENU_SEPARATOR_ID = "paper-acquisition-anti-scrape-separator";
  const TOOLS_MENU_ID = "paper-acquisition-anti-scrape-tools-settings";
  const TOOLS_SEPARATOR_ID = "paper-acquisition-anti-scrape-tools-separator";
  const PREF_PANE_ID = "paper-acquisition-anti-scrape-preferences";
  const DEFAULT_PROFILE = "auto";
  const STATUS_TAGS = [
    "pdf:acquiring",
    "pdf:acquired",
    "pdf:login-required",
    "pdf:cooldown",
    "pdf:captcha-stop",
    "pdf:failed",
    "pdf:missing-metadata"
  ];

  PaperAcquisitionAntiScrape = {
    id: "paper-acquisition-anti-scrape@jyluo1994.github.io",
    prefRoot: "extensions.paperAcquisitionAntiScrape",
    windows: new Set(),
    rootURI: "",
    preferencePaneID: null,
    notifierID: null,
    queue: [],
    queueRunning: false,
    activeItemIDs: new Set(),
    pendingAutoItemIDs: new Set(),
    autoTimers: new Map(),

    async startup(data = {}) {
      this.log("Starting Paper Acquisition Anti-Scrape");
      this.rootURI = data.rootURI || (data.resourceURI && data.resourceURI.spec) || "";
      Zotero.PaperAcquisitionAntiScrape = this;
      await this.registerPreferencePane();
      this.registerNotifier();
      for (let win of this.getMainWindows()) {
        this.addToWindow(win);
      }
    },

    shutdown() {
      this.unregisterNotifier();
      this.unregisterPreferencePane();
      for (let timer of this.autoTimers.values()) {
        clearTimeout(timer);
      }
      this.autoTimers.clear();
      this.pendingAutoItemIDs.clear();
      for (let win of this.getMainWindows()) {
        this.removeFromWindow(win);
      }
      this.windows.clear();
      delete Zotero.PaperAcquisitionAntiScrape;
      this.log("Stopped Paper Acquisition Anti-Scrape");
    },

    onMainWindowLoad({ window }) {
      this.addToWindow(window);
    },

    onMainWindowUnload({ window }) {
      this.removeFromWindow(window);
    },

    async registerPreferencePane() {
      if (!this.rootURI || !Zotero.PreferencePanes || this.preferencePaneID) return;
      try {
        this.preferencePaneID = await Zotero.PreferencePanes.register({
          pluginID: this.id,
          id: PREF_PANE_ID,
          label: "Paper Acquisition",
          src: "preferences.xhtml",
          scripts: ["preferences.js"],
          stylesheets: ["preferences.css"]
        });
      }
      catch (err) {
        this.log(`Could not register preference pane: ${err.stack || err}`);
      }
    },

    unregisterPreferencePane() {
      if (!this.preferencePaneID || !Zotero.PreferencePanes) return;
      try {
        Zotero.PreferencePanes.unregister(this.preferencePaneID);
      }
      catch (err) {
        this.log(`Could not unregister preference pane: ${err}`);
      }
      this.preferencePaneID = null;
    },

    registerNotifier() {
      if (this.notifierID || !Zotero.Notifier) return;
      this.notifierID = Zotero.Notifier.registerObserver({
        notify: (event, type, ids, extraData) => this.onNotifierEvent(event, type, ids, extraData)
      }, ["item"], this.id);
    },

    unregisterNotifier() {
      if (!this.notifierID || !Zotero.Notifier) return;
      try {
        Zotero.Notifier.unregisterObserver(this.notifierID);
      }
      catch (err) {
        this.log(`Could not unregister notifier: ${err}`);
      }
      this.notifierID = null;
    },

    getMainWindows() {
      try {
        if (typeof Zotero.getMainWindows === "function") {
          return Zotero.getMainWindows();
        }
      }
      catch (err) {
        this.log(`Could not enumerate Zotero windows: ${err}`);
      }
      return [];
    },

    addToWindow(win) {
      if (!win || !win.document || this.windows.has(win)) return;

      const doc = win.document;
      const menu = doc.getElementById("zotero-itemmenu");
      if (!menu || doc.getElementById(MENU_ID)) return;

      const separator = this.createXULElement(doc, "menuseparator");
      separator.id = MENU_SEPARATOR_ID;

      const acquireItem = this.createXULElement(doc, "menuitem");
      acquireItem.id = MENU_ID;
      acquireItem.setAttribute("label", "获取 PDF (Paper Acquisition)");
      acquireItem.setAttribute("accesskey", "A");
      acquireItem.addEventListener("command", () => {
        this.acquireSelected(win, this.getDefaultProfile()).catch((err) => {
          this.log(`Acquire failed: ${err.stack || err}`);
          this.alert(win, "Paper Acquisition", err.message || String(err));
        });
      });

      const acquireWithProfileItem = this.createXULElement(doc, "menuitem");
      acquireWithProfileItem.id = MENU_PROFILE_ID;
      acquireWithProfileItem.setAttribute("label", "获取 PDF（选择机构配置）...");
      acquireWithProfileItem.addEventListener("command", () => {
        const profile = this.promptText(win, "Paper Acquisition", "Institution profile:", this.getDefaultProfile());
        if (!profile) return;
        this.acquireSelected(win, profile).catch((err) => {
          this.log(`Profile acquire failed: ${err.stack || err}`);
          this.alert(win, "Paper Acquisition", err.message || String(err));
        });
      });

      const loginItem = this.createXULElement(doc, "menuitem");
      loginItem.id = MENU_LOGIN_ID;
      loginItem.setAttribute("label", "刷新机构登录配置...");
      loginItem.addEventListener("command", () => {
        this.refreshLoginProfile(win).catch((err) => {
          this.log(`Login profile refresh failed: ${err.stack || err}`);
          this.alert(win, "Paper Acquisition", err.message || String(err));
        });
      });

      const settingsItem = this.createXULElement(doc, "menuitem");
      settingsItem.id = MENU_SETTINGS_ID;
      settingsItem.setAttribute("label", "Paper Acquisition 设置...");
      settingsItem.addEventListener("command", () => this.openSettings());

      menu.appendChild(separator);
      menu.appendChild(acquireItem);
      menu.appendChild(acquireWithProfileItem);
      menu.appendChild(loginItem);
      menu.appendChild(settingsItem);
      this.addToolsMenu(win);
      this.windows.add(win);
    },

    removeFromWindow(win) {
      if (!win || !win.document) return;
      for (let id of [MENU_ID, MENU_PROFILE_ID, MENU_LOGIN_ID, MENU_SETTINGS_ID, MENU_SEPARATOR_ID, TOOLS_MENU_ID, TOOLS_SEPARATOR_ID]) {
        const node = win.document.getElementById(id);
        if (node) node.remove();
      }
      this.windows.delete(win);
    },

    addToolsMenu(win) {
      const doc = win.document;
      const toolsMenu = doc.getElementById("menu_ToolsPopup");
      if (!toolsMenu || doc.getElementById(TOOLS_MENU_ID)) return;

      const separator = this.createXULElement(doc, "menuseparator");
      separator.id = TOOLS_SEPARATOR_ID;

      const settingsItem = this.createXULElement(doc, "menuitem");
      settingsItem.id = TOOLS_MENU_ID;
      settingsItem.setAttribute("label", "Paper Acquisition 设置...");
      settingsItem.addEventListener("command", () => this.openSettings());

      toolsMenu.appendChild(separator);
      toolsMenu.appendChild(settingsItem);
    },

    createXULElement(doc, name) {
      if (typeof doc.createXULElement === "function") {
        return doc.createXULElement(name);
      }
      return doc.createElement(name);
    },

    async acquireSelected(win, profile = "auto") {
      const selected = this.getSelectedRegularItems(win);
      if (!selected.length) {
        this.alert(win, "Paper Acquisition", "Select one or more regular Zotero items first.");
        return;
      }
      this.enqueueItems(selected, {
        profile,
        mode: "manual",
        source: "manual",
        window: win
      });
    },

    enqueueItems(items, options = {}) {
      const profile = options.profile || this.getDefaultProfile();
      const mode = options.mode || "manual";
      const source = options.source || mode;
      let added = 0;

      for (let item of items) {
        if (!item || !item.id || this.activeItemIDs.has(item.id) || this.isQueued(item.id)) continue;
        this.queue.push({ itemID: item.id, profile, mode, source, window: options.window || null });
        added++;
      }

      if (!added && source === "manual") {
        this.alert(options.window || this.getMainWindow(), "Paper Acquisition", "这些条目已经在获取队列中。");
      }

      if (added) {
        this.runQueue().catch((err) => {
          this.log(`Queue failed: ${err.stack || err}`);
        });
      }
    },

    isQueued(itemID) {
      return this.queue.some((entry) => entry.itemID === itemID);
    },

    async runQueue() {
      if (this.queueRunning) return;
      this.queueRunning = true;

      const summary = {
        acquired: 0,
        skipped: 0,
        failed: 0,
        loginRequired: 0,
        cooldown: 0,
        captchaStop: 0,
        missingMetadata: 0
      };

      const total = this.queue.length;
      const progress = this.createProgress(total);
      let processed = 0;

      try {
        while (this.queue.length) {
          const entry = this.queue.shift();
          const item = Zotero.Items.get(entry.itemID);
          if (!item || !this.isRegularItem(item)) {
            continue;
          }

          processed++;
          this.activeItemIDs.add(item.id);
          const visibleTotal = Math.max(total, processed + this.queue.length);
          const itemProgress = this.addProgressItem(progress, item, processed, visibleTotal, "正在处理");

          try {
            const outcome = await this.acquireItem(item, entry.profile, entry.mode, {
              window: entry.window || progress?.window || this.getMainWindow()
            });
            summary[outcome] = (summary[outcome] || 0) + 1;
            this.finishProgressItem(itemProgress, item, processed, visibleTotal, outcome);
          }
          catch (err) {
            summary.failed++;
            await this.setOnlyStatusTag(item, "pdf:failed");
            this.finishProgressItem(itemProgress, item, processed, visibleTotal, "failed");
            this.log(`Item ${item.key} failed: ${err.stack || err}`);
          }
          finally {
            this.activeItemIDs.delete(item.id);
          }
        }
        this.finishProgress(progress, summary);
      }
      finally {
        this.queueRunning = false;
      }
    },

    getSelectedRegularItems(win) {
      let items = [];
      try {
        items = win.ZoteroPane.getSelectedItems() || [];
      }
      catch (err) {
        this.log(`Could not read selection: ${err}`);
      }

      return items.filter((item) => {
        try {
          return item && typeof item.isRegularItem === "function" && item.isRegularItem();
        }
        catch {
          return false;
        }
      });
    },

    createProgress(total) {
      if (!this.getPref("showProgressWindow", true) || !Zotero.ProgressWindow) return null;
      const win = this.getMainWindow();
      const progress = new Zotero.ProgressWindow({ window: win, closeOnClick: false });
      progress.changeHeadline("Paper Acquisition", "attachment-pdf", `0/${total}`);
      progress.show();
      return progress;
    },

    addProgressItem(progress, item, index, total, status) {
      if (!progress) return null;
      const title = this.progressTitle(item);
      progress.changeHeadline("Paper Acquisition", "attachment-pdf", `${index}/${total}`);
      const itemProgress = new progress.ItemProgress(
        item.getItemTypeIconName ? item.getItemTypeIconName() : "journalArticle",
        `${status}: ${title}`
      );
      itemProgress.setProgress(25);
      return itemProgress;
    },

    finishProgressItem(itemProgress, item, index, total, outcome) {
      if (!itemProgress) return;
      const label = this.outcomeLabel(outcome);
      itemProgress.setText(`${label}: ${this.progressTitle(item)}`);
      if (outcome === "failed") {
        itemProgress.setError();
      }
      else {
        itemProgress.setProgress(100);
      }
    },

    finishProgress(progress, summary) {
      if (!progress) return;
      progress.changeHeadline("Paper Acquisition 完成", "attachment-pdf");
      progress.addDescription(this.formatSummary(summary));
      progress.startCloseTimer(8000);
    },

    progressTitle(item) {
      const title = this.cleanField(item.getField("title")) || item.key || `Item ${item.id}`;
      return title.length > 100 ? `${title.slice(0, 97)}...` : title;
    },

    outcomeLabel(outcome) {
      const labels = {
        acquired: "已获取",
        skipped: "已跳过",
        failed: "失败",
        loginRequired: "需要登录",
        cooldown: "冷却中",
        captchaStop: "需要人工验证",
        missingMetadata: "缺少元数据"
      };
      return labels[outcome] || outcome;
    },

    async acquireItem(item, profile = "auto", mode = "manual", options = {}) {
      if (this.getPref("skipExistingPDF", true) && await this.hasPdfAttachment(item)) {
        return "skipped";
      }

      const payload = this.itemPayload(item, profile, mode);
      if (options.manualRetry) {
        payload.useExistingBrowser = true;
      }
      if (!payload.doi && !payload.url && !payload.title) {
        await this.setOnlyStatusTag(item, "pdf:missing-metadata");
        return "missingMetadata";
      }

      await this.setOnlyStatusTag(item, "pdf:acquiring");

      const serviceURL = this.getServiceURL();
      await this.ensureServiceAvailable(serviceURL);
      const queued = await this.postJSON(`${serviceURL}/api/acquire`, payload);
      if (!queued.jobId) {
        throw new Error("Local acquisition service did not return a jobId.");
      }

      const result = await this.pollJob(serviceURL, queued.jobId);
      return await this.handleResult(item, result, profile, mode, options);
    },

    itemPayload(item, profile = "auto", mode = "manual") {
      return {
        zoteroItemKey: item.key,
        libraryID: item.libraryID,
        doi: this.cleanField(item.getField("DOI")),
        title: this.cleanField(item.getField("title")),
        url: this.cleanField(item.getField("url")),
        publicationTitle: this.cleanField(item.getField("publicationTitle")),
        date: this.cleanField(item.getField("date")),
        mode,
        profile: profile || "auto",
        ...this.proxyPayload()
      };
    },

    onNotifierEvent(event, type, ids, extraData) {
      if (type !== "item" || event !== "add") return;
      if (!this.getPref("autoAcquireOnNewItems", false)) return;
      if (this.shouldPauseAutoForNativeDownload()) {
        this.log("Auto acquisition paused because Zotero associated-file downloads are enabled.");
        return;
      }

      for (let id of ids || []) {
        this.scheduleAutoAcquire(Number(id));
      }
    },

    shouldPauseAutoForNativeDownload() {
      if (!this.getPref("avoidNativeDownloadConflicts", true)) return false;
      try {
        return !!Zotero.Prefs.get("extensions.zotero.downloadAssociatedFiles", true);
      }
      catch {
        return false;
      }
    },

    scheduleAutoAcquire(itemID) {
      if (!itemID || this.pendingAutoItemIDs.has(itemID) || this.activeItemIDs.has(itemID) || this.isQueued(itemID)) return;
      const item = Zotero.Items.get(itemID);
      if (!this.isRegularItem(item)) return;

      this.pendingAutoItemIDs.add(itemID);
      const delay = Math.max(1000, Number(this.getPref("autoAcquireDelayMS", 30000)) || 30000);
      const timer = setTimeout(() => {
        this.autoTimers.delete(itemID);
        this.pendingAutoItemIDs.delete(itemID);
        this.autoAcquireItem(itemID).catch((err) => {
          this.log(`Auto acquisition for item ${itemID} failed: ${err.stack || err}`);
        });
      }, delay);
      this.autoTimers.set(itemID, timer);
    },

    async autoAcquireItem(itemID) {
      if (!this.getPref("autoAcquireOnNewItems", false)) return;
      if (this.shouldPauseAutoForNativeDownload()) return;
      if (this.activeItemIDs.has(itemID) || this.isQueued(itemID)) return;

      const item = Zotero.Items.get(itemID);
      if (!this.isRegularItem(item)) return;
      if (this.getPref("skipExistingPDF", true) && await this.hasPdfAttachment(item)) return;
      if (this.hasAnyStatusTag(item, ["pdf:acquired", "pdf:acquiring"])) return;

      this.enqueueItems([item], {
        profile: this.getDefaultProfile(),
        mode: "auto",
        source: "auto",
        window: this.getMainWindow()
      });
    },

    isRegularItem(item) {
      try {
        return item && typeof item.isRegularItem === "function" && item.isRegularItem();
      }
      catch {
        return false;
      }
    },

    hasAnyStatusTag(item, tags) {
      try {
        const current = new Set((item.getTags() || []).map((entry) => entry.tag || entry));
        return tags.some((tag) => current.has(tag));
      }
      catch {
        return false;
      }
    },

    async refreshLoginProfile(win) {
      const profile = this.promptText(win, "Paper Acquisition", "Institution profile:", this.getDefaultProfile());
      if (!profile) return;

      const loginUrl = this.promptText(
        win,
        "Paper Acquisition",
        "Login URL (blank uses profile default):",
        ""
      );

      const serviceURL = this.getServiceURL();
      const body = {
        ...this.proxyPayload()
      };
      if (loginUrl) body.loginUrl = loginUrl;
      const result = await this.postJSON(`${serviceURL}/api/login/${encodeURIComponent(profile)}`, body);

      this.alert(
        win,
        "Paper Acquisition",
        [
          `Profile: ${result.profile || profile}`,
          `Label: ${result.label || "unknown"}`,
          `Login URL: ${result.loginUrl || "unknown"}`,
          `CDP: ${result.cdpURL || "unknown"}`,
          `Proxy mode: ${result.proxyMode || this.getProxyMode()}`,
          `Proxy: ${result.proxyServer || "not configured"}`,
          `Proxy auth: ${result.proxyAuthConfigured ? "configured" : "not configured"}`,
          `Browser profile: ${result.userDataDir || "unknown"}`
        ].join("\n")
      );
    },

    cleanField(value) {
      if (value === false || value == null) return "";
      return String(value).trim();
    },

    async handleResult(item, result, profile = "auto", mode = "manual", options = {}) {
      const status = result.status || "failed";

      if (status === "ok") {
        const pdfPath = result.pdfPath || result.pdf_path;
        if (!pdfPath) {
          throw new Error("Acquisition service returned ok without pdfPath.");
        }
        await Zotero.Attachments.importFromFile({
          file: pdfPath,
          parentItemID: item.id,
          title: result.title ? `Full Text PDF - ${result.title}` : "Full Text PDF"
        });
        await this.setOnlyStatusTag(item, "pdf:acquired");
        return "acquired";
      }

      if (status === "login_required" || status === "no_institutional_access") {
        if (await this.tryManualIntervention(item, result, profile, mode, options, "loginRequired")) {
          return "acquired";
        }
        await this.setOnlyStatusTag(item, "pdf:login-required");
        return "loginRequired";
      }

      if (status === "cooldown") {
        await this.setOnlyStatusTag(item, "pdf:cooldown");
        return "cooldown";
      }

      if (status === "human_verification_required" || status === "captcha_stop" || status === "no_pdf_link_found" || status === "download_failed") {
        if (await this.tryManualIntervention(item, result, profile, mode, options, "captchaStop")) {
          return "acquired";
        }
        await this.setOnlyStatusTag(item, "pdf:captcha-stop");
        return "captchaStop";
      }

      if (status === "missing_metadata") {
        await this.setOnlyStatusTag(item, "pdf:missing-metadata");
        return "missingMetadata";
      }

      await this.setOnlyStatusTag(item, "pdf:failed");
      return "failed";
    },

    async tryManualIntervention(item, result, profile, mode, options, fallbackOutcome) {
      if (mode !== "manual" || options.manualRetry) return false;
      const win = options.window || this.getMainWindow();
      const url = this.manualURL(result, item);

      try {
        await this.openManualIntervention(profile, url);
      }
      catch (err) {
        this.alert(win, "Paper Acquisition", `Could not open manual verification browser:\n${err.message || err}`);
        return false;
      }

      const done = this.confirm(
        win,
        "Paper Acquisition",
        [
          "我已经打开获取用的浏览器页面。",
          "",
          "请在浏览器里完成验证码、机构登录或出版商确认页。",
          "完成后点击 OK，我会重新获取这篇 PDF。",
          "",
          "如果还没完成，点 Cancel，条目会标记为需要人工验证。",
          "",
          `URL: ${url || "profile default"}`
        ].join("\n")
      );
      if (!done) return false;

      const retryOutcome = await this.acquireItem(item, profile, mode, {
        ...options,
        manualRetry: true
      });
      return retryOutcome === "acquired";
    },

    manualURL(result, item) {
      const candidates = [
        result.url,
        result.article_url,
        result.articleUrl,
        result.pdf_url,
        result.pdfURL,
        this.cleanField(item.getField("url"))
      ];
      const doi = this.cleanField(item.getField("DOI"));
      if (doi) candidates.push(`https://doi.org/${doi}`);
      return candidates.find((value) => value && /^https?:\/\//i.test(String(value))) || "";
    },

    async openManualIntervention(profile, url) {
      const serviceURL = this.getServiceURL();
      await this.ensureServiceAvailable(serviceURL);
      const body = {
        ...this.proxyPayload(),
        reuseOpenPage: true
      };
      if (url) body.loginUrl = url;
      await this.postJSON(`${serviceURL}/api/login/${encodeURIComponent(profile || this.getDefaultProfile())}`, body);
    },

    async pollJob(serviceURL, jobId) {
      const started = Date.now();
      const interval = Number(this.getPref("pollIntervalMS", 1500));
      const timeout = Number(this.getPref("jobTimeoutMS", 600000));

      while (Date.now() - started < timeout) {
        const result = await this.getJSON(`${serviceURL}/api/jobs/${encodeURIComponent(jobId)}`);
        if (!["queued", "running"].includes(result.status)) {
          return result;
        }
        await this.delay(interval);
      }

      throw new Error(`Acquisition job timed out after ${Math.round(timeout / 1000)} seconds.`);
    },

    async hasPdfAttachment(item) {
      let attachmentIDs = [];
      try {
        attachmentIDs = item.getAttachments() || [];
      }
      catch {
        return false;
      }

      for (let id of attachmentIDs) {
        const attachment = Zotero.Items.get(id);
        if (!attachment) continue;

        const contentType = attachment.attachmentContentType || "";
        if (String(contentType).toLowerCase() === "application/pdf") return true;

        try {
          const filePath = await attachment.getFilePathAsync();
          if (filePath && String(filePath).toLowerCase().endsWith(".pdf")) return true;
        }
        catch {
          // Linked or missing attachments may not expose a readable path.
        }
      }
      return false;
    },

    async setOnlyStatusTag(item, tag) {
      for (let statusTag of STATUS_TAGS) {
        if (statusTag !== tag) {
          try {
            item.removeTag(statusTag);
          }
          catch {
            // Older Zotero builds may throw if the tag does not exist.
          }
        }
      }
      item.addTag(tag);
      await item.saveTx();
    },

    escapeHTML(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    },

    async postJSON(url, payload) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      return await this.parseResponse(response);
    },

    async getJSON(url) {
      const response = await fetch(url);
      return await this.parseResponse(response);
    },

    async ensureServiceAvailable(serviceURL = this.getServiceURL()) {
      try {
        await this.getJSON(`${serviceURL}/health`);
        return;
      }
      catch (err) {
        if (!this.getPref("autoStartService", true)) {
          throw new Error(`Local acquisition service is not running at ${serviceURL}. Enable auto-start in Paper Acquisition settings or start the service manually.`);
        }
      }

      await this.startServiceFromPrefs();
      const deadline = Date.now() + 12000;
      let lastError = null;
      while (Date.now() < deadline) {
        try {
          await this.getJSON(`${serviceURL}/health`);
          return;
        }
        catch (err) {
          lastError = err;
          await this.delay(750);
        }
      }
      throw new Error(`Local acquisition service did not become ready: ${lastError && lastError.message ? lastError.message : "timeout"}`);
    },

    async startServiceFromPrefs() {
      const cwd = String(this.getPref("serviceWorkingDirectory", "") || "").trim();
      const command = String(this.getPref("serviceStartCommand", "npm start") || "").trim();
      if (!cwd) {
        throw new Error("Set the service directory in Paper Acquisition settings first.");
      }
      if (!command) {
        throw new Error("Set the service start command in Paper Acquisition settings first.");
      }
      if (!Zotero.Utilities || !Zotero.Utilities.Internal || !Zotero.Utilities.Internal.exec) {
        throw new Error("Zotero process launcher is not available.");
      }

      const shell = Zotero.isWin ? null : "/bin/sh";
      if (!shell) {
        throw new Error("Automatic service start is currently implemented for macOS/Linux.");
      }

      const logPath = "$HOME/.paper-acquisition/service.log";
      const envLines = [
        "export PATH=\"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH\""
      ];
      const script = [
        `cd ${this.shellQuote(cwd)}`,
        "mkdir -p \"$HOME/.paper-acquisition\"",
        ...envLines,
        `nohup ${command} >> ${logPath} 2>&1 &`
      ].join(" && ");

      await Zotero.Utilities.Internal.exec(shell, ["-lc", script]);
    },

    shellQuote(value) {
      return `'${String(value).replace(/'/g, "'\\''")}'`;
    },

    async parseResponse(response) {
      const text = await response.text();
      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        }
        catch {
          data = { status: "failed", error: text };
        }
      }
      if (!response.ok) {
        throw new Error(data.error || data.message || `HTTP ${response.status}`);
      }
      return data;
    },

    getServiceURL() {
      return String(this.getPref("serviceURL", "http://127.0.0.1:24372")).replace(/\/+$/, "");
    },

    getDefaultProfile() {
      return String(this.getPref("defaultProfile", DEFAULT_PROFILE) || DEFAULT_PROFILE).trim() || DEFAULT_PROFILE;
    },

    getProxyServer() {
      return String(this.getPref("proxyServer", "") || "").trim();
    },

    getProxyMode() {
      const mode = String(this.getPref("proxyMode", "profile") || "profile").trim().toLowerCase();
      if (mode === "local" || mode === "browser-profile") return mode;
      return "profile";
    },

    getProxyUsername() {
      return String(this.getPref("proxyUsername", "") || "").trim();
    },

    getProxyPassword() {
      return String(this.getPref("proxyPassword", "") || "");
    },

    proxyPayload() {
      const proxyMode = this.getProxyMode();
      const payload = { proxyMode };
      if (proxyMode === "local") {
        payload.proxyServer = this.getProxyServer();
        payload.proxyUsername = this.getProxyUsername();
        payload.proxyPassword = this.getProxyPassword();
      }
      return payload;
    },

    openSettings() {
      try {
        if (Zotero.Utilities && Zotero.Utilities.Internal && Zotero.Utilities.Internal.openPreferences) {
          Zotero.Utilities.Internal.openPreferences(PREF_PANE_ID);
          return;
        }
      }
      catch (err) {
        this.log(`Could not open preference pane: ${err}`);
      }
      const win = this.getMainWindow();
      this.alert(win, "Paper Acquisition", "Open Zotero Settings and choose Paper Acquisition.");
    },

    getMainWindow() {
      try {
        return Zotero.getMainWindow ? Zotero.getMainWindow() : null;
      }
      catch {
        return null;
      }
    },

    getPref(name, fallback) {
      try {
        const value = Zotero.Prefs.get(`${this.prefRoot}.${name}`, true);
        return value === undefined ? fallback : value;
      }
      catch {
        return fallback;
      }
    },

    delay(ms) {
      if (Zotero.Promise && typeof Zotero.Promise.delay === "function") {
        return Zotero.Promise.delay(ms);
      }
      return new Promise((resolve) => setTimeout(resolve, ms));
    },

    formatSummary(summary) {
      return [
        `Acquired: ${summary.acquired}`,
        `Skipped existing PDFs: ${summary.skipped}`,
        `Login required: ${summary.loginRequired}`,
        `Cooldown: ${summary.cooldown}`,
        `CAPTCHA stop: ${summary.captchaStop}`,
        `Missing metadata: ${summary.missingMetadata}`,
        `Failed: ${summary.failed}`
      ].join("\n");
    },

    alert(win, title, message) {
      try {
        Services.prompt.alert(win, title, message);
      }
      catch {
        win.alert(`${title}\n\n${message}`);
      }
    },

    promptText(win, title, message, defaultValue = "") {
      const input = { value: defaultValue };
      try {
        const ok = Services.prompt.prompt(win, title, message, input, null, {});
        return ok ? String(input.value || "").trim() : "";
      }
      catch {
        const value = win.prompt(message, defaultValue);
        return value ? String(value).trim() : "";
      }
    },

    confirm(win, title, message) {
      try {
        return Services.prompt.confirm(win, title, message);
      }
      catch {
        return win.confirm(`${title}\n\n${message}`);
      }
    },

    log(message) {
      try {
        Zotero.debug(`[paper-acquisition] ${message}`);
      }
      catch {
        // Zotero is not ready yet.
      }
    }
  };
})();

function install() {}

function uninstall() {}

async function startup(data, reason) {
  await PaperAcquisitionAntiScrape.startup(data, reason);
}

function shutdown(data, reason) {
  PaperAcquisitionAntiScrape.shutdown(data, reason);
  PaperAcquisitionAntiScrape = undefined;
}

function onMainWindowLoad(event) {
  PaperAcquisitionAntiScrape.onMainWindowLoad(event);
}

function onMainWindowUnload(event) {
  PaperAcquisitionAntiScrape.onMainWindowUnload(event);
}
