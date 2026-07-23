"use strict";

// Copy this file to secrets.local.js (which is gitignored - see .gitignore) and fill in the real
// team Slack webhook URL below. background.js loads secrets.local.js via importScripts() and
// falls back gracefully to an empty default if the file doesn't exist, so the extension still
// works without it - each user would then just need to paste a webhook URL into Options
// themselves (Slack Integration section) instead of it being pre-filled automatically.
//
// Do NOT commit secrets.local.js - it is intentionally excluded from git so the real webhook URL
// never ends up in this repository's history.
const DEFAULT_SLACK_WEBHOOK_URL = "";
