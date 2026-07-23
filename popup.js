"use strict";

const DEFAULT_SETTINGS = {
  jiraBaseUrl: "",
  jiraProjectKey: "",
  frontendAssignees: [],
  frontendAssignments: [],
  slackWebhookUrl: ""
};

function getStorageSync() {
  const storageSync = globalThis.chrome?.storage?.sync;
  if (!storageSync) {
    throw new Error(
      "Extension storage API is unavailable. Reload the extension in chrome://extensions and try again."
    );
  }
  return storageSync;
}

const elements = {
  // The Jira URL is configured once in the Options page, not here - this plain object keeps
  // that value in-memory (synced from storage in init()) so the rest of the popup's logic can
  // keep reading `elements.baseUrl.value` exactly as it did when this used to be a real input.
  baseUrl: { value: "" },
  connectedDomain: document.getElementById("connectedDomain"),
  projectSearch: document.getElementById("projectSearch"),
  projectDropdown: document.getElementById("projectDropdown"),
  projectStatus: document.getElementById("projectStatus"),
  // Not a real input - the project key is only ever set programmatically via selectProject(),
  // mirroring the elements.baseUrl pattern so every existing `elements.projectKey.value` call
  // site across the file keeps working unchanged.
  projectKey: { value: "" },
  connectionStatus: document.getElementById("connectionStatus"),
  mode: document.getElementById("mode"),
  updateSection: document.getElementById("updateSection"),
  issueSearch: document.getElementById("issueSearch"),
  issueDropdown: document.getElementById("issueDropdown"),
  issueStatus: document.getElementById("issueStatus"),
  issueType: document.getElementById("issueType"),
  issueTypeIcon: document.getElementById("issueTypeIcon"),
  summary: document.getElementById("summary"),
  details: document.getElementById("details"),
  detailsPreview: document.getElementById("detailsPreview"),
  assigneeSection: document.getElementById("assigneeSection"),
  assigneeSearch: document.getElementById("assigneeSearch"),
  assigneeDropdown: document.getElementById("assigneeDropdown"),
  assigneeStatus: document.getElementById("assigneeStatus"),
  epicSection: document.getElementById("epicSection"),
  epicSearch: document.getElementById("epicSearch"),
  epicDropdown: document.getElementById("epicDropdown"),
  epicStatus: document.getElementById("epicStatus"),
  frontendOptions: document.getElementById("frontendOptions"),
  frontendAssignees: document.getElementById("frontendAssignees"),
  devicePills: document.getElementById("devicePills"),
  deviceStatus: document.getElementById("deviceStatus"),
  frontendRequiredMark: document.getElementById("frontendRequiredMark"),
  slackSection: document.getElementById("slackSection"),
  sendToSlack: document.getElementById("sendToSlack"),
  slackFields: document.getElementById("slackFields"),
  slackPriority: document.getElementById("slackPriority"),
  slackProduct: document.getElementById("slackProduct"),
  slackEta: document.getElementById("slackEta"),
  slackFigma: document.getElementById("slackFigma"),
  slackChannelFeature: document.getElementById("slackChannelFeature"),
  slackStatus: document.getElementById("slackStatus"),
  submitButton: document.getElementById("submitButton"),
  resultStatus: document.getElementById("resultStatus")
};

const FRONTEND_DEVICE_OPTIONS = ["Android", "iOS", "Web"];
let selectedDevices = [];
let slackWebhookConfigured = false;

let cachedIssues = [];
// True while loadIssuesForUpdate() has an in-flight fetch for the currently selected project +
// issue type - lets the Issue search box show "Loading issues..." instead of a misleading
// empty/"no matches" state while the fetch is still in flight.
let issuesLoading = false;
let selectedUpdateIssue = null;
let issueDropdownItems = [];
let issueHighlightIndex = -1;
let cachedProjects = [];
let cachedAssignableUsers = [];
let cachedEpics = [];
// True while loadEpics() has an in-flight fetch for the currently selected project - lets the
// Epic search box show "Loading epics..." instead of the misleading "Select a project first."
// while a project is selected but its epics haven't arrived yet.
let epicsLoading = false;
let selectedProject = null;

let selectedAssignee = null;
let selectedEpic = null;
let projectDropdownItems = [];
let assigneeDropdownItems = [];
let epicDropdownItems = [];
let projectHighlightIndex = -1;
let assigneeHighlightIndex = -1;
let epicHighlightIndex = -1;
let assigneeSearchDebounceId = null;

init().catch((error) => {
  setStatus(elements.resultStatus, `Initialization error: ${error.message}`, true);
});

async function init() {
  const settings = await getStorageSync().get(DEFAULT_SETTINGS);
  elements.baseUrl.value = settings.jiraBaseUrl || "";
  updateConnectedDomainText();
  setProjectOptions([], settings.jiraProjectKey || "");
  setAssigneeOptions([]);
  setEpicOptions([]);
  renderFrontendAssignees(settings);
  // Ask background.js whether a Slack webhook URL has been configured in Options before
  // enabling the checkbox. Defaults to false if the check itself fails for any reason, so the
  // checkbox is never misleadingly enabled.
  try {
    const webhookCheck = await chrome.runtime.sendMessage({ action: "hasSlackWebhook" });
    slackWebhookConfigured = Boolean(webhookCheck.ok && webhookCheck.hasWebhook);
  } catch (_error) {
    slackWebhookConfigured = false;
  }
  elements.sendToSlack.checked = false;
  updateSlackAvailability();

  elements.mode.addEventListener("change", onModeChanged);
  elements.issueType.addEventListener("change", onModeChanged);
  elements.projectSearch.addEventListener("input", onProjectSearchInput);
  elements.projectSearch.addEventListener("focus", onProjectFocus);
  elements.projectSearch.addEventListener("blur", onProjectBlur);
  elements.projectSearch.addEventListener("keydown", onProjectKeydown);
  elements.assigneeSearch.addEventListener("input", onAssigneeSearchInput);
  elements.assigneeSearch.addEventListener("focus", onAssigneeFocus);
  elements.assigneeSearch.addEventListener("blur", onAssigneeBlur);
  elements.assigneeSearch.addEventListener("keydown", onAssigneeKeydown);
  elements.epicSearch.addEventListener("input", onEpicSearchInput);
  elements.epicSearch.addEventListener("focus", onEpicFocus);
  elements.epicSearch.addEventListener("blur", onEpicBlur);
  elements.epicSearch.addEventListener("keydown", onEpicKeydown);
  elements.issueSearch.addEventListener("input", onIssueSearchInput);
  elements.issueSearch.addEventListener("focus", onIssueFocus);
  elements.issueSearch.addEventListener("blur", onIssueBlur);
  elements.issueSearch.addEventListener("keydown", onIssueKeydown);
  elements.details.addEventListener("input", updateDetailsPreview);
  elements.submitButton.addEventListener("click", onSubmit);
  elements.sendToSlack.addEventListener("change", updateSlackFieldsVisibility);

  onModeChanged();
  updateDetailsPreview();
  await autoConnectAndLoadProjects();
}

function updateSlackFieldsVisibility() {
  elements.slackFields.classList.toggle("hidden", !elements.sendToSlack.checked);
}

// The Slack "Front Request" webhook payload's `device` field is derived directly from whichever
// frontend platform pill(s) are selected (see notifySlackWorkflow() in background.js) - sending
// it with no platform selected at all would post a message with an empty/missing device, which
// doesn't correspond to anything meaningful in the Slack workflow. So the "Send to Slack
// workflow" checkbox must only ever be available once at least one platform pill is selected,
// on top of the existing "a webhook URL is configured in Options" requirement.
function updateSlackAvailability() {
  const hasDevice = selectedDevices.length > 0;
  elements.sendToSlack.disabled = !slackWebhookConfigured || !hasDevice;
  if (elements.sendToSlack.disabled) {
    elements.sendToSlack.checked = false;
  }
  if (!slackWebhookConfigured) {
    elements.slackStatus.textContent = "Configure a Slack webhook URL in extension Options to enable this.";
  } else if (!hasDevice) {
    elements.slackStatus.textContent = "Select a frontend platform above to enable this.";
  } else {
    elements.slackStatus.textContent = "";
  }
  updateSlackFieldsVisibility();
}

function onModeChanged() {
  const isUpdate = elements.mode.value === "update";
  elements.updateSection.classList.toggle("hidden", !isUpdate);

  const showFrontendOptions =
    !isUpdate && (elements.issueType.value === "Story" || elements.issueType.value === "Task");
  elements.frontendOptions.classList.toggle("hidden", !showFrontendOptions);
  elements.frontendAssignees.classList.toggle(
    "hidden",
    elements.issueType.value !== "Story" || isUpdate
  );
  elements.slackSection.classList.toggle("hidden", !showFrontendOptions);
  elements.assigneeSection.classList.toggle("hidden", isUpdate);
  const showEpicSelector = isParentEpicRequired();
  elements.epicSection.classList.toggle("hidden", !showEpicSelector);
  updateEpicStatusText();
  updateIssueTypeIcon();

  if (showFrontendOptions) {
    if (elements.issueType.value === "Task" && selectedDevices.length > 1) {
      selectedDevices = selectedDevices.slice(0, 1);
    }
    renderDevicePills();
  } else {
    // Switching to Epic (or Update mode) hides the pills/Slack section entirely - still run
    // updateSlackAvailability() so the checkbox gets unchecked/disabled immediately rather than
    // keeping a stale checked state from a previous Story/Task selection.
    updateSlackAvailability();
  }

  if (isUpdate) {
    // The Issue Type dropdown now drives *which* issues are searchable below it (instead of
    // being disabled/stale as before) - any previously-fetched list/selection belongs to a
    // different type and must be dropped before refetching.
    clearIssueSelection();
    loadIssuesForUpdate().catch((error) => setStatus(elements.resultStatus, error.message, true));
  }
}

// Renders the Android/iOS/Web platform pills. Story allows any combination (multi-select, one
// frontend subtask created per selected pill); Task allows only one selection at a time (acts
// like a radio group) since it's purely descriptive metadata rather than a subtask driver.
function renderDevicePills() {
  const isStory = elements.issueType.value === "Story";
  elements.frontendRequiredMark.classList.add("hidden");
  elements.devicePills.innerHTML = "";
  for (const device of FRONTEND_DEVICE_OPTIONS) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "pill";
    pill.textContent = device;
    pill.classList.toggle("is-selected", selectedDevices.includes(device));
    pill.addEventListener("click", () => toggleDevice(device, isStory));
    elements.devicePills.appendChild(pill);
  }
  updateDeviceStatusText();
  updateSlackAvailability();
}

function toggleDevice(device, isStory) {
  if (isStory) {
    selectedDevices = selectedDevices.includes(device)
      ? selectedDevices.filter((selected) => selected !== device)
      : [...selectedDevices, device];
  } else {
    selectedDevices = selectedDevices.includes(device) ? [] : [device];
  }
  renderDevicePills();
}

function updateDeviceStatusText() {
  const isStory = elements.issueType.value === "Story";
  if (isStory) {
    elements.deviceStatus.textContent = selectedDevices.length
      ? `Will create a frontend subtask for: ${selectedDevices.join(", ")}`
      : "No frontend subtasks will be created.";
  } else {
    elements.deviceStatus.textContent = selectedDevices.length
      ? `Platform: ${selectedDevices[0]}`
      : "No platform selected.";
  }
}


// Jira color-codes each issue type (purple bolt = Epic, green bookmark = Story, blue check =
// Task); mirror that here since native <select><option> elements can't render inline images.
function updateIssueTypeIcon() {
  const iconFile = `icons/issuetype-${elements.issueType.value.toLowerCase()}-32.png`;
  elements.issueTypeIcon.style.backgroundImage = `url("${chrome.runtime.getURL(iconFile)}")`;
}

function isParentEpicRequired() {
  return (
    elements.mode.value === "create" &&
    (elements.issueType.value === "Story" || elements.issueType.value === "Task")
  );
}

function setStatus(element, message, isError = false) {
  element.textContent = message;
  element.style.color = isError ? "#c62828" : "#1b5e20";
}

// Builds a clickable link to an issue's Jira page (e.g. https://your-domain/browse/KEY-123),
// used by setIssueResultStatus below so success messages let you jump straight to the
// created/updated issue instead of just naming its key as plain text.
function buildIssueLink(baseUrl, issueKey) {
  const link = document.createElement("a");
  const trimmed = String(baseUrl || "").trim();
  // jiraBaseUrl is stored without a protocol (just the domain, e.g. "jira.vptech.eu") - a bare
  // domain string has no scheme, so it would otherwise be treated as a relative path rather than
  // an absolute Jira URL. Add https:// whenever it's missing, mirroring normalizeBaseUrl() in
  // background.js.
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  link.href = `${withProtocol.replace(/\/+$/, "")}/browse/${issueKey}`;
  link.textContent = issueKey;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

// Renders a result status message as a mix of plain text and clickable issue-key links.
// `segments` is an array where each entry is either a string (rendered as text) or
// `{ key, baseUrl }` (rendered as a link to that issue). Replaces plain setStatus() for the
// "issue created/updated" success messages so users can click straight through to Jira.
function setIssueResultStatus(element, segments) {
  element.textContent = "";
  element.style.color = "#1b5e20";
  for (const segment of segments) {
    if (typeof segment === "string") {
      if (segment) {
        element.appendChild(document.createTextNode(segment));
      }
    } else if (segment && segment.key) {
      element.appendChild(buildIssueLink(segment.baseUrl, segment.key));
    }
  }
}

function renderFrontendAssignees(settings) {
  const assignments = normalizeFrontendAssignments(
    settings.frontendAssignments || [],
    settings.frontendAssignees || []
  );

  if (!assignments.length) {
    elements.frontendAssignees.textContent =
      "No frontend assignees configured yet. Set them in Options.";
    return;
  }
  elements.frontendAssignees.textContent = `Frontend assignees: ${assignments
    .map((assignment) => `${assignment.role}: ${assignment.accountId}`)
    .join(", ")}`;
}

function normalizeFrontendAssignments(frontendAssignments, frontendAssignees) {
  if (Array.isArray(frontendAssignments) && frontendAssignments.length) {
    return frontendAssignments
      .map((assignment) => ({
        accountId: String(assignment?.accountId || "").trim(),
        role: String(assignment?.role || "").trim()
      }))
      .filter((assignment) => assignment.accountId && assignment.role);
  }

  const fallbackRoles = ["Android", "iOS", "Web"];
  return (frontendAssignees || [])
    .slice(0, 3)
    .map((accountId, index) => ({
      accountId: String(accountId || "").trim(),
      role: fallbackRoles[index]
    }))
    .filter((assignment) => assignment.accountId);
}

function setProjectOptions(projects, selectedKey = "") {
  cachedProjects = [...projects];
  const selected = (selectedKey || selectedProject?.key || "").trim();
  if (!selected) {
    updateProjectStatusText();
    return;
  }

  const match = cachedProjects.find((project) => project.key === selected);
  if (match) {
    selectedProject = match;
    elements.projectKey.value = match.key;
    elements.projectSearch.value = `${match.name} (${match.key})`;
  } else if (!selectedProject || selectedProject.key !== selected) {
    // Keep the previously selected/stored project key visible even before the real project list
    // has loaded (e.g. right after opening the popup, before `loadProjects()` resolves). Without
    // this, the field would blank out on the initial render and, by the time the real project
    // list arrives, the stored selection would already look lost - this was the root cause of
    // "my project selection isn't remembered".
    selectedProject = { key: selected, name: selected };
    elements.projectKey.value = selected;
    elements.projectSearch.value = `${selected} (loading...)`;
  }
  updateProjectStatusText();
}

function clearProjectSelection() {
  selectedProject = null;
  elements.projectKey.value = "";
  elements.projectSearch.value = "";
  updateProjectStatusText();
}

function openProjectDropdown() {
  elements.projectDropdown.classList.remove("hidden");
}

function closeProjectDropdown() {
  elements.projectDropdown.classList.add("hidden");
  projectHighlightIndex = -1;
}

// Projects are already fully fetched on connect (see loadProjects), so this filters instantly on
// every keystroke - no debounce or network round-trip needed, matching the epic combobox.
function renderProjectDropdown(projects, statusText = "") {
  const items = projects.map((project) => ({ project }));
  projectDropdownItems = items;
  projectHighlightIndex = -1;
  elements.projectDropdown.innerHTML = "";

  if (statusText) {
    const status = document.createElement("div");
    status.className = "combobox-status";
    status.textContent = statusText;
    elements.projectDropdown.appendChild(status);
  }

  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "combobox-item";
    row.dataset.index = String(index);
    row.textContent = `${item.project.name} (${item.project.key})`;
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      selectProject(item.project);
    });
    elements.projectDropdown.appendChild(row);
  });

  openProjectDropdown();
}

function highlightProjectItem(index) {
  const rows = elements.projectDropdown.querySelectorAll(".combobox-item");
  rows.forEach((row, rowIndex) => row.classList.toggle("is-highlighted", rowIndex === index));
  projectHighlightIndex = index;
}

function selectProject(project) {
  const previousKey = selectedProject?.key || "";
  selectedProject = project || null;
  elements.projectKey.value = project ? project.key : "";
  elements.projectSearch.value = project ? `${project.name} (${project.key})` : "";
  closeProjectDropdown();
  updateProjectStatusText();
  if (project && project.key !== previousKey) {
    onProjectSelectionChanged();
  }
}

function filterProjects(query) {
  return query
    ? cachedProjects.filter((project) => `${project.key} ${project.name}`.toLowerCase().includes(query.toLowerCase()))
    : cachedProjects;
}

function onProjectFocus() {
  const query = elements.projectSearch.value.trim();
  const filtered = filterProjects(query);
  renderProjectDropdown(filtered, cachedProjects.length ? "" : "Loading projects...");
}

function onProjectBlur() {
  setTimeout(() => closeProjectDropdown(), 150);
}

function onProjectSearchInput() {
  selectedProject = null;
  elements.projectKey.value = "";
  const query = elements.projectSearch.value.trim();
  const filtered = filterProjects(query);
  renderProjectDropdown(filtered, filtered.length ? "" : "No matching projects.");
  updateProjectStatusText();
}

function onProjectKeydown(event) {
  const dropdownHidden = elements.projectDropdown.classList.contains("hidden");
  if (dropdownHidden && event.key !== "ArrowDown") {
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (dropdownHidden) {
      onProjectFocus();
      return;
    }
    highlightProjectItem(Math.min(projectHighlightIndex + 1, projectDropdownItems.length - 1));
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    highlightProjectItem(Math.max(projectHighlightIndex - 1, 0));
  } else if (event.key === "Enter") {
    event.preventDefault();
    const index = projectHighlightIndex >= 0 ? projectHighlightIndex : 0;
    const item = projectDropdownItems[index];
    if (item) {
      selectProject(item.project);
    }
  } else if (event.key === "Escape") {
    closeProjectDropdown();
  }
}

function updateProjectStatusText() {
  if (selectedProject) {
    elements.projectStatus.textContent = `Selected project: ${selectedProject.name} (${selectedProject.key})`;
    elements.projectStatus.classList.remove("warning");
  } else {
    elements.projectStatus.textContent = "Project is required";
    elements.projectStatus.classList.add("warning");
  }
}

function setAssigneeOptions(users, selectedAccountId = "") {
  cachedAssignableUsers = [...users];
  const selected = (selectedAccountId || "").trim();
  if (selected) {
    const match = cachedAssignableUsers.find((user) => user.accountId === selected);
    if (match) {
      selectedAssignee = match;
      elements.assigneeSearch.value = formatAssigneeLabel(match);
    }
  }
  updateAssigneeStatusText();
}

function clearAssigneeSelection() {
  selectedAssignee = null;
  elements.assigneeSearch.value = "";
  updateAssigneeStatusText();
}

function formatAssigneeLabel(user) {
  const email = user.emailAddress ? ` - ${user.emailAddress}` : "";
  return `${user.displayName}${email}`;
}

function updateAssigneeStatusText() {
  elements.assigneeStatus.textContent = selectedAssignee
    ? `Selected assignee: ${formatAssigneeLabel(selectedAssignee)}`
    : "Default assignment: Unassigned";
}

function openAssigneeDropdown() {
  elements.assigneeDropdown.classList.remove("hidden");
}

function closeAssigneeDropdown() {
  elements.assigneeDropdown.classList.add("hidden");
  assigneeHighlightIndex = -1;
}

// Renders the live dropdown for the assignee combobox - `users` is whatever should currently be
// offered (either the small per-project default list, or the results of a server-side
// `/user/picker` search). A pinned "Unassigned (default)" row is always shown first.
function renderAssigneeDropdown(users, statusText = "") {
  const items = [{ type: "unassigned" }, ...users.map((user) => ({ type: "user", user }))];
  assigneeDropdownItems = items;
  assigneeHighlightIndex = -1;
  elements.assigneeDropdown.innerHTML = "";

  if (statusText) {
    const status = document.createElement("div");
    status.className = "combobox-status";
    status.textContent = statusText;
    elements.assigneeDropdown.appendChild(status);
  }

  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "combobox-item";
    row.textContent =
      item.type === "unassigned" ? "Unassigned (default)" : formatAssigneeLabel(item.user);
    row.dataset.index = String(index);
    // mousedown (not click) fires before the input's blur handler, so the selection commits
    // before the blur-triggered close-with-delay would otherwise race it.
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      selectAssignee(item.type === "unassigned" ? null : item.user);
    });
    elements.assigneeDropdown.appendChild(row);
  });

  openAssigneeDropdown();
}

function highlightAssigneeItem(index) {
  const rows = elements.assigneeDropdown.querySelectorAll(".combobox-item");
  rows.forEach((row, rowIndex) => row.classList.toggle("is-highlighted", rowIndex === index));
  assigneeHighlightIndex = index;
}

function selectAssignee(user) {
  selectedAssignee = user || null;
  elements.assigneeSearch.value = user ? formatAssigneeLabel(user) : "";
  closeAssigneeDropdown();
  updateAssigneeStatusText();
}

function onAssigneeFocus() {
  const query = elements.assigneeSearch.value.trim();
  if (query) {
    onAssigneeSearchInput();
    return;
  }
  const projectKey = elements.projectKey.value.trim();
  renderAssigneeDropdown(cachedAssignableUsers, projectKey ? "" : "Select a project first.");
}

function onAssigneeBlur() {
  setTimeout(() => closeAssigneeDropdown(), 150);
}

function onAssigneeKeydown(event) {
  const dropdownHidden = elements.assigneeDropdown.classList.contains("hidden");
  if (dropdownHidden && event.key !== "ArrowDown") {
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (dropdownHidden) {
      onAssigneeFocus();
      return;
    }
    highlightAssigneeItem(Math.min(assigneeHighlightIndex + 1, assigneeDropdownItems.length - 1));
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    highlightAssigneeItem(Math.max(assigneeHighlightIndex - 1, 0));
  } else if (event.key === "Enter") {
    event.preventDefault();
    const index = assigneeHighlightIndex >= 0 ? assigneeHighlightIndex : 0;
    const item = assigneeDropdownItems[index];
    if (item) {
      selectAssignee(item.type === "unassigned" ? null : item.user);
    }
  } else if (event.key === "Escape") {
    closeAssigneeDropdown();
  }
}

function setEpicOptions(epics, selectedEpicKey = "") {
  cachedEpics = [...epics];
  const selected = (selectedEpicKey || "").trim();
  if (selected) {
    const match = cachedEpics.find((epic) => epic.key === selected);
    if (match) {
      selectedEpic = match;
      elements.epicSearch.value = `${match.key} - ${match.summary}`;
    }
  }
  updateEpicStatusText();
}

function clearEpicSelection() {
  selectedEpic = null;
  elements.epicSearch.value = "";
  updateEpicStatusText();
}

function openEpicDropdown() {
  elements.epicDropdown.classList.remove("hidden");
}

function closeEpicDropdown() {
  elements.epicDropdown.classList.add("hidden");
  epicHighlightIndex = -1;
}

function filterEpics(query) {
  return query
    ? cachedEpics.filter((epic) => `${epic.key} ${epic.summary}`.toLowerCase().includes(query.toLowerCase()))
    : cachedEpics;
}

// Epics are already fully fetched per-project (see loadEpics), so this filters instantly/locally
// on every keystroke - no debounce or network round-trip needed.
function renderEpicDropdown(epics, statusText = "") {
  const includeClearOption = !isParentEpicRequired();
  const items = includeClearOption
    ? [{ type: "clear" }, ...epics.map((epic) => ({ type: "epic", epic }))]
    : epics.map((epic) => ({ type: "epic", epic }));
  epicDropdownItems = items;
  epicHighlightIndex = -1;
  elements.epicDropdown.innerHTML = "";

  if (statusText) {
    const status = document.createElement("div");
    status.className = "combobox-status";
    status.textContent = statusText;
    elements.epicDropdown.appendChild(status);
  }

  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "combobox-item";
    row.dataset.index = String(index);
    if (item.type === "clear") {
      row.textContent = "No parent epic";
    } else {
      const icon = document.createElement("span");
      icon.className = "combobox-item-icon issuetype-icon";
      icon.style.backgroundImage = `url("${chrome.runtime.getURL("icons/issuetype-epic-32.png")}")`;
      icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = `${item.epic.key} - ${item.epic.summary}`;
      row.appendChild(icon);
      row.appendChild(label);
    }
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      selectEpic(item.type === "clear" ? null : item.epic);
    });
    elements.epicDropdown.appendChild(row);
  });

  openEpicDropdown();
}

function highlightEpicItem(index) {
  const rows = elements.epicDropdown.querySelectorAll(".combobox-item");
  rows.forEach((row, rowIndex) => row.classList.toggle("is-highlighted", rowIndex === index));
  epicHighlightIndex = index;
}

function selectEpic(epic) {
  selectedEpic = epic || null;
  elements.epicSearch.value = epic ? `${epic.key} - ${epic.summary}` : "";
  closeEpicDropdown();
  updateEpicStatusText();
}

function onEpicFocus() {
  if (epicsLoading) {
    renderEpicDropdown([], "Loading epics...");
    return;
  }
  const query = elements.epicSearch.value.trim();
  const filtered = filterEpics(query);
  renderEpicDropdown(filtered, cachedEpics.length ? "" : "Select a project first.");
}

function onEpicBlur() {
  setTimeout(() => closeEpicDropdown(), 150);
}

function onEpicKeydown(event) {
  const dropdownHidden = elements.epicDropdown.classList.contains("hidden");
  if (dropdownHidden && event.key !== "ArrowDown") {
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (dropdownHidden) {
      onEpicFocus();
      return;
    }
    highlightEpicItem(Math.min(epicHighlightIndex + 1, epicDropdownItems.length - 1));
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    highlightEpicItem(Math.max(epicHighlightIndex - 1, 0));
  } else if (event.key === "Enter") {
    event.preventDefault();
    const index = epicHighlightIndex >= 0 ? epicHighlightIndex : 0;
    const item = epicDropdownItems[index];
    if (item) {
      selectEpic(item.type === "clear" ? null : item.epic);
    }
  } else if (event.key === "Escape") {
    closeEpicDropdown();
  }
}

function updateEpicStatusText() {
  if (selectedEpic) {
    elements.epicStatus.textContent = `Selected epic: ${selectedEpic.key} - ${selectedEpic.summary}`;
    elements.epicStatus.classList.remove("warning");
    return;
  }
  if (epicsLoading) {
    elements.epicStatus.textContent = "Loading epics...";
    elements.epicStatus.classList.remove("warning");
    return;
  }
  if (isParentEpicRequired()) {
    elements.epicStatus.textContent = "Parent epic is required";
    elements.epicStatus.classList.add("warning");
  } else {
    elements.epicStatus.textContent = "No parent epic selected";
    elements.epicStatus.classList.remove("warning");
  }
}

function clearIssueSelection() {
  selectedUpdateIssue = null;
  elements.issueSearch.value = "";
  elements.summary.value = "";
  elements.details.value = "";
  updateDetailsPreview();
  updateIssueStatusText();
}

function openIssueDropdown() {
  elements.issueDropdown.classList.remove("hidden");
}

function closeIssueDropdown() {
  elements.issueDropdown.classList.add("hidden");
  issueHighlightIndex = -1;
}

function filterIssues(query) {
  return query
    ? cachedIssues.filter((issue) => `${issue.key} ${issue.summary}`.toLowerCase().includes(query.toLowerCase()))
    : cachedIssues;
}

// Issues are fetched once per project+issue-type combination (see loadIssuesForUpdate), then
// filtered locally on every keystroke here - same "live"/no-debounce pattern as the Epic
// combobox, since the full candidate list is already in memory.
function renderIssueDropdown(issues, statusText = "") {
  const items = issues.map((issue) => ({ type: "issue", issue }));
  issueDropdownItems = items;
  issueHighlightIndex = -1;
  elements.issueDropdown.innerHTML = "";

  if (statusText) {
    const status = document.createElement("div");
    status.className = "combobox-status";
    status.textContent = statusText;
    elements.issueDropdown.appendChild(status);
  }

  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "combobox-item";
    row.dataset.index = String(index);
    const label = document.createElement("span");
    label.textContent = `${item.issue.key} - ${item.issue.summary}`;
    row.appendChild(label);
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      selectIssue(item.issue);
    });
    elements.issueDropdown.appendChild(row);
  });

  openIssueDropdown();
}

function highlightIssueItem(index) {
  const rows = elements.issueDropdown.querySelectorAll(".combobox-item");
  rows.forEach((row, rowIndex) => row.classList.toggle("is-highlighted", rowIndex === index));
  issueHighlightIndex = index;
}

// Selecting an issue always overwrites Title/Details with that issue's real current content -
// this is "load this issue for editing", so any leftover text from a previous selection must be
// replaced, not merged, to avoid submitting the wrong issue's data.
async function selectIssue(issue) {
  selectedUpdateIssue = issue || null;
  elements.issueSearch.value = issue ? `${issue.key} - ${issue.summary}` : "";
  closeIssueDropdown();
  updateIssueStatusText();

  if (!issue) {
    elements.summary.value = "";
    elements.details.value = "";
    updateDetailsPreview();
    return;
  }

  setStatus(elements.resultStatus, `Loading ${issue.key}...`);
  try {
    const response = await chrome.runtime.sendMessage({
      action: "getIssueDetails",
      baseUrl: elements.baseUrl.value.trim(),
      issueKey: issue.key
    });
    if (!response.ok) {
      throw new Error(response.error);
    }
    elements.summary.value = response.summary || "";
    elements.details.value = response.details || "";
    updateDetailsPreview();
    setStatus(elements.resultStatus, `Loaded ${issue.key}.`);
  } catch (error) {
    setStatus(elements.resultStatus, error.message, true);
  }
}

function onIssueFocus() {
  if (issuesLoading) {
    renderIssueDropdown([], "Loading issues...");
    return;
  }
  const query = elements.issueSearch.value.trim();
  const filtered = filterIssues(query);
  renderIssueDropdown(filtered, cachedIssues.length ? "" : "Select a project and issue type first.");
}

function onIssueBlur() {
  setTimeout(() => closeIssueDropdown(), 150);
}

function onIssueSearchInput() {
  selectedUpdateIssue = null;
  if (issuesLoading) {
    renderIssueDropdown([], "Loading issues...");
    updateIssueStatusText();
    return;
  }
  if (!cachedIssues.length) {
    renderIssueDropdown([], "Select a project and issue type first.");
    updateIssueStatusText();
    return;
  }
  const query = elements.issueSearch.value.trim();
  const filtered = filterIssues(query);
  renderIssueDropdown(filtered, filtered.length ? "" : "No matching issues.");
  updateIssueStatusText();
}

function onIssueKeydown(event) {
  const dropdownHidden = elements.issueDropdown.classList.contains("hidden");
  if (dropdownHidden && event.key !== "ArrowDown") {
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (dropdownHidden) {
      onIssueFocus();
      return;
    }
    highlightIssueItem(Math.min(issueHighlightIndex + 1, issueDropdownItems.length - 1));
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    highlightIssueItem(Math.max(issueHighlightIndex - 1, 0));
  } else if (event.key === "Enter") {
    event.preventDefault();
    const index = issueHighlightIndex >= 0 ? issueHighlightIndex : 0;
    const item = issueDropdownItems[index];
    if (item) {
      selectIssue(item.issue);
    }
  } else if (event.key === "Escape") {
    closeIssueDropdown();
  }
}

function updateIssueStatusText() {
  if (issuesLoading) {
    elements.issueStatus.textContent = "Loading issues...";
    return;
  }
  if (selectedUpdateIssue) {
    elements.issueStatus.textContent = `Editing ${selectedUpdateIssue.key}.`;
    return;
  }
  if (!cachedIssues.length) {
    elements.issueStatus.textContent = "Select a project and issue type first";
    return;
  }
  elements.issueStatus.textContent = "Select an issue to update";
}


function updateDetailsPreview() {
  const markdown = elements.details.value.trim();
  if (!markdown) {
    elements.detailsPreview.textContent = "Markdown preview will appear here.";
    return;
  }
  elements.detailsPreview.innerHTML = markdownToHtml(markdown);
}

function markdownToHtml(markdown) {
  const escaped = escapeHtml(markdown);
  const withCodeBlocks = escaped.replace(
    /```([\s\S]*?)```/g,
    (_match, code) => `<pre><code>${code.trim()}</code></pre>`
  );
  const lines = withCodeBlocks.split(/\n/);
  const html = [];
  let inUl = false;
  let inOl = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inUl) {
        html.push("</ul>");
        inUl = false;
      }
      if (inOl) {
        html.push("</ol>");
        inOl = false;
      }
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      if (inUl) {
        html.push("</ul>");
        inUl = false;
      }
      if (inOl) {
        html.push("</ol>");
        inOl = false;
      }
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdownToHtml(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (inOl) {
        html.push("</ol>");
        inOl = false;
      }
      if (!inUl) {
        html.push("<ul>");
        inUl = true;
      }
      html.push(`<li>${inlineMarkdownToHtml(bullet[1])}</li>`);
      continue;
    }

    const numbered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (numbered) {
      if (inUl) {
        html.push("</ul>");
        inUl = false;
      }
      if (!inOl) {
        html.push("<ol>");
        inOl = true;
      }
      html.push(`<li>${inlineMarkdownToHtml(numbered[1])}</li>`);
      continue;
    }

    if (inUl) {
      html.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      html.push("</ol>");
      inOl = false;
    }

    if (trimmed.startsWith("<pre><code>")) {
      html.push(trimmed);
    } else {
      html.push(`<p>${inlineMarkdownToHtml(trimmed)}</p>`);
    }
  }

  if (inUl) {
    html.push("</ul>");
  }
  if (inOl) {
    html.push("</ol>");
  }

  return html.join("") || "<p>Markdown preview will appear here.</p>";
}

function inlineMarkdownToHtml(text) {
  return text
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function saveCommonSettings() {
  await getStorageSync().set({
    jiraBaseUrl: elements.baseUrl.value.trim(),
    jiraProjectKey: elements.projectKey.value.trim()
  });
}

async function onProjectSelectionChanged() {
  clearAssigneeSelection();
  clearEpicSelection();
  clearIssueSelection();
  cachedAssignableUsers = [];
  cachedEpics = [];
  cachedIssues = [];
  // Mark epics as loading immediately (not just once loadEpics() itself fires) - loadAssignableUsers()
  // below runs first and can take a noticeable amount of time, and without this the epic search box
  // would show the misleading "Select a project first." for that whole window if the user starts
  // typing right after switching projects, instead of "Loading epics...".
  epicsLoading = true;
  updateEpicStatusText();
  await saveCommonSettings();
  await loadAssignableUsers();
  await loadEpics();
  if (elements.mode.value === "update") {
    await loadIssuesForUpdate().catch((error) => setStatus(elements.resultStatus, error.message, true));
  }
}

// Performs a live, debounced, server-side search via Jira's own `/user/picker` endpoint (the
// same one powering Jira's native assignee picker) instead of filtering a client-side cached
// list - the previous cached-list approach silently failed to find users who weren't included
// in the small default page `/user/assignable/search` returns without a query.
function onAssigneeSearchInput() {
  const projectKey = elements.projectKey.value.trim();
  const query = elements.assigneeSearch.value.trim();

  // Typing invalidates whatever was previously selected - a selection only counts once it is
  // re-confirmed by picking a row from the dropdown (or leaving the field blank for Unassigned).
  selectedAssignee = null;

  if (assigneeSearchDebounceId) {
    clearTimeout(assigneeSearchDebounceId);
    assigneeSearchDebounceId = null;
  }

  if (!projectKey) {
    renderAssigneeDropdown([], "Select a project first.");
    return;
  }

  if (!query) {
    renderAssigneeDropdown(cachedAssignableUsers);
    updateAssigneeStatusText();
    return;
  }

  renderAssigneeDropdown([], "Searching...");

  assigneeSearchDebounceId = setTimeout(async () => {
    try {
      const response = await chrome.runtime.sendMessage({
        action: "searchAssignableUsers",
        baseUrl: elements.baseUrl.value.trim(),
        projectKey,
        query
      });
      if (elements.assigneeSearch.value.trim() !== query) {
        // A newer keystroke has already superseded this in-flight request.
        return;
      }
      if (!response.ok) {
        renderAssigneeDropdown([], response.error || "Search failed.");
        return;
      }
      const users = response.users || [];
      renderAssigneeDropdown(users, users.length ? "" : "No matching users.");
    } catch (error) {
      renderAssigneeDropdown([], error.message || "Search failed.");
    }
  }, 250);
}

function onEpicSearchInput() {
  selectedEpic = null;
  if (epicsLoading) {
    renderEpicDropdown([], "Loading epics...");
    updateEpicStatusText();
    return;
  }
  if (!cachedEpics.length) {
    renderEpicDropdown([], "Select a project first.");
    updateEpicStatusText();
    return;
  }
  const query = elements.epicSearch.value.trim();
  const filtered = filterEpics(query);
  renderEpicDropdown(filtered, filtered.length ? "" : "No matching epics.");
  updateEpicStatusText();
}

async function loadIssuesForUpdate() {
  const projectKey = elements.projectKey.value.trim();
  const issueType = elements.issueType.value;
  if (!projectKey || !issueType) {
    cachedIssues = [];
    updateIssueStatusText();
    return cachedIssues;
  }
  await saveCommonSettings();
  issuesLoading = true;
  updateIssueStatusText();
  try {
    const response = await chrome.runtime.sendMessage({
      action: "listIssues",
      baseUrl: elements.baseUrl.value.trim(),
      projectKey,
      issueType
    });
    if (!response.ok) {
      throw new Error(response.error);
    }
    cachedIssues = response.issues || [];
    return cachedIssues;
  } finally {
    issuesLoading = false;
    updateIssueStatusText();
  }
}

async function onSubmit() {
  try {
    await saveCommonSettings();

    if (!elements.projectKey.value.trim()) {
      updateProjectStatusText();
      elements.projectSearch.focus();
      throw new Error("Select a Jira project before continuing.");
    }

    if (isParentEpicRequired() && !selectedEpic) {
      updateEpicStatusText();
      elements.epicSearch.focus();
      throw new Error("Select a parent Epic before creating a Story or Task.");
    }

    if (elements.mode.value === "update" && !selectedUpdateIssue) {
      updateIssueStatusText();
      elements.issueSearch.focus();
      throw new Error("Select an issue to update before continuing.");
    }

    const isCreate = elements.mode.value === "create";
    const isStory = elements.issueType.value === "Story";
    const isTask = elements.issueType.value === "Task";

    if (isCreate && elements.sendToSlack.checked) {
      if (!elements.slackPriority.value || !elements.slackProduct.value || !elements.slackEta.value) {
        elements.slackStatus.textContent = "Priority, Product and Expected ETA are required to send to Slack.";
        throw new Error("Fill in Priority, Product and Expected ETA before sending to Slack.");
      }
    }

    const payload = {
      baseUrl: elements.baseUrl.value.trim(),
      projectKey: elements.projectKey.value.trim(),
      mode: elements.mode.value,
      issueType: elements.issueType.value,
      issueKey: elements.mode.value === "update" && selectedUpdateIssue ? selectedUpdateIssue.key : "",
      summary: elements.summary.value.trim(),
      details: elements.details.value.trim(),
      assigneeAccountId:
        elements.mode.value === "create" && selectedAssignee ? selectedAssignee.accountId : "",
      parentEpicKey: isParentEpicRequired() && selectedEpic ? selectedEpic.key : "",
      frontendSubtaskRoles: isCreate && isStory ? selectedDevices : [],
      device: isCreate && isTask ? selectedDevices[0] || "" : "",
      slack:
        isCreate && elements.sendToSlack.checked
          ? {
              enabled: true,
              priority: elements.slackPriority.value,
              product: elements.slackProduct.value,
              expectedEta: elements.slackEta.value,
              figma: elements.slackFigma.value.trim(),
              channelFeature: elements.slackChannelFeature.value.trim()
            }
          : { enabled: false }
    };

    const response = await chrome.runtime.sendMessage({
      action: "submitIssue",
      payload
    });
    if (!response.ok) {
      throw new Error(response.error);
    }

    const slackWarningText =
      response.slackWarnings && response.slackWarnings.length
        ? ` ${response.slackWarnings.join("; ")}`
        : "";
    const subtaskWarningText =
      response.subtaskWarnings && response.subtaskWarnings.length
        ? ` ${response.subtaskWarnings.join("; ")}`
        : "";

    if (payload.mode === "update") {
      setIssueResultStatus(elements.resultStatus, [
        `${payload.issueType} `,
        { key: response.updatedIssueKey, baseUrl: payload.baseUrl },
        " updated."
      ]);
      clearIssueSelection();
      await loadIssuesForUpdate().catch(() => {});
      return;
    }

    const subtaskSegments = [];
    if (response.subtasks && response.subtasks.length) {
      subtaskSegments.push(" Subtasks: ");
      response.subtasks.forEach((subtaskKey, index) => {
        if (index > 0) {
          subtaskSegments.push(", ");
        }
        subtaskSegments.push({ key: subtaskKey, baseUrl: payload.baseUrl });
      });
    }
    setIssueResultStatus(elements.resultStatus, [
      `${payload.issueType} `,
      { key: response.created.key, baseUrl: payload.baseUrl },
      " created.",
      ...subtaskSegments,
      subtaskWarningText,
      slackWarningText
    ]);

    // The Parent Epic combobox filters a client-side cached list (see loadEpics), so a freshly
    // created Epic wouldn't show up as selectable for a Story/Task until the popup got reopened.
    // Refresh the cached epic list right after a successful Epic creation so it's immediately
    // available as a parent, without requiring a reopen.
    if (payload.issueType === "Epic") {
      await loadEpics().catch(() => {});
    }
  } catch (error) {
    setStatus(elements.resultStatus, error.message, true);
  }
}

// Extracts just the hostname (e.g. "your-company.atlassian.net") from the full configured base
// URL for a compact, read-only "which Jira am I talking to" display, now that the URL itself is
// only editable from the Options page.
function getJiraDomainFromBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch (_error) {
    return baseUrl;
  }
}

function updateConnectedDomainText() {
  const baseUrl = elements.baseUrl.value.trim();
  elements.connectedDomain.textContent = baseUrl
    ? `Jira: ${getJiraDomainFromBaseUrl(baseUrl)}`
    : 'Jira is not configured yet. Open "extension options" below to connect.';
}

async function autoConnectAndLoadProjects() {
  const baseUrl = elements.baseUrl.value.trim();
  updateConnectedDomainText();
  if (!baseUrl) {
    redirectToOptionsWithError("Jira is not configured yet. Opening extension options...");
    return;
  }

  try {
    await testConnection();
    // Same reasoning as onProjectSelectionChanged(): flag epics as loading up front so typing in
    // the epic search box during testConnection()/loadProjects()/loadAssignableUsers() (all of
    // which run before loadEpics() itself) shows "Loading epics..." instead of a stale/misleading
    // status.
    epicsLoading = true;
    updateEpicStatusText();
    await loadProjects();
    await loadAssignableUsers();
    await loadEpics();
    if (elements.mode.value === "update") {
      await loadIssuesForUpdate();
    }
  } catch (error) {
    redirectToOptionsWithError(`${error.message} Opening extension options to fix the connection...`);
  }
}

// Jira connection problems can't be fixed from the popup anymore (the URL/token fields live
// exclusively in Options now), so surface the error and send the user straight there instead of
// leaving them stuck looking at an empty project list.
function redirectToOptionsWithError(message) {
  setStatus(elements.connectionStatus, message, true);
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL("options.html"), "_blank");
  }
}

async function testConnection() {
  await saveCommonSettings();
  const response = await chrome.runtime.sendMessage({
    action: "testAuth",
    baseUrl: elements.baseUrl.value.trim()
  });
  if (!response.ok) {
    throw new Error(response.error);
  }

  setStatus(
    elements.connectionStatus,
    `Connected as ${response.user.displayName} (${response.user.accountId})`
  );

  return response.user;
}

async function loadProjects() {
  await saveCommonSettings();
  const response = await chrome.runtime.sendMessage({
    action: "listProjects",
    baseUrl: elements.baseUrl.value.trim()
  });
  if (!response.ok) {
    throw new Error(response.error);
  }

  const projects = response.projects || [];
  setProjectOptions(projects, elements.projectKey.value.trim());
  if (!projects.length) {
    throw new Error("No Jira projects found for this account.");
  }

  const selectedProjectKey = elements.projectKey.value.trim();
  const suffix = selectedProjectKey ? ` Selected project: ${selectedProjectKey}.` : "";
  setStatus(elements.connectionStatus, `Loaded ${projects.length} projects.${suffix}`);

  return projects;
}

async function loadAssignableUsers() {
  const projectKey = elements.projectKey.value.trim();
  if (!projectKey) {
    setAssigneeOptions([]);
    return [];
  }

  // Fetches a small default page of assignable users for this project - used to populate the
  // dropdown when the assignee field gets focus before the user has typed anything. Actual text
  // search is handled live/server-side via searchAssignableUsers (see onAssigneeSearchInput),
  // since this default page is not guaranteed to include every assignable user.
  const response = await chrome.runtime.sendMessage({
    action: "listAssignableUsers",
    baseUrl: elements.baseUrl.value.trim(),
    projectKey
  });
  if (!response.ok) {
    throw new Error(response.error);
  }

  const users = response.users || [];
  setAssigneeOptions(users, selectedAssignee ? selectedAssignee.accountId : "");
  return users;
}

async function loadEpics() {
  const projectKey = elements.projectKey.value.trim();
  if (!projectKey) {
    setEpicOptions([]);
    return [];
  }

  // Epic search input can be focused/typed into while this fetch is still in flight (e.g. right
  // after switching projects) - track loading state so the dropdown can show "Loading epics..."
  // instead of the misleading "Select a project first.", and so the dropdown/status text can be
  // refreshed automatically once the fetch resolves instead of only updating on the next keypress
  // (previously, typing while epics were still loading showed nothing until the field was
  // cleared and retyped, since only a fresh "input" event re-ran the filter against the by-then
  // populated list).
  epicsLoading = true;
  if (!elements.epicDropdown.classList.contains("hidden")) {
    renderEpicDropdown([], "Loading epics...");
  }
  updateEpicStatusText();

  try {
    const response = await chrome.runtime.sendMessage({
      action: "listEpics",
      baseUrl: elements.baseUrl.value.trim(),
      projectKey
    });
    if (!response.ok) {
      throw new Error(response.error);
    }

    const epics = response.epics || [];
    setEpicOptions(epics, selectedEpic ? selectedEpic.key : "");
    return epics;
  } finally {
    epicsLoading = false;
    if (!elements.epicDropdown.classList.contains("hidden") || document.activeElement === elements.epicSearch) {
      const query = elements.epicSearch.value.trim();
      renderEpicDropdown(filterEpics(query), cachedEpics.length ? "" : "No matching epics.");
    }
    updateEpicStatusText();
  }
}
