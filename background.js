"use strict";

// The real Slack webhook default (DEFAULT_SLACK_WEBHOOK_URL) lives in secrets.local.js, which is
// gitignored so it never ends up in this repo's git history - see secrets.local.example.js for
// the template every teammate should copy locally. importScripts() throws synchronously if the
// file doesn't exist (e.g. a fresh clone before copying the example file), so it's wrapped in a
// try/catch and DEFAULT_SLACK_WEBHOOK_URL falls back to an empty string, which just means the
// Slack webhook URL field in Options is no longer pre-filled and each user must paste their own.
try {
  importScripts("secrets.local.js");
} catch (_error) {
  globalThis.DEFAULT_SLACK_WEBHOOK_URL = "";
}

const DEFAULT_SUBTASK_TEMPLATE =
  "Implement {role} subtask #{index} for story: {storySummary}";
const JIRA_API_ROOT_CANDIDATES = [
  "/rest/api/2",
  "/rest/api/3"
];
const jiraApiRootByBaseUrl = new Map();
const DEFAULT_AUTH_SETTINGS = {
  jiraAuthMode: "basic",
  jiraAuthScheme: "auto",
  jiraAuthEmail: "",
  jiraAuthApiToken: "",
  jiraAuthBearerToken: "",
  jiraForceBearerOnly: false,
  // Default new installs to the confirmed-working root for Jira Server/Data Center deployments
  // instead of relying on auto-detection, which has repeatedly locked onto legacy "/jira/..."
  // alias paths that pass a lightweight /myself probe but then redirect to a login/permission
  // page on write/metadata calls (issue/createmeta, issue create). Cloud users on
  // *.atlassian.net can clear this field in Options to fall back to auto-detection (/rest/api/3).
  jiraApiRootOverride: "/rest/api/2"
};
const DEFAULT_FRONTEND_ASSIGNMENT_ROLES = ["Android", "iOS", "Web"];
const BACKGROUND_BUILD_TAG = "bg-build-2026-07-21-07";
console.log(`[Jira Manager] background.js loaded, build: ${BACKGROUND_BUILD_TAG}`);

function getStorageSync() {
  const storageSync = globalThis.chrome?.storage?.sync;
  if (!storageSync) {
    throw new Error(
      "Extension storage API is unavailable. Reload the extension in chrome://extensions and try again."
    );
  }
  return storageSync;
}

async function getAuthConfig() {
  const configs = await getAuthConfigsForRequest();
  return configs[0];
}

function buildBasicAuthConfig(email, token) {
  return {
    mode: "basic",
    credentials: "omit",
    headers: {
      Authorization: `Basic ${btoa(`${email}:${token}`)}`
    }
  };
}

function buildBearerAuthConfig(token) {
  return {
    mode: "bearer",
    credentials: "omit",
    headers: {
      Authorization: `Bearer ${token}`
    }
  };
}

async function getAuthConfigsForRequest() {
  const settings = await getStorageSync().get(DEFAULT_AUTH_SETTINGS);
  const email = (settings.jiraAuthEmail || "").trim();
  const token = (settings.jiraAuthApiToken || settings.jiraAuthBearerToken || "").trim();
  const authScheme = (settings.jiraAuthScheme || "auto").trim().toLowerCase();
  if (!token) {
    throw new Error(
      "Jira token is required. Open extension Options and set your token."
    );
  }

  if (authScheme === "basic") {
    if (!email) {
      throw new Error("Atlassian email is required for Basic auth mode.");
    }
    return [buildBasicAuthConfig(email, token)];
  }

  if (authScheme === "bearer") {
    return [buildBearerAuthConfig(token)];
  }

  const authConfigs = [];
  if (email) {
    authConfigs.push(buildBasicAuthConfig(email, token));
  }
  authConfigs.push(buildBearerAuthConfig(token));
  return authConfigs;
}

async function getAuthConfigsForRequestWithFallback() {
  return getAuthConfigsForRequest();
}

async function getAuthConfigsForRequestWithFallbackV2() {
  return getAuthConfigsForRequest();
}

async function diagnoseAuth(inputBaseUrl) {
  const baseUrl = normalizeBaseUrl(inputBaseUrl);
  const settings = await getStorageSync().get(DEFAULT_AUTH_SETTINGS);
  const token = (settings.jiraAuthApiToken || settings.jiraAuthBearerToken || "").trim();
  const email = (settings.jiraAuthEmail || "").trim();

  if (!token) {
    throw new Error("Jira token is required before running diagnostics.");
  }

  const authConfigs = [];
  if (email) {
    authConfigs.push({
      scheme: "basic",
      credentials: "omit",
      headers: { Authorization: `Basic ${btoa(`${email}:${token}`)}` }
    });
  }
  authConfigs.push({
    scheme: "bearer",
    credentials: "omit",
    headers: { Authorization: `Bearer ${token}` }
  });

  const attempts = [];
  let success = null;
  for (const authConfig of authConfigs) {
    for (const apiRoot of JIRA_API_ROOT_CANDIDATES) {
      const attempt = await rawJiraAuthAttempt(baseUrl, `${apiRoot}/myself`, authConfig, "GET");
      attempts.push({ scheme: authConfig.scheme, apiRoot, method: "GET", ...attempt });
      if (attempt.ok && attempt.isJson) {
        success = { scheme: authConfig.scheme, apiRoot };
        break;
      }
    }
    if (success) {
      break;
    }
  }

  let writeCheck = null;
  if (success) {
    const authConfig = authConfigs.find((config) => config.scheme === success.scheme);
    const writeAttempt = await rawJiraAuthAttempt(
      baseUrl,
      `${success.apiRoot}/search`,
      authConfig,
      "POST",
      JSON.stringify({ jql: "order by created desc", maxResults: 0 })
    );
    writeCheck = { scheme: success.scheme, apiRoot: success.apiRoot, method: "POST", ...writeAttempt };
  }

  return { success, attempts, writeCheck };
}

async function rawJiraAuthAttempt(baseUrl, path, authConfig, method = "GET", body) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      credentials: authConfig.credentials,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(method !== "GET"
          ? { "X-Atlassian-Token": "no-check", "X-Requested-With": "XMLHttpRequest" }
          : {}),
        ...(authConfig.headers || {})
      },
      ...(body !== undefined ? { body } : {})
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      isJson: false,
      isHtml: false,
      details: `Network error: ${error.message}`
    };
  }

  const responseBody = await response.text();
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const isJson = contentType.includes("application/json");
  const isHtml = !isJson && /<html[\s>]/i.test(responseBody || "");
  const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(responseBody || "");
  return {
    ok: response.ok,
    status: response.status,
    isJson,
    isHtml,
    redirected: response.redirected,
    finalUrl: response.url,
    pageTitle: titleMatch ? titleMatch[1].trim() : "",
    details: String(responseBody || "").trim().slice(0, 180)
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((payload) => sendResponse({ ok: true, ...payload }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

// The toolbar icon's click behavior is configurable in Options (see the "Toolbar Icon Behavior"
// section) between two modes:
//   - "window" (default): opens popup.html in its own real, separate browser window via
//     chrome.windows.create, which supports normal OS-level resize/move/drag and stays open when
//     clicking elsewhere - the closest equivalent to how the Gemini side panel behaves.
//   - "dropdown": restores the classic behavior from before that window-based approach existed -
//     a native toolbar "action popup" (set via chrome.action.setPopup) that closes the instant
//     focus moves elsewhere and can't be resized, but opens instantly right under the icon.
// chrome.action.onClicked only ever fires when NO popup is currently set via setPopup/manifest -
// so switching modes means toggling whether a popup is set at all, not just what "click" does.
// applyPopupMode() is called on every service-worker wake (top-level, onStartup, onInstalled) -
// MV3 service workers are ephemeral and don't retain any prior setPopup() call across restarts -
// and again immediately whenever the setting changes in Options (storage.onChanged) so an already
//-running service worker picks up the change without needing a reload.
async function applyPopupMode() {
  const storageLocal = globalThis.chrome?.storage?.local;
  const { popupMode } = storageLocal
    ? await storageLocal.get({ popupMode: "window" })
    : { popupMode: "window" };
  await chrome.action.setPopup({ popup: popupMode === "dropdown" ? "popup.html" : "" });
}

applyPopupMode();
chrome.runtime.onStartup.addListener(applyPopupMode);
chrome.runtime.onInstalled.addListener(applyPopupMode);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.popupMode) {
    applyPopupMode();
  }
});

// Only reached when in "window" mode (see applyPopupMode() above) - if a window from a previous
// click is still open, this re-focuses it instead of opening a second one.
let toolWindowId = null;

chrome.action.onClicked.addListener(async () => {
  if (toolWindowId !== null) {
    try {
      await chrome.windows.update(toolWindowId, { focused: true });
      return;
    } catch (_error) {
      // The previously tracked window was closed/no longer exists - fall through and open a
      // fresh one below.
      toolWindowId = null;
    }
  }

  const createdWindow = await chrome.windows.create({
    url: chrome.runtime.getURL("popup.html"),
    type: "popup",
    width: 460,
    height: 720
  });
  toolWindowId = createdWindow.id;
});

chrome.windows.onRemoved.addListener((closedWindowId) => {
  if (closedWindowId === toolWindowId) {
    toolWindowId = null;
  }
});

async function handleMessage(message) {
  switch (message?.action) {
    case "testAuth":
      return testAuth(message.baseUrl);
    case "listProjects":
      return listProjects(message.baseUrl);
    case "listAssignableUsers":
      return listAssignableUsers(message.baseUrl, message.projectKey);
    case "searchAssignableUsers":
      return searchAssignableUsers(message.baseUrl, message.projectKey, message.query);
    case "listEpics":
      return listEpics(message.baseUrl, message.projectKey);
    case "listIssues":
      return listIssues(message.baseUrl, message.projectKey);
    case "diagnoseAuth":
      return diagnoseAuth(message.baseUrl);
    case "submitIssue":
      return submitIssue(message.payload);
    default:
      throw new Error("Unsupported action.");
  }
}

function normalizeBaseUrl(baseUrl) {
  const input = (baseUrl || "").trim();
  if (!input) {
    throw new Error("Jira URL is required.");
  }

  const withProtocol = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch (_error) {
    throw new Error(
      "Invalid Jira URL. Use your site domain (example: https://your-company.atlassian.net)."
    );
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Jira URL must use https.");
  }

  return parsed.origin;
}

// Jira Server/Data Center's classic `/rest/api/2` requires the `description` field to be a
// plain string (Jira's own "wiki markup" syntax, not JSON) - passing an ADF object there fails
// with "Operation value must be a string". ADF is a Jira Cloud `/rest/api/3` concept only.
// Dispatch based on the resolved API root so both API versions get the format they expect.
function toDescriptionField(apiRoot, text) {
  return String(apiRoot || "").includes("/api/3") ? toAdf(text) : toWikiMarkup(text);
}

// Jira Cloud (`/rest/api/3`) identifies users by an opaque `accountId` and expects
// `assignee: { accountId }`. Classic Jira Server/Data Center (`/rest/api/2`) has no concept of
// accountId at all - it identifies users by username and expects `assignee: { name }`, and
// rejects an `accountId`-shaped object with "expected Object containing a 'name' property".
// listAssignableUsers()/normalizeFrontendAssignments() already store the Server username under
// the "accountId" property of our own internal user model for simplicity (there's no separate
// concept to store it under on Server) - this dispatcher picks the correct wire shape based on
// the resolved API root, mirroring toDescriptionField() above.
function toAssigneeField(apiRoot, identifier) {
  const trimmed = String(identifier || "").trim();
  if (!trimmed) {
    return null;
  }
  return String(apiRoot || "").includes("/api/3") ? { accountId: trimmed } : { name: trimmed };
}

function toWikiMarkup(text) {
  const source = (text || "").replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (/^```/.test(trimmed)) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push(`{code}\n${codeLines.join("\n")}\n{code}`);
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push(`h${headingMatch[1].length}. ${inlineMarkdownToWiki(headingMatch[2])}`);
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items = [];
      while (index < lines.length) {
        const itemMatch = lines[index].trim().match(/^[-*]\s+(.+)$/);
        if (!itemMatch) {
          break;
        }
        items.push(`* ${inlineMarkdownToWiki(itemMatch[1])}`);
        index += 1;
      }
      blocks.push(items.join("\n"));
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items = [];
      while (index < lines.length) {
        const itemMatch = lines[index].trim().match(/^\d+\.\s+(.+)$/);
        if (!itemMatch) {
          break;
        }
        items.push(`# ${inlineMarkdownToWiki(itemMatch[1])}`);
        index += 1;
      }
      blocks.push(items.join("\n"));
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length) {
      const paragraphLine = lines[index];
      const paragraphTrimmed = paragraphLine.trim();
      if (
        !paragraphTrimmed ||
        /^```/.test(paragraphTrimmed) ||
        /^(#{1,6})\s+/.test(paragraphTrimmed) ||
        /^[-*]\s+/.test(paragraphTrimmed) ||
        /^\d+\.\s+/.test(paragraphTrimmed)
      ) {
        break;
      }
      paragraphLines.push(inlineMarkdownToWiki(paragraphLine));
      index += 1;
    }
    blocks.push(paragraphLines.join("\n"));
  }

  return blocks.join("\n\n");
}

function inlineMarkdownToWiki(text) {
  const BOLD_PLACEHOLDER = "\u0000BOLD\u0000";
  const boldSegments = [];
  let result = String(text || "")
    // Image placeholders inserted by the extension look like `![alt](image:<attachment-filename>)`.
    // The filename is chosen up front to exactly match the attachment that gets uploaded to the
    // issue right after creation/update, so Jira Server/Data Center's wiki markup image syntax
    // (`!filename!`) resolves correctly as soon as that attachment exists - no further edit needed.
    .replace(/!\[([^\]]*)\]\(image:([^)]+)\)/g, (_match, _alt, filename) => `!${filename}!`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "[$1|$2]")
    .replace(/\*\*([^*]+)\*\*/g, (_, inner) => {
      boldSegments.push(inner);
      return `${BOLD_PLACEHOLDER}${boldSegments.length - 1}${BOLD_PLACEHOLDER}`;
    })
    .replace(/\*([^*]+)\*/g, "_$1_")
    .replace(/`([^`]+)`/g, "{{$1}}");

  result = result.replace(
    new RegExp(`${BOLD_PLACEHOLDER}(\\d+)${BOLD_PLACEHOLDER}`, "g"),
    (_, i) => `*${boldSegments[Number(i)]}*`
  );

  return result;
}

function toAdf(text) {
  const source = (text || "").replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  const content = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (/^```/.test(trimmed)) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      content.push({
        type: "codeBlock",
        content: [{ type: "text", text: codeLines.join("\n") }]
      });
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      content.push({
        type: "heading",
        attrs: { level: headingMatch[1].length },
        content: parseInlineMarkdown(headingMatch[2])
      });
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items = [];
      while (index < lines.length) {
        const itemMatch = lines[index].trim().match(/^[-*]\s+(.+)$/);
        if (!itemMatch) {
          break;
        }
        items.push({
          type: "listItem",
          content: [{ type: "paragraph", content: parseInlineMarkdown(itemMatch[1]) }]
        });
        index += 1;
      }
      content.push({ type: "bulletList", content: items });
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items = [];
      while (index < lines.length) {
        const itemMatch = lines[index].trim().match(/^\d+\.\s+(.+)$/);
        if (!itemMatch) {
          break;
        }
        items.push({
          type: "listItem",
          content: [{ type: "paragraph", content: parseInlineMarkdown(itemMatch[1]) }]
        });
        index += 1;
      }
      content.push({ type: "orderedList", content: items });
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length) {
      const paragraphLine = lines[index];
      const paragraphTrimmed = paragraphLine.trim();
      if (
        !paragraphTrimmed ||
        /^```/.test(paragraphTrimmed) ||
        /^(#{1,6})\s+/.test(paragraphTrimmed) ||
        /^[-*]\s+/.test(paragraphTrimmed) ||
        /^\d+\.\s+/.test(paragraphTrimmed)
      ) {
        break;
      }
      paragraphLines.push(paragraphLine);
      index += 1;
    }
    content.push({
      type: "paragraph",
      content: parseParagraphLines(paragraphLines)
    });
  }

  return { type: "doc", version: 1, content: content.length ? content : [{ type: "paragraph", content: [] }] };
}

function parseParagraphLines(lines) {
  const segments = lines.map((line) => parseInlineMarkdown(line));
  const content = [];
  for (let index = 0; index < segments.length; index += 1) {
    if (index > 0) {
      content.push({ type: "hardBreak" });
    }
    content.push(...segments[index]);
  }
  return content.length ? content : [];
}

function parseInlineMarkdown(text) {
  const content = [];
  let value = String(text || "");

  while (value.length > 0) {
    // Jira Cloud's ADF has no simple way to reference an attachment that hasn't been uploaded
    // yet at doc-build time (real inline image embedding needs a media node with the
    // attachment's media id, which only exists after upload). Degrade gracefully to a plain text
    // marker here; the actual file is still uploaded and attached to the issue right after
    // creation/update, it just won't render inline on Cloud the way it does via Server/DC wiki
    // markup (`!filename!`, handled in inlineMarkdownToWiki).
    const imageMatch = value.match(/^!\[([^\]]*)\]\(image:([^)]+)\)/);
    if (imageMatch) {
      content.push({ type: "text", text: `[Image attached: ${imageMatch[2]}]`, marks: [{ type: "em" }] });
      value = value.slice(imageMatch[0].length);
      continue;
    }

    const linkMatch = value.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/);
    if (linkMatch) {
      content.push({
        type: "text",
        text: linkMatch[1],
        marks: [{ type: "link", attrs: { href: linkMatch[2] } }]
      });
      value = value.slice(linkMatch[0].length);
      continue;
    }

    const boldMatch = value.match(/^\*\*([^*]+)\*\*/);
    if (boldMatch) {
      content.push({ type: "text", text: boldMatch[1], marks: [{ type: "strong" }] });
      value = value.slice(boldMatch[0].length);
      continue;
    }

    const italicMatch = value.match(/^\*([^*]+)\*/);
    if (italicMatch) {
      content.push({ type: "text", text: italicMatch[1], marks: [{ type: "em" }] });
      value = value.slice(italicMatch[0].length);
      continue;
    }

    const codeMatch = value.match(/^`([^`]+)`/);
    if (codeMatch) {
      content.push({ type: "text", text: codeMatch[1], marks: [{ type: "code" }] });
      value = value.slice(codeMatch[0].length);
      continue;
    }

    const nextSpecialIndex = value.search(/(\[|\*\*|\*|`)/);
    if (nextSpecialIndex === 0) {
      content.push({ type: "text", text: value[0] });
      value = value.slice(1);
      continue;
    }

    if (nextSpecialIndex === -1) {
      content.push({ type: "text", text: value });
      break;
    }

    content.push({ type: "text", text: value.slice(0, nextSpecialIndex) });
    value = value.slice(nextSpecialIndex);
  }

  return content.length ? content : [];
}

async function jiraFetch(baseUrl, path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const isWriteMethod = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  const authConfigs = await getAuthConfigsForRequestWithFallbackV2();
  let lastError = null;

  for (let index = 0; index < authConfigs.length; index += 1) {
    const authConfig = authConfigs[index];
    const isLastAttempt = index === authConfigs.length - 1;

    try {
      return await jiraFetchWithAuthConfig(baseUrl, path, options, authConfig, isWriteMethod);
    } catch (error) {
      lastError = error;
      if (!isLastAttempt && isAuthChallengeError(error)) {
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("Unable to reach Jira.");
}

async function jiraFetchWithAuthConfig(baseUrl, path, options, authConfig, isWriteMethod) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      credentials: authConfig.credentials,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(isWriteMethod
          ? { "X-Atlassian-Token": "no-check", "X-Requested-With": "XMLHttpRequest" }
          : {}),
        ...(authConfig.headers || {}),
        ...(options.headers || {})
      },
      ...options
    });
  } catch (error) {
    throw new Error(`Unable to reach Jira: ${error.message}`);
  }

  const rawBody = await response.text();
  const contentType = response.headers.get("content-type") || "";
  const isJsonResponse = contentType.toLowerCase().includes("application/json");
  const isHtmlBody = rawBody && !isJsonResponse && /<html[\s>]/i.test(rawBody);
  let json = null;

  if (rawBody && isJsonResponse) {
    try {
      json = JSON.parse(rawBody);
    } catch (_error) {
      throw new Error("Jira returned invalid JSON. Please try again.");
    }
  }

  if (!response.ok) {
    if (isHtmlBody) {
      const error = new Error(
        `Jira returned a login page instead of API data (status ${response.status}) for ${
          options.method || "GET"
        } ${baseUrl}${path}. ${describeHtmlChallenge(response, rawBody)}`
      );
      error.authChallenge = true;
      throw error;
    }

    const details =
      json?.errorMessages?.join(", ") ||
      json?.errors?.summary ||
      (typeof rawBody === "string" ? rawBody.trim().slice(0, 300) : "") ||
      json?.message ||
      "Unknown Jira error";
    const error = new Error(
      `Jira API error (${response.status}) for ${options.method || "GET"} ${baseUrl}${path}: ${details}`
    );
    if (response.status === 401 || response.status === 403) {
      error.authChallenge = true;
    }
    throw error;
  }

  if (isHtmlBody) {
    const error = new Error(
      `Jira returned an HTML page instead of API data (status ${response.status}) for ${
        options.method || "GET"
      } ${baseUrl}${path}. ${describeHtmlChallenge(response, rawBody)}`
    );
    error.authChallenge = true;
    throw error;
  }

  return json;
}

function describeHtmlChallenge(response, rawBody) {
  const parts = [];
  if (response.redirected && response.url) {
    parts.push(`Request was redirected to: ${response.url}`);
  }
  const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(rawBody || "");
  if (titleMatch && titleMatch[1].trim()) {
    parts.push(`Page title: "${titleMatch[1].trim()}"`);
  }
  if (!parts.length) {
    parts.push(
      "This usually means a proxy/SSO gateway in front of Jira is intercepting the request (often only on write/POST calls) and serving its own login page instead of passing the Authorization header through."
    );
  }
  return parts.join(" ");
}

function isAuthChallengeError(error) {
  return Boolean(error?.authChallenge);
}

async function testAuth(inputBaseUrl) {
  const baseUrl = normalizeBaseUrl(inputBaseUrl);
  const apiRoot = await resolveJiraApiRoot(baseUrl, true);
  const user = await jiraFetch(baseUrl, `${apiRoot}/myself`, {
    method: "GET"
  });

  return {
    user: {
      displayName: user.displayName,
      accountId: user.accountId,
      emailAddress: user.emailAddress || ""
    },
    apiRoot
  };
}

async function listProjects(inputBaseUrl) {
  const baseUrl = normalizeBaseUrl(inputBaseUrl);
  const apiRoot = await resolveJiraApiRoot(baseUrl);
  let projects = [];

  try {
    const path = `${apiRoot}/project/search?maxResults=1000&orderBy=name`;
    const result = await jiraFetch(baseUrl, path, { method: "GET" });
    projects = Array.isArray(result?.values) ? result.values : [];
  } catch (_error) {
    projects = [];
  }

  if (!projects.length) {
    const fallbackPath = `${apiRoot}/project`;
    const result = await jiraFetch(baseUrl, fallbackPath, { method: "GET" });
    projects = Array.isArray(result) ? result : [];
  }

  return {
    projects: projects.map((project) => ({
      id: project.id,
      key: project.key,
      name: project.name || project.key
    }))
  };
}

async function listAssignableUsers(inputBaseUrl, projectKey, queryText = "") {
  const baseUrl = normalizeBaseUrl(inputBaseUrl);
  const apiRoot = await resolveJiraApiRoot(baseUrl);
  const key = (projectKey || "").trim();
  const query = (queryText || "").trim();
  if (!key) {
    throw new Error("Project key is required to list assignable users.");
  }

  let users;
  try {
    users = await fetchAssignableUsersPaginated(baseUrl, apiRoot, key, query, false);
  } catch (_error) {
    users = await fetchAssignableUsersPaginated(baseUrl, apiRoot, key, query, true);
  }

  return {
    users: (users || [])
      .map((user) => ({
        // Jira Server/DC only has `name` (username) and `key` (internal DB id, e.g.
        // "JIRAUSER22146"); prefer `name` since that's what toAssigneeField() sends as
        // `{ name }` for API v2 - sending `key` there gets rejected with "User 'JIRAUSER...'
        // does not exist." Cloud has a real `accountId`, so it always wins when present.
        accountId: user.accountId || user.name || user.key || "",
        displayName: user.displayName || user.name || user.emailAddress || "Unknown user",
        emailAddress: user.emailAddress || ""
      }))
      .filter((user) => user.accountId)
  };
}

// `/user/assignable/search` without a query parameter (used by listAssignableUsers above for the
// initial/default list) only returns a small default page on many Jira Server/Data Center
// instances - it is NOT a full directory listing, which is why users could be selected/typed but
// never show up ("the dev search is not working as I cannot find them"). Jira's own assignee
// picker widget (the one shown in Jira's native "Create issue" screen) is powered by
// `/user/picker`, which performs a real server-side search across the whole applicable user
// directory and supports a `project` parameter to scope results to users assignable to that
// project - this is what actually gives the "type and see live matching results" experience the
// user is asking for, instead of relying on a client-side filter over a possibly-incomplete
// locally cached list.
async function searchAssignableUsers(inputBaseUrl, projectKey, queryText) {
  const baseUrl = normalizeBaseUrl(inputBaseUrl);
  const apiRoot = await resolveJiraApiRoot(baseUrl);
  const key = (projectKey || "").trim();
  const query = (queryText || "").trim();
  if (!key) {
    throw new Error("Project key is required to search assignable users.");
  }
  if (!query) {
    return { users: [] };
  }

  const queryParams = new URLSearchParams({
    query,
    project: key,
    maxResults: "20",
    showAvatar: "false"
  });

  let result;
  try {
    result = await jiraFetch(baseUrl, `${apiRoot}/user/picker?${queryParams.toString()}`, {
      method: "GET"
    });
  } catch (_error) {
    // Fall back to the older assignable/search endpoint (with the query param this time,
    // scoped to the project) in case `/user/picker` isn't available on this Jira version.
    const users = await fetchAssignableUsersPaginated(baseUrl, apiRoot, key, query, false);
    return {
      users: (users || [])
        .map((user) => ({
          // See the matching comment in listAssignableUsers() above: prefer username (`name`)
          // over the internal `key` for Server/DC.
          accountId: user.accountId || user.name || user.key || "",
          displayName: user.displayName || user.name || user.emailAddress || "Unknown user",
          emailAddress: user.emailAddress || ""
        }))
        .filter((user) => user.accountId)
    };
  }

  const rawUsers = Array.isArray(result?.users) ? result.users : [];
  return {
    users: rawUsers
      .map((user) => ({
        accountId: user.accountId || user.name || user.key || "",
        displayName: user.displayName || user.name || user.emailAddress || "Unknown user",
        emailAddress: user.emailAddress || ""
      }))
      .filter((user) => user.accountId)
  };
}

async function fetchAssignableUsersPaginated(
  baseUrl,
  apiRoot,
  projectKey,
  query,
  useUsernameParam
) {
  const users = [];
  const maxResults = 100;
  let startAt = 0;

  while (startAt < 5000) {
    const queryParams = new URLSearchParams({
      project: projectKey,
      maxResults: String(maxResults),
      startAt: String(startAt),
      [useUsernameParam ? "username" : "query"]: query
    });
    const result = await jiraFetch(
      baseUrl,
      `${apiRoot}/user/assignable/search?${queryParams.toString()}`,
      { method: "GET" }
    );

    const chunk = Array.isArray(result)
      ? result
      : Array.isArray(result?.values)
        ? result.values
        : [];
    users.push(...chunk);

    if (!chunk.length || chunk.length < maxResults) {
      break;
    }
    startAt += chunk.length;
  }

  return users;
}

async function listIssues(inputBaseUrl, projectKey) {
  const baseUrl = normalizeBaseUrl(inputBaseUrl);
  const apiRoot = await resolveJiraApiRoot(baseUrl);
  const key = (projectKey || "").trim();
  if (!key) {
    throw new Error("Project key is required to list issues.");
  }

  const jql = encodeURIComponent(
    `project = ${key} AND issuetype in (Epic, Story, Task) ORDER BY updated DESC`
  );
  const path = `${apiRoot}/search?jql=${jql}&maxResults=50&fields=summary,issuetype`;
  const result = await jiraFetch(baseUrl, path, { method: "GET" });

  return {
    issues: (result.issues || []).map((issue) => ({
      key: issue.key,
      summary: issue.fields?.summary || "(No summary)",
      issueType: issue.fields?.issuetype?.name || "Unknown"
    }))
  };
}

async function listEpics(inputBaseUrl, projectKey) {
  const baseUrl = normalizeBaseUrl(inputBaseUrl);
  const apiRoot = await resolveJiraApiRoot(baseUrl);
  const key = (projectKey || "").trim();
  if (!key) {
    throw new Error("Project key is required to list epics.");
  }

  const jql = encodeURIComponent(`project = ${key} AND issuetype = Epic ORDER BY updated DESC`);
  const path = `${apiRoot}/search?jql=${jql}&maxResults=200&fields=summary`;
  const result = await jiraFetch(baseUrl, path, { method: "GET" });

  return {
    epics: (result.issues || []).map((issue) => ({
      key: issue.key,
      summary: issue.fields?.summary || "(No summary)"
    }))
  };
}

async function submitIssue(payload) {
  const baseUrl = normalizeBaseUrl(payload.baseUrl);
  const initialApiRoot = await resolveJiraApiRoot(baseUrl);
  const projectKey = (payload.projectKey || "").trim();
  if (!projectKey) {
    throw new Error("Project key is required.");
  }

  if (payload.mode === "update") {
    const updateResult = await updateIssue(
      initialApiRoot,
      baseUrl,
      payload.issueKey,
      payload.summary,
      payload.details
    );
    updateResult.attachmentWarnings = await uploadPendingImages(
      baseUrl,
      initialApiRoot,
      updateResult.updatedIssueKey,
      payload.images
    );
    return updateResult;
  }

  const shouldApplyFrontsNaming =
    payload.issueType === "Story" && Array.isArray(payload.frontendSubtaskRoles) && payload.frontendSubtaskRoles.length > 0;
  const normalizedStorySummary = normalizeFrontStorySummary(payload.summary, shouldApplyFrontsNaming);

  let createdIssue;
  let apiRoot = initialApiRoot;
  try {
    const createResult = await createIssueWithApiRootFallback(
      baseUrl,
      projectKey,
      payload.issueType,
      normalizedStorySummary,
      payload.details,
      payload.assigneeAccountId,
      payload.parentEpicKey
    );
    createdIssue = createResult.createdIssue;
    apiRoot = createResult.apiRoot;
  } catch (error) {
    throw new Error(`Issue creation failed: ${error.message}`);
  }

  // Subtask creation, image upload, and the Slack notification are all independent once the
  // parent issue exists, so run them concurrently instead of one after another. This matters
  // because MV3 service workers can be terminated (idle-killed) after roughly 30 seconds -
  // creating 2+ frontend subtasks sequentially (each with its own retries/delays for Jira's
  // "Issue Does Not Exist" indexing lag) could push the Slack call past that window and lose it
  // silently. Running them in parallel keeps the total wall-clock time close to the slowest single
  // step instead of the sum of all of them, and means a slow/retrying subtask can no longer delay
  // (or, in the worst case, outright prevent) the Slack webhook from firing.
  console.log(
    `[Jira Manager] submitIssue: parent ${createdIssue.key} created, starting subtasks/attachments/slack in parallel`,
    { frontendSubtaskRoles: payload.frontendSubtaskRoles, slackEnabled: Boolean(payload.slack?.enabled) }
  );
  const subtasksPromise =
    payload.issueType === "Story" && Array.isArray(payload.frontendSubtaskRoles) && payload.frontendSubtaskRoles.length
      ? createFrontendSubtasks(baseUrl, {
          apiRoot,
          parentIssueKey: createdIssue.key,
          projectKey,
          storySummary: normalizedStorySummary,
          roles: payload.frontendSubtaskRoles
        })
      : Promise.resolve({ created: [], failures: [] });

  const attachmentWarningsPromise = uploadPendingImages(baseUrl, apiRoot, createdIssue.key, payload.images);

  const slackWarningsPromise =
    payload.slack && payload.slack.enabled
      ? notifySlackWorkflow(baseUrl, createdIssue.key, payload)
          .then(() => {
            console.log("[Jira Manager] Slack webhook call succeeded.");
            return [];
          })
          .catch((error) => {
            console.error("[Jira Manager] Slack webhook call failed:", error);
            return [`Slack workflow notification failed: ${error.message}`];
          })
      : Promise.resolve([]);

  const [subtaskResult, attachmentWarnings, slackWarnings] = await Promise.all([
    subtasksPromise,
    attachmentWarningsPromise,
    slackWarningsPromise
  ]);
  const subtasks = subtaskResult.created;
  const subtaskWarnings = subtaskResult.failures;
  console.log("[Jira Manager] submitIssue: all parallel work finished.", {
    subtasks,
    subtaskWarnings,
    attachmentWarnings,
    slackWarnings
  });

  return {
    created: createdIssue,
    subtasks,
    subtaskWarnings,
    attachmentWarnings,
    slackWarnings
  };
}

// Normalizes the configured Slack member ID: trims whitespace, and strips a leading "@" or
// wrapping "<@...>" if the user pasted it in one of those forms by mistake. Slack requires the
// *raw* member ID (e.g. "U0123ABC456") as the payload value - see the comment at the call site
// below for why "@handle" text can never become a real mention, no matter what we send.
function normalizeSlackId(slackUserId) {
  const trimmed = String(slackUserId || "").trim();
  const angleMatch = trimmed.match(/^<@([^|>]+)/);
  if (angleMatch) {
    return angleMatch[1];
  }
  return trimmed.replace(/^@/, "");
}

// Fallback default for the team's shared "Front Request" Slack workflow webhook (defined in
// secrets.local.js, imported above), used only when a user hasn't entered their own override in
// Options (Slack Integration section). Baking a default in removes per-teammate setup friction,
// at the cost of the URL being visible to anyone with access to this extension's source
// (chrome://extensions -> inspect, or the shared folder/zip) - acceptable here since this
// extension is only distributed within a small trusted internal team and the worst-case abuse
// (posting fake requests to one internal Slack channel) is low-impact. If that changes (e.g.
// wider distribution), replace this with a server-side proxy instead of a client-embedded
// secret. Each user can still override it per-machine in Options.

// Posts one call per selected platform to the Slack "Front Request" workflow webhook so it shows
// up in the team's intake pipeline without the requester having to re-fill the Slack form by
// hand. The workflow's message template is built around a *single* device value (e.g. "...has
// requested X to Android with Priority..."), so previously joining multiple selected platforms
// into one comma-separated string (e.g. "iOS, Android") for a single combined call didn't match
// what the workflow expects and the notification silently never posted for multi-platform
// Stories. Firing one independent webhook call per selected platform (concurrently) instead
// fixes that, and mirrors how one Jira frontend subtask is already created per platform. See the
// Slack Integration section in options.html/options.js for where slackWebhookUrl and slackUserId
// are configured.
async function notifySlackWorkflow(baseUrl, issueKey, payload) {
  const settings = await getStorageSync().get({ slackWebhookUrl: "", slackUserId: "" });
  const webhookUrl = (settings.slackWebhookUrl || "").trim() || DEFAULT_SLACK_WEBHOOK_URL;
  const slack = payload.slack || {};
  const rawDevices =
    payload.frontendSubtaskRoles && payload.frontendSubtaskRoles.length
      ? payload.frontendSubtaskRoles
      : payload.device
      ? [payload.device]
      : [];
  // If no platform was selected at all (e.g. an Epic, or a Story/Task with no pill picked), still
  // send a single call with an empty device value rather than skipping the notification entirely.
  const devicesToNotify = rawDevices.length ? rawDevices : [""];

  const jiraTicketUrl = `${normalizeBaseUrl(baseUrl)}/browse/${issueKey}`;
  const slackId = normalizeSlackId(settings.slackUserId);

  const results = await Promise.all(
    devicesToNotify.map(async (device) => {
      // The extension's internal role naming uses "Web" (matching options.html's frontend
      // assignee roles), but the Slack "Front Request" workflow's Device field enum uses
      // "Desktop" instead - translate just for this outbound payload, leaving Jira subtask role
      // names as-is.
      const slackDevice = device === "Web" ? "Desktop" : device;
      const body = {
        request_features: payload.summary || "",
        device: slackDevice,
        priority: slack.priority || "",
        product: slack.product || "",
        expected_eta: slack.expectedEta || "",
        figma: slack.figma || "",
        jira_ticket: jiraTicketUrl,
        channel_feature: slack.channelFeature || "",
        // Slack ONLY ever renders a real clickable/notifying mention for the literal syntax
        // <@MEMBER_ID> evaluated server-side when the message is posted - a plain "@handle"
        // string (however it's produced) is always just inert text, since Slack has no way to
        // resolve a handle to a user from arbitrary API-posted text. So this must be the raw
        // member ID, and the workflow's message step text itself must contain literal
        // "<@{{slack_id}}>" (not just "{{slack_id}}") for it to render as a mention - see README
        // for the Slack-side fix.
        slack_id: slackId
      };

      try {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          // Log the exact outbound body alongside the failure - Slack's "invalid_workflow_input"
          // error doesn't say which field/key is the problem, so seeing precisely what we sent
          // is the only way to compare it against the webhook trigger's defined variables
          // (names/types/required flags) in Slack Workflow Builder and spot the mismatch.
          console.error(`[Jira Manager] Slack webhook rejected the request body:`, body);
          throw new Error(`Slack webhook returned ${response.status}: ${text.slice(0, 200)}`);
        }
        console.log(`[Jira Manager] Slack webhook call succeeded for device "${slackDevice || "(none)"}".`);
        return { device, ok: true };
      } catch (error) {
        console.error(`[Jira Manager] Slack webhook call failed for device "${slackDevice || "(none)"}":`, error);
        return { device, ok: false, error };
      }
    })
  );

  const failures = results.filter((result) => !result.ok);
  if (failures.length === results.length) {
    // Every call failed - surface it the same way a single-call failure always has, so the
    // caller's existing "Slack workflow notification failed: ..." warning message is unchanged
    // for the common single-platform case.
    throw failures[0].error;
  }
  if (failures.length) {
    throw new Error(
      `partially failed for: ${failures.map((failure) => failure.device || "(none)").join(", ")} - ${failures[0].error.message}`
    );
  }
}



// Uploads every pending image (attached via the extension's Details field) to the given issue as
// a regular Jira attachment. Runs after the issue already exists, since Jira's attachments
// endpoint is scoped to an issue key. Failures here are collected as warnings rather than thrown,
// because the issue itself was already created/updated successfully by this point - losing that
// just because one image failed to upload would be a worse outcome than surfacing a warning.
async function uploadPendingImages(baseUrl, apiRoot, issueKey, images) {
  const warnings = [];
  for (const image of images || []) {
    const filename = (image?.filename || "").trim();
    const dataUrl = image?.dataUrl || "";
    if (!filename || !dataUrl) {
      continue;
    }
    try {
      await uploadAttachment(baseUrl, apiRoot, issueKey, filename, dataUrl);
    } catch (error) {
      warnings.push(`${filename}: ${error.message}`);
    }
  }
  return warnings;
}

async function uploadAttachment(baseUrl, apiRoot, issueKey, fileName, dataUrl) {
  const key = (issueKey || "").trim();
  if (!key) {
    throw new Error("Issue key is required to upload an attachment.");
  }

  const blob = dataUrlToBlob(dataUrl);
  const authConfigs = await getAuthConfigsForRequestWithFallbackV2();
  let lastError = null;

  for (let index = 0; index < authConfigs.length; index += 1) {
    const authConfig = authConfigs[index];
    const isLastAttempt = index === authConfigs.length - 1;
    try {
      // Attachment uploads are multipart/form-data, unlike the rest of the JSON-only API calls
      // in jiraFetch(), so this talks to `fetch` directly and must NOT set a Content-Type header
      // itself - the browser/runtime sets the multipart boundary automatically from the FormData.
      const formData = new FormData();
      formData.append("file", blob, fileName);

      const response = await fetch(`${baseUrl}${apiRoot}/issue/${encodeURIComponent(key)}/attachments`, {
        method: "POST",
        credentials: authConfig.credentials,
        headers: {
          Accept: "application/json",
          "X-Atlassian-Token": "no-check",
          "X-Requested-With": "XMLHttpRequest",
          ...(authConfig.headers || {})
        },
        body: formData
      });

      const rawBody = await response.text();
      const contentType = response.headers.get("content-type") || "";
      const isJsonResponse = contentType.toLowerCase().includes("application/json");
      const isHtmlBody = rawBody && !isJsonResponse && /<html[\s>]/i.test(rawBody);

      if (!response.ok || isHtmlBody) {
        const details = isHtmlBody
          ? describeHtmlChallenge(response, rawBody)
          : rawBody.trim().slice(0, 300) || `status ${response.status}`;
        const error = new Error(`Attachment upload failed (status ${response.status}): ${details}`);
        if (response.status === 401 || response.status === 403) {
          error.authChallenge = true;
        }
        throw error;
      }

      return true;
    } catch (error) {
      lastError = error;
      if (!isLastAttempt && isAuthChallengeError(error)) {
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("Unable to upload attachment.");
}

function dataUrlToBlob(dataUrl) {
  const [header, base64] = String(dataUrl || "").split(",");
  if (!base64) {
    throw new Error("Invalid image data.");
  }
  const mimeMatch = /data:([^;]+);base64/i.exec(header || "");
  const mimeType = mimeMatch ? mimeMatch[1] : "application/octet-stream";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

function normalizeFrontStorySummary(summary, shouldApplyFrontsNaming) {
  const raw = String(summary || "").trim();
  if (!shouldApplyFrontsNaming || !raw) {
    return raw;
  }
  if (/^\[fronts\]\s+/i.test(raw)) {
    return raw;
  }
  return `[Fronts] ${raw}`;
}

function removeFrontsPrefix(summary) {
  return String(summary || "").replace(/^\[fronts\]\s*/i, "").trim();
}

async function createIssueWithApiRootFallback(
  baseUrl,
  projectKey,
  issueType,
  summary,
  details,
  assigneeAccountId,
  parentEpicKey
) {
  // Always force a fresh detection here instead of trusting a possibly stale in-memory cache
  // (the service worker's Map can be repopulated with a wrong value from an earlier run, and a
  // stale root is a real, confusing failure mode for this specific write path).
  const preferredApiRoot = await resolveJiraApiRoot(baseUrl, true);

  // The root is trusted as-is here: resolveJiraApiRoot() already applied the pinned override (or
  // detection). Do NOT fall back to other JIRA_API_ROOT_CANDIDATES on any error, including a 404
  // "Issue Does Not Exist" - a previous version of this function did that and it caused a
  // confusing failure mode: a genuine functional error on the correct/pinned root (e.g. createmeta
  // itself returning 404 on some Jira Data Center versions) was silently retried against an
  // unrelated, invalid candidate root, and the LESS useful error from that unrelated root (a
  // login-page redirect) replaced the real, more diagnostic original error. Always surface the
  // real error from the resolved root directly.
  const createdIssue = await createIssue(
    preferredApiRoot,
    baseUrl,
    projectKey,
    issueType,
    summary,
    details,
    assigneeAccountId,
    parentEpicKey
  );
  return { createdIssue, apiRoot: preferredApiRoot };
}

async function updateIssue(apiRoot, baseUrl, issueKey, summary, details) {
  const key = (issueKey || "").trim();
  if (!key) {
    throw new Error("Issue key is required for update.");
  }
  if (!(summary || "").trim()) {
    throw new Error("Title is required for update.");
  }

  await jiraFetch(baseUrl, `${apiRoot}/issue/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({
      fields: {
        summary: summary.trim(),
        description: toDescriptionField(apiRoot, details)
      }
    })
  });

  return { updatedIssueKey: key };
}

async function createIssue(
  apiRoot,
  baseUrl,
  projectKey,
  issueType,
  summary,
  details,
  assigneeAccountId,
  parentEpicKey
) {
  const normalizedType = (issueType || "").trim();
  const normalizedSummary = (summary || "").trim();
  if (!normalizedType) {
    throw new Error("Issue type is required.");
  }
  if (!normalizedSummary) {
    throw new Error("Title is required.");
  }

  const fields = {
    project: { key: projectKey },
    issuetype: { name: normalizedType },
    summary: normalizedSummary,
    description: toDescriptionField(apiRoot, details)
  };

  let metadata;
  try {
    metadata = await getCreateMetaFields(apiRoot, baseUrl, projectKey, normalizedType, normalizedSummary);
  } catch (metadataError) {
    // A handful of Jira Server/Data Center instances throw a generic 404 "Issue Does Not
    // Exist" from the bulk createmeta call (expand=projects.issuetypes.fields) even when the
    // project/issue type/permissions are all fine - this is a known Jira bug triggered by a
    // broken field reference (e.g. a custom field default value pointing at a deleted issue)
    // on that screen. Try the newer per-issue-type scoped createmeta endpoints next (these
    // power Jira's own modern "Create" dialog and are not affected by the same bug).
    console.warn(
      `[Jira Manager] bulk createmeta lookup failed, trying scoped createmeta: ${metadataError.message}`
    );
    try {
      metadata = await getCreateMetaFieldsScoped(apiRoot, baseUrl, projectKey, normalizedType, normalizedSummary);
    } catch (scopedMetadataError) {
      // Both metadata lookups failed. Don't let this block issue creation entirely: fall back
      // to minimal fields and let the actual POST surface any real field problems directly.
      console.warn(
        `[Jira Manager] scoped createmeta lookup also failed, proceeding with minimal fields: ${scopedMetadataError.message}`
      );
      metadata = {
        additionalFields: {},
        hasAssigneeField: true,
        // Default to false, not true: "parent" is only valid on subtask issue types (or Epic
        // links in Jira Cloud team-managed projects) - assuming it's always available caused a
        // real bug ("Issue type ... is not a sub-task but a parent is specified.") when creating
        // a Story/Task with a parent Epic on this classic Jira Server/Data Center instance,
        // which links Epics via a separate "Epic Link" custom field instead. The Epic Link
        // field lookup below (via the global field list) is the safe fallback for that case.
        hasParentField: false,
        epicLinkFieldKey: ""
      };
    }
  }
  const metadataFields = metadata.additionalFields;
  for (const [fieldKey, fieldValue] of Object.entries(metadataFields)) {
    fields[fieldKey] = fieldValue;
  }

  // "Epic Name" is a mandatory custom field on many Jira Server/Data Center instances when
  // creating an Epic, but createmeta lookups (both the bulk and per-issue-type scoped ones)
  // can fail to surface it - e.g. because the whole createmeta call errors out, or the field
  // isn't marked `required` on this project's create screen even though Jira still rejects the
  // create request without it. As a last resort specifically for Epics, look up the "Epic
  // Name" field ID via Jira's global field list (`/field`, unaffected by createmeta bugs) and
  // set it directly if it wasn't already populated above.
  if (normalizedType.toLowerCase() === "epic" && !Object.keys(metadataFields).length) {
    try {
      const epicNameFieldKey = await findFieldKeyByName(apiRoot, baseUrl, "Epic Name");
      if (epicNameFieldKey) {
        fields[epicNameFieldKey] = normalizedSummary;
      }
    } catch (fieldLookupError) {
      console.warn(
        `[Jira Manager] Epic Name field lookup failed, submitting without it: ${fieldLookupError.message}`
      );
    }
  }

  const normalizedAssigneeAccountId = (assigneeAccountId || "").trim();
  if (normalizedAssigneeAccountId && metadata.hasAssigneeField) {
    fields.assignee = toAssigneeField(apiRoot, normalizedAssigneeAccountId);
  } else if (normalizedAssigneeAccountId && !metadata.hasAssigneeField) {
    throw new Error("Assignee is not available for this issue type/project.");
  } else if (metadata.hasAssigneeField) {
    // No assignee was chosen ("Unassigned" selected in the panel). Jira does NOT leave new
    // issues unassigned just because the `assignee` field is omitted from the create request -
    // many projects have a "Default Assignee" scheme (e.g. "Project Lead" or, in some Server/DC
    // configs, the reporter) that Jira applies automatically whenever `assignee` isn't present
    // at all, which is why a Story explicitly left "Unassigned" in the panel could still come
    // out assigned to the reporter (the logged-in user). Explicitly sending `assignee: null`
    // tells Jira to leave the issue unassigned regardless of any default assignee scheme.
    fields.assignee = null;
  }

  const normalizedParentEpicKey = (parentEpicKey || "").trim();
  if (normalizedParentEpicKey) {
    if (metadata.hasParentField) {
      fields.parent = { key: normalizedParentEpicKey };
    } else if (metadata.epicLinkFieldKey) {
      fields[metadata.epicLinkFieldKey] = normalizedParentEpicKey;
    } else {
      // Metadata didn't tell us how to link a parent Epic (e.g. createmeta failed entirely, or
      // this issue type's create screen doesn't expose the field even though Jira still accepts
      // it). Classic Jira Server/Data Center links Epics via the "Epic Link" custom field, not
      // "parent" (which is reserved for actual sub-tasks) - look it up via the global field list
      // as a last resort before giving up.
      let epicLinkFieldKey = "";
      try {
        epicLinkFieldKey = await findFieldKeyByName(apiRoot, baseUrl, "Epic Link");
      } catch (fieldLookupError) {
        console.warn(`[Jira Manager] Epic Link field lookup failed: ${fieldLookupError.message}`);
      }

      if (epicLinkFieldKey) {
        fields[epicLinkFieldKey] = normalizedParentEpicKey;
      } else {
        throw new Error(
          "Epic parent is not available for this issue type/project. Jira metadata does not expose parent or Epic Link field."
        );
      }
    }
  }


  const issue = await jiraFetch(baseUrl, `${apiRoot}/issue`, {
    method: "POST",
    body: JSON.stringify({ fields })
  });

  return { id: issue.id, key: issue.key };
}

async function getCreateMetaFields(apiRoot, baseUrl, projectKey, issueTypeName, summary) {
  const path = `${apiRoot}/issue/createmeta?projectKeys=${encodeURIComponent(
    projectKey
  )}&issuetypeNames=${encodeURIComponent(issueTypeName)}&expand=projects.issuetypes.fields`;
  const createMeta = await jiraFetch(baseUrl, path, { method: "GET" });

  const issueTypeMeta =
    createMeta.projects?.[0]?.issuetypes?.find((it) => it.name === issueTypeName) || null;
  const fields = issueTypeMeta?.fields || {};

  return buildMetadataFromFieldsMap(fields, summary);
}

// Some Jira Server/Data Center instances throw a generic 404 from the classic bulk
// `issue/createmeta?...&expand=projects.issuetypes.fields` call even when the project/issue
// type/permissions are all fine (a known Jira bug triggered by a broken field reference on
// that create screen). Jira's own "Create" dialog avoids this because modern Jira versions
// fetch metadata per-issue-type via these newer scoped endpoints instead - try the same path
// as a fallback before giving up on metadata entirely.
async function getCreateMetaFieldsScoped(apiRoot, baseUrl, projectKey, issueTypeName, summary) {
  const issueTypesPath = `${apiRoot}/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`;
  const issueTypesResponse = await jiraFetch(baseUrl, issueTypesPath, { method: "GET" });
  const issueTypes = issueTypesResponse.values || issueTypesResponse.issueTypes || [];
  const issueTypeMeta = issueTypes.find(
    (it) => String(it.name || "").toLowerCase() === issueTypeName.toLowerCase()
  );
  if (!issueTypeMeta?.id) {
    throw new Error(`Issue type "${issueTypeName}" not found via scoped createmeta lookup.`);
  }

  const fieldsPath = `${apiRoot}/issue/createmeta/${encodeURIComponent(
    projectKey
  )}/issuetypes/${encodeURIComponent(issueTypeMeta.id)}/fields`;
  const fieldsResponse = await jiraFetch(baseUrl, fieldsPath, { method: "GET" });
  const fieldValues = fieldsResponse.values || [];

  const fields = {};
  for (const fieldInfo of fieldValues) {
    if (fieldInfo?.fieldId) {
      fields[fieldInfo.fieldId] = {
        required: Boolean(fieldInfo.required),
        name: fieldInfo.name
      };
    }
  }

  return buildMetadataFromFieldsMap(fields, summary);
}

function buildMetadataFromFieldsMap(fields, summary) {
  const additionalFields = {};
  for (const [fieldKey, fieldInfo] of Object.entries(fields)) {
    if (
      fieldInfo?.required &&
      fieldInfo?.name &&
      fieldInfo.name.toLowerCase() === "epic name"
    ) {
      // "Epic Name" is a distinct field from "Summary" in Jira's data model, but the user wants
      // them to always match - use the issue's actual Summary rather than a generic
      // "<Type> - <date>" placeholder.
      additionalFields[fieldKey] = summary;
    }
  }

  return {
    additionalFields,
    hasAssigneeField: Boolean(fields.assignee),
    hasParentField: Boolean(fields.parent),
    epicLinkFieldKey: findEpicLinkFieldKey(fields)
  };
}

function findEpicLinkFieldKey(fields) {
  for (const [fieldKey, fieldInfo] of Object.entries(fields || {})) {
    const fieldName = String(fieldInfo?.name || "").toLowerCase();
    if (fieldName === "epic link") {
      return fieldKey;
    }
  }
  return "";
}

// Looks up a field's key/id by its display name using Jira's global field list. This endpoint
// enumerates every field defined on the whole Jira instance (not scoped to a project/issue
// type), so it is unaffected by the createmeta bugs that can hide fields like "Epic Name" on
// some Jira Server/Data Center instances.
async function findFieldKeyByName(apiRoot, baseUrl, fieldName) {
  const allFields = await jiraFetch(baseUrl, `${apiRoot}/field`, { method: "GET" });
  const normalizedTarget = fieldName.toLowerCase();
  const match = (Array.isArray(allFields) ? allFields : []).find(
    (field) => String(field?.name || "").toLowerCase() === normalizedTarget
  );
  return match?.id || match?.key || "";
}

async function createFrontendSubtasks(
  baseUrl,
  { apiRoot, parentIssueKey, projectKey, storySummary, roles }
) {
  const requestedRoles = Array.isArray(roles) && roles.length ? roles : null;
  const created = [];
  const failures = [];

  try {
    const settings = await getStorageSync().get({
      frontendAssignees: [],
      frontendAssignments: [],
      subtaskTemplate: DEFAULT_SUBTASK_TEMPLATE
    });

    const assignments = normalizeFrontendAssignments(
      settings.frontendAssignments,
      settings.frontendAssignees
    );

    if (assignments.length < 3) {
      throw new Error(
        "At least 3 frontend assignments (account + role) must be configured in extension options."
      );
    }

    const subtaskIssueType = await getSubtaskIssueType(apiRoot, baseUrl);
    // `roles` (from the platform pill selector) narrows the fixed 3 configured assignments down to
    // only the platforms the user actually selected - one subtask per selected role, instead of
    // always creating all 3.
    const selectedAssignments = requestedRoles
      ? assignments.filter((assignment) => requestedRoles.includes(assignment.role))
      : assignments.slice(0, 3);
    const baseStorySummary = removeFrontsPrefix(storySummary);

    for (let index = 0; index < selectedAssignments.length; index += 1) {
      const assignment = selectedAssignments[index];
      const assignee = assignment.accountId;
      const role = assignment.role;
      const summary = `[${role}] ${baseStorySummary}`;
      const descriptionText = settings.subtaskTemplate
        .replaceAll("{index}", String(index + 1))
        .replaceAll("{storySummary}", baseStorySummary)
        .replaceAll("{role}", role);

      // Each platform's subtask is created independently - one platform's failure (e.g. a
      // transient Jira error) must not prevent the other selected platforms' subtasks from being
      // attempted, nor block anything that runs after subtask creation (image upload, the Slack
      // webhook notification).
      try {
        const issue = await createSubtaskWithRetry({
          baseUrl,
          apiRoot,
          projectKey,
          parentIssueKey,
          subtaskIssueTypeId: subtaskIssueType.id,
          summary,
          descriptionText,
          assignee
        });
        created.push(issue.key);
      } catch (error) {
        failures.push(`${role} subtask failed: ${error.message}`);
      }
    }
  } catch (error) {
    // Setup-level failures (missing config, subtask issue type lookup failing, etc.) apply to
    // every requested role at once, since no subtasks could even be attempted.
    failures.push(error.message);
  }

  return { created, failures };
}

async function createSubtaskWithRetry({
  baseUrl,
  apiRoot,
  projectKey,
  parentIssueKey,
  subtaskIssueTypeId,
  summary,
  descriptionText,
  assignee
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await jiraFetch(baseUrl, `${apiRoot}/issue`, {
        method: "POST",
        body: JSON.stringify({
          fields: {
            project: { key: projectKey },
            parent: { key: parentIssueKey },
            issuetype: { id: subtaskIssueTypeId },
            summary,
            description: toDescriptionField(apiRoot, descriptionText),
            assignee: toAssigneeField(apiRoot, assignee)
          }
        })
      });
    } catch (error) {
      lastError = error;
      if (!/Issue Does Not Exist/i.test(error.message) || attempt === 3) {
        throw error;
      }
      await delay(500);
    }
  }
  throw lastError;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeFrontendAssignments(frontendAssignments, frontendAssignees) {
  const assignments = Array.isArray(frontendAssignments) ? frontendAssignments : [];
  if (assignments.length >= 3) {
    return assignments
      .slice(0, 3)
      .map((assignment, index) => ({
        accountId: String(assignment?.accountId || "").trim(),
        role: String(assignment?.role || DEFAULT_FRONTEND_ASSIGNMENT_ROLES[index]).trim()
      }))
      .filter((assignment) => assignment.accountId && assignment.role);
  }

  const assignees = Array.isArray(frontendAssignees) ? frontendAssignees : [];
  return DEFAULT_FRONTEND_ASSIGNMENT_ROLES.map((role, index) => ({
    accountId: String(assignees[index] || "").trim(),
    role
  })).filter((assignment) => assignment.accountId);
}

async function getSubtaskIssueType(apiRoot, baseUrl) {
  const issueTypes = await jiraFetch(baseUrl, `${apiRoot}/issuetype`, { method: "GET" });
  const subtaskType =
    issueTypes.find((it) => it.subtask && it.name.toLowerCase() === "sub-task") ||
    issueTypes.find((it) => it.subtask);

  if (!subtaskType) {
    throw new Error("No Jira sub-task issue type was found.");
  }

  return { id: subtaskType.id, name: subtaskType.name };
}

async function resolveJiraApiRoot(baseUrl, forceRefresh = false) {
  const settings = await getStorageSync().get({ jiraApiRootOverride: "" });
  const storedOverride = normalizeApiRootOverride(settings.jiraApiRootOverride);
  // Do not trust chrome.storage.get()'s default-filling behavior here: it only applies a default
  // when the key is entirely absent from storage. Many installs already have an explicit empty
  // string saved for this key (from before this override existed, or from opening/saving Options
  // once), which would silently defeat a storage-level default. Instead, hardcode the fallback at
  // the application level: an explicit non-empty override always wins; typing "auto" explicitly
  // opts back into detection (useful for Jira Cloud, which uses /rest/api/3); any other empty
  // value assumes "/rest/api/2" (the confirmed-working root for this Jira Server/Data Center
  // instance) rather than falling through to auto-detection, which has repeatedly locked onto
  // invalid alias paths here.
  const requestsAutoDetection = storedOverride.toLowerCase() === "auto";
  let override;
  if (requestsAutoDetection) {
    override = ""; // explicit opt-out: fall through to detection below
  } else if (storedOverride) {
    override = storedOverride;
  } else {
    override = "/rest/api/2";
  }
  console.log(
    `[Jira Manager] resolveJiraApiRoot: storedOverride="${storedOverride}", resolvedOverride="${override}", forceRefresh=${forceRefresh}`
  );
  if (override) {
    // A manually pinned root always wins: it skips detection entirely, avoiding any risk of
    // auto-detection landing on a look-alike path (e.g. a legacy alias context on Jira
    // Server/Data Center that responds to GET but redirects to a login/permission page on other
    // requests) that happens to pass the lightweight /myself probe below.
    jiraApiRootByBaseUrl.set(baseUrl, override);
    return override;
  }

  if (!forceRefresh && jiraApiRootByBaseUrl.has(baseUrl)) {
    return jiraApiRootByBaseUrl.get(baseUrl);
  }

  let lastError = null;
  for (const candidate of JIRA_API_ROOT_CANDIDATES) {
    try {
      const user = await jiraFetch(baseUrl, `${candidate}/myself`, { method: "GET" });
      if (user && (user.displayName || user.accountId || user.name)) {
        jiraApiRootByBaseUrl.set(baseUrl, candidate);
        return candidate;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw new Error(`Unable to detect Jira API endpoint. ${lastError.message}`);
  }

  throw new Error("Unable to detect Jira API endpoint.");
}

function normalizeApiRootOverride(rawValue) {
  const value = (rawValue || "").trim();
  if (!value) {
    return "";
  }
  if (value.toLowerCase() === "auto") {
    return "auto";
  }
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.replace(/\/+$/, "");
}
