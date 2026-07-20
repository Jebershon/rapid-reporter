# Install Rapid Reporter (for testers)

Rapid Reporter is a Chrome/Edge extension that files a complete Redmine bug — with
screenshot, console, network, page details, and steps — in one click.

Setup takes about a minute and you only paste **one thing**: your Redmine API key.

## 1. Install the extension

1. Download **`rapid-reporter-<version>.zip`** (from your team lead or the release page).
2. **Unzip it** into a folder you'll keep (e.g. `Documents\rapid-reporter`). Don't
   delete this folder afterward — the extension runs from it.
3. Open your browser and go to:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
4. Turn on **Developer mode** (toggle, top-right in Chrome / left in Edge).
5. Click **Load unpacked** and select the **unzipped folder**.
6. Click the puzzle-piece 🧩 in the toolbar and **pin** Rapid Reporter.

## 2. Add your API key (opens automatically)

The **Settings** page opens on first install. If it doesn't, right-click the
Rapid Reporter icon → **Options**.

1. Get your key from Redmine: **My account → API access key → Show**, and copy it.
2. Paste it into **Your Redmine API key** (the URL is already filled in).
3. Click **Save**.

That's it — you're ready.

## 3. Report a bug

1. On the page where you hit the bug, click the **Rapid Reporter** icon → a panel
   opens on the right and stays open while you work.
2. Pick the **project**; type, priority, severity, assignee, and the project's
   custom fields fill in. Environment/Language are auto-detected.
3. Write a short title and (optionally) a description — Arabic types right-to-left.
4. **Capture screenshot**, then draw a box/arrow or redact anything sensitive
   (zoom with − / + for precision).
5. **File bug** — you get a link to the new Redmine bug.

Console, network, page details, and your steps are captured automatically.

> **Tip:** reload the app page after installing (or updating) the extension, so
> the console/network recorder is in place before you reproduce the bug.

## Updating to a new version

1. Download the new zip and **unzip it over the same folder** (replace the files).
2. Go to the extensions page and click **Reload ↻** on the Rapid Reporter tile.

Your saved API key stays — no need to re-enter it.

## Privacy

Your API key is stored only on your computer. Screenshots, console, and network
metadata are captured on every report; the DOM snapshot is opt-in. Sensitive
values (emails, IDs, tokens) are stripped automatically, and you can redact
anything on the screenshot before filing.
