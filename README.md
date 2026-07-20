# Rapid Reporter

One-click bug reporting for [Redmine](https://www.redmine.org/) — a Chrome/Edge
extension that files **developer-ready** bugs straight from the page under test,
with the screenshot, console, network, DOM, and the right fields already filled in.

It pairs with [mcp-redmine-rd](https://github.com/Jebershon/mcp-redmine-rd): the
bugs it files are rich enough for Claude Code's `/fix-bug` to read and fix.

## What one click captures

| Captured | Where it lands | Always / opt-in |
|---|---|---|
| **Screenshot** of the tab | Attachment `screenshot.png` (shown inline) | Always |
| **Console** log + errors | Attachment `console.log` + a "Console errors" block in the description | Always |
| **Network** calls (metadata) | Attachment `network.log` + a "Failed network calls" block | Always |
| **DOM** snapshot (scrubbed) | Attachment `dom.html` | Opt-in per report |
| **Environment / Language / Version / URL / browser** | Auto-detected, written into the description | Always |
| **Project · Type · Priority · Severity · Assignee** | Picked from dropdowns, set as real Redmine fields | Chosen |

For a **Mendix** app it also pulls the failing `/xas/` **action name** (the
microflow) and the Mendix version — the fast path to the fix.

## Requirements

- Google Chrome or Microsoft Edge (Chromium, Manifest V3).
- A Redmine instance with the **REST API enabled**.
- Your personal Redmine **API key** (Redmine → My account → API access key).

## Install (load unpacked)

There's no build step — the files you see are what the browser runs.

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (`rapid-reporter`).
4. Click the puzzle-piece 🧩 in the toolbar and **pin** Rapid Reporter.

After changing any file, click **Reload** ↻ on the extension tile. The version on
the tile is your proof the reload took effect.

## Configure

1. `chrome://extensions` → Rapid Reporter → **Details** → **Extension options**.
2. Enter your **Redmine URL** (e.g. `https://tracker.rapiddata.com`) and paste your
   **API key**, then **Save**.

Your key is stored in `chrome.storage.local` — on your machine only. It is **never**
written into the code and never committed.

## Use

1. On the page where you hit the bug, click the **Rapid Reporter** toolbar icon.
2. Pick **Project** → the **Type** and **Assignee** dropdowns fill from that project.
3. Set **Priority** / **Severity**, optionally choose an assignee, tick **Include
   DOM snapshot** only if you need it.
4. Click **Capture & file test bug** → you get a link to the new Redmine bug.

Console and network are captured automatically. Because that capture starts at page
load, **reload the app page after (re)loading the extension** so the recorder is in
place before the bug happens.

## Privacy & data handling

This tool can capture content from applications that hold personal data, so it is
conservative by default:

- **Screenshot, console, and network metadata** are captured on every report;
  **full DOM** is **opt-in per report** and clearly labelled.
- **Redaction always runs** before anything leaves the browser: emails, Emirates
  IDs, `Bearer` tokens, and JWTs are stripped from captured text.
- **Network capture is metadata only** — method, URL, status, timing — never
  request/response bodies. For Mendix `/xas/` it keeps the action name, not the data.
- **DOM is scrubbed**: `<script>` tags removed and form field values blanked;
  structure, classes, and validation text are kept.
- Cookies, `localStorage`, and `sessionStorage` are never captured.

For a legal/government application, get a data-governance sign-off before rolling
this out to testers, even with the safeguards above.

## How it fits with Claude

```
Tester clicks Report  →  rich Redmine bug (screenshot + console + network + fields)
                       →  developer runs  /fix-bug <id>  in Claude Code
                       →  the redmine MCP reads the screenshot + pulls console.log /
                          network.log / dom.html via get_attachment_text
                       →  Claude has the microflow, the failing request, the DOM
```

## How it works (files)

| File | Role |
|---|---|
| `manifest.json` | Extension config: permissions, popup, options, content script |
| `popup.html` / `popup.js` | The bug form; fills dropdowns, captures, sends to the service worker |
| `options.html` / `options.js` | Settings page (Redmine URL + API key) |
| `background.js` | Service worker: fetches Redmine field data, uploads attachments, creates the issue |
| `capture.js` | Content script (page's MAIN world, from page load): buffers console + network |

The project, tracker, priority, and assignee dropdowns are populated live from the
Redmine REST API, so they always match what the selected project allows.

## Not built yet (roadmap)

- Defect Category / Service dropdowns, and mapping the auto-detected
  Environment/Language/Version into the matching custom fields (project-aware).
- Element picker and screenshot annotation for UI/content bugs.
- Duplicate detection (search similar open bugs before filing).
- Packaging for org-wide install via enterprise policy.

## License

MIT — see [LICENSE](LICENSE).
