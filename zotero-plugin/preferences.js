var PaperAcquisitionPreferences = {
  initialized: false,

  init() {
    if (this.initialized) return;
    this.initialized = true;
    this.$("paa-test-service").addEventListener("command", () => this.testService());
    this.$("paa-start-service").addEventListener("command", () => this.startService());
    this.$("paa-refresh-login").addEventListener("command", () => this.refreshLoginProfile());
    this.testService().catch((err) => this.setStatus(`Service check failed: ${err.message || err}`, true));
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
    return String(this.pref("defaultProfile", "pumc-kokonur-zeroomega") || "pumc-kokonur-zeroomega").trim();
  },

  async testService() {
    this.setStatus("Checking local service...");
    const response = await fetch(`${this.serviceURL()}/health`);
    const data = await this.parseResponse(response);
    const profiles = Array.isArray(data.profiles) ? data.profiles.join(", ") : "unknown";
    this.setStatus(`Service OK. Download dir: ${data.downloadDir || "unknown"}. Profiles: ${profiles}`);
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
      body: "{}"
    });
    const data = await this.parseResponse(response);
    this.setStatus(`Opened ${data.label || data.profile || profile}. CDP: ${data.cdpURL || "unknown"}. ZeroOmega: ${data.zeroOmegaProfile || "not configured"}`);
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
    node.textContent = message;
    node.style.color = isError ? "var(--accent-red, #b00020)" : "";
  }
};
