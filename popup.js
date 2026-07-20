// popup.js — collects inputs, fills the Project / Type / Priority / Assignee
// dropdowns, captures the screenshot, and hands the job to the service worker.

const titleInput = document.getElementById("title");
const projectSelect = document.getElementById("project");
const typeSelect = document.getElementById("type");
const prioritySelect = document.getElementById("priority");
const severitySelect = document.getElementById("severity");
const assigneeSelect = document.getElementById("assignee");
const contextBox = document.getElementById("context");
const includeDomCheck = document.getElementById("includeDom");
const fileButton = document.getElementById("file");
const statusText = document.getElementById("status");
const previewImage = document.getElementById("preview");

// Holds the Textile block we build from the page context, to attach when filing.
let contextText = "";

// On open: load the dropdowns AND read the page context.
loadProjects();
loadPriorities();
detectContext();

// Picking a project instantly refreshes the project-specific dropdowns.
projectSelect.addEventListener("change", () => {
  chrome.storage.local.set({ lastProject: projectSelect.value });
  loadProjectData();
});

async function loadProjects() {
  const res = await chrome.runtime.sendMessage({ type: "GET_PROJECTS" });
  fillSelect(projectSelect, res && res.ok ? res.projects : null, res ? res.error : "no response");

  // Reselect the project you used last time, then load its trackers + members.
  const saved = await chrome.storage.local.get(["lastProject"]);
  if (saved.lastProject) projectSelect.value = saved.lastProject;
  loadProjectData();
}

// ---- Auto-detect page context (Step 1.3) --------------------------------

// This function is INJECTED INTO THE PAGE, so it must be self-contained. It reads
// things only the page can see and returns them as a plain object.
function readPageContext() {
  var ctx = {
    url: location.href,
    title: document.title,
    lang: document.documentElement.getAttribute("lang") || "",
    dir: document.documentElement.getAttribute("dir") || "",
    userAgent: navigator.userAgent,
    viewport: window.innerWidth + "x" + window.innerHeight,
    mendixVersion: "",
  };
  try {
    if (window.mx && window.mx.version) ctx.mendixVersion = String(window.mx.version);
  } catch (e) {}
  return ctx;
}

async function detectContext() {
  try {
    // Find the tab behind the popup, then run readPageContext() inside it.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readPageContext,
    });
    const ctx = injection.result;

    // Derive the friendly values from the raw context.
    const env = guessEnvironment(ctx.url);
    const lang = guessLanguage(ctx);
    const browser = shortBrowser(ctx.userAgent);

    // Build a Textile block for the bug description...
    const lines = [
      "h3. Environment (auto-captured)",
      "* URL: " + ctx.url,
      "* Page: " + ctx.title,
      "* Environment: " + env,
      "* Language: " + lang,
      ctx.mendixVersion ? "* Mendix version: " + ctx.mendixVersion : null,
      "* Browser: " + browser,
      "* Viewport: " + ctx.viewport,
    ].filter(Boolean);
    contextText = lines.join("\n");

    // ...and a shorter version to show the tester in the popup.
    contextBox.textContent =
      env + " · " + lang + (ctx.mendixVersion ? " · Mendix " + ctx.mendixVersion : "") +
      "\n" + browser + " · " + ctx.viewport + "\n" + ctx.url;
  } catch (e) {
    contextText = "";
    contextBox.textContent = "Auto-capture not available on this page.";
  }
}

function guessEnvironment(url) {
  const h = (url || "").toLowerCase();
  if (h.includes("uat")) return "UAT";
  if (h.includes("dev") || h.includes("localhost") || h.includes("test")) return "DEV";
  return "PROD";
}

function guessLanguage(ctx) {
  const dir = (ctx.dir || "").toLowerCase();
  const lang = (ctx.lang || "").toLowerCase();
  if (dir === "rtl" || lang.startsWith("ar")) return "Arabic";
  return "English";
}

function shortBrowser(ua) {
  const b = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? b + " / " + os : b;
}

// ---- DOM capture (Step 2.1) ---------------------------------------------

// INJECTED INTO THE PAGE. Returns a scrubbed copy of the page's HTML:
//  - <script> tags removed
//  - form field values blanked (they may hold personal data)
// Structure, classes, aria-* and validation text are kept — that's the signal a
// developer needs, and it isn't personal data.
function readDomScrubbed() {
  var clone = document.documentElement.cloneNode(true);
  var scripts = clone.querySelectorAll("script");
  for (var i = 0; i < scripts.length; i++) scripts[i].remove();
  var fields = clone.querySelectorAll("input, textarea");
  for (var j = 0; j < fields.length; j++) {
    fields[j].setAttribute("value", "[redacted]");
    fields[j].textContent = "";
  }
  return "<!doctype html>\n" + clone.outerHTML;
}

// Run readDomScrubbed in the active tab and return the HTML (or null on failure).
async function captureDom() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readDomScrubbed,
    });
    return injection.result;
  } catch (e) {
    return null;
  }
}

// ---- Console capture (Step 2.2) -----------------------------------------

// INJECTED INTO THE PAGE'S MAIN WORLD. Reads the buffer that capture.js filled.
function readConsole() {
  try {
    return (window.__rapidReporter && window.__rapidReporter.logs) || [];
  } catch (e) {
    return [];
  }
}

// Read the console buffer from the page. Note world: "MAIN" — the buffer lives in
// the page's main world (where capture.js runs), not the isolated one.
async function captureConsole() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: readConsole,
    });
    return injection.result || [];
  } catch (e) {
    return [];
  }
}

// Strip obvious secrets/PII from any captured text (always applied).
function redact(text) {
  return String(text)
    .replace(/\b784-?\d{4}-?\d{7}-?\d\b/g, "[emirates-id]")
    .replace(/[\w.+-]+@[\w.-]+\.\w{2,}/g, "[email]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [token]")
    .replace(/\beyJ[A-Za-z0-9._-]{20,}/g, "[jwt]");
}

// The full log, for the console.log attachment.
function formatConsole(logs) {
  return logs.map((l) => "[" + l.time + "] [" + l.level + "] " + redact(l.text)).join("\n");
}

// A short "top errors" block for the bug description (what a dev reads first).
function formatErrorsBlock(logs) {
  const errors = logs.filter((l) => l.level === "error").slice(-3);
  if (!errors.length) return "";
  const lines = ["h3. Console errors (last " + errors.length + ")", "<pre>"];
  errors.forEach((e) => lines.push(redact(e.text)));
  lines.push("</pre>");
  return lines.join("\n");
}

// ---- Network capture (Step 2.3) -----------------------------------------

// INJECTED INTO THE PAGE'S MAIN WORLD. Reads the network buffer capture.js filled.
function readNetwork() {
  try {
    return (window.__rapidReporter && window.__rapidReporter.network) || [];
  } catch (e) {
    return [];
  }
}

async function captureNetwork() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: readNetwork,
    });
    return injection.result || [];
  } catch (e) {
    return [];
  }
}

// One readable line per request, for the network.log attachment.
function formatNetwork(net) {
  return net
    .map((n) => "[" + (n.status || "ERR") + "] " + n.method + " " + redact(n.url) + " (" + n.ms + "ms)" + (n.action ? "  action=" + n.action : ""))
    .join("\n");
}

// The failed requests (4xx/5xx or network error), for the bug description.
function formatFailedBlock(net) {
  const failed = net.filter((n) => !n.status || n.status >= 400).slice(-5);
  if (!failed.length) return "";
  const lines = ["h3. Failed network calls (" + failed.length + ")"];
  failed.forEach((n) =>
    lines.push("* " + (n.status || "ERR") + " " + n.method + " " + redact(n.url) + (n.action ? "  (action: " + n.action + ")" : ""))
  );
  return lines.join("\n");
}

// Reload the dropdowns that depend on the chosen project.
function loadProjectData() {
  loadTrackers();
  loadMembers();
}

async function loadTrackers() {
  const projectId = projectSelect.value;
  if (!projectId) {
    typeSelect.innerHTML = '<option value="">(pick a project)</option>';
    return;
  }
  typeSelect.innerHTML = '<option value="">Loading...</option>';
  const res = await chrome.runtime.sendMessage({ type: "GET_TRACKERS", projectId: projectId });
  fillSelect(typeSelect, res && res.ok ? res.trackers : null, res ? res.error : "no response");
}

async function loadMembers() {
  const projectId = projectSelect.value;
  if (!projectId) {
    assigneeSelect.innerHTML = '<option value="">(unassigned)</option>';
    return;
  }
  assigneeSelect.innerHTML = '<option value="">Loading...</option>';
  const res = await chrome.runtime.sendMessage({ type: "GET_MEMBERS", projectId: projectId });
  fillSelect(assigneeSelect, res && res.ok ? res.members : null, res ? res.error : "no response", "(unassigned)");
}

async function loadPriorities() {
  const res = await chrome.runtime.sendMessage({ type: "GET_PRIORITIES" });
  fillSelect(prioritySelect, res && res.ok ? res.priorities : null, res ? res.error : "no response");
  for (const option of prioritySelect.options) {
    if (option.textContent === "Normal") option.selected = true;
  }
}

// Fill a <select> with [{id, name}] items. If placeholder is given, add it first
// with an empty value (used for the optional "(unassigned)" choice).
function fillSelect(select, items, errorText, placeholder) {
  select.innerHTML = "";
  if (placeholder) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = placeholder;
    select.appendChild(opt);
  }
  if (!items) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(could not load: " + errorText + ")";
    select.appendChild(opt);
    return;
  }
  items.forEach((item) => {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = item.name;
    select.appendChild(opt);
  });
}

fileButton.addEventListener("click", () => {
  const subject = titleInput.value.trim() || "[TEST] Rapid Reporter smoke test";
  const projectId = projectSelect.value;

  if (!projectId) {
    statusText.textContent = "Pick a project first.";
    return;
  }

  statusText.textContent = "Capturing screenshot...";

  chrome.tabs.captureVisibleTab({ format: "png" }, async (dataUrl) => {
    if (chrome.runtime.lastError) {
      statusText.textContent = "Error: " + chrome.runtime.lastError.message;
      return;
    }
    previewImage.src = dataUrl;
    previewImage.style.display = "block";

    // Console + network are captured on every report; DOM only if opted in.
    statusText.textContent = "Capturing console + network...";
    const logs = await captureConsole();
    const consoleText = formatConsole(logs);
    const errorsBlock = formatErrorsBlock(logs);

    const net = await captureNetwork();
    const networkText = formatNetwork(net);
    const failedBlock = formatFailedBlock(net);

    let domHtml = null;
    if (includeDomCheck.checked) {
      statusText.textContent = "Capturing DOM...";
      domHtml = await captureDom();
    }

    // Fold the console errors and failed requests into the description.
    const fullContext =
      contextText +
      (errorsBlock ? "\n\n" + errorsBlock : "") +
      (failedBlock ? "\n\n" + failedBlock : "");

    statusText.textContent = "Filing the bug in Redmine...";

    const result = await chrome.runtime.sendMessage({
      type: "FILE_BUG",
      dataUrl: dataUrl,
      projectId: projectId,
      subject: subject,
      trackerId: typeSelect.value,
      priorityId: prioritySelect.value,
      severity: severitySelect.value,
      assignedToId: assigneeSelect.value,
      contextText: fullContext,
      domHtml: domHtml,
      consoleText: consoleText,
      networkText: networkText,
    });

    if (result && result.ok) {
      statusText.innerHTML =
        'Filed! <a href="' + result.url + '" target="_blank">Open #' + result.id + "</a>";
    } else {
      statusText.textContent = "Error: " + (result ? result.error : "no response");
    }
  });
});
