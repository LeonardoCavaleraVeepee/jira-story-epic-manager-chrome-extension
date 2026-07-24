// Shared, side-effect-free constants and utility functions used across this extension's UI
// surfaces - the Gemini side panel (gemini_integration.js), the toolbar popup (popup.js), the
// Options page (options.js), and the Jira page button (jira_page_button.js) where relevant.
// These were previously copy-pasted separately into each file and had already started drifting
// out of sync (e.g. slightly different comments, and at least one case - getJiraDomainFromBaseUrl
// - where a bug fix landed in only one copy) - keeping a single copy here means a fix or tweak
// only has to be made once and every surface gets it automatically.
//
// Deliberately NOT loaded by background.js: these functions assume a `document`/DOM is available
// (e.g. `buildIssueLink` calls `document.createElement`), which doesn't exist in the background
// service worker's context. background.js keeps its own small, separate copy of the couple of
// functions it needs (e.g. `getStorageSync`) rather than sharing a module across such different
// execution contexts, to avoid the added complexity/risk of moving the service worker to ES
// modules just for this.
//
// Loaded as a plain (non-module) script before its consumer in each place:
//   - manifest.json's content_scripts entries for gemini_integration.js and jira_page_button.js
//   - a <script> tag in popup.html, before popup.js
//   - a <script> tag in options.html, before options.js

// The three frontend platforms a Story/Task can be assigned to - drives the pill pickers in the
// create/update form (gemini_integration.js, popup.js) and the Jira-page Slack button
// (jira_page_button.js), and is used as the fallback role ordering in
// normalizeFrontendAssignments() below.
const FRONTEND_DEVICE_OPTIONS = ["Android", "iOS", "Web"];

// Escapes a string for safe insertion into innerHTML. Used anywhere user-provided or Jira-sourced
// text (issue summaries, Markdown content, etc.) is rendered as HTML instead of via
// textContent/createTextNode.
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Formats a user object (the { accountId, displayName, emailAddress, restricted? } shape returned
// by background.js's listAssignableUsers()/searchAssignableUsers()/getIssueDetails()) into the
// label shown in the Assignee combobox dropdown.
function formatAssigneeLabel(user) {
  const email = user.emailAddress ? ` - ${user.emailAddress}` : "";
  // `restricted` is set when this user was only found via the unscoped directory-wide fallback
  // search (see searchAssignableUsers in background.js) - i.e. they don't currently show up as
  // assignable on this specific project, so assigning them may still be rejected by Jira until a
  // project admin grants them that permission.
  const warning = user.restricted ? " ⚠ may lack assign permission on this project" : "";
  return `${user.displayName}${email}${warning}`;
}

// Extracts just the host (e.g. "your-domain.atlassian.net") from a stored base URL, for display
// purposes (e.g. "Connected to <domain>" status text). jiraBaseUrl may be stored either with or
// without a protocol depending on where it was saved from, so a missing protocol is assumed to be
// https:// before parsing (mirroring normalizeBaseUrl() in background.js) rather than just falling
// straight through to the raw-string fallback, which would only coincidentally look right for a
// bare domain and would show more than just the host for something like "jira.example.com/path".
function getJiraDomainFromBaseUrl(baseUrl) {
  try {
    const withProtocol = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
    return new URL(withProtocol).host;
  } catch (_error) {
    return baseUrl;
  }
}

// Thin accessor for chrome.storage.sync with a clear error if the extension APIs are unavailable
// (e.g. this script somehow got loaded outside of a proper extension context after an update -
// reloading the extension fixes it).
function getStorageSync() {
  const storageSync = globalThis.chrome?.storage?.sync;
  if (!storageSync) {
    throw new Error(
      "Extension storage API is unavailable. Reload the extension in chrome://extensions and try again."
    );
  }
  return storageSync;
}

// Normalizes the two ways frontend assignees can be configured in Options into one consistent
// `[{ accountId, role }]` shape: the newer explicit per-role mapping (`frontendAssignments`), or
// the older positional list (`frontendAssignees`, where index 0/1/2 implicitly meant
// Android/iOS/Web) kept for backward compatibility with settings saved before the explicit
// mapping existed.
function normalizeFrontendAssignments(frontendAssignments, frontendAssignees) {
  if (Array.isArray(frontendAssignments) && frontendAssignments.length) {
    return frontendAssignments
      .map((assignment) => ({
        accountId: String(assignment?.accountId || "").trim(),
        role: String(assignment?.role || "").trim()
      }))
      .filter((assignment) => assignment.accountId && assignment.role);
  }

  return (frontendAssignees || [])
    .slice(0, 3)
    .map((accountId, index) => ({
      accountId: String(accountId || "").trim(),
      role: FRONTEND_DEVICE_OPTIONS[index]
    }))
    .filter((assignment) => assignment.accountId && assignment.role);
}

// Builds a clickable link to a Jira issue (e.g. for success/status messages after create/update).
function buildIssueLink(baseUrl, issueKey) {
  const link = document.createElement("a");
  const trimmed = String(baseUrl || "").trim();
  // jiraBaseUrl is stored without a protocol (just the domain, e.g. "jira.vptech.eu") - a bare
  // domain string has no scheme, so it would otherwise be treated as a relative path off the
  // current page instead of an absolute Jira URL. Add https:// whenever it's missing, mirroring
  // normalizeBaseUrl() in background.js.
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  link.href = `${withProtocol.replace(/\/+$/, "")}/browse/${issueKey}`;
  link.textContent = issueKey;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

// Renders a status message made up of plain text segments and/or `{ baseUrl, key }` issue-link
// segments (via buildIssueLink above) into the given element, e.g. "Created " + <link to KEY-1>
// + " with 2 subtasks: " + <link to KEY-2> + ", " + <link to KEY-3>.
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
