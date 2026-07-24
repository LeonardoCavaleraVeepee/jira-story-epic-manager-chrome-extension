// Injects a floating "Send to Slack" button directly onto Jira issue pages, so a Task or
// Sub-task that already exists in Jira (created outside this extension, or long before Slack
// notifications were wired up) can still be pushed into the Slack "Front Request" workflow
// webhook without recreating it through the extension's own Gemini panel/popup first.
//
// Jira is a single-page app on both Cloud and Server/DC, so the issue key in the URL can change
// without a full page reload (navigating the backlog/board, or clicking between issues in a
// list) - this polls the URL on an interval rather than relying on a one-time DOMContentLoaded
// check, and re-fetches issue details (via the background service worker, over the same
// REST API + auth already configured in Options) whenever the detected key changes, instead of
// scraping the page's DOM for the summary/issue type. DOM scraping would be far more fragile
// across Jira Cloud's frequent UI changes and the very different Server/DC issue view markup.

const FRONTEND_DEVICE_OPTIONS = ["Android", "iOS", "Web"];
let jsbCurrentIssueKey = null;
let jsbSlackWebhookConfigured = false;
let jsbSelectedDevice = "";
let jsbPanelEl = null;
let jsbFabEl = null;

function extractIssueKeyFromLocation() {
  const path = window.location.pathname;
  const browseMatch = path.match(/\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/);
  if (browseMatch) {
    return browseMatch[1].toUpperCase();
  }
  const params = new URLSearchParams(window.location.search);
  const candidateParams = ["selectedIssue", "issueKey", "selectedJiraIssueKey"];
  for (const name of candidateParams) {
    const value = params.get(name);
    if (value && /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(value)) {
      return value.toUpperCase();
    }
  }
  return null;
}

// Only Task/Sub-task issue types are relevant here - Stories/Epics already have their own Slack
// notification step built into the extension's create form (see gemini_integration.js/popup.js),
// so surfacing this button for those would just be a confusing, redundant second path.
function isTaskLikeIssueType(issueType) {
  const normalized = (issueType || "").toLowerCase();
  return normalized === "task" || normalized === "sub-task" || normalized === "subtask";
}

function ensureRootElements() {
  if (jsbFabEl && jsbPanelEl) {
    return;
  }

  const root = document.createElement("div");
  root.id = "jsb-root";
  document.documentElement.appendChild(root);

  jsbFabEl = document.createElement("button");
  jsbFabEl.type = "button";
  jsbFabEl.className = "jsb-fab jsb-hidden";
  jsbFabEl.innerHTML = `<span class="jsb-fab-icon">💬</span><span>Send to Slack</span>`;
  jsbFabEl.addEventListener("click", () => {
    const isHidden = jsbPanelEl.classList.contains("jsb-hidden");
    if (isHidden) {
      openPanel();
    } else {
      closePanel();
    }
  });

  jsbPanelEl = document.createElement("div");
  jsbPanelEl.className = "jsb-panel jsb-hidden";
  jsbPanelEl.innerHTML = `
    <h3>Send to Slack "Front Request"</h3>
    <p class="jsb-summary" id="jsb-summary"></p>
    <label for="jsb-priority">Priority</label>
    <select id="jsb-priority">
      <option value="">Select priority…</option>
      <option value="Low">Low</option>
      <option value="Medium">Medium</option>
      <option value="High">High</option>
      <option value="Critical">Critical</option>
    </select>
    <label for="jsb-product">Product</label>
    <select id="jsb-product">
      <option value="">Select product…</option>
      <option value="User Engagement">User Engagement</option>
      <option value="Navigation">Navigation</option>
      <option value="Sales">Sales</option>
      <option value="OrderPipe">OrderPipe</option>
      <option value="Post Sales">Post Sales</option>
      <option value="FastLine">FastLine</option>
      <option value="Member LifeCycle">Member LifeCycle</option>
      <option value="Payment">Payment</option>
      <option value="Member Support">Member Support</option>
    </select>
    <label for="jsb-eta">Expected ETA</label>
    <select id="jsb-eta">
      <option value="">Select month…</option>
      <option value="January">January</option>
      <option value="February">February</option>
      <option value="March">March</option>
      <option value="April">April</option>
      <option value="May">May</option>
      <option value="June">June</option>
      <option value="July">July</option>
      <option value="August">August</option>
      <option value="September">September</option>
      <option value="October">October</option>
      <option value="November">November</option>
      <option value="December">December</option>
    </select>
    <label>Platform (optional)</label>
    <div class="jsb-pill-group" id="jsb-device-pills"></div>
    <label for="jsb-figma">Figma (optional)</label>
    <input id="jsb-figma" placeholder="https://figma.com/..." />
    <label for="jsb-channel">Channel ID (optional)</label>
    <input id="jsb-channel" placeholder="e.g. C0123ABC456" />
    <div class="jsb-actions">
      <button type="button" class="jsb-btn jsb-btn-secondary" id="jsb-cancel">Cancel</button>
      <button type="button" class="jsb-btn jsb-btn-primary" id="jsb-submit">Send</button>
    </div>
    <p class="jsb-status" id="jsb-status"></p>
  `;

  const devicePillsEl = jsbPanelEl.querySelector("#jsb-device-pills");
  for (const device of FRONTEND_DEVICE_OPTIONS) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "jsb-pill";
    pill.textContent = device;
    pill.addEventListener("click", () => {
      jsbSelectedDevice = jsbSelectedDevice === device ? "" : device;
      devicePillsEl.querySelectorAll(".jsb-pill").forEach((el) => {
        el.classList.toggle("jsb-selected", el.textContent === jsbSelectedDevice);
      });
    });
    devicePillsEl.appendChild(pill);
  }

  jsbPanelEl.querySelector("#jsb-cancel").addEventListener("click", closePanel);
  jsbPanelEl.querySelector("#jsb-submit").addEventListener("click", onSubmit);

  root.appendChild(jsbPanelEl);
  root.appendChild(jsbFabEl);
}

function openPanel() {
  jsbPanelEl.classList.remove("jsb-hidden");
  const statusEl = jsbPanelEl.querySelector("#jsb-status");
  statusEl.textContent = "";
  statusEl.className = "jsb-status";
}

function closePanel() {
  jsbPanelEl.classList.add("jsb-hidden");
}

async function onSubmit() {
  const statusEl = jsbPanelEl.querySelector("#jsb-status");
  const submitBtn = jsbPanelEl.querySelector("#jsb-submit");
  if (!jsbCurrentIssueKey) {
    statusEl.textContent = "No issue detected on this page.";
    statusEl.className = "jsb-status jsb-error";
    return;
  }

  submitBtn.disabled = true;
  statusEl.textContent = "Sending…";
  statusEl.className = "jsb-status";

  const summaryEl = jsbPanelEl.querySelector("#jsb-summary");
  try {
    const response = await chrome.runtime.sendMessage({
      action: "notifySlackFromJiraPage",
      baseUrl: window.location.origin,
      issueKey: jsbCurrentIssueKey,
      summary: summaryEl.dataset.summary || "",
      device: jsbSelectedDevice,
      slack: {
        priority: jsbPanelEl.querySelector("#jsb-priority").value,
        product: jsbPanelEl.querySelector("#jsb-product").value,
        expectedEta: jsbPanelEl.querySelector("#jsb-eta").value,
        figma: jsbPanelEl.querySelector("#jsb-figma").value.trim(),
        channelFeature: jsbPanelEl.querySelector("#jsb-channel").value.trim()
      }
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Slack notification failed.");
    }

    statusEl.textContent = `Sent ${jsbCurrentIssueKey} to Slack.`;
    statusEl.className = "jsb-status jsb-success";
    setTimeout(closePanel, 1500);
  } catch (error) {
    statusEl.textContent = error.message || "Slack notification failed.";
    statusEl.className = "jsb-status jsb-error";
  } finally {
    submitBtn.disabled = false;
  }
}

async function refreshForCurrentIssue() {
  const detectedKey = extractIssueKeyFromLocation();
  if (detectedKey === jsbCurrentIssueKey) {
    return;
  }
  jsbCurrentIssueKey = detectedKey;
  closePanel();

  if (!detectedKey || !jsbSlackWebhookConfigured) {
    jsbFabEl.classList.add("jsb-hidden");
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      action: "getIssueDetails",
      baseUrl: window.location.origin,
      issueKey: detectedKey
    });
    // The URL may have already moved on to a different issue by the time this resolves - drop a
    // stale response rather than showing/labeling the button for the wrong issue.
    if (extractIssueKeyFromLocation() !== detectedKey) {
      return;
    }
    if (!response || !response.ok || !isTaskLikeIssueType(response.issueType)) {
      jsbFabEl.classList.add("jsb-hidden");
      return;
    }

    const summaryEl = jsbPanelEl.querySelector("#jsb-summary");
    summaryEl.textContent = `${detectedKey}: ${response.summary || ""}`;
    summaryEl.dataset.summary = response.summary || "";
    jsbFabEl.classList.remove("jsb-hidden");
  } catch (_error) {
    jsbFabEl.classList.add("jsb-hidden");
  }
}

async function init() {
  ensureRootElements();

  await refreshSlackConfigured();
  await refreshForCurrentIssue();
  setInterval(refreshForCurrentIssue, 1500);

  // Pick up a webhook URL saved in Options *after* this page already loaded, without requiring a
  // full reload of the Jira tab.
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(async (changes, areaName) => {
      if (areaName === "sync" && changes.slackWebhookUrl) {
        await refreshSlackConfigured();
        jsbCurrentIssueKey = null; // force a re-check against the (possibly newly-)configured webhook
        await refreshForCurrentIssue();
      }
    });
  }
}

async function refreshSlackConfigured() {
  try {
    const webhookCheck = await chrome.runtime.sendMessage({ action: "hasSlackWebhook" });
    jsbSlackWebhookConfigured = Boolean(webhookCheck && webhookCheck.ok && webhookCheck.hasWebhook);
  } catch (_error) {
    jsbSlackWebhookConfigured = false;
  }
}

init();
