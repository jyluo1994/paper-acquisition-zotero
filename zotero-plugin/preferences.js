var PaperAcquisitionPreferences = {
  initialized: false,

  init() {
    if (this.initialized) return;
    if (!this.$("paa-test-service") || !this.$("paa-start-service") || !this.$("paa-refresh-login")) {
      setTimeout(() => this.init(), 100);
      return;
    }
    this.initialized = true;
    this.bindButton("paa-test-service", () => this.testService());
    this.bindButton("paa-start-service", () => this.startService());
    this.bindButton("paa-refresh-login", () => this.refreshLoginProfile());
    this.testService().catch((err) => this.setStatus(`Service check failed: ${err.message || err}`, true));
  },

  bindButton(id, handler) {
    const node = this.$(id);
    if (!node) return;
    let lastRun = 0;
    const run = () => {
      const now = Date.now();
      if (now - lastRun < 250) return;
      lastRun = now;
      Promise.resolve()
        .then(handler)
        .catch((err) => this.setStatus(`Action failed: ${err.message || err}`, true));
    };
    node.addEventListener("command", run);
    node.addEventListener("click", run);
  },

  $(id) {
    return document.getElementById(id);
  },

  pref(name, fallback) {
    try {
      const value = Zotero.Prefs.get(`extensions.paperAcquisitionAntiScrape.${name}`, true);
      return value === undefined ? fallback : value;
    }
    catch {
      return fallback;
    }
  },

  serviceURL() {
    return String(this.pref("serviceURL", "http://127.0.0.1:24372")).replace(/\/+$/, "");
  },

  defaultProfile() {
    return String(this.pref("defaultProfile", "auto") || "auto").trim();
  },

  proxyServer() {
    return String(this.pref("proxyServer", "") || "").trim();
  },

  proxyMode() {
    const mode = String(this.pref("proxyMode", "browser-profile") || "browser-profile").trim().toLowerCase();
    return mode === "local" ? "local" : "browser-profile";
  },

  proxyUsername() {
    return String(this.pref("proxyUsername", "") || "").trim();
  },

  proxyPassword() {
    return String(this.pref("proxyPassword", "") || "");
  },

  async testService() {
    this.setStatus("Checking local service...");
    const response = await fetch(`${this.serviceURL()}/health`);
    const data = await this.parseResponse(response);
    const profiles = Array.isArray(data.profiles) ? data.profiles.join(", ") : "unknown";
    const mode = this.proxyMode();
    const proxy = mode === "local"
      ? (this.proxyServer() ? "local proxy configured" : "local proxy mode, proxy empty")
      : "browser profile proxy mode";
    const auth = mode === "local" && this.proxyUsername() ? "proxy auth configured" : "proxy auth off";
    this.setStatus(`Service OK. Download dir: ${data.downloadDir || "unknown"}. Profiles: ${profiles}. ${proxy}. ${auth}.`);
  },

  async refreshLoginProfile() {
    const profile = this.defaultProfile();
    if (!profile) {
      this.setStatus("Default profile is empty.", true);
      return;
    }
    this.setStatus(`Opening login profile: ${profile}...`);
    const response = await fetch(`${this.serviceURL()}/api/login/${encodeURIComponent(profile)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.requestOptions())
    });
    const data = await this.parseResponse(response);
    const mode = data.proxyMode ? ` Proxy mode: ${data.proxyMode}.` : "";
    const proxy = data.proxyServer ? ` Proxy: ${data.proxyServer}.` : "";
    const auth = data.proxyAuthConfigured ? " Proxy auth configured." : "";
    this.setStatus(`Opened ${data.label || data.profile || profile}. CDP: ${data.cdpURL || "unknown"}.${mode}${proxy}${auth}`);
  },

  requestOptions() {
    const proxyMode = this.proxyMode();
    const options = { proxyMode };
    if (proxyMode === "local") {
      options.proxyServer = this.proxyServer();
      options.proxyUsername = this.proxyUsername();
      options.proxyPassword = this.proxyPassword();
    }
    return options;
  },

  async startService() {
    if (!Zotero.PaperAcquisitionAntiScrape || !Zotero.PaperAcquisitionAntiScrape.startServiceFromPrefs) {
      this.setStatus("Plugin service launcher is not available.", true);
      return;
    }
    try {
      this.setStatus("Starting local service...");
      await Zotero.PaperAcquisitionAntiScrape.startServiceFromPrefs();
      await this.waitForService();
      await this.testService();
    }
    catch (err) {
      this.setStatus(`Service start failed: ${err.message || err}`, true);
    }
  },

  async waitForService() {
    const deadline = Date.now() + 10000;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.serviceURL()}/health`);
        await this.parseResponse(response);
        return;
      }
      catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
    throw lastError || new Error("Timed out waiting for local service.");
  },

  async parseResponse(response) {
    let data = {};
    const text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text);
      }
      catch {
        data = { error: text };
      }
    }
    if (!response.ok) {
      throw new Error(data.error || data.message || `HTTP ${response.status}`);
    }
    return data;
  },

  setStatus(message, isError = false) {
    const node = this.$("paa-service-status");
    if (!node) return;
    node.textContent = message;
    node.style.color = isError ? "var(--accent-red, #b00020)" : "";
  }
};

(function () {
  const init = () => PaperAcquisitionPreferences.init();
  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init, { once: true });
    }
    else {
      setTimeout(init, 0);
    }
    window.addEventListener("load", init, { once: true });
  }
  catch {
    setTimeout(init, 0);
  }
})();
