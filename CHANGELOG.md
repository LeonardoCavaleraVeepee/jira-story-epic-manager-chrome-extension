# Changelog & Technical Notes

This file contains the detailed, chronological history of bug fixes, root-cause explanations,
and implementation notes for the **Jira Story & Epic Manager** Chrome extension. It's aimed at
whoever maintains this code (or wants to understand *why* something works the way it does), not
at end users.

For a quick overview of what the extension does and how to use it day-to-day, see
[README.md](README.md).

---

- Auto mode tries `Basic(email:token)` first (if email is set), then falls back to `Bearer(token)`.
- Jira API root auto-detection is supported across common paths.
- Project/assignee selectors support search.
- Details fields support Markdown with live preview.
- **Auth diagnostics** now runs two checks: a GET `/myself` read check and a POST `/search` write check.
  If the read check passes but the write check fails (especially with an HTML/login response on a
  200-range status, or a redirect to a different URL), this points to a proxy/SSO gateway in front of
  Jira that intercepts write requests specifically - not a problem with your token or auth scheme.
  Diagnostics will now show the redirect target and HTML page title when available so you (or your
  Jira/network admin) can identify the gateway rule that needs adjusting.
- Legacy `/jira/rest/api/2` and `/jira/rest/api/3` alias paths were removed from auto-detection
  entirely: on Jira Server/Data Center instances these can answer simple GET requests but redirect
  to a login/permission page (`login.jsp?permissionViolation=true`) specifically on issue
  creation/metadata calls, causing confusing failures. The **Jira API root override** applies
  `/rest/api/2` whenever this field is empty (this is enforced in code, not via `chrome.storage`
  defaults, since an install that already has an explicit empty string saved would otherwise defeat
  a storage-level default). Type `auto` in that field to explicitly opt back into auto-detection.
- Every "HTML page instead of API data" error now includes the exact method + URL that was attempted,
  plus the redirect target and HTML page title when available, to make root-cause diagnosis immediate.
- Issue creation no longer retries other API root candidates on any failure. It was previously
  silently retrying on a 404 "Issue Does Not Exist" response, which could replace a real, useful
  error (e.g. `createmeta` genuinely returning 404 on the correct/pinned root) with a confusing,
  unrelated login-page-redirect error from an invalid candidate root. Issue creation now always
  uses the resolved/pinned root and surfaces whatever error it returns directly.
- Some Jira Server/Data Center instances return a generic 404 "Issue Does Not Exist" from the
  classic bulk metadata call (`issue/createmeta?projectKeys=...&issuetypeNames=...&expand=projects.issuetypes.fields`)
  even when the project/issue type/permissions are all fine - a known Jira bug, usually triggered
  by a broken field reference (e.g. a custom field default value pointing at a deleted issue) on
  that project's create screen. Issue creation now falls back to Jira's newer per-issue-type
  scoped metadata endpoints (`issue/createmeta/{projectKey}/issuetypes` and
  `issue/createmeta/{projectKey}/issuetypes/{issueTypeId}/fields`) when the bulk call fails, and
  if even that fails, proceeds with only the minimal required fields (project, issue type,
  summary, description) rather than blocking issue creation entirely.
- The `description` field is now formatted based on the resolved API root, not always as
  Atlassian Document Format (ADF). Jira Cloud's `/rest/api/3` requires ADF (a JSON object), but
  Jira Server/Data Center's `/rest/api/2` requires a plain string using Jira's own wiki markup
  syntax (`h1.` headings, `*bold*`, `_italic_`, `{{monospace}}`, `{code}` blocks, `*`/`#` lists,
  `[text|url]` links) - sending ADF there fails with `"Operation value must be a string"`. The
  Markdown you type in the extension is now converted to whichever format the detected/pinned
  root actually expects.
- When creating an Epic, if the required "Epic Name" custom field could not be located via the
  normal createmeta lookups (bulk or scoped) - e.g. because both failed on a Jira instance
  affected by the createmeta bug described above - the extension now falls back to Jira's
  global field list (`/field`) to find the field by its display name ("Epic Name") and fill it
  in directly. This endpoint enumerates every field on the whole instance and is not scoped to
  a project/issue type, so it is unaffected by the same createmeta bug.
- **Gemini panel UI improvements**:
  - The **Parent Epic** selector now appears directly below the **Issue Type** dropdown (before
    Summary/Details), and is **required** when creating a Story or Task - submitting without a
    parent Epic selected is now blocked client-side with a clear message, instead of silently
    creating an orphaned issue.
  - Project, assignee, and epic search boxes now match on all the words you type, in any order
    (e.g. searching `test AI` matches an item containing "AI test project") - a plain substring
    match previously made search feel broken whenever word order didn't line up exactly.
  - Assignee ("dev") search no longer depends on Jira's `/user/assignable/search` `query`
    parameter, which some Jira Server/Data Center instances silently ignore (returning the full
    unfiltered list with a 200 OK instead of an error) rather than rejecting - that silent
    failure made assignee search appear to do nothing. The full assignable-user list is now
    fetched once per project and filtered entirely client-side, exactly like epic search.
  - Fixed a bug where your selected project would appear to "forget" itself: right after opening
    the panel (or right after switching Jira URL), the project dropdown was briefly re-rendered
    with an empty project list, which reset the select's value to blank before the real project
    list (and your stored selection) had a chance to load. The stored project key is now kept
    as a placeholder option during that loading window so it survives until the real list
    arrives.
  - Related sections (Parent Epic, Assignee) are now visually grouped in bordered boxes for
    clarity.
- Fixed a bug where creating a Story/Task with a parent Epic (and, separately, the 3 frontend
  subtasks) could fail with `"Issue type ... is not a sub-task but a parent is specified."` On
  classic Jira Server/Data Center, the `parent` field is only valid for actual sub-task issue
  types - Epics are linked to Stories/Tasks via a separate "Epic Link" custom field instead.
  This surfaced when the createmeta metadata lookup failed (see the createmeta bug notes above)
  and the fallback incorrectly assumed the Cloud-style `parent` field was always available. The
  fallback now defaults to *not* assuming `parent` is available, and looks up the real "Epic
  Link" field by name via Jira's global field list (`/field`) as a last resort before giving up.
- Pasting rich text into the **Details** field (e.g. copying a formatted response from Gemini)
  no longer loses Markdown formatting. Previously, pasting into the plain `<textarea>` used the
  browser's default plain-text extraction, which only reads `textContent` - since the source
  formatting lives in HTML tags (`<strong>`, `<ul>`, `<h2>`, ...) rather than literal `**`/`-`/`#`
  characters, that formatting was silently dropped. Paste is now intercepted: when the clipboard
  contains HTML, it is converted into actual Markdown (headings, bold/italic, inline code, links,
  bullet/numbered lists, code blocks) before being inserted. The **Refresh from Gemini** button
  and manual text selection now use the same HTML-to-Markdown conversion instead of plain
  `textContent`/`selection.toString()`, for the same reason.
- Fixed the **"Send to Jira" launcher button** (and, for the same underlying reason, the panel's
  own Close/Submit/etc. buttons) appearing to do nothing when clicked. The Gemini panel's boot
  sequence previously attached all of its click/change listeners *after* awaiting the initial
  settings hydration (auto-connect to Jira, loading projects/assignees/epics). If that initial
  async step threw for any reason - a storage API hiccup, a network error while auto-connecting,
  an unexpected exception in a helper - the whole boot function rejected before ever reaching the
  `addEventListener` calls, leaving every button in the panel (including the launcher itself)
  visibly present but completely unwired. All event listeners are now attached synchronously
  right after the panel is built and inserted into the page, before any async initialization
  runs; the async hydration step is wrapped separately so a failure there only shows up as a
  status message and never prevents the UI from being interactive.
- Fixed the Gemini panel losing your in-progress Summary/Details/attached images whenever you
  clicked **Close** and reopened it. Closing the panel only hides it (the DOM/state was never
  actually cleared) - but reopening it previously always auto-pulled the latest Gemini response
  into Details, silently overwriting anything you had already typed or edited. The panel now only
  auto-loads from Gemini on open when Summary and Details are both still empty; once you've
  started filling them in, reopening the panel leaves your content untouched. The **Refresh from
  Gemini** button still always refreshes on demand. The form (Summary, Details, attached images,
  the "create subtasks" checkbox) is now only cleared automatically after a successful
  create/update - never on close, and never after a failed submit - so nothing is lost until Jira
  has actually confirmed the change went through.
- Added **image support** in the Details field: attach images via the new file picker, by
  pasting an image from the clipboard, or by dragging & dropping one directly onto Details. Each
  image gets a unique placeholder inserted into the Markdown text (`![name](image:<filename>)`)
  and a live thumbnail in the Markdown preview; use **Remove** in the Images list to detach one
  (this also removes its placeholder from the text). Images are uploaded as real Jira attachments
  immediately after the issue is created/updated (Jira's attachment endpoint requires an existing
  issue key, so this can't happen beforehand). On Jira Server/Data Center (`/rest/api/2`), the
  placeholder is converted to wiki markup's inline image syntax (`!filename!`), which renders the
  attachment inline in the issue description as soon as it's attached - no extra step needed
  since the same filename is used for both the reference and the upload. On Jira Cloud
  (`/rest/api/3`), true inline embedding needs a media node keyed by the attachment's id, which
  only exists after upload; as a pragmatic fallback there, the description shows a
  `[Image attached: filename]` text marker and the image is still attached to the issue as a
  regular file, just not inlined in the rendered description. If an image fails to upload, the
  issue is still created/updated successfully and the failure is reported as a warning rather
  than blocking the whole submission.
- Fixed `400 "expected Object containing a 'name' property"` when creating a frontend subtask
  (and, on some instances, the main issue itself) with an assignee. Just like the `description`
  field, Jira Cloud (`/rest/api/3`) identifies a user by `accountId` (`assignee: { accountId }`),
  while classic Jira Server/Data Center (`/rest/api/2`) has no concept of `accountId` at all and
  identifies users by username instead (`assignee: { name }`) - sending the Cloud shape there is
  rejected outright. A new `toAssigneeField()` dispatcher now picks the correct shape based on
  the resolved API root, the same way `toDescriptionField()` already does for descriptions.
- Fixed a Story/Task/Epic created with **no assignee selected** ("Unassigned (default)" in the
  panel) still ending up assigned - typically to the logged-in user. Omitting the `assignee`
  field entirely from a create request does not guarantee "unassigned": many Jira projects have a
  "Default Assignee" scheme (e.g. Project Lead, or on some Server/Data Center configurations, the
  reporter) that Jira applies automatically whenever the field is simply missing. Issue creation
  now explicitly sends `assignee: null` when nothing is selected, which tells Jira to leave the
  issue unassigned regardless of any project-level default assignee scheme.
- Fixed the **Epic Name** field (a separate custom field from Summary that many Jira instances
  require specifically for Epics) not matching the issue's title. It was previously set to a
  generic `"Epic - YYYY-MM-DD"` placeholder in every code path that populates it (via createmeta
  metadata, the scoped createmeta fallback, and the last-resort global `/field` lookup). Epic
  Name is now always set to the exact same text as the Summary you entered, so the Epic's name
  and title are guaranteed to match.
- **Redesigned the UI** (both the Gemini side panel and the toolbar popup) with a purple/blue
  gradient accent, rounded cards, subtle shadows, and colored section borders, replacing the
  previous flat grey look.
- The **Gemini panel** is now a true right-hand **side panel**: docked to the full height of the
  viewport and slid in from the right edge with a short animation, instead of a small floating
  card near the bottom-right corner. It sits on top of the page as an overlay, but the rest of
  the Gemini page underneath remains fully visible and usable at all times - the panel never
  resizes or pushes the page content.
- **Reworked Assignee and Parent Epic search into live comboboxes** (in both the Gemini side
  panel and the toolbar popup), replacing the old "search box + separate `<select>`" pattern:
  - A single input now doubles as the search box and the current-selection display, with a
    dropdown of live results appearing directly below it as you type - closer to Jira's own
    native assignee/epic pickers. Supports mouse selection, keyboard navigation (Arrow
    Up/Down + Enter), Escape to close, and closes automatically on blur/outside click.
  - **Assignee search now performs a real, live, debounced (~250ms) server-side search** against
    Jira's own `/user/picker` endpoint (the same one powering Jira's native "Create issue"
    assignee field), scoped to the selected project. This replaces the previous approach of
    pre-fetching one unfiltered page of users via `/user/assignable/search` and filtering it
    client-side - that endpoint does not return the full user directory without a query, which is
    why some users could never be found no matter what was typed. A pinned "Unassigned (default)"
    entry is always shown first. If `/user/picker` isn't available on a given instance, the
    search transparently falls back to the previous endpoint (now with the query and project
    scoping applied).
  - Epic search still filters the already-fetched per-project epic list entirely client-side (no
    network round-trip per keystroke), now presented through the same combobox UI for visual and
    interaction consistency with the assignee field.
  - The toolbar popup's Parent Epic field is now also marked required and blocks submission when
    missing for Story/Task issues, matching the Gemini panel's existing behavior.
- Fixed **Gemini Canvas** (aka Immersive mode) content not being detected: "Refresh from
  Gemini"/auto-load previously only looked at normal chat response bubbles
  (`model-response`/`[data-message-author-role='model']`/etc.), so when a Canvas document was
  open, the extension silently grabbed the last regular chat message underneath it instead of
  the Canvas document itself. Canvas content lives in a completely separate rich-text editor
  (`#extended-response-markdown-content [contenteditable='true']`), which is now detected and
  used automatically whenever a Canvas panel is open and visible. Priority order when pulling
  content is: (1) an explicit manual text selection on the page (always wins, since it's an
  unambiguous user action), (2) the open Canvas document if present, (3) the last regular chat
  response as before. When Canvas content is used and no Summary is set yet, the panel now also
  auto-fills Summary from the Canvas document's own title (shown in its toolbar) instead of
  deriving one from the first line of the content.
- Removed the Jira URL field from both the Gemini side panel and the toolbar popup - the connected
  domain is now shown as a read-only line (e.g. "Jira: your-company.atlassian.net") in both UIs,
  with a "Jira Settings" button (Gemini panel) / existing "Open extension options" link (toolbar
  popup) to reach the Options page whenever the connection needs to be changed. The Jira URL is
  now configured in exactly one place: the extension's Options screen.
- Added a **guided setup wizard** to the Options page for first-time configuration. It walks
  new users through exactly the 3 things needed to connect - Jira domain, Jira account email, and
  Jira personal access token/API token - one step at a time (Enter key advances to the next
  step), then tests the connection and saves it automatically (defaulting the auth scheme to
  "Auto" and leaving the API root override on its default). The wizard is shown expanded
  automatically when Jira isn't configured yet, and collapses in favor of the existing
  advanced/manual settings form (now tucked behind an "Advanced / manual configuration"
  disclosure) once a connection is established. A "Run setup wizard again" button lets any user
  re-run it later, e.g. to switch to a different Jira instance.
- Replaced the generic auto-generated "J" toolbar icon with a real extension icon (an original,
  Jira-blue gradient ticket/checkmark design at 16/32/48/128px, stored in `icons/`) referenced from
  `manifest.json`'s `icons` and `action.default_icon` fields.
- Added color-coded issue type icons - a purple lightning bolt for **Epic**, a green bookmark for
  **Story**, and a blue checkmark for **Task** - matching Jira's own issue-type color convention.
  Since native `<select><option>` elements can't render inline images, a small icon badge next to
  the Issue Type dropdown now updates automatically to match the selected type, in both the Gemini
  side panel and the toolbar popup. The same Epic icon is also shown next to every entry in the
  Parent Epic search dropdown, mirroring Jira's own epic picker.
- Renamed the "Summary" field to "Title" in both the Gemini side panel and the toolbar popup form
  (label, placeholder, and the two related validation error messages). This is a display-only
  change - the underlying field/variable name (`summary`) and the Jira API mapping (issue
  `summary`) are unchanged.
- Removed the "Test Connection", "Load Projects", and "Load Issues" buttons from both the Gemini
  side panel and the toolbar popup. These actions now happen automatically instead:
  - Projects (and assignable users/epics) load automatically as soon as the panel/popup opens, as
    long as Jira is configured and reachable - no manual "Load Projects" click needed anymore.
  - Switching to "Update existing issue" mode, or changing the selected project while in that
    mode, now automatically loads the matching issue list - no manual "Load Issues" click needed.
  - If Jira isn't configured yet, or the automatic connection check fails, the panel/popup now
    shows the error and immediately opens the Options page so the connection can be fixed right
    away, instead of leaving the user stuck looking at an empty project list.
  - The manual "Test Connection" action (and the more detailed "Run auth diagnostics") remain
    available exclusively on the Options page, where the Jira URL/email/token are configured.
- **Unified the Project field into the same live combobox pattern as Assignee/Epic**, in both the
  Gemini side panel and the toolbar popup:
  - Replaced the old "search box + separate `<select>`" pair with a single text input and a live
    filtered dropdown, exactly matching how Assignee and Parent Epic already worked.
  - Project filtering happens entirely client-side against the already-fetched project list (no
    extra network round-trip per keystroke), with keyboard navigation (arrow keys, Enter, Escape)
    and a status line ("Selected project: Name (KEY)" / "Project is required") just like Epic.
  - **The selected project is now remembered across panel/popup reopens** - it's restored from
    storage immediately on open (showing a "(loading...)" placeholder if the full project list
    hasn't finished fetching yet) so it's never necessary to re-search for the same project every
    time you open the extension.
  - A project is always required to create/update an issue, so - unlike Epic - there is no "clear
    selection" option in the Project dropdown; submitting without a project selected is blocked
    client-side with a clear message, mirroring the existing Epic-required validation.
- **Reordered the toolbar popup's fields to match the Gemini side panel's layout**: the Parent
  Epic selector now appears directly below Issue Type in both places (previously the popup had it
  much further down, after Assignee/Details/Title, which made the two UIs feel inconsistent).
- Fixed the "Create 3 frontend subtasks" checkbox staying visible in the Gemini side panel even
  when the selected Issue Type was **Epic** or **Task** (it should only ever show for **Story**).
  The show/hide logic in JS was already correct, but a CSS specificity tie between the generic
  `.hidden` utility class and the checkbox row's own `display: flex` rule meant `.hidden` silently
  lost the cascade. The `.hidden` rule now always wins, so the checkbox correctly disappears for
  Epic/Task in both the create and update flows.
- Fixed assigning a Story/Task to a specific person failing on Jira Server/Data Center with
  `Jira API error (400): "User 'JIRAUSER22146' does not exist."` (while leaving the issue
  Unassigned worked fine). The Assignee dropdown's user list (from both `/user/picker` and the
  `/user/assignable/search` fallback) was mapping each user's identifier as
  `user.accountId || user.key || user.name`, which on Server/DC put the internal database `key`
  (e.g. `JIRAUSER22146`) ahead of the real username (`name`) - and Server/DC's `assignee` field
  must be set to `{ name: <username> }`, not the internal key. The mapping now prefers `name`
  over `key` (`user.accountId || user.name || user.key`), so Server/DC assigns issues using the
  real username while Jira Cloud (which has a genuine `accountId`) is unaffected.
- Fixed newly created Epics not being selectable as a Parent Epic for a Story/Task right away -
  previously you had to reload the whole Gemini page/reopen the popup before a just-created Epic
  would show up in the Parent Epic search. The Parent Epic combobox filters a client-side cached
  epic list (fetched once per project via `loadEpics`, to keep search instant with no per-keystroke
  network round-trip), and that cache was never refreshed after successfully creating a new issue.
  Both the Gemini side panel and the toolbar popup now automatically re-fetch the epic list right
  after a successful Epic creation, so the new Epic is immediately available to pick as a parent.
- **Improved the create/update success message**: it now names the exact issue type (e.g.
  "Story CPS-7920 created." / "Epic CPS-7921 updated." / "Task CPS-7922 created.") instead of the
  generic "Created issue CPS-7920.", and the issue key (as well as every created subtask key) is
  now a clickable link that opens the issue directly in Jira (`/browse/KEY`) in a new tab. For
  updates, since the Issue Type selector is disabled and not necessarily current while in "Update
  existing issue" mode, the exact type shown is looked up from the already-loaded issue list by
  key, rather than trusted from the (possibly stale) Issue Type dropdown.
- **Added a Slack Integration section to the Options page** (`Slack Workflow webhook URL` +
  `Your Slack user ID`), laying the groundwork for optionally forwarding newly created
  Stories/Tasks to a Slack Workflow Builder webhook (e.g. a "Front Request" intake workflow) right
  after they're created in Jira. Settings are stored under `slackWebhookUrl`/`slackUserId` in
  `chrome.storage.sync`. The webhook URL field is saved as-is (treated as a secret, since anyone
  holding it can trigger the workflow) after a basic URL-format check. This is configuration-only
  for now - the extension does not yet send anything to Slack automatically.
- **Added a Frontend platform pill selector for Story/Task, and a "Send to Slack workflow"
  checkbox for both**, replacing the old all-or-nothing "Create 3 frontend subtasks" checkbox:
  - Android/iOS/Web pills now appear for both **Story** and **Task** creation. For a **Story**,
    any combination can be toggled on (multi-select) - one frontend subtask is created per
    selected platform (instead of always creating exactly 3). For a **Task**, only one platform
    can be selected at a time (acts like a radio group) - this doesn't create any subtasks, it's
    just descriptive metadata about which platform the Task concerns (used for the Slack payload
    below).
  - `background.js`'s `createFrontendSubtasks()` now accepts the selected roles and only creates
    a subtask for each one, instead of unconditionally creating all 3 configured assignments.
  - A new **"Send to Slack workflow"** checkbox (disabled with an explanatory message until a
    Slack webhook URL is configured in Options) appears alongside the pill selector. Checking it
    reveals Priority/Product/Expected ETA dropdowns (matching the Slack "Front Request" workflow's
    exact enum values) plus optional Figma and Channel feature text fields.
  - On submit, if checked, `background.js` POSTs a JSON payload (`request_features`, `device`,
    `priority`, `product`, `expected_eta`, `figma`, `jira_ticket` - the created issue's full
    `/browse/KEY` link - `channel_feature`, `slack_id`) to the configured webhook URL right after
    the Jira issue (and any frontend subtasks) are created. A failure here is reported as a
    non-fatal warning appended to the success message - the Jira issue itself is never rolled back.
  - The pill/subtask role labeled "Web" internally is translated to `"Desktop"` specifically in
    the Slack payload's `device` field, to match the exact wording the Slack "Front Request"
    workflow's Device dropdown expects - Jira subtask summaries/roles keep using "Web" unchanged.
- Fixed two bugs surfaced while testing the Slack integration:
  - **The created/updated issue's clickable link was broken.** `jiraBaseUrl` is stored without a
    protocol (just the bare domain, e.g. `jira.vptech.eu`), but `buildIssueLink()` in both
    `gemini_integration.js` and `popup.js` used that raw value directly as the link's `href` -
    without a scheme, the browser treated it as a relative path off the current page instead of
    an absolute Jira URL, so the link either did nothing or went somewhere wrong. `buildIssueLink`
    now adds `https://` whenever it's missing, mirroring `normalizeBaseUrl()` in `background.js`.
  - **"Slack workflow notification failed: Failed to fetch."** `manifest.json`'s
    `host_permissions` only listed the Jira domains, so Manifest V3's service worker had no
    permission to bypass CORS for `https://hooks.slack.com/*` (where Slack Workflow Builder
    webhook trigger URLs live), and the `fetch()` call to the webhook was blocked before it ever
    left the browser. Added `"https://hooks.slack.com/*"` to `host_permissions`.
- **Corrected the Slack `slack_id` mention handling** (superseding the previous "@handle" attempt,
  which didn't actually work - Slack never auto-links plain `@text` posted via API/webhook, only
  the literal `<@MEMBER_ID>` syntax renders as a real mention, and that has to be in Slack's
  message step text itself, not something the sender can influence by changing the string it
  sends). The Options field is back to expecting the **raw Slack member ID** (e.g. `U0123ABC456`,
  renamed back to "Your Slack member ID"), and `background.js`'s `normalizeSlackId()` strips a
  stray leading `@` or `<@...>` wrapper if one was pasted in by mistake, always sending the bare
  ID.
- **Corrected the Slack-side fix for the mention** (the previous README/Options guidance to
  manually type `<@{{slack_id}}>` around the inserted variable in the message step turned out not
  to work either - it still showed up as literal text like `<@USKFJ98PJ>`, because Workflow
  Builder's message composer escapes hand-typed `<`/`@`/`>` characters instead of parsing them as
  mention syntax). The Options page's help text now explains the fix that actually works: the
  `slack_id` webhook trigger variable's **Data type** must be changed from `Text` to `User` in the
  trigger's settings, and then re-inserted into the message step using the variable
  picker (typing "/" or "@" to open it) rather than typed by hand - only then does Workflow
  Builder render it as a real mention when the message is sent. The extension itself is
  unaffected either way - it always sends the raw member ID string as `slack_id`.
- Fixed the "for more than 1 front[end platform], the Slack webhook is not triggered" bug: when
  creating a Story with 2+ platforms selected, if creating any one platform's frontend subtask
  failed, `submitIssue()` immediately threw and aborted the whole request - skipping image
  upload and the Slack webhook notification entirely, even though the Jira issue itself had
  already been created successfully. `createFrontendSubtasks()` now creates each selected
  platform's subtask independently (one failing no longer stops the others or anything after it)
  and returns `{ created, failures }` instead of throwing; `submitIssue()` always continues on to
  image upload and the Slack notification regardless, surfacing any subtask failures as a
  non-fatal `subtaskWarnings` message alongside the rest of the success message.
- Fixed the Epic search box showing nothing while typing right after switching projects, until
  the text was cleared and retyped. The Epic list is fetched once per project (`loadEpics()`) and
  filtered client-side on every keystroke - if a keystroke happened before that fetch resolved,
  the dropdown/status showed "Select a project first." (since the epic list was still empty), and
  nothing then refreshed it once the epics actually arrived - only a brand new keystroke re-ran
  the filter against the by-then-populated list, hence "delete and start again" seeming to fix it.
  Both the Gemini side panel and the toolbar popup now track an explicit loading state: the Epic
  field shows "Loading epics..." while the fetch for the current project is in flight, and the
  dropdown/status automatically refreshes the moment the fetch resolves (if the field is still
  focused/open) instead of waiting for another keystroke.
- **Follow-up fix - the multi-platform Slack webhook was still not firing.** The previous fix
  above (making `createFrontendSubtasks()` non-throwing) was necessary but not sufficient: the
  remaining problem was that subtask creation, image upload, and the Slack notification ran
  sequentially, one after another, and each frontend subtask is created with its own internal
  retry loop (up to 3 attempts with a 500ms delay) to work around Jira's "Issue Does Not Exist"
  indexing lag right after the parent issue is created. With 2-3 platforms selected, that
  sequential chain of retried API calls could take long enough to run past Manifest V3's ~30
  second service-worker idle-termination window, killing the background script (and losing the
  still-pending Slack call) before it ever got there - which is also why it looked fine with a
  single platform (fast enough to finish in time) but broke with more than one. `submitIssue()`
  now kicks off subtask creation, image upload, and the Slack notification **concurrently**
  (`Promise.all`) right after the parent issue is created, instead of sequentially, so the total
  wall-clock time is close to the slowest single step rather than the sum of all of them, and a
  slow/retrying subtask can no longer delay or starve out the Slack webhook call.
- **Follow-up fix - the Epic loading indicator still wasn't showing while typing.** The previous
  fix above only set the loading flag once `loadEpics()` itself started fetching - but switching
  projects first clears the epic list and then awaits `loadAssignableUsers()` *before* calling
  `loadEpics()`, so there was still a window (the assignable-users round trip) where the epic list
  was already empty but the loading flag hadn't been set yet, during which typing showed the
  misleading "Select a project first." instead of "Loading epics...". The loading flag is now set
  as soon as the epic list is cleared for a project change/initial load (in
  `onProjectSelectionChanged()`/`autoConnectAndLoadProjects()`), before any of the preceding
  network calls, not just inside `loadEpics()` itself.
- Extended the Slack **Expected ETA** month dropdown (Gemini panel and popup) to cover all 12
  months (January-December) instead of only May-September.
- **Follow-up fix - the multi-platform Slack webhook was STILL not firing** even after the
  concurrency fix above. The actual remaining root cause: when 2+ platforms were selected for a
  Story, `notifySlackWorkflow()` sent a single combined webhook call with the platforms joined
  into one comma-separated string (e.g. `device: "iOS, Android"`). The Slack "Front Request"
  workflow's message template is built around a *single* device value (see the confirmed working
  message format: `"...has requested X to Android with Priority..."` - singular "to Android"),
  so a joined multi-value string never matched what the workflow's message step expected and the
  notification silently never posted for any multi-platform selection, while still working fine
  for a single platform. `notifySlackWorkflow()` now sends one independent webhook call per
  selected platform (all fired concurrently via `Promise.all`, mirroring how one Jira frontend
  subtask is already created per platform), rather than one call with every platform joined
  together. A failure on one platform's call no longer blocks the others.
- Added `console.log`/`console.error` tracing around subtask creation, attachment upload, and
  the Slack webhook call in `background.js` (visible in the extension's service worker console
  at `chrome://extensions` → "service worker" link under this extension) to make any future
  "webhook not firing"-style issue immediately diagnosable from the actual logged request/response
  instead of guesswork.
- **Made both the toolbar popup and the Gemini side panel resizable.**
  - Chrome extension popups have no native draggable-edge resizing at all - the popup window
    always auto-sizes to match the popup document's rendered width/height (up to Chrome's own
    hard cap, roughly 800x600). A drag handle was added in the popup's bottom-right corner
    (`#popupResizeHandle`) that sets an explicit width/height directly on `<html>` as you drag;
    Chrome then re-measures and resizes the actual popup window to match, giving the effect of a
    resizable popup (clamped to 320-800px wide, 300-600px tall). The chosen size is remembered
    across popup opens via `chrome.storage.local`.
  - The Gemini side panel is docked to the right edge of the page, so a slim drag handle was
    added along its *left* edge (`#jiraResizeHandle`) - dragging it left grows the panel, right
    shrinks it (clamped to 320px up to 900px or 95% of the window width, whichever is smaller).
    The chosen width is remembered across page loads via `chrome.storage.local`.
  - Both use `chrome.storage.local` (not `.sync`) since panel/popup size is a per-device UI
    preference, not something that should follow the user's Jira/Slack configuration to other
    machines.
- **Replaced the toolbar dropdown popup with a real, separate, natively resizable browser
  window**, since a genuine toolbar "action popup" (the previous `default_popup`) is a special
  browser surface that always closes the instant focus moves elsewhere and has no title bar or
  native resize/drag support at all - the JS-driven fake resize handle added for it (see above)
  was a hacky workaround for that limitation. `manifest.json`'s `action` no longer declares a
  `default_popup`; clicking the toolbar icon now runs a `chrome.action.onClicked` handler in
  `background.js` that opens `popup.html` in its own `chrome.windows.create({ type: "popup" })`
  window instead - a real OS-level window with normal resize/move/drag, that stays open even
  after clicking elsewhere. Clicking the icon again while that window is still open refocuses it
  instead of opening a duplicate. The now-redundant JS-driven fake resize handle/logic was removed
  from `popup.html`/`popup.js`/`popup.css`, and the popup's content now fills whatever size the
  real window actually is (previously capped at a small fixed width) for a more comfortable
  amount of room to type into the Summary/Details fields.
- **The "Send to Slack workflow" checkbox is now also disabled until a frontend platform pill is
  selected**, in both the Gemini panel and the popup. Previously it only depended on a Slack
  webhook URL being configured in Options - it was possible to check it with no platform pill
  selected at all, which would send the webhook a payload with an empty `device` field (see
  `notifySlackWorkflow()` in `background.js`), not corresponding to anything meaningful in the
  Slack workflow. The checkbox (and its Priority/Product/ETA fields) now automatically
  unchecks/disables itself the moment the last selected platform pill is deselected, or when
  switching Issue Type away from Story/Task, and re-enables the instant a pill is selected again
  - with status text explaining which of the two requirements ("configure a webhook URL" /
  "select a frontend platform") still needs to be met.
- **Added an Options setting to choose between the separate-window popup and the classic
  dropdown popup.** A new "Toolbar Icon Behavior" section in `options.html` lets you pick what
  clicking the toolbar icon does: `"window"` (default, added above) opens `popup.html` in its
  own real, resizable browser window; `"dropdown"` restores the original native "action popup"
  behavior from before that change (opens instantly under the icon, but closes on click-away and
  can't be resized). This is stored in `chrome.storage.local` (`popupMode`) as a per-device UI
  preference, same as the panel/popup size settings. `background.js` applies the setting by
  calling `chrome.action.setPopup({ popup: "popup.html" | "" })` on every service worker
  start/install (since MV3 service workers are ephemeral and don't retain a prior `setPopup()`
  call across restarts) and again immediately via a `chrome.storage.onChanged` listener whenever
  the setting is changed and saved in Options, so it takes effect without needing to reload the
  extension. `chrome.action.onClicked` (which opens the separate window) only ever fires when no
  popup is set, so the two modes are mutually exclusive by   construction.
- **Baked in a default Slack webhook URL so most teammates need zero Slack setup.** Previously
  every user had to find and paste their own copy of the team's "Front Request" webhook URL into
  Options before Slack notifications worked at all. `notifySlackWorkflow()` in `background.js`
  now falls back to a `DEFAULT_SLACK_WEBHOOK_URL` constant baked directly into the extension
  whenever a user hasn't entered their own override in Options - Options' webhook field is now
  explicitly optional ("Leave blank to use the team's default webhook"). The "Send to Slack
  workflow" checkbox is correspondingly always considered available now (gated only on a
  frontend platform being selected, not also on a webhook being configured, since one is always
  present). **Security note:** a Slack Workflow Builder webhook URL is a bearer secret with no
  other authentication - anyone who has it can trigger the workflow, and since extension source
  is always readable by anyone who installs it (`chrome://extensions` inspect, or unzipping the
  folder), baking it in means it's exposed to everyone with access to this extension, not just
  people who've been given it directly. This is an accepted, deliberate trade-off *only* because
  this extension is shared within a small trusted internal team and never published or forwarded
  outside it, and because the worst-case abuse (posting fake requests to one internal Slack
  channel) is low-impact and the webhook can simply be rotated in Slack + updated here if that
  ever happens. If this extension's distribution ever widens, replace `DEFAULT_SLACK_WEBHOOK_URL`
  with a call to a small server-side proxy that holds the real webhook instead, so the secret
  never ships in client code at all. Each user's own Slack member ID (`slackUserId`, used for the
  `@mention` in the notification) is unrelated to this and remains a required one-time per-person
  field, since it's inherently personal and can't have a shared default.
- **Moved the project into a git repo, and moved the real Slack webhook default out of source
  control accordingly.** The hardcoded `DEFAULT_SLACK_WEBHOOK_URL` value from the previous entry
  has been extracted out of `background.js` into `secrets.local.js`, a new file that is listed in
  `.gitignore` and therefore never committed - so pushing this project to GitHub (even a private
  repo) doesn't put the real webhook URL into the repo's history. `background.js` now loads it via
  `importScripts("secrets.local.js")` wrapped in a try/catch, falling back to an empty default if
  the file is missing (e.g. a fresh clone before it's been created) - in that case the extension
  still works fine, it just no longer pre-fills the webhook field in Options for that person.
  `secrets.local.example.js` is the checked-in template teammates copy locally and fill in with
  the real URL; see the Setup section above.
- **Fixed the "Send to Slack workflow" checkbox being wrongly enabled on a fresh checkout with no
  `secrets.local.js` and no webhook configured in Options**, which caused a confusing failure
  (attempting to `fetch()` an empty URL) instead of a clear error when submitted. When
  `DEFAULT_SLACK_WEBHOOK_URL` was moved into `secrets.local.js` (previous entry), the panel/popup
  UI was left unconditionally assuming a webhook was always available
  (`slackWebhookConfigured = true`), since it can no longer read that background-service-worker-
  only global directly. Added a `hasSlackWebhook` message handler in `background.js` that reports
  whether a webhook is actually available (user's Options override OR `secrets.local.js`
  default); the Gemini panel and popup now call it on load and only enable the checkbox when the
  answer is genuinely yes. `notifySlackWorkflow()` also once again throws a clear
  "No Slack webhook URL is configured..." error (pointing at Options and `secrets.local.js`) if
  neither source has one, instead of silently trying to POST to an empty URL. Net effect: without
  `secrets.local.js`, the extension works exactly as before Slack support existed - every other
  feature (Jira create/update, frontend subtasks, images) is completely unaffected either way,
  since Slack notification has always been an optional, non-blocking add-on.
- **Removed the `secrets.local.js` / baked-in default webhook mechanism entirely**, now that this
  repo is **public**. The previous two entries' approach (a shared team webhook baked into a
  gitignored local file) was designed for a small, trusted, *private* audience - it never leaked
  into git history, but it was the wrong pattern for a public repo where anyone could clone it and
  potentially be confused about whether a webhook was expected to already be there. Removed
  `secrets.local.js`, `secrets.local.example.js`, the `importScripts()`/try-catch loading logic
  and `DEFAULT_SLACK_WEBHOOK_URL` from `background.js`, and the now-unnecessary `.gitignore` entry.
  `notifySlackWorkflow()` and `hasSlackWebhook()` now only ever look at the user's own
  `slackWebhookUrl` in Options - back to the simple, original model: Slack notifications are
  entirely optional, and each person who wants them pastes their own webhook URL into Options
  (Slack Integration section). Nothing else in the extension is affected either way.
- **Fixed "Update existing issue" not working, by requiring the Issue Type first and replacing
  the plain "Issue to update" dropdown with a proper search combobox.** Root cause: the Title
  field is required to submit an update, but switching to Update mode never pre-filled it (or
  Details) from the selected issue - Title started empty, so clicking Submit without manually
  retyping the exact title threw "Title is required for update", and any leftover Details text
  risked overwriting the real Jira description. Separately, the Issue Type dropdown was disabled
  in Update mode and the "Issue to update" `<select>` listed up to 50 Epic/Story/Task issues
  mixed together with no filtering, making it impractical to find the right one on any
  reasonably active project.
  - Issue Type is now enabled and required first in Update mode, and drives which issues are
    searchable below it (`listIssues()` in `background.js` now takes an `issueType` JQL filter
    instead of hardcoding `issuetype in (Epic, Story, Task)`).
  - The plain issue `<select>` was replaced with a live search combobox (`#jiraIssueSearch`/
    `#jiraIssueDropdown` in the Gemini panel, `#issueSearch`/`#issueDropdown` in the popup),
    matching the existing Project/Epic/Assignee combobox pattern: fetch once per project+type,
    filter instantly client-side on every keystroke, full keyboard navigation.
  - Selecting an issue now calls a new `getIssueDetails` background action (added to
    `background.js`, along with `wikiMarkupToMarkdown()`/`adfToMarkdown()`/`fromDescriptionField()`
    - reverse converters mirroring the existing `toWikiMarkup()`/`toAdf()`/`toDescriptionField()`
    Markdown-to-Jira converters) which fetches the issue's real current Summary/Description and
    pre-fills Title/Details, always overwriting whatever was there before (this is "load this
    issue for editing", so stale content must never linger). Submitting now targets the actual
    selected issue's key instead of a stale/disabled dropdown value, and is blocked with a clear
    "Select an issue to update before continuing." error if nothing is selected yet.
- **Allowed editing the Assignee when updating an existing issue, pre-filled with its current
  assignee.** Previously the Assignee combobox was hidden entirely in Update mode, so updating an
  issue could never change (or even see) who it was assigned to. The Assignee section is now
  shown in both Create and Update mode; selecting an issue to update now also fetches its current
  assignee (`getIssueDetails` in `background.js` now requests the `assignee` field alongside
  summary/description/issuetype) and pre-selects it in the combobox via the same `selectAssignee()`
  used for a manual pick, clearing back to "Unassigned" if the issue genuinely has no assignee.
  `updateIssue()` now always sends the `assignee` field on submit (the selected user's ID, or
  explicit `null` to unassign) so leaving the field untouched round-trips the same assignee, and
  clearing it to "Unassigned" before submitting genuinely unassigns the issue.
- **Added upfront validation for the Slack member ID field in Options**, catching the same
  `invalid_workflow_input` mistake documented in the previous entry (a plain name/handle typed
  into a field whose Workflow Builder trigger variable is typed as `User`) before it's saved,
  instead of only surfacing as a confusing 400 error the next time an issue is submitted.
  `onSaveSlackSettings()` now rejects values that don't look like a real Slack member ID (a
  short all-caps alphanumeric token starting with a letter, e.g. `U0123ABC456`), with a clear
  message pointing at Slack's "Copy member ID" action.
- **Fixed `invalid_workflow_input` after changing the `channel_feature` trigger variable's Data
  type to Channel.** Same root cause as the `slack_id`/User case: once a Workflow Builder trigger
  variable is typed as `Channel` (instead of `Text`), Slack validates the value server-side and
  rejects anything that isn't a real Channel ID - the "Channel feature" field previously accepted
  free text like `#prj-bla-bla`, which passed fine while the variable was Text-typed but is
  rejected once it's Channel-typed. Renamed the field to **Channel ID** with a placeholder/help
  text pointing at Slack's real Channel ID (found via the channel name dropdown → scroll to
  "Channel ID"), and added `normalizeSlackChannelId()` in `background.js` (mirroring
  `normalizeSlackId()`) so pasting Slack's `<#C0123ABC456|name>` mention syntax or a leftover
  leading `#` still resolves to the bare ID Slack's webhook now expects.
- **Fixed `invalid_workflow_input` persisting even with a real Channel ID entered.** Root cause:
  Slack Workflow Builder variables typed as `Channel` (or `User`) validate the value's *format*
  server-side regardless of whether the variable itself is marked optional - an empty string is
  not treated as "not provided" for these types the way it is for a plain `Text` variable, it's
  rejected outright as a malformed value. Since "Channel ID" (and the Slack member ID) are
  optional fields in this extension's UI, leaving either blank still sent `channel_feature: ""` /
  `slack_id: ""` in the webhook body, which Slack now rejects once those variables are
  Channel/User-typed. `notifySlackWorkflow()` in `background.js` now omits the `channel_feature`
  and `slack_id` keys from the request body entirely when there's no value, instead of sending an
  empty string, so Slack sees "not provided" for an optional variable rather than "provided but
  invalid".
- **Improved the assignee search to explain (and partly work around) "some devs aren't found".**
  Root cause: `searchAssignableUsers()` calls `/user/picker?project=<key>&query=...`, which is
  Jira's own native assignee-picker endpoint - it deliberately excludes any account that isn't
  currently assignable on that specific project (i.e. doesn't have "Assignable User" permission
  there via the project's permission scheme/role), even if the account is perfectly valid and
  findable elsewhere in Jira. That's expected Jira behavior, not a code bug, but it looked
  identical to a broken search. Two changes: (1) raised `maxResults` from 20 to 50, since a very
  common name/surname could previously push the actual match past Jira's own relevance cutoff and
  never appear at all; (2) when the project-scoped search comes back with zero matches,
  `searchAssignableUsers()` now retries once, unscoped, across the whole Jira user directory via
  the same `/user/picker` endpoint (no `project` param) so the account can still be found and
  selected, flagging each such result with `restricted: true`. The Assignee dropdown in both the
  Gemini panel and popup shows a "⚠ may lack assign permission on this project" note on those
  entries and a "Not assignable in this project yet - found in the wider directory instead."
  status line, since actually assigning them may still be rejected by Jira until a project admin
  adds them to the right role - the real fix for that side of it is on Jira's permission scheme,
  not in this extension.
- **Added a "Send to Slack" button directly on Jira Task/Sub-task pages.** New content script
  `jira_page_button.js` (+ `jira_page_button.css`) is injected on `https://*.atlassian.net/*` and
  `https://jira.vptech.eu/*` (matching `host_permissions`) and shows a floating button in the
  bottom-right corner whenever the currently-viewed issue is a Task or Sub-task and a Slack
  webhook is configured in Options. Clicking it opens a small panel (Priority/Product/Expected
  ETA/Platform/Figma/Channel ID, mirroring the fields already in the create form) and posts to the
  same Slack "Front Request" workflow webhook via a new `notifySlackFromJiraPage()` in
  `background.js`, which just re-uses the existing `notifySlackWorkflow()` so both entry points
  share one code path. This covers tickets that already existed before Slack notifications were
  set up, or were created outside this extension entirely, without having to recreate them through
  the panel/popup just to trigger the webhook. The issue key is read from the page URL (handles
  both `/browse/KEY` and board/backlog `?selectedIssue=KEY`-style URLs, polled every 1.5s since
  Jira is a single-page app and the URL can change without a full reload) and the summary/issue
  type are fetched via the same authenticated REST call as `getIssueDetails()` rather than
  scraping the DOM, since Jira's issue-view markup differs a lot between Cloud/Server and across
  UI redesigns.
- **Refactored: extracted duplicated utilities into a new shared_utils.js.** gemini_integration.js
  and popup.js had ~79 same-named functions, but only a handful were actually byte-for-byte
  identical (most differ because gemini_integration.js threads a `panel` object through its
  functions while popup.js uses module-level state - unifying those would be a much larger,
  riskier rewrite and was intentionally left alone). The genuinely identical pieces - the
  `FRONTEND_DEVICE_OPTIONS` constant, `escapeHtml()`, `formatAssigneeLabel()`, `getStorageSync()`,
  `normalizeFrontendAssignments()`, `buildIssueLink()`, and `setIssueResultStatus()` - now live
  once in `shared_utils.js`, loaded before their consumer via manifest.json's content_scripts
  entries (gemini_integration.js, jira_page_button.js) and a `<script>` tag (popup.html,
  options.html). Also folded options.js's separate `DEFAULT_ASSIGNMENT_ROLES` array and duplicate
  `getStorageSync()`/`getJiraDomainFromBaseUrl()` into the same shared copies.
  While comparing the duplicates, found that `getJiraDomainFromBaseUrl()` in
  gemini_integration.js/popup.js was missing the "assume https:// if no protocol is present"
  handling that options.js's copy already had (jiraBaseUrl can be stored without a protocol) -
  the shared version now always includes that fix. `background.js` (the service worker) keeps its
  own small separate copies of anything DOM-dependent copies can't reach, and its own
  `normalizeFrontendAssignments()` (subtly different validation rules from the UI copy - a
  requires-3-assignees variant used only for server-side subtask creation) was deliberately left
  as-is rather than force-unified, to avoid changing behavior no one asked to change. No
  user-facing behavior changes from this refactor other than the `getJiraDomainFromBaseUrl` fix
  above.
- **Made Platform required on the Jira-page "Send to Slack" button.** The create/update form's
  Slack notification already requires a frontend platform pill to be selected; the Jira-page
  button (added in 0.1.81) had left it optional, which could post a notification with an empty
  `device` value that doesn't match what the Slack workflow's template expects. The Platform
  field is now marked with a required-field asterisk and `onSubmit()` in `jira_page_button.js`
  rejects the submission with a clear inline message ("Select a platform before sending.") if no
  pill is selected, mirroring the same requirement already enforced in gemini_integration.js/
  popup.js's own create/update forms.
- **Made Priority, Product, and Expected ETA required on the Jira-page "Send to Slack" button**,
  matching the same requirement already enforced on the main create/update form's Slack fields
  (see the `panel.slackStatus` check in gemini_integration.js). `onSubmit()` in
  `jira_page_button.js` now blocks submission with "Priority, Product and Expected ETA are
  required to send to Slack." if any of the three is left unselected, and the three field labels
  show a required-field asterisk.
- **Added toggles to show/hide the floating "Send to Jira" (Gemini) and "Send to Slack" (Jira)
  buttons**, in Options → General Behavior. Both default to on. `gemini_integration.js` and
  `jira_page_button.js` each read their own sync-storage flag (`showGeminiSendToJiraButton`,
  `showJiraSendToSlackButton`) before injecting their button/panel, so disabling one removes it
  from the page entirely (an already-open tab needs a reload to pick up the change).
