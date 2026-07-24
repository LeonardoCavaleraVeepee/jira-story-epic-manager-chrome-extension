"use strict";

// FRONTEND_DEVICE_OPTIONS, escapeHtml, formatAssigneeLabel, getJiraDomainFromBaseUrl,
// getStorageSync, normalizeFrontendAssignments, buildIssueLink, and setIssueResultStatus are
// defined in shared_utils.js (loaded first, see manifest.json's content_scripts entry for this
// file) since they're identical to the copies popup.js needs - see that file's header comment
// for why.

if (!document.getElementById("jira-gemini-launcher")) {
  bootGeminiJiraIntegration().catch((error) => {
    console.error("Jira Gemini integration failed:", error);
  });
}

function updateDetailsPreview(panel) {
  const markdown = panel.details.value.trim();
  if (!markdown) {
    panel.detailsPreview.textContent = "Markdown preview will appear here.";
    return;
  }
  panel.detailsPreview.innerHTML = markdownToHtml(markdown, panel.pendingImages);
}

// Pasting rich text (e.g. copied from Gemini's rendered response, which is HTML with real
// <strong>/<ul>/<h2> tags rather than literal markdown characters) into a plain <textarea>
// normally loses all formatting: the browser converts the clipboard content to plain text
// using textContent, which never contained markdown syntax to begin with. Intercept the paste
// and convert the clipboard's HTML into actual Markdown text instead, when HTML is available.
function onDetailsPaste(panel, event) {
  const clipboardData = event.clipboardData || window.clipboardData;

  const imageFile = getImageFileFromClipboard(clipboardData);
  if (imageFile) {
    event.preventDefault();
    addPendingImage(panel, imageFile);
    return;
  }

  const html = clipboardData?.getData("text/html");
  if (!html) {
    return;
  }

  const container = document.createElement("div");
  container.innerHTML = html;
  const markdown = convertNodeToMarkdown(container).trim();
  if (!markdown) {
    return;
  }

  event.preventDefault();
  insertTextAtCursor(panel.details, markdown);
  updateDetailsPreview(panel);
}

function onDetailsDrop(panel, event) {
  const files = [...(event.dataTransfer?.files || [])].filter((file) => file.type.startsWith("image/"));
  if (!files.length) {
    return;
  }
  event.preventDefault();
  for (const file of files) {
    addPendingImage(panel, file);
  }
}

function getImageFileFromClipboard(clipboardData) {
  if (!clipboardData?.items) {
    return null;
  }
  for (const item of clipboardData.items) {
    if (item.kind === "file" && item.type && item.type.startsWith("image/")) {
      return item.getAsFile();
    }
  }
  return null;
}

function onImagesSelected(panel, fileList) {
  for (const file of [...(fileList || [])]) {
    if (file.type && file.type.startsWith("image/")) {
      addPendingImage(panel, file);
    }
  }
  panel.imageInput.value = "";
}

// Reads the image as a data URL (kept in memory only - never written to chrome.storage) and
// inserts a placeholder into Details at the cursor using a filename that is chosen right now and
// reused unchanged as the actual attachment filename once the issue is created/updated. This
// lets the wiki-markup image reference (`!filename!`) resolve correctly without any further edit,
// since the filename in the text and the filename of the uploaded attachment always match.
async function addPendingImage(panel, file) {
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const filename = buildUniqueImageFilename(panel, file.name);
    panel.pendingImages.set(filename, { file, dataUrl, displayName: file.name || filename });
    insertTextAtCursor(panel.details, `![${file.name || "image"}](image:${filename})\n`);
    updateDetailsPreview(panel);
    renderPendingImagesList(panel);
  } catch (error) {
    setStatus(panel.resultStatus, error.message, true);
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the selected image file."));
    reader.readAsDataURL(file);
  });
}

function buildUniqueImageFilename(panel, originalName) {
  const safeBase = String(originalName || "image.png").replace(/[^a-zA-Z0-9._-]/g, "_");
  const base = /\.[a-zA-Z0-9]+$/.test(safeBase) ? safeBase : `${safeBase}.png`;
  let candidate = `${Date.now()}-${panel.pendingImages.size + 1}-${base}`;
  let attempt = 1;
  while (panel.pendingImages.has(candidate)) {
    attempt += 1;
    candidate = `${Date.now()}-${panel.pendingImages.size + attempt}-${base}`;
  }
  return candidate;
}

function renderPendingImagesList(panel) {
  panel.imageList.innerHTML = "";
  if (!panel.pendingImages.size) {
    panel.imageList.textContent = "No images attached.";
    return;
  }
  for (const [filename, info] of panel.pendingImages) {
    const row = document.createElement("div");
    row.className = "jira-image-row";
    const label = document.createElement("span");
    label.textContent = info.displayName;
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", () => removePendingImage(panel, filename));
    row.append(label, removeButton);
    panel.imageList.appendChild(row);
  }
}

function removePendingImage(panel, filename) {
  panel.pendingImages.delete(filename);
  const pattern = new RegExp(`!\\[[^\\]]*\\]\\(image:${filename}\\)\\n?`, "g");
  panel.details.value = panel.details.value.replace(pattern, "");
  updateDetailsPreview(panel);
  renderPendingImagesList(panel);
}

function insertTextAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const value = textarea.value;
  textarea.value = value.slice(0, start) + text + value.slice(end);
  const cursor = start + text.length;
  textarea.selectionStart = cursor;
  textarea.selectionEnd = cursor;
}

function markdownToHtml(markdown, imageMap) {
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
      html.push(`<h${level}>${inlineMarkdownToHtml(heading[2], imageMap)}</h${level}>`);
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
      html.push(`<li>${inlineMarkdownToHtml(bullet[1], imageMap)}</li>`);
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
      html.push(`<li>${inlineMarkdownToHtml(numbered[1], imageMap)}</li>`);
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
      html.push(`<p>${inlineMarkdownToHtml(trimmed, imageMap)}</p>`);
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

// `imageMap` is the panel's pendingImages Map (filename -> { dataUrl, displayName }), used so the
// live preview can render an actual thumbnail for `![alt](image:filename)` placeholders instead
// of leaving raw placeholder text visible - the data URL is available locally since the image
// hasn't been uploaded to Jira yet at preview time.
function inlineMarkdownToHtml(text, imageMap) {
  return text
    .replace(/!\[([^\]]*)\]\(image:([^)]+)\)/g, (_match, alt, filename) => {
      const info = imageMap?.get(filename);
      if (!info) {
        return `[Image: ${alt || filename}]`;
      }
      return `<br><img src="${info.dataUrl}" alt="${alt}" class="jira-image-preview" /><br>`;
    })
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

// Converts a DOM node's rendered HTML into Markdown text, preserving headings, bold/italic,
// inline code, links, and bullet/numbered lists. Used both for pasting rich text into the
// Details textarea and for pulling structured content out of Gemini's rendered response -
// without this, formatting present in the source HTML (e.g. **bold**, "- " bullets) simply
// disappears because the browser/DOM only exposes plain textContent by default, which never
// contained the markdown syntax to begin with (the formatting lived in HTML tags, not text).
function convertNodeToMarkdown(rootNode) {
  const blocks = [];
  let inlineBuffer = "";

  const flushInline = () => {
    const trimmed = inlineBuffer.trim();
    if (trimmed) {
      blocks.push(trimmed);
    }
    inlineBuffer = "";
  };

  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        inlineBuffer += child.textContent;
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }

      const tag = child.tagName;
      switch (tag) {
        case "H1":
        case "H2":
        case "H3":
        case "H4":
        case "H5":
        case "H6": {
          flushInline();
          const level = Number(tag[1]);
          const text = convertInlineMarkdown(child).trim();
          if (text) {
            blocks.push(`${"#".repeat(level)} ${text}`);
          }
          break;
        }
        case "P": {
          flushInline();
          const text = convertInlineMarkdown(child).trim();
          if (text) {
            blocks.push(text);
          }
          break;
        }
        case "DIV":
        case "SECTION":
        case "ARTICLE":
        case "MAIN": {
          flushInline();
          walk(child);
          break;
        }
        case "UL": {
          flushInline();
          const items = [...child.children]
            .filter((item) => item.tagName === "LI")
            .map((item) => `- ${convertInlineMarkdown(item).trim()}`)
            .filter((line) => line !== "-");
          if (items.length) {
            blocks.push(items.join("\n"));
          }
          break;
        }
        case "OL": {
          flushInline();
          const items = [...child.children]
            .filter((item) => item.tagName === "LI")
            .map((item, index) => `${index + 1}. ${convertInlineMarkdown(item).trim()}`);
          if (items.length) {
            blocks.push(items.join("\n"));
          }
          break;
        }
        case "PRE": {
          flushInline();
          const codeText = child.textContent.replace(/\n+$/, "");
          blocks.push(`\`\`\`\n${codeText}\n\`\`\``);
          break;
        }
        case "BLOCKQUOTE": {
          flushInline();
          const inner = convertInlineMarkdown(child).trim();
          if (inner) {
            blocks.push(
              inner
                .split("\n")
                .map((line) => `> ${line}`)
                .join("\n")
            );
          }
          break;
        }
        case "HR": {
          flushInline();
          blocks.push("---");
          break;
        }
        default: {
          inlineBuffer += convertInlineMarkdown(child);
        }
      }
    }
  };

  walk(rootNode);
  flushInline();
  return blocks.join("\n\n");
}

function convertInlineMarkdown(node) {
  let result = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      result += child.textContent;
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    const tag = child.tagName;
    switch (tag) {
      case "BR":
        result += "\n";
        break;
      case "STRONG":
      case "B": {
        const inner = convertInlineMarkdown(child).trim();
        result += inner ? `**${inner}**` : "";
        break;
      }
      case "EM":
      case "I": {
        const inner = convertInlineMarkdown(child).trim();
        result += inner ? `*${inner}*` : "";
        break;
      }
      case "CODE":
        result += `\`${child.textContent}\``;
        break;
      case "A": {
        const href = child.getAttribute("href");
        const text = convertInlineMarkdown(child).trim();
        result += href && text ? `[${text}](${href})` : text;
        break;
      }
      default:
        result += convertInlineMarkdown(child);
    }
  }
  return result;
}

// Matches if every whitespace-separated word in the search text appears somewhere in the
// haystack, in any order (e.g. searching "test AI" matches "AI test project"). A plain
// substring match ("aggh test".includes("test AI")) was too strict and made project/epic/
// assignee search feel broken whenever word order in the search box didn't exactly match the
// underlying text.
function matchesSearchTokens(haystack, searchText) {
  const normalizedHaystack = String(haystack || "").toLowerCase();
  const tokens = String(searchText || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return tokens.every((token) => normalizedHaystack.includes(token));
}

async function bootGeminiJiraIntegration() {
  const launcher = document.createElement("button");
  launcher.id = "jira-gemini-launcher";
  launcher.type = "button";
  launcher.textContent = "Send to Jira";

  const panel = buildPanel();
  document.body.appendChild(launcher);
  document.body.appendChild(panel.root);

  // Attach every event listener BEFORE doing any async initialization (settings hydration,
  // auto-connecting to Jira, loading projects/assignees/epics). Previously this was ordered the
  // other way around: `await hydratePanelSettings(panel)` ran first, and if that promise
  // rejected for any reason (storage API hiccup, network error, an unexpected exception in a
  // helper), the whole boot function would throw before ever reaching the addEventListener
  // calls below - leaving the "Send to Jira" launcher button (and the panel's own Close/Submit/
  // etc. buttons) visibly present but completely non-functional, since no click handler was
  // ever wired up. Listeners must always be attached regardless of whether the async hydration
  // step succeeds.
  launcher.addEventListener("click", () => {
    panel.root.classList.toggle("hidden");
    // Only auto-pull the latest Gemini response when the panel is opened with nothing already
    // in progress (empty Summary/Details). Previously this always ran on every reopen, which
    // meant closing the panel and reopening it - even just to check something on the page -
    // would silently overwrite whatever the user had already typed or edited. Explicit "Refresh
    // from Gemini" clicks (the button below) still always refresh, since that's an intentional
    // action.
    const hasInProgressContent = panel.summary.value.trim() || panel.details.value.trim();
    if (!panel.root.classList.contains("hidden") && !hasInProgressContent) {
      refreshFromGemini(panel);
    }
  });

  panel.mode.addEventListener("change", () => updateModeState(panel));
  panel.issueType.addEventListener("change", () => updateModeState(panel));
  panel.openOptionsButton.addEventListener("click", () => openJiraOptionsPage());
  panel.projectSearch.addEventListener("input", () => onProjectSearchInput(panel));
  panel.projectSearch.addEventListener("focus", () => onProjectFocus(panel));
  panel.projectSearch.addEventListener("blur", () => onProjectBlur(panel));
  panel.projectSearch.addEventListener("keydown", (event) => onProjectKeydown(panel, event));
  panel.assigneeSearch.addEventListener("input", () => onAssigneeSearchInput(panel));
  panel.assigneeSearch.addEventListener("focus", () => onAssigneeFocus(panel));
  panel.assigneeSearch.addEventListener("blur", () => onAssigneeBlur(panel));
  panel.assigneeSearch.addEventListener("keydown", (event) => onAssigneeKeydown(panel, event));
  panel.epicSearch.addEventListener("input", () => onEpicSearchInput(panel));
  panel.epicSearch.addEventListener("focus", () => onEpicFocus(panel));
  panel.epicSearch.addEventListener("blur", () => onEpicBlur(panel));
  panel.epicSearch.addEventListener("keydown", (event) => onEpicKeydown(panel, event));
  panel.issueSearch.addEventListener("input", () => onIssueSearchInput(panel));
  panel.issueSearch.addEventListener("focus", () => onIssueFocus(panel));
  panel.issueSearch.addEventListener("blur", () => onIssueBlur(panel));
  panel.issueSearch.addEventListener("keydown", (event) => onIssueKeydown(panel, event));
  panel.details.addEventListener("input", () => updateDetailsPreview(panel));
  panel.details.addEventListener("paste", (event) => onDetailsPaste(panel, event));
  panel.details.addEventListener("dragover", (event) => event.preventDefault());
  panel.details.addEventListener("drop", (event) => onDetailsDrop(panel, event));
  panel.imageInput.addEventListener("change", () => onImagesSelected(panel, panel.imageInput.files));
  panel.closeButton.addEventListener("click", (event) => closePanel(panel, event));
  panel.refreshButton.addEventListener("click", () => refreshFromGemini(panel));
  panel.submitButton.addEventListener("click", () => onSubmit(panel));
  panel.sendToSlack.addEventListener("change", () => updateSlackFieldsVisibility(panel));

  initPanelResize(panel);

  // Everything below is best-effort initialization. It's wrapped so a failure here (e.g. Jira
  // unreachable, stale/invalidated extension context) only shows up as a status message inside
  // the panel - it must never take down the listeners registered above.
  try {
    await hydratePanelSettings(panel);
    refreshFromGemini(panel);
    updateModeState(panel);
  } catch (error) {
    console.error("Jira Gemini panel initialization failed:", error);
    setStatus(panel.connectionStatus, error.message, true);
  }
}

function buildPanel() {
  const root = document.createElement("aside");
  root.id = "jira-gemini-panel";
  root.classList.add("hidden");
  root.innerHTML = `
    <div id="jiraResizeHandle" title="Drag to resize"></div>
    <div class="jira-header">
      <h2>Create/Update Jira</h2>
      <button id="jiraCloseButton" type="button">Close</button>
    </div>
    <div class="jira-body">
    <p id="jiraConnectedDomain" class="jira-muted"></p>

    <label for="jiraProjectSearch">Project <span class="jira-required">*</span></label>
    <div class="jira-combobox">
      <input id="jiraProjectSearch" placeholder="Type to search projects by key or name" autocomplete="off" />
      <div id="jiraProjectDropdown" class="jira-combobox-dropdown hidden"></div>
    </div>
    <p id="jiraProjectStatus" class="jira-muted">Project is required</p>

    <div class="jira-row">
      <button id="jiraOpenOptionsButton" type="button">Jira Settings</button>
    </div>
    <p id="jiraConnectionStatus" class="jira-muted"></p>

    <label for="jiraMode">Action</label>
    <select id="jiraMode">
      <option value="create">Create new issue</option>
      <option value="update">Update existing issue</option>
    </select>

    <label for="jiraIssueType">Issue Type</label>
    <div class="jira-issuetype-row">
      <span id="jiraIssueTypeIcon" class="jira-issuetype-icon" aria-hidden="true"></span>
      <select id="jiraIssueType">
        <option value="Story">Story</option>
        <option value="Task">Task</option>
        <option value="Epic">Epic</option>
      </select>
    </div>

    <section id="jiraUpdateSection" class="jira-section hidden">
      <label for="jiraIssueSearch">Issue to update <span class="jira-required">*</span></label>
      <div class="jira-combobox">
        <input id="jiraIssueSearch" placeholder="Type to search issues by key or summary" autocomplete="off" />
        <div id="jiraIssueDropdown" class="jira-combobox-dropdown hidden"></div>
      </div>
      <p id="jiraIssueStatus" class="jira-muted">Select a project and issue type first</p>
    </section>

    <section id="jiraEpicSection" class="jira-section">
      <label for="jiraEpicSearch">Parent Epic <span class="jira-required">*</span></label>
      <div class="jira-combobox">
        <input id="jiraEpicSearch" placeholder="Type to search epics by key or summary" autocomplete="off" />
        <div id="jiraEpicDropdown" class="jira-combobox-dropdown hidden"></div>
      </div>
      <p id="jiraEpicStatus" class="jira-muted">Parent epic is required</p>
    </section>

    <label for="jiraSummary">Title</label>
    <input id="jiraSummary" placeholder="Issue title" />

    <label for="jiraDetails">Details</label>
    <textarea id="jiraDetails" placeholder="Detailed acceptance criteria, context, technical notes... (Markdown supported)"></textarea>
    <p class="jira-muted">Markdown preview</p>
    <div id="jiraDetailsPreview" class="jira-markdown-preview"></div>

    <section id="jiraImageSection" class="jira-section">
      <label for="jiraImageInput">Images</label>
      <input id="jiraImageInput" type="file" accept="image/*" multiple />
      <p class="jira-muted">You can also paste or drag &amp; drop an image directly into Details.</p>
      <div id="jiraImageList" class="jira-image-list">No images attached.</div>
    </section>

    <section id="jiraAssigneeSection" class="jira-section">
      <label for="jiraAssigneeSearch">Assignee</label>
      <div class="jira-combobox">
        <input id="jiraAssigneeSearch" placeholder="Type a name or email to search" autocomplete="off" />
        <div id="jiraAssigneeDropdown" class="jira-combobox-dropdown hidden"></div>
      </div>
      <p id="jiraAssigneeStatus" class="jira-muted">Default assignment: Unassigned</p>
    </section>

    <section id="jiraFrontendSection" class="jira-section">
      <label for="jiraDevicePills">Frontend platform<span id="jiraFrontendRequiredMark" class="jira-required hidden"> *</span></label>
      <div id="jiraDevicePills" class="jira-pill-group" role="group"></div>
      <p id="jiraDeviceStatus" class="jira-muted"></p>
      <p id="jiraFrontendAssignees" class="jira-muted"></p>
    </section>

    <section id="jiraSlackSection" class="jira-section">
      <div class="jira-checkbox">
        <input id="jiraSendToSlack" type="checkbox" />
        <label for="jiraSendToSlack">Send to Slack "Front Request" workflow</label>
      </div>
      <div id="jiraSlackFields" class="jira-slack-fields hidden">
        <label for="jiraSlackPriority">Priority</label>
        <select id="jiraSlackPriority">
          <option value="">Select priority…</option>
          <option value="Low">Low</option>
          <option value="Medium">Medium</option>
          <option value="High">High</option>
          <option value="Critical">Critical</option>
        </select>
        <label for="jiraSlackProduct">Product</label>
        <select id="jiraSlackProduct">
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
        <label for="jiraSlackEta">Expected ETA</label>
        <select id="jiraSlackEta">
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
        <label for="jiraSlackFigma">Figma (optional)</label>
        <input id="jiraSlackFigma" placeholder="https://figma.com/..." />
        <label for="jiraSlackChannelFeature">Channel ID (optional)</label>
        <input id="jiraSlackChannelFeature" placeholder="e.g. C0123ABC456" />
        <p class="jira-muted">
          Must be the Slack channel's real ID, not its name - open the channel, click its name at
          the top &rarr; scroll down to "Channel ID" &rarr; copy it.
        </p>
      </div>
      <p id="jiraSlackStatus" class="jira-muted"></p>
    </section>

    <div class="jira-actions">
      <button id="jiraRefreshButton" type="button">Refresh from Gemini</button>
      <button id="jiraSubmitButton" type="button">Submit to Jira</button>
    </div>
    <p id="jiraResultStatus" class="jira-status"></p>
    </div>
  `;

  return {
    root,
    resizeHandle: root.querySelector("#jiraResizeHandle"),
    closeButton: root.querySelector("#jiraCloseButton"),
    // The Jira URL is configured once in the extension's Options page, not here - this holds
    // that value in-memory (kept in sync from storage in hydratePanelSettings) so the rest of
    // the panel's logic can keep reading `panel.baseUrl.value` exactly as it did when this used
    // to be a real input element, without needing a wider refactor.
    baseUrl: { value: "" },
    connectedDomain: root.querySelector("#jiraConnectedDomain"),
    openOptionsButton: root.querySelector("#jiraOpenOptionsButton"),
    projectSearch: root.querySelector("#jiraProjectSearch"),
    projectDropdown: root.querySelector("#jiraProjectDropdown"),
    projectStatus: root.querySelector("#jiraProjectStatus"),
    // Not a real input - the project key is only ever set programmatically via selectProject(),
    // mirroring the panel.baseUrl pattern so every existing `panel.projectKey.value` call site
    // across the file keeps working unchanged.
    projectKey: { value: "" },
    connectionStatus: root.querySelector("#jiraConnectionStatus"),
    mode: root.querySelector("#jiraMode"),
    updateSection: root.querySelector("#jiraUpdateSection"),
    issueSearch: root.querySelector("#jiraIssueSearch"),
    issueDropdown: root.querySelector("#jiraIssueDropdown"),
    issueStatus: root.querySelector("#jiraIssueStatus"),
    issueType: root.querySelector("#jiraIssueType"),
    issueTypeIcon: root.querySelector("#jiraIssueTypeIcon"),
    summary: root.querySelector("#jiraSummary"),
    details: root.querySelector("#jiraDetails"),
    detailsPreview: root.querySelector("#jiraDetailsPreview"),
    imageInput: root.querySelector("#jiraImageInput"),
    imageList: root.querySelector("#jiraImageList"),
    assigneeSection: root.querySelector("#jiraAssigneeSection"),
    assigneeSearch: root.querySelector("#jiraAssigneeSearch"),
    assigneeDropdown: root.querySelector("#jiraAssigneeDropdown"),
    assigneeStatus: root.querySelector("#jiraAssigneeStatus"),
    epicSection: root.querySelector("#jiraEpicSection"),
    epicSearch: root.querySelector("#jiraEpicSearch"),
    epicDropdown: root.querySelector("#jiraEpicDropdown"),
    epicStatus: root.querySelector("#jiraEpicStatus"),
    frontendSection: root.querySelector("#jiraFrontendSection"),
    frontendAssignees: root.querySelector("#jiraFrontendAssignees"),
    devicePills: root.querySelector("#jiraDevicePills"),
    deviceStatus: root.querySelector("#jiraDeviceStatus"),
    frontendRequiredMark: root.querySelector("#jiraFrontendRequiredMark"),
    slackSection: root.querySelector("#jiraSlackSection"),
    sendToSlack: root.querySelector("#jiraSendToSlack"),
    slackFields: root.querySelector("#jiraSlackFields"),
    slackPriority: root.querySelector("#jiraSlackPriority"),
    slackProduct: root.querySelector("#jiraSlackProduct"),
    slackEta: root.querySelector("#jiraSlackEta"),
    slackFigma: root.querySelector("#jiraSlackFigma"),
    slackChannelFeature: root.querySelector("#jiraSlackChannelFeature"),
    slackStatus: root.querySelector("#jiraSlackStatus"),
    refreshButton: root.querySelector("#jiraRefreshButton"),
    submitButton: root.querySelector("#jiraSubmitButton"),
    resultStatus: root.querySelector("#jiraResultStatus"),
    issues: [],
    // True while loadIssuesForUpdate() has an in-flight fetch for the currently selected
    // project + issue type - lets the Issue search box show "Loading issues..." instead of a
    // misleading empty/"no matches" state while the fetch is still in flight.
    issuesLoading: false,
    projects: [],
    assignableUsers: [],
    epics: [],
    // True while loadEpics() has an in-flight fetch for the currently selected project - lets
    // the Epic search box show "Loading epics..." instead of the misleading "Select a project
    // first." while a project is selected but its epics haven't arrived yet.
    epicsLoading: false,
    // Currently selected project/assignee/epic, populated only via an explicit dropdown
    // selection (never parsed back out of the free-typed search text) so submission always
    // uses an exact match.
    selectedProject: null,
    selectedAssignee: null,
    selectedEpic: null,
    // The issue currently selected for updating, populated only via an explicit dropdown
    // selection in the Issue search combobox (same "never parsed from free text" rule as
    // selectedProject/selectedEpic above) so submission always targets an exact issue.
    selectedUpdateIssue: null,
    // Frontend platform pill selection. For a Story, any combination can be selected (order of
    // selection is preserved) - one frontend subtask is created per selected platform. For a
    // Task, selecting a pill acts like a radio button (single selection only) - purely metadata
    // about which platform the Task concerns, no subtask is created.
    selectedDevices: [],
    // The list of items currently rendered in each dropdown (in display order), used for
    // keyboard navigation (ArrowUp/Down/Enter) - kept in sync every time a dropdown re-renders.
    projectDropdownItems: [],
    assigneeDropdownItems: [],
    epicDropdownItems: [],
    issueDropdownItems: [],
    projectHighlightIndex: -1,
    assigneeHighlightIndex: -1,
    epicHighlightIndex: -1,
    issueHighlightIndex: -1,
    assigneeSearchDebounceId: null,
    // Maps the unique attachment filename (chosen when the image is added, matching the
    // `!filename!` / `(image:filename)` reference already written into Details) to
    // { file, dataUrl, displayName }. Uploaded to the issue right after it's created/updated.
    pendingImages: new Map()
  };
}

async function hydratePanelSettings(panel) {
  const settings = await getStorageSync().get({
    jiraBaseUrl: "",
    jiraProjectKey: "",
    frontendAssignees: [],
    frontendAssignments: [],
    slackWebhookUrl: ""
  });
  panel.baseUrl.value = settings.jiraBaseUrl || "";
  updateConnectedDomainText(panel);
  setProjectOptions(panel, [], settings.jiraProjectKey || "");
  setAssigneeOptions(panel, []);
  setEpicOptions(panel, []);
  const assignments = normalizeFrontendAssignments(
    settings.frontendAssignments || [],
    settings.frontendAssignees || []
  );
  panel.frontendAssignees.textContent = assignments.length
    ? `Frontend assignees: ${assignments
        .map((assignment) => `${assignment.role}: ${assignment.accountId}`)
        .join(", ")}`
    : "No frontend assignees configured. Use extension Options.";
  // Ask background.js whether a Slack webhook URL has been configured in Options before
  // enabling the checkbox. Defaults to false if the check itself fails for any reason, so the
  // checkbox is never misleadingly enabled.
  let hasSlackWebhook = false;
  try {
    const webhookCheck = await chrome.runtime.sendMessage({ action: "hasSlackWebhook" });
    hasSlackWebhook = Boolean(webhookCheck.ok && webhookCheck.hasWebhook);
  } catch (_error) {
    hasSlackWebhook = false;
  }
  panel.slackWebhookConfigured = hasSlackWebhook;
  panel.sendToSlack.checked = false;
  updateSlackAvailability(panel);
  renderPendingImagesList(panel);
  updateDetailsPreview(panel);

  await autoConnectAndLoadProjects(panel);
}

function updateSlackFieldsVisibility(panel) {
  panel.slackFields.classList.toggle("hidden", !panel.sendToSlack.checked);
}

// The Slack "Front Request" webhook payload's `device` field is derived directly from whichever
// frontend platform pill(s) are selected (see notifySlackWorkflow() in background.js) - sending
// it with no platform selected at all would post a message with an empty/missing device, which
// doesn't correspond to anything meaningful in the Slack workflow. So the "Send to Slack
// workflow" checkbox must only ever be available once at least one platform pill is selected,
// on top of the existing "a webhook URL is configured in Options" requirement.
function updateSlackAvailability(panel) {
  const hasDevice = panel.selectedDevices.length > 0;
  panel.sendToSlack.disabled = !panel.slackWebhookConfigured || !hasDevice;
  if (panel.sendToSlack.disabled) {
    panel.sendToSlack.checked = false;
  }
  if (!panel.slackWebhookConfigured) {
    panel.slackStatus.textContent = "Configure a Slack webhook URL in extension Options to enable this.";
  } else if (!hasDevice) {
    panel.slackStatus.textContent = "Select a frontend platform above to enable this.";
  } else {
    panel.slackStatus.textContent = "";
  }
  updateSlackFieldsVisibility(panel);
}

function setProjectOptions(panel, projects, selectedKey = "") {
  panel.projects = [...projects];
  const selected = (selectedKey || panel.selectedProject?.key || "").trim();
  if (!selected) {
    updateProjectStatusText(panel);
    return;
  }

  const match = panel.projects.find((project) => project.key === selected);
  if (match) {
    panel.selectedProject = match;
    panel.projectKey.value = match.key;
    panel.projectSearch.value = `${match.name} (${match.key})`;
  } else if (!panel.selectedProject || panel.selectedProject.key !== selected) {
    // Keep the previously selected/stored project key visible even before the real project list
    // has loaded (e.g. right after opening the panel, before `loadProjects()` resolves). Without
    // this, the field would blank out on the initial render and, by the time the real project
    // list arrives, the stored selection would already look lost - this was the root cause of
    // "my project selection isn't remembered".
    panel.selectedProject = { key: selected, name: selected };
    panel.projectKey.value = selected;
    panel.projectSearch.value = `${selected} (loading...)`;
  }
  updateProjectStatusText(panel);
}

function clearProjectSelection(panel) {
  panel.selectedProject = null;
  panel.projectKey.value = "";
  panel.projectSearch.value = "";
  updateProjectStatusText(panel);
}

function openProjectDropdown(panel) {
  panel.projectDropdown.classList.remove("hidden");
}

function closeProjectDropdown(panel) {
  panel.projectDropdown.classList.add("hidden");
  panel.projectHighlightIndex = -1;
}

// Projects are already fully fetched on connect (see loadProjects), so this filters instantly on
// every keystroke - no debounce or network round-trip needed, matching the epic combobox.
function renderProjectDropdown(panel, projects, statusText = "") {
  const items = projects.map((project) => ({ project }));
  panel.projectDropdownItems = items;
  panel.projectHighlightIndex = -1;
  panel.projectDropdown.innerHTML = "";

  if (statusText) {
    const status = document.createElement("div");
    status.className = "jira-combobox-status";
    status.textContent = statusText;
    panel.projectDropdown.appendChild(status);
  }

  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "jira-combobox-item";
    row.dataset.index = String(index);
    row.textContent = `${item.project.name} (${item.project.key})`;
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      selectProject(panel, item.project);
    });
    panel.projectDropdown.appendChild(row);
  });

  openProjectDropdown(panel);
}

function highlightProjectItem(panel, index) {
  const rows = panel.projectDropdown.querySelectorAll(".jira-combobox-item");
  rows.forEach((row, rowIndex) => row.classList.toggle("is-highlighted", rowIndex === index));
  panel.projectHighlightIndex = index;
}

function selectProject(panel, project) {
  const previousKey = panel.selectedProject?.key || "";
  panel.selectedProject = project || null;
  panel.projectKey.value = project ? project.key : "";
  panel.projectSearch.value = project ? `${project.name} (${project.key})` : "";
  closeProjectDropdown(panel);
  updateProjectStatusText(panel);
  if (project && project.key !== previousKey) {
    onProjectSelectionChanged(panel);
  }
}

function filterProjects(panel, query) {
  return query
    ? panel.projects.filter((project) => matchesSearchTokens(`${project.key} ${project.name}`, query))
    : panel.projects;
}

function onProjectFocus(panel) {
  const query = panel.projectSearch.value.trim();
  const filtered = filterProjects(panel, query);
  renderProjectDropdown(panel, filtered, panel.projects.length ? "" : "Loading projects...");
}

function onProjectBlur(panel) {
  setTimeout(() => closeProjectDropdown(panel), 150);
}

function onProjectSearchInput(panel) {
  panel.selectedProject = null;
  panel.projectKey.value = "";
  const query = panel.projectSearch.value.trim();
  const filtered = filterProjects(panel, query);
  renderProjectDropdown(panel, filtered, filtered.length ? "" : "No matching projects.");
  updateProjectStatusText(panel);
}

function onProjectKeydown(panel, event) {
  const dropdownHidden = panel.projectDropdown.classList.contains("hidden");
  if (dropdownHidden && event.key !== "ArrowDown") {
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (dropdownHidden) {
      onProjectFocus(panel);
      return;
    }
    highlightProjectItem(
      panel,
      Math.min(panel.projectHighlightIndex + 1, panel.projectDropdownItems.length - 1)
    );
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    highlightProjectItem(panel, Math.max(panel.projectHighlightIndex - 1, 0));
  } else if (event.key === "Enter") {
    event.preventDefault();
    const index = panel.projectHighlightIndex >= 0 ? panel.projectHighlightIndex : 0;
    const item = panel.projectDropdownItems[index];
    if (item) {
      selectProject(panel, item.project);
    }
  } else if (event.key === "Escape") {
    closeProjectDropdown(panel);
  }
}

function updateProjectStatusText(panel) {
  if (panel.selectedProject) {
    panel.projectStatus.textContent = `Selected project: ${panel.selectedProject.name} (${panel.selectedProject.key})`;
    panel.projectStatus.classList.remove("jira-warning");
  } else {
    panel.projectStatus.textContent = "Project is required";
    panel.projectStatus.classList.add("jira-warning");
  }
}

function setAssigneeOptions(panel, users, selectedAccountId = "") {
  panel.assignableUsers = [...users];
  const selected = (selectedAccountId || "").trim();
  if (selected) {
    const match = panel.assignableUsers.find((user) => user.accountId === selected);
    if (match) {
      panel.selectedAssignee = match;
      panel.assigneeSearch.value = formatAssigneeLabel(match);
    }
  }
  updateAssigneeStatusText(panel);
}

function clearAssigneeSelection(panel) {
  panel.selectedAssignee = null;
  panel.assigneeSearch.value = "";
  updateAssigneeStatusText(panel);
}

function updateAssigneeStatusText(panel) {
  panel.assigneeStatus.textContent = panel.selectedAssignee
    ? `Selected assignee: ${formatAssigneeLabel(panel.selectedAssignee)}`
    : "Default assignment: Unassigned";
}

function openAssigneeDropdown(panel) {
  panel.assigneeDropdown.classList.remove("hidden");
}

function closeAssigneeDropdown(panel) {
  panel.assigneeDropdown.classList.add("hidden");
  panel.assigneeHighlightIndex = -1;
}

// Renders the live dropdown for the assignee combobox. `users` is whatever should currently be
// offered (either the small per-project default list, or the results of a server-side
// `/user/picker` search) - a pinned "Unassigned (default)" row is always shown first so clearing
// the assignee is always one click away, matching Jira's own assignee picker.
function renderAssigneeDropdown(panel, users, statusText = "") {
  const items = [{ type: "unassigned" }, ...users.map((user) => ({ type: "user", user }))];
  panel.assigneeDropdownItems = items;
  panel.assigneeHighlightIndex = -1;
  panel.assigneeDropdown.innerHTML = "";

  if (statusText) {
    const status = document.createElement("div");
    status.className = "jira-combobox-status";
    status.textContent = statusText;
    panel.assigneeDropdown.appendChild(status);
  }

  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "jira-combobox-item";
    row.textContent =
      item.type === "unassigned" ? "Unassigned (default)" : formatAssigneeLabel(item.user);
    row.dataset.index = String(index);
    // mousedown (not click) fires before the input's blur handler, so the selection commits
    // before the blur-triggered close-with-delay would otherwise race it.
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      selectAssignee(panel, item.type === "unassigned" ? null : item.user);
    });
    panel.assigneeDropdown.appendChild(row);
  });

  openAssigneeDropdown(panel);
}

function highlightAssigneeItem(panel, index) {
  const rows = panel.assigneeDropdown.querySelectorAll(".jira-combobox-item");
  rows.forEach((row, rowIndex) => row.classList.toggle("is-highlighted", rowIndex === index));
  panel.assigneeHighlightIndex = index;
}

function selectAssignee(panel, user) {
  panel.selectedAssignee = user || null;
  panel.assigneeSearch.value = user ? formatAssigneeLabel(user) : "";
  closeAssigneeDropdown(panel);
  updateAssigneeStatusText(panel);
}

function onAssigneeFocus(panel) {
  const query = panel.assigneeSearch.value.trim();
  if (query) {
    onAssigneeSearchInput(panel);
    return;
  }
  const projectKey = panel.projectKey.value.trim();
  renderAssigneeDropdown(
    panel,
    panel.assignableUsers,
    projectKey ? "" : "Select a project first."
  );
}

function onAssigneeBlur(panel) {
  // Delay long enough for a dropdown-row mousedown handler to run first.
  setTimeout(() => closeAssigneeDropdown(panel), 150);
}

// Performs a live, debounced, server-side search via Jira's own `/user/picker` endpoint (the
// same one powering Jira's native assignee picker) instead of filtering a client-side cached
// list - the previous cached-list approach silently failed to find users who weren't included
// in the small default page `/user/assignable/search` returns without a query.
function onAssigneeSearchInput(panel) {
  const projectKey = panel.projectKey.value.trim();
  const query = panel.assigneeSearch.value.trim();

  // Typing invalidates whatever was previously selected - a selection only counts once it is
  // re-confirmed by picking a row from the dropdown (or leaving the field blank for Unassigned).
  panel.selectedAssignee = null;

  if (panel.assigneeSearchDebounceId) {
    clearTimeout(panel.assigneeSearchDebounceId);
    panel.assigneeSearchDebounceId = null;
  }

  if (!projectKey) {
    renderAssigneeDropdown(panel, [], "Select a project first.");
    return;
  }

  if (!query) {
    renderAssigneeDropdown(panel, panel.assignableUsers);
    updateAssigneeStatusText(panel);
    return;
  }

  renderAssigneeDropdown(panel, [], "Searching...");

  panel.assigneeSearchDebounceId = setTimeout(async () => {
    try {
      const response = await chrome.runtime.sendMessage({
        action: "searchAssignableUsers",
        baseUrl: panel.baseUrl.value.trim(),
        projectKey,
        query
      });
      if (panel.assigneeSearch.value.trim() !== query) {
        // A newer keystroke has already superseded this in-flight request - drop the stale
        // result rather than overwriting whatever the newer request will render.
        return;
      }
      if (!response.ok) {
        renderAssigneeDropdown(panel, [], response.error || "Search failed.");
        return;
      }
      const users = response.users || [];
      const anyRestricted = users.some((user) => user.restricted);
      const status = !users.length
        ? "No matching users."
        : anyRestricted
        ? "Not assignable in this project yet - found in the wider directory instead."
        : "";
      renderAssigneeDropdown(panel, users, status);
    } catch (error) {
      renderAssigneeDropdown(panel, [], error.message || "Search failed.");
    }
  }, 250);
}

function onAssigneeKeydown(panel, event) {
  const dropdownHidden = panel.assigneeDropdown.classList.contains("hidden");
  if (dropdownHidden && event.key !== "ArrowDown") {
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (dropdownHidden) {
      onAssigneeFocus(panel);
      return;
    }
    highlightAssigneeItem(
      panel,
      Math.min(panel.assigneeHighlightIndex + 1, panel.assigneeDropdownItems.length - 1)
    );
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    highlightAssigneeItem(panel, Math.max(panel.assigneeHighlightIndex - 1, 0));
  } else if (event.key === "Enter") {
    event.preventDefault();
    const index = panel.assigneeHighlightIndex >= 0 ? panel.assigneeHighlightIndex : 0;
    const item = panel.assigneeDropdownItems[index];
    if (item) {
      selectAssignee(panel, item.type === "unassigned" ? null : item.user);
    }
  } else if (event.key === "Escape") {
    closeAssigneeDropdown(panel);
  }
}

function updateModeState(panel) {
  const isUpdate = panel.mode.value === "update";
  panel.updateSection.classList.toggle("hidden", !isUpdate);
  const showEpicSelector = isParentEpicRequired(panel);
  panel.epicSection.classList.toggle("hidden", !showEpicSelector);
  updateEpicStatusText(panel);
  const showFrontend =
    !isUpdate && (panel.issueType.value === "Story" || panel.issueType.value === "Task");
  panel.frontendSection.classList.toggle("hidden", !showFrontend);
  panel.frontendAssignees.classList.toggle("hidden", panel.issueType.value !== "Story" || isUpdate);
  panel.slackSection.classList.toggle("hidden", !showFrontend);
  if (showFrontend) {
    // Task only ever allows a single platform selection (it's just metadata, not a driver of
    // subtask creation) - trim down if the user had multiple selected while on Story and then
    // switched the Issue Type to Task.
    if (panel.issueType.value === "Task" && panel.selectedDevices.length > 1) {
      panel.selectedDevices = panel.selectedDevices.slice(0, 1);
    }
    renderDevicePills(panel);
  } else {
    // Switching to Epic (or Update mode) hides the pills/Slack section entirely - still run
    // updateSlackAvailability() so the checkbox gets unchecked/disabled immediately rather than
    // keeping a stale checked state from a previous Story/Task selection.
    updateSlackAvailability(panel);
  }
  updateIssueTypeIcon(panel);

  if (isUpdate) {
    // The Issue Type dropdown now drives *which* issues are searchable below it (instead of
    // being disabled/stale as before) - any previously-fetched list/selection belongs to a
    // different type and must be dropped before refetching.
    clearIssueSelection(panel);
    loadIssuesForUpdate(panel).catch((error) => setStatus(panel.resultStatus, error.message, true));
  }
}

// Renders the Android/iOS/Web platform pills. Story allows any combination (multi-select, one
// frontend subtask created per selected pill); Task allows only one selection at a time (acts
// like a radio group) since it's purely descriptive metadata rather than a subtask driver.
function renderDevicePills(panel) {
  const isStory = panel.issueType.value === "Story";
  panel.frontendRequiredMark.classList.add("hidden");
  panel.devicePills.innerHTML = "";
  for (const device of FRONTEND_DEVICE_OPTIONS) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "jira-pill";
    pill.textContent = device;
    pill.classList.toggle("is-selected", panel.selectedDevices.includes(device));
    pill.addEventListener("click", () => toggleDevice(panel, device, isStory));
    panel.devicePills.appendChild(pill);
  }
  updateDeviceStatusText(panel);
  updateSlackAvailability(panel);
}

function toggleDevice(panel, device, isStory) {
  if (isStory) {
    panel.selectedDevices = panel.selectedDevices.includes(device)
      ? panel.selectedDevices.filter((selected) => selected !== device)
      : [...panel.selectedDevices, device];
  } else {
    // Task: acts like a radio group - clicking the already-selected pill deselects it, clicking
    // any other pill replaces the current selection.
    panel.selectedDevices = panel.selectedDevices.includes(device) ? [] : [device];
  }
  renderDevicePills(panel);
}

function updateDeviceStatusText(panel) {
  const isStory = panel.issueType.value === "Story";
  if (isStory) {
    panel.deviceStatus.textContent = panel.selectedDevices.length
      ? `Will create a frontend subtask for: ${panel.selectedDevices.join(", ")}`
      : "No frontend subtasks will be created.";
  } else {
    panel.deviceStatus.textContent = panel.selectedDevices.length
      ? `Platform: ${panel.selectedDevices[0]}`
      : "No platform selected.";
  }
}

// Jira color-codes each issue type (purple bolt = Epic, green bookmark = Story, blue check =
// Task); mirror that here since native <select><option> elements can't render inline images.
function updateIssueTypeIcon(panel) {
  const iconFile = `icons/issuetype-${panel.issueType.value.toLowerCase()}-32.png`;
  panel.issueTypeIcon.style.backgroundImage = `url("${chrome.runtime.getURL(iconFile)}")`;
}

function setStatus(element, text, isError = false) {
  element.textContent = text;
  element.style.color = isError ? "#c62828" : "#1b5e20";
}

// Builds a clickable link to an issue's Jira page (e.g. https://your-domain/browse/KEY-123),
// used by setIssueResultStatus below so success messages let you jump straight to the
// created/updated issue instead of just naming its key as plain text.

// Renders a result status message as a mix of plain text and clickable issue-key links.
// `segments` is an array where each entry is either a string (rendered as text) or
// `{ key, baseUrl }` (rendered as a link to that issue). Replaces plain setStatus() for the
// "issue created/updated" success messages so users can click straight through to Jira.

function setEpicOptions(panel, epics, selectedEpicKey = "") {
  panel.epics = [...epics];
  const selected = (selectedEpicKey || "").trim();
  if (selected) {
    const match = panel.epics.find((epic) => epic.key === selected);
    if (match) {
      panel.selectedEpic = match;
      panel.epicSearch.value = `${match.key} - ${match.summary}`;
    }
  }
  updateEpicStatusText(panel);
}

function clearEpicSelection(panel) {
  panel.selectedEpic = null;
  panel.epicSearch.value = "";
  updateEpicStatusText(panel);
}

function openEpicDropdown(panel) {
  panel.epicDropdown.classList.remove("hidden");
}

function closeEpicDropdown(panel) {
  panel.epicDropdown.classList.add("hidden");
  panel.epicHighlightIndex = -1;
}

// Epics are already fully fetched per-project (see loadEpics), so unlike the assignee combobox
// this filters instantly/locally on every keystroke - no debounce or network round-trip needed,
// which gives an even more "live" feel than Jira's own epic picker.
function renderEpicDropdown(panel, epics, statusText = "") {
  const includeClearOption = !isParentEpicRequired(panel);
  const items = includeClearOption
    ? [{ type: "clear" }, ...epics.map((epic) => ({ type: "epic", epic }))]
    : epics.map((epic) => ({ type: "epic", epic }));
  panel.epicDropdownItems = items;
  panel.epicHighlightIndex = -1;
  panel.epicDropdown.innerHTML = "";

  if (statusText) {
    const status = document.createElement("div");
    status.className = "jira-combobox-status";
    status.textContent = statusText;
    panel.epicDropdown.appendChild(status);
  }

  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "jira-combobox-item";
    row.dataset.index = String(index);
    if (item.type === "clear") {
      row.textContent = "No parent epic";
    } else {
      const icon = document.createElement("span");
      icon.className = "jira-combobox-item-icon jira-issuetype-icon";
      icon.style.backgroundImage = `url("${chrome.runtime.getURL("icons/issuetype-epic-32.png")}")`;
      icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = `${item.epic.key} - ${item.epic.summary}`;
      row.appendChild(icon);
      row.appendChild(label);
    }
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      selectEpic(panel, item.type === "clear" ? null : item.epic);
    });
    panel.epicDropdown.appendChild(row);
  });

  openEpicDropdown(panel);
}

function highlightEpicItem(panel, index) {
  const rows = panel.epicDropdown.querySelectorAll(".jira-combobox-item");
  rows.forEach((row, rowIndex) => row.classList.toggle("is-highlighted", rowIndex === index));
  panel.epicHighlightIndex = index;
}

function selectEpic(panel, epic) {
  panel.selectedEpic = epic || null;
  panel.epicSearch.value = epic ? `${epic.key} - ${epic.summary}` : "";
  closeEpicDropdown(panel);
  updateEpicStatusText(panel);
}

function filterEpics(panel, query) {
  return query
    ? panel.epics.filter((epic) => matchesSearchTokens(`${epic.key} ${epic.summary}`, query))
    : panel.epics;
}

function onEpicFocus(panel) {
  if (panel.epicsLoading) {
    renderEpicDropdown(panel, [], "Loading epics...");
    return;
  }
  const query = panel.epicSearch.value.trim();
  const filtered = filterEpics(panel, query);
  renderEpicDropdown(panel, filtered, panel.epics.length ? "" : "Select a project first.");
}

function onEpicBlur(panel) {
  setTimeout(() => closeEpicDropdown(panel), 150);
}

function onEpicSearchInput(panel) {
  panel.selectedEpic = null;
  if (panel.epicsLoading) {
    renderEpicDropdown(panel, [], "Loading epics...");
    updateEpicStatusText(panel);
    return;
  }
  if (!panel.epics.length) {
    renderEpicDropdown(panel, [], "Select a project first.");
    updateEpicStatusText(panel);
    return;
  }
  const query = panel.epicSearch.value.trim();
  const filtered = filterEpics(panel, query);
  renderEpicDropdown(panel, filtered, filtered.length ? "" : "No matching epics.");
  updateEpicStatusText(panel);
}

function onEpicKeydown(panel, event) {
  const dropdownHidden = panel.epicDropdown.classList.contains("hidden");
  if (dropdownHidden && event.key !== "ArrowDown") {
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (dropdownHidden) {
      onEpicFocus(panel);
      return;
    }
    highlightEpicItem(
      panel,
      Math.min(panel.epicHighlightIndex + 1, panel.epicDropdownItems.length - 1)
    );
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    highlightEpicItem(panel, Math.max(panel.epicHighlightIndex - 1, 0));
  } else if (event.key === "Enter") {
    event.preventDefault();
    const index = panel.epicHighlightIndex >= 0 ? panel.epicHighlightIndex : 0;
    const item = panel.epicDropdownItems[index];
    if (item) {
      selectEpic(panel, item.type === "clear" ? null : item.epic);
    }
  } else if (event.key === "Escape") {
    closeEpicDropdown(panel);
  }
}

function isParentEpicRequired(panel) {
  return (
    panel.mode.value === "create" &&
    (panel.issueType.value === "Story" || panel.issueType.value === "Task")
  );
}

function updateEpicStatusText(panel) {
  if (panel.selectedEpic) {
    panel.epicStatus.textContent = `Selected epic: ${panel.selectedEpic.key} - ${panel.selectedEpic.summary}`;
    panel.epicStatus.classList.remove("jira-warning");
    return;
  }

  if (panel.epicsLoading) {
    panel.epicStatus.textContent = "Loading epics...";
    panel.epicStatus.classList.remove("jira-warning");
    return;
  }

  if (isParentEpicRequired(panel)) {
    panel.epicStatus.textContent = "Parent epic is required";
    panel.epicStatus.classList.add("jira-warning");
  } else {
    panel.epicStatus.textContent = "No parent epic selected";
    panel.epicStatus.classList.remove("jira-warning");
  }
}

function closePanel(panel, event) {
  event.preventDefault();
  event.stopPropagation();
  panel.root.classList.add("hidden");
}

const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 900;

// The panel is docked to the right edge of the page (see #jira-gemini-panel in
// gemini_integration.css), so dragging the handle on its *left* edge and moving the mouse left
// should grow it, and moving right should shrink it - i.e. width changes by the negative of the
// mouse's horizontal movement. The chosen width is remembered across page loads/panel
// open-closes via chrome.storage.local (local, not sync - this is a per-device UI preference,
// not something that should follow the user's Jira/Slack config to other machines).
async function initPanelResize(panel) {
  if (!panel.resizeHandle) {
    return;
  }

  const storageLocal = globalThis.chrome?.storage?.local;
  if (storageLocal) {
    try {
      const { geminiPanelWidth } = await storageLocal.get(["geminiPanelWidth"]);
      if (geminiPanelWidth) {
        panel.root.style.width = `${clampPanelWidth(geminiPanelWidth)}px`;
      }
    } catch (_error) {
      // Not fatal - just fall back to the CSS default width.
    }
  }

  let startX = 0;
  let startWidth = 0;

  const onPointerMove = (event) => {
    const width = clampPanelWidth(startWidth - (event.clientX - startX));
    panel.root.style.width = `${width}px`;
  };

  const onPointerUp = () => {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    if (storageLocal) {
      const width = panel.root.getBoundingClientRect().width;
      storageLocal.set({ geminiPanelWidth: Math.round(width) });
    }
  };

  panel.resizeHandle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    startX = event.clientX;
    startWidth = panel.root.getBoundingClientRect().width;
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  });
}

function clampPanelWidth(width) {
  const maxAllowed = Math.min(PANEL_MAX_WIDTH, window.innerWidth * 0.95);
  return Math.min(Math.max(width, PANEL_MIN_WIDTH), maxAllowed);
}

async function saveCommonSettings(panel) {
  await getStorageSync().set({
    jiraBaseUrl: panel.baseUrl.value.trim(),
    jiraProjectKey: panel.projectKey.value.trim()
  });
}

function refreshFromGemini(panel) {
  const selectionText = getManualSelectionText();
  const canvasContent = selectionText ? "" : getGeminiCanvasText();
  const details = selectionText || canvasContent || getGeminiChatResponseText();
  if (!details) {
    setStatus(
      panel.resultStatus,
      "Could not find Gemini response text. Select text manually and click Refresh.",
      true
    );
    return;
  }
  panel.details.value = details;
  updateDetailsPreview(panel);
  if (!panel.summary.value.trim()) {
    // If a Canvas doc is open (and no manual selection overrode it), prefer its own title (e.g.
    // "Jira Task: Hide Invoice Download Button") over deriving one from the first line of the
    // content - Canvas titles are usually already a clean, purpose-written summary.
    const canvasTitle = canvasContent ? getGeminiCanvasTitle() : "";
    panel.summary.value = canvasTitle || makeSummaryFromText(details);
  }
  setStatus(
    panel.resultStatus,
    canvasContent ? "Loaded content from the open Gemini Canvas." : "Loaded content from Gemini."
  );
}

// Gemini's "Canvas" (aka Immersive) mode opens a separate side document - a rich-text editor,
// not a normal chat response bubble - so none of the chat-response selectors in
// getGeminiChatResponseText() ever match it. When Canvas is open, its content is what the user
// actually means by "the AI response", so it must be detected and preferred explicitly rather
// than falling through to (and wrongly grabbing) the last chat bubble underneath it.
function getGeminiCanvasEditor() {
  const editor = document.querySelector(
    "#extended-response-markdown-content [contenteditable='true'], immersive-editor-container .ProseMirror[contenteditable='true'], .immersive-editor .ProseMirror[contenteditable='true']"
  );
  // Guard against a Canvas panel that exists in the DOM but is currently collapsed/hidden -
  // offsetParent is null for display:none/hidden ancestors, so this avoids picking up stale
  // Canvas content from a previous turn that the user has since closed.
  return editor && editor.offsetParent ? editor : null;
}

function getGeminiCanvasText() {
  const editor = getGeminiCanvasEditor();
  if (!editor) {
    return "";
  }
  return convertNodeToMarkdown(editor).trim();
}

function getGeminiCanvasTitle() {
  const titleNode = document.querySelector(
    "extended-response-panel .title-text, immersive-panel .title-text"
  );
  return titleNode ? titleNode.textContent.trim() : "";
}

// Explicit text selections (made by the user manually highlighting something on the page, inside
// or outside Canvas) always take priority over any auto-detection - it's an unambiguous signal
// of exactly what the user wants pulled into Details.
function getManualSelectionText() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    return "";
  }
  // Convert the selected rich text to Markdown instead of using selection.toString() (plain
  // text only) so bold/headings/lists selected directly from Gemini's response are preserved.
  const container = document.createElement("div");
  for (let i = 0; i < selection.rangeCount; i += 1) {
    container.appendChild(selection.getRangeAt(i).cloneContents());
  }
  return convertNodeToMarkdown(container).trim();
}

function getGeminiChatResponseText() {
  const candidates = [
    ...document.querySelectorAll(
      "model-response, [data-message-author-role='model'], .model-response-text, markdown"
    )
  ]
    .map((node) => convertNodeToMarkdown(node).trim())
    .filter((text) => text.length > 40);

  return candidates.length ? candidates[candidates.length - 1] : "";
}

// Kept for backward compatibility with any other call sites - applies the full priority chain
// (manual selection, then Canvas, then the last regular chat response).
function getGeminiText() {
  return getManualSelectionText() || getGeminiCanvasText() || getGeminiChatResponseText();
}

function makeSummaryFromText(text) {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return "";
  }
  return firstLine.length > 110 ? `${firstLine.slice(0, 107)}...` : firstLine;
}

async function onProjectSelectionChanged(panel) {
  clearAssigneeSelection(panel);
  clearEpicSelection(panel);
  clearIssueSelection(panel);
  panel.assignableUsers = [];
  panel.epics = [];
  panel.issues = [];
  // Mark epics as loading immediately (not just once loadEpics() itself fires) - loadAssignableUsers()
  // below runs first and can take a noticeable amount of time, and without this the epic search box
  // would show the misleading "Select a project first." for that whole window if the user starts
  // typing right after switching projects, instead of "Loading epics...".
  panel.epicsLoading = true;
  updateEpicStatusText(panel);
  await saveCommonSettings(panel);
  await loadAssignableUsers(panel);
  await loadEpics(panel);
  if (panel.mode.value === "update") {
    await loadIssuesForUpdate(panel).catch((error) => setStatus(panel.resultStatus, error.message, true));
  }
}

async function loadIssuesForUpdate(panel) {
  const projectKey = panel.projectKey.value.trim();
  const issueType = panel.issueType.value;
  if (!projectKey || !issueType) {
    panel.issues = [];
    updateIssueStatusText(panel);
    return panel.issues;
  }
  await saveCommonSettings(panel);
  panel.issuesLoading = true;
  updateIssueStatusText(panel);
  try {
    const response = await chrome.runtime.sendMessage({
      action: "listIssues",
      baseUrl: panel.baseUrl.value.trim(),
      projectKey,
      issueType
    });
    if (!response.ok) {
      throw new Error(response.error);
    }
    panel.issues = response.issues || [];
    return panel.issues;
  } finally {
    panel.issuesLoading = false;
    updateIssueStatusText(panel);
  }
}

function clearIssueSelection(panel) {
  panel.selectedUpdateIssue = null;
  panel.issueSearch.value = "";
  panel.summary.value = "";
  panel.details.value = "";
  updateDetailsPreview(panel);
  updateIssueStatusText(panel);
  clearAssigneeSelection(panel);
}

function openIssueDropdown(panel) {
  panel.issueDropdown.classList.remove("hidden");
}

function closeIssueDropdown(panel) {
  panel.issueDropdown.classList.add("hidden");
  panel.issueHighlightIndex = -1;
}

// Issues are fetched once per project+issue-type combination (see loadIssuesForUpdate), then
// filtered locally on every keystroke here - same "live"/no-debounce pattern as the Epic
// combobox, since the full candidate list is already in memory.
function renderIssueDropdown(panel, issues, statusText = "") {
  const items = issues.map((issue) => ({ type: "issue", issue }));
  panel.issueDropdownItems = items;
  panel.issueHighlightIndex = -1;
  panel.issueDropdown.innerHTML = "";

  if (statusText) {
    const status = document.createElement("div");
    status.className = "jira-combobox-status";
    status.textContent = statusText;
    panel.issueDropdown.appendChild(status);
  }

  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "jira-combobox-item";
    row.dataset.index = String(index);
    const label = document.createElement("span");
    label.textContent = `${item.issue.key} - ${item.issue.summary}`;
    row.appendChild(label);
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      selectIssue(panel, item.issue);
    });
    panel.issueDropdown.appendChild(row);
  });

  openIssueDropdown(panel);
}

function highlightIssueItem(panel, index) {
  const rows = panel.issueDropdown.querySelectorAll(".jira-combobox-item");
  rows.forEach((row, rowIndex) => row.classList.toggle("is-highlighted", rowIndex === index));
  panel.issueHighlightIndex = index;
}

// Selecting an issue always overwrites Title/Details with that issue's real current content -
// this is "load this issue for editing", so any leftover Gemini-autofill text or a previous
// selection's content must be replaced, not merged, to avoid submitting the wrong issue's data.
async function selectIssue(panel, issue) {
  panel.selectedUpdateIssue = issue || null;
  panel.issueSearch.value = issue ? `${issue.key} - ${issue.summary}` : "";
  closeIssueDropdown(panel);
  updateIssueStatusText(panel);

  if (!issue) {
    panel.summary.value = "";
    panel.details.value = "";
    updateDetailsPreview(panel);
    clearAssigneeSelection(panel);
    return;
  }

  setStatus(panel.resultStatus, `Loading ${issue.key}...`);
  try {
    const response = await chrome.runtime.sendMessage({
      action: "getIssueDetails",
      baseUrl: panel.baseUrl.value.trim(),
      issueKey: issue.key
    });
    if (!response.ok) {
      throw new Error(response.error);
    }
    panel.summary.value = response.summary || "";
    panel.details.value = response.details || "";
    updateDetailsPreview(panel);
    // Pre-fill the Assignee combobox with the issue's real current assignee (or clear it back to
    // Unassigned) - same "always overwrite on selection" rule as Title/Details, so editing an
    // issue always starts from its actual current state rather than a stale/leftover selection.
    selectAssignee(panel, response.assignee || null);
    setStatus(panel.resultStatus, `Loaded ${issue.key}.`);
  } catch (error) {
    setStatus(panel.resultStatus, error.message, true);
  }
}

function filterIssues(panel, query) {
  return query
    ? panel.issues.filter((issue) => matchesSearchTokens(`${issue.key} ${issue.summary}`, query))
    : panel.issues;
}

function onIssueFocus(panel) {
  if (panel.issuesLoading) {
    renderIssueDropdown(panel, [], "Loading issues...");
    return;
  }
  const query = panel.issueSearch.value.trim();
  const filtered = filterIssues(panel, query);
  renderIssueDropdown(panel, filtered, panel.issues.length ? "" : "Select a project and issue type first.");
}

function onIssueBlur(panel) {
  setTimeout(() => closeIssueDropdown(panel), 150);
}

function onIssueSearchInput(panel) {
  panel.selectedUpdateIssue = null;
  if (panel.issuesLoading) {
    renderIssueDropdown(panel, [], "Loading issues...");
    updateIssueStatusText(panel);
    return;
  }
  if (!panel.issues.length) {
    renderIssueDropdown(panel, [], "Select a project and issue type first.");
    updateIssueStatusText(panel);
    return;
  }
  const query = panel.issueSearch.value.trim();
  const filtered = filterIssues(panel, query);
  renderIssueDropdown(panel, filtered, filtered.length ? "" : "No matching issues.");
  updateIssueStatusText(panel);
}

function onIssueKeydown(panel, event) {
  const dropdownHidden = panel.issueDropdown.classList.contains("hidden");
  if (dropdownHidden && event.key !== "ArrowDown") {
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (dropdownHidden) {
      onIssueFocus(panel);
      return;
    }
    highlightIssueItem(
      panel,
      Math.min(panel.issueHighlightIndex + 1, panel.issueDropdownItems.length - 1)
    );
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    highlightIssueItem(panel, Math.max(panel.issueHighlightIndex - 1, 0));
  } else if (event.key === "Enter") {
    event.preventDefault();
    const index = panel.issueHighlightIndex >= 0 ? panel.issueHighlightIndex : 0;
    const item = panel.issueDropdownItems[index];
    if (item) {
      selectIssue(panel, item.issue);
    }
  } else if (event.key === "Escape") {
    closeIssueDropdown(panel);
  }
}

function updateIssueStatusText(panel) {
  if (panel.issuesLoading) {
    panel.issueStatus.textContent = "Loading issues...";
    return;
  }
  if (panel.selectedUpdateIssue) {
    panel.issueStatus.textContent = `Editing ${panel.selectedUpdateIssue.key}.`;
    return;
  }
  if (!panel.issues.length) {
    panel.issueStatus.textContent = "Select a project and issue type first";
    return;
  }
  panel.issueStatus.textContent = "Select an issue to update";
}

async function onSubmit(panel) {
  try {
    await saveCommonSettings(panel);

    if (!panel.projectKey.value.trim()) {
      updateProjectStatusText(panel);
      panel.projectSearch.focus();
      throw new Error("Select a Jira project before continuing.");
    }

    if (isParentEpicRequired(panel) && !panel.selectedEpic) {
      updateEpicStatusText(panel);
      panel.epicSearch.focus();
      throw new Error("Select a parent Epic before creating a Story or Task.");
    }

    if (panel.mode.value === "update" && !panel.selectedUpdateIssue) {
      updateIssueStatusText(panel);
      panel.issueSearch.focus();
      throw new Error("Select an issue to update before continuing.");
    }

    const isCreate = panel.mode.value === "create";
    const isStory = panel.issueType.value === "Story";
    const isTask = panel.issueType.value === "Task";

    if (isCreate && panel.sendToSlack.checked) {
      if (!panel.slackPriority.value || !panel.slackProduct.value || !panel.slackEta.value) {
        panel.slackStatus.textContent = "Priority, Product and Expected ETA are required to send to Slack.";
        throw new Error("Fill in Priority, Product and Expected ETA before sending to Slack.");
      }
    }

    const payload = {
      baseUrl: panel.baseUrl.value.trim(),
      projectKey: panel.projectKey.value.trim(),
      mode: panel.mode.value,
      issueType: panel.issueType.value,
      issueKey: panel.mode.value === "update" && panel.selectedUpdateIssue ? panel.selectedUpdateIssue.key : "",
      summary: panel.summary.value.trim(),
      details: panel.details.value.trim(),
      assigneeAccountId: panel.selectedAssignee ? panel.selectedAssignee.accountId : "",
      parentEpicKey: isParentEpicRequired(panel) && panel.selectedEpic ? panel.selectedEpic.key : "",
      frontendSubtaskRoles: isCreate && isStory ? panel.selectedDevices : [],
      device: isCreate && isTask ? panel.selectedDevices[0] || "" : "",
      slack:
        isCreate && panel.sendToSlack.checked
          ? {
              enabled: true,
              priority: panel.slackPriority.value,
              product: panel.slackProduct.value,
              expectedEta: panel.slackEta.value,
              figma: panel.slackFigma.value.trim(),
              channelFeature: panel.slackChannelFeature.value.trim()
            }
          : { enabled: false },
      images: Array.from(panel.pendingImages.entries()).map(([filename, info]) => ({
        filename,
        dataUrl: info.dataUrl
      }))
    };

    const response = await chrome.runtime.sendMessage({
      action: "submitIssue",
      payload
    });
    if (!response.ok) {
      throw new Error(response.error);
    }

    const attachmentWarningText =
      response.attachmentWarnings && response.attachmentWarnings.length
        ? ` Some images failed to attach: ${response.attachmentWarnings.join("; ")}`
        : "";
    const slackWarningText =
      response.slackWarnings && response.slackWarnings.length
        ? ` ${response.slackWarnings.join("; ")}`
        : "";
    const subtaskWarningText =
      response.subtaskWarnings && response.subtaskWarnings.length
        ? ` ${response.subtaskWarnings.join("; ")}`
        : "";

    if (payload.mode === "update") {
      setIssueResultStatus(panel.resultStatus, [
        `${payload.issueType} `,
        { key: response.updatedIssueKey, baseUrl: payload.baseUrl },
        ` updated.${attachmentWarningText}`
      ]);
      resetFormAfterSuccess(panel);
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
    setIssueResultStatus(panel.resultStatus, [
      `${payload.issueType} `,
      { key: response.created.key, baseUrl: payload.baseUrl },
      ` created.`,
      ...subtaskSegments,
      attachmentWarningText,
      subtaskWarningText,
      slackWarningText
    ]);
    resetFormAfterSuccess(panel);

    // The Parent Epic combobox filters a client-side cached list (see loadEpics), so a freshly
    // created Epic wouldn't show up as selectable for a Story/Task until the whole panel got
    // reloaded. Refresh the cached epic list right after a successful Epic creation so it's
    // immediately available as a parent, without requiring a page refresh.
    if (payload.issueType === "Epic") {
      await loadEpics(panel).catch(() => {});
    }
  } catch (error) {
    setStatus(panel.resultStatus, error.message, true);
  }
}

// Only clears Summary/Details/attached images once the issue has actually been created/updated
// successfully - never on close, and never on a failed submit - so in-progress work is preserved
// exactly as the user left it until Jira has confirmed the change went through.
function resetFormAfterSuccess(panel) {
  panel.summary.value = "";
  panel.details.value = "";
  panel.pendingImages.clear();
  panel.selectedDevices = [];
  panel.sendToSlack.checked = false;
  panel.slackPriority.value = "";
  panel.slackProduct.value = "";
  panel.slackEta.value = "";
  panel.slackFigma.value = "";
  panel.slackChannelFeature.value = "";
  updateSlackFieldsVisibility(panel);
  updateDetailsPreview(panel);
  renderPendingImagesList(panel);
  renderDevicePills(panel);
  if (panel.mode.value === "update") {
    clearIssueSelection(panel);
    loadIssuesForUpdate(panel).catch((error) => setStatus(panel.resultStatus, error.message, true));
  }
}

// Extracts just the hostname (e.g. "your-company.atlassian.net") from the full configured base
// URL for a compact, read-only "which Jira am I talking to" display, now that the URL itself is
// only editable from the Options page (see updateConnectedDomainText below).

function updateConnectedDomainText(panel) {
  const baseUrl = panel.baseUrl.value.trim();
  panel.connectedDomain.textContent = baseUrl
    ? `Jira: ${getJiraDomainFromBaseUrl(baseUrl)}`
    : "Jira is not configured yet. Click \"Jira Settings\" below to connect.";
}

// Opens the extension's Options page in a new tab. chrome.runtime.openOptionsPage() is not
// available to content scripts, so this uses chrome.runtime.getURL() + window.open() instead,
// which works the same way from inside the Gemini page.
function openJiraOptionsPage() {
  window.open(chrome.runtime.getURL("options.html"), "_blank");
}

async function autoConnectAndLoadProjects(panel) {
  const baseUrl = panel.baseUrl.value.trim();
  updateConnectedDomainText(panel);
  if (!baseUrl) {
    redirectToOptionsWithError(panel, "Jira is not configured yet. Opening Jira Settings...");
    return;
  }

  try {
    await testConnection(panel);
    // Same reasoning as onProjectSelectionChanged(): flag epics as loading up front so typing in
    // the epic search box during testConnection()/loadProjects()/loadAssignableUsers() (all of
    // which run before loadEpics() itself) shows "Loading epics..." instead of a stale/misleading
    // status.
    panel.epicsLoading = true;
    updateEpicStatusText(panel);
    await loadProjects(panel);
    await loadAssignableUsers(panel);
    await loadEpics(panel);
    if (panel.mode.value === "update") {
      await loadIssuesForUpdate(panel);
    }
  } catch (error) {
    redirectToOptionsWithError(panel, `${error.message} Opening Jira Settings to fix the connection...`);
  }
}

// Jira connection problems can't be fixed from this panel anymore (the URL/token fields live
// exclusively in Options now), so surface the error and send the user straight there instead of
// leaving them stuck looking at an empty project list.
function redirectToOptionsWithError(panel, message) {
  setStatus(panel.connectionStatus, message, true);
  openJiraOptionsPage();
}

async function testConnection(panel) {
  await saveCommonSettings(panel);
  const response = await chrome.runtime.sendMessage({
    action: "testAuth",
    baseUrl: panel.baseUrl.value.trim()
  });
  if (!response.ok) {
    throw new Error(response.error);
  }

  setStatus(
    panel.connectionStatus,
    `Connected as ${response.user.displayName} (${response.user.accountId})`
  );

  return response.user;
}

async function loadProjects(panel) {
  await saveCommonSettings(panel);
  const response = await chrome.runtime.sendMessage({
    action: "listProjects",
    baseUrl: panel.baseUrl.value.trim()
  });
  if (!response.ok) {
    throw new Error(response.error);
  }

  const projects = response.projects || [];
  setProjectOptions(panel, projects, panel.projectKey.value.trim());
  if (!projects.length) {
    throw new Error("No Jira projects found for this account.");
  }

  const selectedProjectKey = panel.projectKey.value.trim();
  const suffix = selectedProjectKey ? ` Selected project: ${selectedProjectKey}.` : "";
  setStatus(panel.connectionStatus, `Loaded ${projects.length} projects.${suffix}`);

  return projects;
}

async function loadAssignableUsers(panel) {
  const projectKey = panel.projectKey.value.trim();
  if (!projectKey) {
    setAssigneeOptions(panel, [], "");
    return [];
  }

  // Fetches a small default page of assignable users for this project - used to populate the
  // dropdown when the assignee field gets focus before the user has typed anything. Actual text
  // search is handled live/server-side via searchAssignableUsers() (see onAssigneeSearchInput),
  // since this default page is not guaranteed to include every assignable user.
  const response = await chrome.runtime.sendMessage({
    action: "listAssignableUsers",
    baseUrl: panel.baseUrl.value.trim(),
    projectKey
  });
  if (!response.ok) {
    throw new Error(response.error);
  }

  const users = response.users || [];
  setAssigneeOptions(panel, users, panel.selectedAssignee ? panel.selectedAssignee.accountId : "");
  return users;
}

async function loadEpics(panel) {
  const projectKey = panel.projectKey.value.trim();
  if (!projectKey) {
    setEpicOptions(panel, [], "");
    return [];
  }

  // Epic search input can be focused/typed into while this fetch is still in flight (e.g. right
  // after switching projects) - track loading state so the dropdown can show "Loading epics..."
  // instead of the misleading "Select a project first.", and so the dropdown/status text can be
  // refreshed automatically once the fetch resolves instead of only updating on the next keypress
  // (previously, typing while epics were still loading showed nothing until the field was
  // cleared and retyped, since only a fresh "input" event re-ran the filter against the by-then
  // populated list).
  panel.epicsLoading = true;
  if (!panel.epicDropdown.classList.contains("hidden")) {
    renderEpicDropdown(panel, [], "Loading epics...");
  }
  updateEpicStatusText(panel);

  try {
    const response = await chrome.runtime.sendMessage({
      action: "listEpics",
      baseUrl: panel.baseUrl.value.trim(),
      projectKey
    });
    if (!response.ok) {
      throw new Error(response.error);
    }

    const epics = response.epics || [];
    setEpicOptions(panel, epics, panel.selectedEpic ? panel.selectedEpic.key : "");
    return epics;
  } finally {
    panel.epicsLoading = false;
    // If the dropdown is still open (or the search input still has focus) once loading finishes,
    // refresh it immediately against the now-populated epic list, rather than waiting for another
    // keystroke.
    if (!panel.epicDropdown.classList.contains("hidden") || document.activeElement === panel.epicSearch) {
      const query = panel.epicSearch.value.trim();
      renderEpicDropdown(panel, filterEpics(panel, query), panel.epics.length ? "" : "No matching epics.");
    }
    updateEpicStatusText(panel);
  }
}
