"use strict";

const DEFAULT_TEMPLATE =
  "Implement {role} subtask #{index} for story: {storySummary}";
const DEFAULT_ASSIGNMENT_ROLES = ["Android", "iOS", "Web"];

const jiraBaseUrl = document.getElementById("jiraBaseUrl");
const jiraAuthScheme = document.getElementById("jiraAuthScheme");
const jiraAuthEmail = document.getElementById("jiraAuthEmail");
const jiraApiToken = document.getElementById("jiraApiToken");
const jiraApiRootOverride = document.getElementById("jiraApiRootOverride");
const captureApiTokenButton = document.getElementById("captureApiTokenButton");
const diagnoseAuthButton = document.getElementById("diagnoseAuthButton");
const assignee1 = document.getElementById("assignee1");
const role1 = document.getElementById("role1");
const assignee2 = document.getElementById("assignee2");
const role2 = document.getElementById("role2");
const assignee3 = document.getElementById("assignee3");
const role3 = document.getElementById("role3");
const subtaskTemplate = document.getElementById("subtaskTemplate");
const initConnectionButton = document.getElementById("initConnectionButton");
const saveButton = document.getElementById("saveButton");
const status = document.getElementById("status");
const advancedDetails = document.getElementById("advancedDetails");

const slackWebhookUrl = document.getElementById("slackWebhookUrl");
const slackUserId = document.getElementById("slackUserId");
const saveSlackButton = document.getElementById("saveSlackButton");
const slackStatus = document.getElementById("slackStatus");

const popupMode = document.getElementById("popupMode");
const saveGeneralButton = document.getElementById("saveGeneralButton");
const generalStatus = document.getElementById("generalStatus");


const wizardSummary = document.getElementById("wizardSummary");
const wizardToggleButton = document.getElementById("wizardToggleButton");
const wizardBody = document.getElementById("wizardBody");
const wizardStepIndicator = document.getElementById("wizardStepIndicator");
const wizardStep1 = document.getElementById("wizardStep1");
const wizardStep2 = document.getElementById("wizardStep2");
const wizardStep3 = document.getElementById("wizardStep3");
const wizardDomain = document.getElementById("wizardDomain");
const wizardEmail = document.getElementById("wizardEmail");
const wizardToken = document.getElementById("wizardToken");
const wizardBackButton = document.getElementById("wizardBackButton");
const wizardNextButton = document.getElementById("wizardNextButton");
const wizardFinishButton = document.getElementById("wizardFinishButton");
const wizardStatus = document.getElementById("wizardStatus");

const WIZARD_STEPS = [
  { section: wizardStep1, input: wizardDomain, label: "Jira domain" },
  { section: wizardStep2, input: wizardEmail, label: "Jira account email" },
  { section: wizardStep3, input: wizardToken, label: "Jira personal access token" }
];
let wizardCurrentStep = 0;


function getStorageSync() {
  const storageSync = globalThis.chrome?.storage?.sync;
  if (!storageSync) {
    throw new Error(
      "Extension storage API is unavailable. Reload the extension in chrome://extensions and try again."
    );
  }
  return storageSync;
}

// The toolbar icon's popup-vs-window behavior is a per-device UI preference, not something that
// should follow the user's Jira/Slack configuration to other machines (mirroring the same
// reasoning already used for the remembered popup/panel resize dimensions) - so it's kept in
// chrome.storage.local instead of .sync.
function getStorageLocal() {
  const storageLocal = globalThis.chrome?.storage?.local;
  if (!storageLocal) {
    throw new Error(
      "Extension storage API is unavailable. Reload the extension in chrome://extensions and try again."
    );
  }
  return storageLocal;
}

init().catch((error) => renderStatus(error.message, true));

async function init() {
  const settings = await getStorageSync().get({
    jiraBaseUrl: "",
    jiraAuthMode: "basic",
    jiraAuthScheme: "auto",
    jiraAuthEmail: "",
    jiraAuthApiToken: "",
    jiraAuthBearerToken: "",
    jiraApiRootOverride: "/rest/api/2",
    frontendAssignees: [],
    frontendAssignments: [],
    subtaskTemplate: DEFAULT_TEMPLATE,
    slackWebhookUrl: "",
    slackUserId: ""
  });

  const assignments = normalizeAssignments(
    settings.frontendAssignments,
    settings.frontendAssignees
  );

  jiraBaseUrl.value = settings.jiraBaseUrl || "";
  jiraAuthScheme.value = settings.jiraAuthScheme || "auto";
  jiraAuthEmail.value = settings.jiraAuthEmail || "";
  jiraApiToken.value = settings.jiraAuthApiToken || settings.jiraAuthBearerToken || "";
  jiraApiRootOverride.value = settings.jiraApiRootOverride || "/rest/api/2";
  assignee1.value = assignments[0]?.accountId || "";
  role1.value = assignments[0]?.role || DEFAULT_ASSIGNMENT_ROLES[0];
  assignee2.value = assignments[1]?.accountId || "";
  role2.value = assignments[1]?.role || DEFAULT_ASSIGNMENT_ROLES[1];
  assignee3.value = assignments[2]?.accountId || "";
  role3.value = assignments[2]?.role || DEFAULT_ASSIGNMENT_ROLES[2];
  subtaskTemplate.value = settings.subtaskTemplate || DEFAULT_TEMPLATE;
  slackWebhookUrl.value = settings.slackWebhookUrl || "";
  slackUserId.value = settings.slackUserId || "";

  const localSettings = await getStorageLocal().get({ popupMode: "window" });
  popupMode.value = localSettings.popupMode || "window";

  captureApiTokenButton.addEventListener("click", onCaptureApiToken);
  diagnoseAuthButton.addEventListener("click", onDiagnoseAuth);
  initConnectionButton.addEventListener("click", onInitializeConnection);
  saveButton.addEventListener("click", onSaveAllSettings);
  saveSlackButton.addEventListener("click", onSaveSlackSettings);
  saveGeneralButton.addEventListener("click", onSaveGeneralSettings);

  initWizard(settings);
}

async function onSaveGeneralSettings() {
  try {
    await getStorageLocal().set({ popupMode: popupMode.value });
    // background.js listens for this storage change (chrome.storage.onChanged) and calls
    // chrome.action.setPopup() accordingly - no message needs to be sent explicitly here.
    renderGeneralStatus("Saved. This takes effect the next time you click the toolbar icon.");
  } catch (error) {
    renderGeneralStatus(error.message, true);
  }
}

function renderGeneralStatus(message, isError = false) {
  generalStatus.textContent = message;
  generalStatus.style.color = isError ? "#c62828" : "#1b5e20";
}

function getJiraDomainFromBaseUrl(baseUrl) {
  try {
    return new URL(/^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`).host;
  } catch (_error) {
    return baseUrl;
  }
}

function isJiraConfigured(settings) {
  return Boolean(settings.jiraBaseUrl && (settings.jiraAuthApiToken || settings.jiraAuthBearerToken));
}

function initWizard(settings) {
  const configured = isJiraConfigured(settings);

  wizardSummary.textContent = configured
    ? `Connected to ${getJiraDomainFromBaseUrl(settings.jiraBaseUrl)}`
    : "Jira is not configured yet. Run the setup wizard below to get started.";
  wizardToggleButton.textContent = configured ? "Run setup wizard again" : "Start setup wizard";

  advancedDetails.open = configured;
  setWizardBodyVisible(!configured);
  if (!configured) {
    prefillWizardFromFields();
    showWizardStep(0);
  }

  wizardToggleButton.addEventListener("click", () => {
    const isHidden = wizardBody.classList.contains("hidden");
    if (isHidden) {
      prefillWizardFromFields();
      showWizardStep(0);
    }
    setWizardBodyVisible(isHidden);
  });

  wizardBackButton.addEventListener("click", () => showWizardStep(wizardCurrentStep - 1));
  wizardNextButton.addEventListener("click", onWizardNext);
  wizardFinishButton.addEventListener("click", onWizardFinish);

  WIZARD_STEPS.forEach((step, index) => {
    step.input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      if (index === WIZARD_STEPS.length - 1) {
        onWizardFinish();
      } else {
        onWizardNext();
      }
    });
  });
}

function setWizardBodyVisible(visible) {
  wizardBody.classList.toggle("hidden", !visible);
}

function prefillWizardFromFields() {
  wizardDomain.value = jiraBaseUrl.value.replace(/^https?:\/\//i, "").trim();
  wizardEmail.value = jiraAuthEmail.value.trim();
  wizardToken.value = jiraApiToken.value.trim();
}

function showWizardStep(index) {
  const clamped = Math.max(0, Math.min(index, WIZARD_STEPS.length - 1));
  wizardCurrentStep = clamped;
  WIZARD_STEPS.forEach((step, stepIndex) => {
    step.section.classList.toggle("hidden", stepIndex !== clamped);
  });
  wizardStepIndicator.textContent = `Step ${clamped + 1} of ${WIZARD_STEPS.length}: ${WIZARD_STEPS[clamped].label}`;
  wizardBackButton.classList.toggle("hidden", clamped === 0);
  wizardNextButton.classList.toggle("hidden", clamped === WIZARD_STEPS.length - 1);
  wizardFinishButton.classList.toggle("hidden", clamped !== WIZARD_STEPS.length - 1);
  renderWizardStatus("");
  WIZARD_STEPS[clamped].input.focus();
}

function onWizardNext() {
  const step = WIZARD_STEPS[wizardCurrentStep];
  if (!step.input.value.trim()) {
    renderWizardStatus(`${step.label} is required.`, true);
    return;
  }
  showWizardStep(wizardCurrentStep + 1);
}

async function onWizardFinish() {
  const domain = wizardDomain.value.trim();
  const email = wizardEmail.value.trim();
  const token = wizardToken.value.trim();

  if (!domain) {
    showWizardStep(0);
    renderWizardStatus("Jira domain is required.", true);
    return;
  }
  if (!email) {
    showWizardStep(1);
    renderWizardStatus("Jira account email is required.", true);
    return;
  }
  if (!token) {
    showWizardStep(2);
    renderWizardStatus("Jira personal access token is required.", true);
    return;
  }

  wizardFinishButton.disabled = true;
  renderWizardStatus("Testing connection...");
  try {
    const connectionSettings = {
      baseUrl: domain,
      authScheme: "auto",
      email,
      apiToken: token,
      apiRootOverride: ""
    };
    await saveConnectionSettings(connectionSettings);

    const response = await chrome.runtime.sendMessage({
      action: "testAuth",
      baseUrl: connectionSettings.baseUrl
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Connection test failed.");
    }

    jiraBaseUrl.value = connectionSettings.baseUrl;
    jiraAuthScheme.value = "auto";
    jiraAuthEmail.value = email;
    jiraApiToken.value = token;
    jiraApiRootOverride.value = "";

    const connectedUser =
      response.user?.displayName || response.user?.emailAddress || response.user?.accountId || "Unknown user";
    const domainLabel = getJiraDomainFromBaseUrl(connectionSettings.baseUrl);
    wizardSummary.textContent = `Connected to ${domainLabel}`;
    wizardToggleButton.textContent = "Run setup wizard again";
    renderWizardStatus(`Connected as ${connectedUser}.`);
    renderStatus(`Connection initialized. Connected as ${connectedUser}.`);
    advancedDetails.open = true;
    setWizardBodyVisible(false);
  } catch (error) {
    renderWizardStatus(error.message, true);
  } finally {
    wizardFinishButton.disabled = false;
  }
}

function renderWizardStatus(message, isError = false) {
  wizardStatus.textContent = message;
  wizardStatus.style.color = isError ? "#c62828" : "#1b5e20";
}

function normalizeAssignments(frontendAssignments, frontendAssignees) {
  const assignments = Array.isArray(frontendAssignments) ? frontendAssignments : [];
  if (assignments.length >= 3) {
    return assignments.slice(0, 3).map((assignment, index) => ({
      accountId: String(assignment?.accountId || "").trim(),
      role: String(assignment?.role || DEFAULT_ASSIGNMENT_ROLES[index]).trim()
    }));
  }

  const assignees = Array.isArray(frontendAssignees) ? frontendAssignees : [];
  return DEFAULT_ASSIGNMENT_ROLES.map((role, index) => ({
    accountId: String(assignees[index] || "").trim(),
    role
  }));
}

function collectConnectionSettings() {
  return {
    baseUrl: jiraBaseUrl.value.trim(),
    authScheme: jiraAuthScheme.value,
    email: jiraAuthEmail.value.trim(),
    apiToken: jiraApiToken.value.trim(),
    apiRootOverride: jiraApiRootOverride.value.trim()
  };
}

function validateConnectionSettings(connectionSettings) {
  if (!connectionSettings.baseUrl) {
    throw new Error("Jira URL is required.");
  }
  if (!connectionSettings.apiToken) {
    throw new Error("Jira token is required.");
  }
  if (connectionSettings.authScheme === "basic" && !connectionSettings.email) {
    throw new Error("Atlassian account email is required for Basic auth mode.");
  }
}

async function saveConnectionSettings(connectionSettings) {
  await getStorageSync().set({
    jiraBaseUrl: connectionSettings.baseUrl,
    jiraAuthMode: connectionSettings.authScheme === "bearer" ? "bearer" : "basic",
    jiraAuthScheme: connectionSettings.authScheme,
    jiraAuthEmail: connectionSettings.email,
    jiraAuthApiToken: connectionSettings.apiToken,
    jiraAuthBearerToken: connectionSettings.apiToken,
    jiraForceBearerOnly: false,
    jiraApiRootOverride: connectionSettings.apiRootOverride || ""
  });
}

async function onCaptureApiToken() {
  try {
    if (!navigator.clipboard?.readText) {
      throw new Error("Clipboard access is unavailable in this browser context.");
    }
    const clipboardValue = (await navigator.clipboard.readText()).trim();
    if (!clipboardValue) {
      throw new Error("Clipboard is empty. Copy your Atlassian API token first.");
    }
    jiraApiToken.value = clipboardValue;
    renderStatus("API token captured from clipboard.");
  } catch (error) {
    renderStatus(error.message, true);
  }
}

async function onInitializeConnection() {
  try {
    const connectionSettings = collectConnectionSettings();
    validateConnectionSettings(connectionSettings);
    await saveConnectionSettings(connectionSettings);

    const response = await chrome.runtime.sendMessage({
      action: "testAuth",
      baseUrl: connectionSettings.baseUrl
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Connection test failed.");
    }

    const connectedUser =
      response.user?.displayName || response.user?.emailAddress || response.user?.accountId || "Unknown user";
    renderStatus(`Connection initialized. Connected as ${connectedUser}.`);
  } catch (error) {
    renderStatus(error.message, true);
  }
}

async function onDiagnoseAuth() {
  try {
    const connectionSettings = collectConnectionSettings();
    if (!connectionSettings.baseUrl) {
      throw new Error("Jira URL is required.");
    }
    if (!connectionSettings.apiToken) {
      throw new Error("Jira token is required.");
    }

    await saveConnectionSettings(connectionSettings);
    const response = await chrome.runtime.sendMessage({
      action: "diagnoseAuth",
      baseUrl: connectionSettings.baseUrl
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Auth diagnostics failed.");
    }

    if (response.success) {
      const readMessage = `Read OK: ${response.success.scheme.toUpperCase()} works on ${response.success.apiRoot}/myself.`;
      const writeCheck = response.writeCheck;
      if (writeCheck && writeCheck.ok && !writeCheck.isHtml) {
        renderStatus(`${readMessage} Write check also OK (POST ${writeCheck.apiRoot}/search).`);
        return;
      }

      if (writeCheck) {
        const location = writeCheck.redirected && writeCheck.finalUrl ? ` Redirected to: ${writeCheck.finalUrl}.` : "";
        const title = writeCheck.pageTitle ? ` Page title: "${writeCheck.pageTitle}".` : "";
        renderStatus(
          `${readMessage} BUT write check FAILED: POST ${writeCheck.apiRoot}/search -> status ${writeCheck.status}.${
            writeCheck.isHtml ? " Jira/proxy returned an HTML page instead of JSON." : ""
          }${location}${title} This means reads work but a proxy/SSO gateway is likely blocking write (POST) requests specifically - that is why issue creation fails even though auth is otherwise valid.`,
          true
        );
        return;
      }

      renderStatus(readMessage);
      return;
    }

    const firstFailure = (response.attempts || [])[0];
    if (firstFailure) {
      const location = firstFailure.redirected && firstFailure.finalUrl ? ` Redirected to: ${firstFailure.finalUrl}.` : "";
      const title = firstFailure.pageTitle ? ` Page title: "${firstFailure.pageTitle}".` : "";
      renderStatus(
        `Diagnostics failed: ${firstFailure.scheme.toUpperCase()} ${firstFailure.apiRoot} -> status ${firstFailure.status}. ${firstFailure.isHtml ? "HTML login page returned." : firstFailure.details}${location}${title}`,
        true
      );
      return;
    }

    renderStatus("Diagnostics failed: no attempt results were produced.", true);
  } catch (error) {
    renderStatus(error.message, true);
  }
}

async function onSaveAllSettings() {
  try {
    const assignments = [
      { accountId: assignee1.value.trim(), role: role1.value.trim() },
      { accountId: assignee2.value.trim(), role: role2.value.trim() },
      { accountId: assignee3.value.trim(), role: role3.value.trim() }
    ];
    if (assignments.some((assignment) => !assignment.accountId || !assignment.role)) {
      throw new Error("Please provide accountId and role for all 3 frontend assignments.");
    }

    const connectionSettings = collectConnectionSettings();
    validateConnectionSettings(connectionSettings);

    await getStorageSync().set({
      jiraBaseUrl: connectionSettings.baseUrl,
      jiraAuthMode: connectionSettings.authScheme === "bearer" ? "bearer" : "basic",
      jiraAuthScheme: connectionSettings.authScheme,
      jiraAuthEmail: connectionSettings.email,
      jiraAuthApiToken: connectionSettings.apiToken,
      jiraAuthBearerToken: connectionSettings.apiToken,
      jiraForceBearerOnly: false,
      jiraApiRootOverride: connectionSettings.apiRootOverride || "",
      frontendAssignees: assignments.map((assignment) => assignment.accountId),
      frontendAssignments: assignments,
      subtaskTemplate: subtaskTemplate.value.trim() || DEFAULT_TEMPLATE
    });
    renderStatus("All settings saved.");
  } catch (error) {
    renderStatus(error.message, true);
  }
}

function renderStatus(message, isError = false) {
  status.textContent = message;
  status.style.color = isError ? "#c62828" : "#1b5e20";
}

async function onSaveSlackSettings() {
  try {
    const webhookUrl = slackWebhookUrl.value.trim();
    const userId = slackUserId.value.trim();
    if (webhookUrl) {
      // Fail fast on an obviously malformed URL rather than silently saving something that will
      // just error out with a confusing "Failed to fetch" the next time an issue is created.
      try {
        new URL(webhookUrl);
      } catch (_error) {
        throw new Error("Slack webhook URL doesn't look like a valid URL.");
      }
    }

    await getStorageSync().set({
      slackWebhookUrl: webhookUrl,
      slackUserId: userId
    });
    renderSlackStatus("Slack settings saved.");
  } catch (error) {
    renderSlackStatus(error.message, true);
  }
}

function renderSlackStatus(message, isError = false) {
  slackStatus.textContent = message;
  slackStatus.style.color = isError ? "#c62828" : "#1b5e20";
}

