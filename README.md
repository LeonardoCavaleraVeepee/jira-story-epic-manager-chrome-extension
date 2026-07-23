# Jira Story & Epic Manager (Chrome Extension)

Create and update Jira **Stories**, **Tasks**, and **Epics** without leaving your browser -
either from a side panel docked onto [Gemini](https://gemini.google.com) (so you can turn a
chat/Canvas response directly into a ticket), or from the toolbar popup anywhere else.

> Looking for implementation details, root-cause write-ups, or the full history of fixes? See
> [CHANGELOG.md](CHANGELOG.md).

## Features

- **Connect to Jira** (Cloud or Server/Data Center) using Basic or Bearer auth, with auto-detection
  of the right auth scheme and API version.
- **Create** a new Story, Task, or Epic, or **update** an existing one selected from a live,
  searchable list.
- **Two ways to open it**:
  - A side panel that docks onto the Gemini page - pulls the current chat response (or Canvas
    document) straight into the ticket's Details field.
  - A toolbar popup for use anywhere else, with the same fields and behavior.
- **Frontend subtasks**: pick any combination of Android / iOS / Web for a Story to auto-create
  one subtask per platform (Task allows picking a single platform as metadata only).
- **Slack notifications**: optionally post newly created tickets to a Slack Workflow Builder
  webhook (e.g. an intake/"Front Request" workflow), one call per selected platform.
- **Image attachments**: paste, drag-drop, or pick an image into the Details field - it's uploaded
  to Jira and referenced inline where the API supports it.
- **Markdown support** in Details, including automatic conversion to Jira's expected format
  (wiki markup on Server/Data Center, ADF on Cloud) and HTML-to-Markdown conversion on paste.
- Resizable Gemini side panel, and a choice between a resizable popup window or the classic
  toolbar dropdown (see Settings below).

## Setup

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Click the extension's icon (or open **Options** directly) and follow the **setup wizard**:
   enter your Jira domain, account email, and API token/personal access token. The wizard tests
   the connection and saves it automatically.
5. *(Optional)* To enable Slack notifications, open **Options** → **Slack Integration** and paste
   your webhook URL there. This is entirely optional and per-person - nothing else in the
   extension depends on it.

## How to use it

### Creating or updating an issue

1. Open the extension - either the Gemini side panel (visit gemini.google.com and click the tab
   on the right edge) or the toolbar popup.
2. Choose **Create new** or **Update existing**, then the issue type (Story / Task / Epic).
3. Pick a **Project** (remembered across sessions) and, for Story/Task, a **Parent Epic**
   (required).
4. Fill in **Title** and **Details** - Markdown is supported, with a live preview. In the Gemini
   panel, Details auto-fills from the current chat/Canvas response; use **Refresh from Gemini**
   to pull the latest one on demand.
5. Optionally attach images (file picker, paste, or drag & drop) and pick an **Assignee**.
6. For a Story or Task, optionally select one or more **frontend platform pills**
   (Android/iOS/Web) - each selected platform creates its own subtask for a Story.
7. Click **Create**/**Update**. On success, the issue key (and any subtask keys) link directly to
   the ticket in Jira.

### Sending a Slack notification

Once at least one frontend platform pill is selected, check **Send to Slack workflow** to reveal
Priority/Product/Expected ETA fields (plus optional Figma/Channel links). On submit, one webhook
call per selected platform is sent to the configured Slack workflow, alongside creating the Jira
issue. This checkbox stays disabled until a webhook URL has been configured in Options.

### Settings (Options page)

- **Jira connection**: domain, auth, and API root override, plus an "Advanced / manual
  configuration" section and auth diagnostics for troubleshooting.
- **Frontend assignees**: map each platform (Android/iOS/Web) to a default assignee.
- **Slack Integration**: webhook URL and your Slack member ID (used for @mentions in
  notifications). Both are optional and stored per-installation.
- **Toolbar Icon Behavior**: choose whether clicking the toolbar icon opens a resizable popup
  window (default) or the classic dropdown popup.

## Security note

A Slack Workflow Builder webhook URL is a bearer secret - anyone who has it can trigger the
workflow. This repo is public, so **never commit a real webhook URL to source control**. Each
person who wants Slack notifications should paste their own webhook URL into Options; it's saved
locally to that browser profile and never leaves it except when actually posting a notification.
See [CHANGELOG.md](CHANGELOG.md) for the full history.
