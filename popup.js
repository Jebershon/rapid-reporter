// popup.js — collects inputs, fills the Project / Type / Priority / Assignee
// dropdowns, captures the screenshot, and hands the job to the service worker.

const titleInput = document.getElementById("title");
const projectSelect = document.getElementById("project");
const typeSelect = document.getElementById("type");
const prioritySelect = document.getElementById("priority");
const severitySelect = document.getElementById("severity");
const assigneeSelect = document.getElementById("assignee");
const notesInput = document.getElementById("notes");
const customFieldsBox = document.getElementById("customFields");
const dupesBox = document.getElementById("dupes");
const contextBox = document.getElementById("context");
const includeDomCheck = document.getElementById("includeDom");
const pickButton = document.getElementById("pick");
const pickedBox = document.getElementById("picked");
const captureButton = document.getElementById("capture");
const annotateBox = document.getElementById("annotate");
const shotCanvas = document.getElementById("shot");
const fileButton = document.getElementById("file");
const statusText = document.getElementById("status");

// Holds the Textile block we build from the page context, to attach when filing.
let contextText = "";
// Auto-detected values, used to pre-select matching custom fields.
let detectedEnv = "";
let detectedLang = "";
// The element the tester picked (or null).
let pickedInfo = null;

// On open: load the dropdowns AND read the page context.
loadProjects();
loadPriorities();
detectContext();

// Picking a project instantly refreshes the project-specific dropdowns.
projectSelect.addEventListener("change", () => {
  chrome.storage.local.set({ lastProject: projectSelect.value });
  loadProjectData();
  checkDuplicates();
});

// Warn about similar open bugs when the title is edited.
titleInput.addEventListener("change", checkDuplicates);

// ---- Element picker (Step 4a) -------------------------------------------

pickButton.addEventListener("click", async () => {
  statusText.textContent = "Pick mode — click an element in the page (Esc to cancel)…";
  const info = await pickElementInPage();
  statusText.textContent = "";
  if (!info) return;
  pickedInfo = info;
  pickedBox.style.display = "block";
  pickedBox.textContent =
    "Picked: " + (info.text || info.tag) + (info.mxName ? "  [mx-name: " + info.mxName + "]" : "") +
    "\n" + info.selector;
});

async function pickElementInPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pickElement,
    });
    return injection.result;
  } catch (e) {
    return null;
  }
}

// INJECTED INTO THE PAGE. Highlights the hovered element; resolves with its
// details on click, or null on Escape. Returns a Promise, which executeScript
// awaits.
function pickElement() {
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.style.cssText =
      "position:fixed;z-index:2147483647;border:2px solid #e23a2e;background:rgba(226,58,46,0.12);pointer-events:none;transition:top .05s,left .05s,width .05s,height .05s;";
    const hint = document.createElement("div");
    hint.textContent = "Click an element to capture it — Esc to cancel";
    hint.style.cssText =
      "position:fixed;z-index:2147483647;top:10px;left:50%;transform:translateX(-50%);background:#1c1c1a;color:#f7f2e6;font:600 12px system-ui;padding:6px 12px;pointer-events:none;";
    document.body.appendChild(box);
    document.body.appendChild(hint);
    let current = null;

    function mxName(el) {
      let n = el;
      while (n && n.classList) {
        for (let i = 0; i < n.classList.length; i++) {
          if (n.classList[i].indexOf("mx-name-") === 0) return n.classList[i].slice(8);
        }
        n = n.parentElement;
      }
      return "";
    }
    function selectorFor(el) {
      if (el.id) return "#" + el.id;
      const parts = [];
      let node = el;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 4) {
        let s = node.tagName.toLowerCase();
        if (typeof node.className === "string" && node.className.trim()) {
          const cls = node.className.trim().split(/\s+/).filter((c) => c && c.indexOf("mx-name-") !== 0).slice(0, 2);
          if (cls.length) s += "." + cls.join(".");
        }
        parts.unshift(s);
        node = node.parentElement;
        depth++;
      }
      return parts.join(" > ");
    }
    function move(e) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === box || el === hint) return;
      current = el;
      const r = el.getBoundingClientRect();
      box.style.top = r.top + "px";
      box.style.left = r.left + "px";
      box.style.width = r.width + "px";
      box.style.height = r.height + "px";
    }
    function cleanup() {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      box.remove();
      hint.remove();
    }
    function click(e) {
      e.preventDefault();
      e.stopPropagation();
      const el = current || e.target;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const info = {
        tag: el.tagName.toLowerCase(),
        mxName: mxName(el),
        selector: selectorFor(el),
        text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60),
        rect: Math.round(r.width) + "x" + Math.round(r.height) + " @ (" + Math.round(r.left) + "," + Math.round(r.top) + ")",
        styles: {
          display: cs.display,
          position: cs.position,
          color: cs.color,
          background: cs.backgroundColor,
          font: cs.fontSize + " " + (cs.fontFamily || "").split(",")[0],
          margin: cs.margin,
          padding: cs.padding,
          direction: cs.direction,
        },
      };
      cleanup();
      resolve(info);
    }
    function key(e) {
      if (e.key === "Escape") {
        cleanup();
        resolve(null);
      }
    }
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
  });
}

// A "Picked element" block for the bug description.
function formatElementBlock(info) {
  if (!info) return "";
  const s = info.styles || {};
  return [
    "h3. Picked element",
    "* Element: " + (info.text ? "'" + info.text + "' " : "") + info.tag + (info.mxName ? "  (mx-name: " + info.mxName + ")" : ""),
    "* Selector: @" + info.selector + "@",
    "* Size/pos: " + info.rect,
    "* Styles: display=" + s.display + ", position=" + s.position + ", direction=" + s.direction +
      ", color=" + s.color + ", background=" + s.background + ", font=" + s.font +
      ", margin=" + s.margin + ", padding=" + s.padding,
  ].join("\n");
}

async function checkDuplicates() {
  dupesBox.classList.remove("show");
  dupesBox.innerHTML = "";

  const projectId = projectSelect.value;
  const query = titleInput.value.trim();
  if (!projectId || query.length < 4) return;

  const res = await chrome.runtime.sendMessage({ type: "GET_SIMILAR", projectId: projectId, query: query });
  if (!res || !res.ok || !res.results.length) return;

  const heading = document.createElement("div");
  heading.className = "dupes-title";
  heading.textContent = "Possible duplicates";
  dupesBox.appendChild(heading);

  res.results.slice(0, 5).forEach((r) => {
    const a = document.createElement("a");
    a.href = r.url;
    a.target = "_blank";
    a.textContent = r.title || "#" + r.id;
    dupesBox.appendChild(a);
  });
  dupesBox.classList.add("show");
}

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
    detectedEnv = env;
    detectedLang = lang;

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
  if (!logs.length) {
    return "(No console output captured — reload the app page before reproducing so capture starts at page load.)";
  }
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
  if (!net.length) {
    return "(No network requests captured — reload the app page before reproducing so capture starts at page load.)";
  }
  return net
    .map((n) => "[" + (n.status || "ERR") + "] " + n.method + " " + redact(n.url) + " (" + n.ms + "ms)" + (n.action ? "  action=" + n.action : ""))
    .join("\n");
}

// ---- Action trail (Step: auto steps to reproduce) -----------------------

function readActions() {
  try {
    return (window.__rapidReporter && window.__rapidReporter.actions) || [];
  } catch (e) {
    return [];
  }
}

async function captureActions() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: readActions,
    });
    return injection.result || [];
  } catch (e) {
    return [];
  }
}

// A numbered "steps to reproduce" block from the last dozen actions.
function formatSteps(actions) {
  if (!actions.length) return "";
  const lines = ["h3. Steps to reproduce (auto-captured)"];
  actions.slice(-12).forEach((a) => lines.push("# " + redact(a.step)));
  return lines.join("\n");
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
  loadCustomFields();
}

// Discover the project's custom fields (Defect Category, Service, Environment…)
// and render a dropdown for each, pre-selecting matches from the page detection.
async function loadCustomFields() {
  customFieldsBox.innerHTML = "";
  const projectId = projectSelect.value;
  if (!projectId) return;

  const res = await chrome.runtime.sendMessage({ type: "GET_CUSTOM_FIELDS", projectId: projectId });
  if (!res || !res.ok || !res.fields.length) return; // not critical — skip quietly

  res.fields.forEach((f) => {
    const field = document.createElement("div");
    field.className = "field";

    const label = document.createElement("label");
    label.textContent = f.name;

    const wrap = document.createElement("div");
    wrap.className = "select-wrap";

    const select = document.createElement("select");
    select.dataset.cfId = f.id;
    if (f.multiple) select.dataset.multiple = "1";

    const none = document.createElement("option");
    none.value = "";
    none.textContent = "(none)";
    select.appendChild(none);

    f.values.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      if (autoMatch(f.name, v)) opt.selected = true; // auto-fill Environment/Language
      select.appendChild(opt);
    });

    wrap.appendChild(select);
    field.appendChild(label);
    field.appendChild(wrap);
    customFieldsBox.appendChild(field);
  });
}

// Best-effort pre-selection of Environment / Language from the page detection.
function autoMatch(fieldName, value) {
  const n = fieldName.toLowerCase();
  const v = value.toLowerCase();
  if (n.includes("environment") && detectedEnv && v.includes(detectedEnv.toLowerCase())) return true;
  if (n.includes("language") && detectedLang && v === detectedLang.toLowerCase()) return true;
  return false;
}

// Collect the tester's custom-field choices as [{id, value}].
function collectCustomFields() {
  const out = [];
  customFieldsBox.querySelectorAll("select").forEach((select) => {
    if (!select.value) return;
    const id = Number(select.dataset.cfId);
    out.push({ id: id, value: select.dataset.multiple ? [select.value] : select.value });
  });
  return out;
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

// ---- Screenshot capture + annotation (Step 4b) --------------------------

let annImage = null;    // the captured screenshot as an Image
let shapes = [];        // committed annotations
let drawing = null;     // shape being drawn
let tool = "box";       // box | arrow | redact

// Take a screenshot of the active tab; returns a data URL or null.
function captureTab() {
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab({ format: "png" }, (dataUrl) => {
      resolve(chrome.runtime.lastError ? null : dataUrl);
    });
  });
}

captureButton.addEventListener("click", async () => {
  statusText.textContent = "Capturing screenshot…";
  const dataUrl = await captureTab();
  if (!dataUrl) {
    statusText.textContent = "Couldn't capture this page (try a normal website tab).";
    return;
  }
  statusText.textContent = "";
  startAnnotation(dataUrl);
});

function startAnnotation(dataUrl) {
  annImage = new Image();
  annImage.onload = () => {
    shotCanvas.width = annImage.naturalWidth;
    shotCanvas.height = annImage.naturalHeight;
    shapes = [];
    annotateBox.style.display = "block";
    redraw();
  };
  annImage.src = dataUrl;
}

function redraw(inProgress) {
  const ctx = shotCanvas.getContext("2d");
  ctx.clearRect(0, 0, shotCanvas.width, shotCanvas.height);
  if (annImage) ctx.drawImage(annImage, 0, 0);
  const all = inProgress ? shapes.concat([inProgress]) : shapes;
  all.forEach((s) => drawShape(ctx, s));
}

function drawShape(ctx, s) {
  const lw = Math.max(3, shotCanvas.width / 300);
  ctx.lineWidth = lw;
  if (s.type === "redact") {
    ctx.fillStyle = "#1c1c1a";
    ctx.fillRect(s.x, s.y, s.w, s.h);
  } else if (s.type === "box") {
    ctx.strokeStyle = "#e23a2e";
    ctx.strokeRect(s.x, s.y, s.w, s.h);
  } else if (s.type === "arrow") {
    ctx.strokeStyle = "#e23a2e";
    ctx.fillStyle = "#e23a2e";
    const x1 = s.x, y1 = s.y, x2 = s.x + s.w, y2 = s.y + s.h;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    const a = Math.atan2(y2 - y1, x2 - x1);
    const h = Math.max(14, shotCanvas.width / 55);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - h * Math.cos(a - 0.4), y2 - h * Math.sin(a - 0.4));
    ctx.lineTo(x2 - h * Math.cos(a + 0.4), y2 - h * Math.sin(a + 0.4));
    ctx.closePath();
    ctx.fill();
  }
}

// Map a mouse event to internal canvas coordinates (canvas is CSS-scaled).
function canvasXY(e) {
  const r = shotCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (shotCanvas.width / r.width),
    y: (e.clientY - r.top) * (shotCanvas.height / r.height),
  };
}

shotCanvas.addEventListener("mousedown", (e) => {
  const p = canvasXY(e);
  drawing = { type: tool, x: p.x, y: p.y, w: 0, h: 0 };
});
shotCanvas.addEventListener("mousemove", (e) => {
  if (!drawing) return;
  const p = canvasXY(e);
  drawing.w = p.x - drawing.x;
  drawing.h = p.y - drawing.y;
  redraw(drawing);
});
window.addEventListener("mouseup", () => {
  if (!drawing) return;
  if (Math.abs(drawing.w) > 3 || Math.abs(drawing.h) > 3) shapes.push(drawing);
  drawing = null;
  redraw();
});

document.querySelectorAll(".tool[data-tool]").forEach((btn) => {
  btn.addEventListener("click", () => {
    tool = btn.dataset.tool;
    document.querySelectorAll(".tool[data-tool]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  });
});
document.getElementById("undo").addEventListener("click", () => {
  shapes.pop();
  redraw();
});

// The annotated screenshot as a data URL, or null if none was captured.
function annotatedDataUrl() {
  return annImage ? shotCanvas.toDataURL("image/png") : null;
}

// ---- File the bug -------------------------------------------------------

fileButton.addEventListener("click", async () => {
  const subject = titleInput.value.trim() || "[TEST] Rapid Reporter smoke test";
  const projectId = projectSelect.value;

  if (!projectId) {
    statusText.textContent = "Pick a project first.";
    return;
  }

  // Use the annotated screenshot if one was captured, else grab a fresh one.
  let dataUrl = annotatedDataUrl();
  if (!dataUrl) {
    statusText.textContent = "Capturing screenshot…";
    dataUrl = await captureTab();
    if (!dataUrl) {
      statusText.textContent = "Couldn't capture this page.";
      return;
    }
  }

  // Steps, console + network are captured on every report; DOM only if opted in.
  statusText.textContent = "Capturing console + network…";
  const actions = await captureActions();
  const stepsBlock = formatSteps(actions);

  const logs = await captureConsole();
  const consoleText = formatConsole(logs);
  const errorsBlock = formatErrorsBlock(logs);

  const net = await captureNetwork();
  const networkText = formatNetwork(net);
  const failedBlock = formatFailedBlock(net);

  let domHtml = null;
  if (includeDomCheck.checked) {
    statusText.textContent = "Capturing DOM…";
    domHtml = await captureDom();
  }

  const elementBlock = formatElementBlock(pickedInfo);
  const fullContext =
    (stepsBlock ? stepsBlock + "\n\n" : "") +
    (elementBlock ? elementBlock + "\n\n" : "") +
    contextText +
    (errorsBlock ? "\n\n" + errorsBlock : "") +
    (failedBlock ? "\n\n" + failedBlock : "");

  statusText.textContent = "Filing the bug in Redmine…";

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
    notes: notesInput.value.trim(),
    customFields: collectCustomFields(),
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
