// popup.js — collects inputs, fills the Project / Type / Priority / Assignee
// dropdowns, captures the screenshot, and hands the job to the service worker.

const titleInput = document.getElementById("title");
const projectSelect = document.getElementById("project");
const typeSelect = document.getElementById("type");
const prioritySelect = document.getElementById("priority");
const severitySelect = document.getElementById("severity");
const assigneeSelect = document.getElementById("assignee");
const notesEditor = document.getElementById("notesEditor");
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
const successBox = document.getElementById("success");
const successLink = document.getElementById("successLink");
const formBox = document.getElementById("form");
const newBugButton = document.getElementById("newBug");

// Holds the Textile block we build from the page context, to attach when filing.
let contextText = "";
// The structured page context (for the machine-readable rapid-reporter.json).
let pageContext = null;
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

// ---- Rich text editor (Description) -------------------------------------

// Toolbar: apply the formatting command without losing the selection.
document.querySelectorAll(".rte-tools .tool[data-cmd]").forEach((btn) => {
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    notesEditor.focus();
    document.execCommand(btn.dataset.cmd, false, null);
  });
});

// Convert the editor's HTML to Redmine Textile (only the formats the toolbar
// can produce). Returns "" for an empty editor.
function htmlToTextile(el) {
  const out = Array.from(el.childNodes).map(nodeToTextile).join("");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
function nodeToTextile(node) {
  if (node.nodeType === 3) return node.nodeValue; // text
  if (node.nodeType !== 1) return "";
  const inner = () => Array.from(node.childNodes).map(nodeToTextile).join("");
  switch (node.tagName.toLowerCase()) {
    case "b":
    case "strong":
      return "*" + inner() + "*";
    case "i":
    case "em":
      return "_" + inner() + "_";
    case "u":
      return "+" + inner() + "+";
    case "a":
      return '"' + inner() + '":' + (node.getAttribute("href") || "");
    case "br":
      return "\n";
    case "ul":
      return Array.from(node.children).map((li) => "* " + inlineTextile(li)).join("\n") + "\n";
    case "ol":
      return Array.from(node.children).map((li) => "# " + inlineTextile(li)).join("\n") + "\n";
    case "li":
      return inlineTextile(node);
    case "div":
    case "p":
      return inner() + "\n";
    default:
      return inner();
  }
}
function inlineTextile(node) {
  return Array.from(node.childNodes).map(nodeToTextile).join("").replace(/\n+/g, " ").trim();
}

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
    function widgetPath(el) {
      // Mendix stamps the full page-widget path onto ids / data-button-id, e.g.
      // "p.Module_UI.MyPage.btnSave" — a dev can jump straight to it in Studio Pro.
      let n = el;
      while (n && n.getAttribute) {
        const b = n.getAttribute("data-button-id") || (n.id && n.id.indexOf("p.") === 0 ? n.id : "");
        if (b) return b;
        n = n.parentElement;
      }
      return "";
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
        widgetPath: widgetPath(el),
        html: (el.outerHTML || "").replace(/\s+/g, " ").trim().slice(0, 600),
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
    info.widgetPath ? "* Mendix widget: @" + info.widgetPath + "@" : null,
    "* Selector: @" + info.selector + "@",
    "* Size/pos: " + info.rect,
    "* Styles: display=" + s.display + ", position=" + s.position + ", direction=" + s.direction +
      ", color=" + s.color + ", background=" + s.background + ", font=" + s.font +
      ", margin=" + s.margin + ", padding=" + s.padding,
  ].filter(Boolean).join("\n");
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
    isMendix: false,
    mendixVersion: "",
    mendixPage: "",
    mendixPageTitle: "",
    mendixUser: "",
    mendixLocale: "",
  };
  // Runs in the page's MAIN world, so window.mx (the Mendix client) is reachable.
  // Confirm it's a Mendix app first, then read each detail defensively — the mx
  // API differs across Mendix versions, so one missing call must not break the rest.
  try {
    var mx = window.mx;
    if (mx && typeof mx === "object") {
      ctx.isMendix = true;
      try {
        if (mx.version) ctx.mendixVersion = String(mx.version);
      } catch (e) {}
      try {
        if (mx.ui && typeof mx.ui.getContentForm === "function") {
          var form = mx.ui.getContentForm();
          if (form) {
            if (form.path) ctx.mendixPage = String(form.path);
            if (form.title) ctx.mendixPageTitle = String(form.title);
          }
        }
      } catch (e) {}
      try {
        if (mx.session && typeof mx.session.getUserName === "function") {
          ctx.mendixUser = String(mx.session.getUserName());
        }
      } catch (e) {}
      try {
        if (mx.session && typeof mx.session.getConfig === "function") {
          var loc = mx.session.getConfig("locale");
          if (loc) ctx.mendixLocale = String(loc.code || loc.languageCode || loc);
        }
      } catch (e) {}
    }
  } catch (e) {}

  // Derive the page from Mendix widget ids (p.<Module>.<Page>.<widget>) — this is
  // concrete and version-independent, so prefer it as the page name. The main
  // content page is whichever Module.Page prefix owns the most widgets on screen.
  try {
    var wEls = document.querySelectorAll('[data-button-id^="p."], [id^="p."]');
    var wCounts = {};
    for (var wi = 0; wi < wEls.length; wi++) {
      var wRaw = wEls[wi].getAttribute("data-button-id") || wEls[wi].id || "";
      var wParts = wRaw.replace(/^p\./, "").split(".");
      if (wParts.length >= 3) {
        var wPage = wParts[0] + "." + wParts[1];
        wCounts[wPage] = (wCounts[wPage] || 0) + 1;
      }
    }
    var wBest = 0, wName = "";
    for (var wk in wCounts) if (wCounts[wk] > wBest) { wBest = wCounts[wk]; wName = wk; }
    if (wName) { ctx.mendixPage = wName; ctx.isMendix = true; }
  } catch (e) {}

  return ctx;
}

async function detectContext() {
  try {
    // Find the tab behind the popup, then run readPageContext() inside it.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN", // reach the page's window.mx (Mendix client)
      func: readPageContext,
    });
    const ctx = injection.result;

    // Derive the friendly values from the raw context.
    const env = guessEnvironment(ctx.url);
    // Prefer the Mendix locale (e.g. ar_AE) when present; else guess from dir/lang.
    const lang = ctx.mendixLocale
      ? ctx.mendixLocale.toLowerCase().indexOf("ar") === 0
        ? "Arabic"
        : "English"
      : guessLanguage(ctx);
    const browser = shortBrowser(ctx.userAgent);
    const page = ctx.mendixPage || ctx.title; // Mendix page path, else the tab title
    detectedEnv = env;
    detectedLang = lang;

    // Build a Textile block for the bug description (Mendix lines only if present).
    const lines = [
      "h3. Environment (auto-captured)",
      "* URL: " + ctx.url,
      "* Page: " + page,
      ctx.mendixPageTitle ? "* Page title: " + ctx.mendixPageTitle : null,
      "* Environment: " + env,
      "* Language: " + lang,
      ctx.mendixVersion ? "* Mendix version: " + ctx.mendixVersion : null,
      ctx.mendixLocale ? "* Mendix locale: " + ctx.mendixLocale : null,
      ctx.mendixUser ? "* Mendix user: " + ctx.mendixUser : null,
      "* Browser: " + browser,
      "* Viewport: " + ctx.viewport,
    ].filter(Boolean);
    contextText = lines.join("\n");

    // Keep the structured version too, for the rapid-reporter.json fix packet.
    pageContext = {
      url: ctx.url,
      title: ctx.title,
      page: page,
      pageTitle: ctx.mendixPageTitle || "",
      isMendix: !!ctx.isMendix,
      mendixVersion: ctx.mendixVersion || "",
      mendixLocale: ctx.mendixLocale || "",
      mendixUser: ctx.mendixUser || "",
      environment: env,
      language: lang,
      browser: browser,
      viewport: ctx.viewport,
      userAgent: ctx.userAgent,
    };

    // ...and a shorter version to show the tester in the popup.
    contextBox.textContent =
      env + " · " + lang + (ctx.mendixVersion ? " · Mendix " + ctx.mendixVersion : "") +
      "\nPage: " + page +
      (ctx.mendixUser ? "\nUser: " + ctx.mendixUser : "") +
      "\n" + browser + " · " + ctx.viewport + "\n" + ctx.url;
  } catch (e) {
    contextText = "";
    pageContext = null;
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
// Always renders — an explicit "none" is a finding (rules out a JS error), and
// its absence would just look like the tool failed.
function formatErrorsBlock(logs) {
  const errors = logs.filter((l) => l.level === "error").slice(-3);
  if (!errors.length) {
    return "h3. Console errors\n_None captured._";
  }
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
    .map(
      (n) =>
        "[" + (n.status || "ERR") + "] " + n.method + " " + redact(n.url) + " (" + n.ms + "ms)" +
        (n.action ? "  action=" + n.action : "") +
        (n.entity ? " entity=" + n.entity : "") +
        (n.raw ? "\n    payload: " + redact(n.raw) : "")
    )
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
  if (!failed.length) {
    return net.length
      ? "h3. Failed network calls\n_None — every request returned a success status._"
      : "h3. Failed network calls\n_No network activity captured — reload the app page before reproducing._";
  }
  const lines = ["h3. Failed network calls (" + failed.length + ")"];
  failed.forEach((n) =>
    lines.push("* " + (n.status || "ERR") + " " + n.method + " " + redact(n.url) + (n.action ? "  (action: " + n.action + ")" : ""))
  );
  return lines.join("\n");
}

// The Mendix microflows / nanoflows that ran, pulled from the /xas/ action names
// (module-qualified names like "Module.MF_DoThing"). This is usually the single
// most useful signal for a Mendix developer, so it goes in the description body,
// in call order, with the status and timing of each.
function formatMicroflows(net) {
  const flows = net.filter((n) => n.action && n.action.indexOf(".") > 0);
  if (!flows.length) {
    return net.length
      ? "h3. Microflows / nanoflows called\n_None — no microflow/nanoflow ran during this session (only data retrieval)._"
      : "h3. Microflows / nanoflows called\n_No network activity captured — reload the app page before reproducing so capture starts at page load._";
  }
  const shown = flows.slice(-15);
  const head =
    "h3. Microflows / nanoflows called (" +
    flows.length +
    (flows.length > shown.length ? ", last " + shown.length + " shown" : "") +
    ")";
  const lines = [head];
  shown.forEach((n) =>
    lines.push(
      "# *" + n.action + "* — " + (n.status || "ERR") + (n.ms != null ? " · " + n.ms + " ms" : "")
    )
  );
  return lines.join("\n");
}

// The /xas/ calls that aren't microflows — retrieve/commit/changes — so a dev can
// see what data the page loaded (and the entity), and whether any of it failed.
function isDataXas(n) {
  return (n.url || "").indexOf("/xas") !== -1 && (!n.action || n.action.indexOf(".") < 0);
}
function formatDataCalls(net) {
  const calls = net.filter(isDataXas);
  if (!calls.length) return "";
  const shown = calls.slice(-15);
  const head =
    "h3. Data / retrieval xas calls (" +
    calls.length +
    (calls.length > shown.length ? ", last " + shown.length + " shown" : "") +
    ")";
  const lines = [head];
  shown.forEach((n) =>
    lines.push(
      "# " + (n.action || "xas") + (n.entity ? " *" + n.entity + "*" : "") +
        " — " + (n.status || "ERR") + (n.ms != null ? " · " + n.ms + " ms" : "")
    )
  );
  return lines.join("\n");
}

// A one-glance pointer for a developer reading the ticket by hand: the failing
// microflow and/or the first console error — where to start looking. Only shown
// when there's an actual signal, so it never adds noise to a clean report.
function formatLikelyCause(net, logs) {
  const bits = [];
  const failedFlow = net.find(
    (n) => n.action && n.action.indexOf(".") > 0 && (!n.status || n.status >= 400)
  );
  if (failedFlow) {
    bits.push(
      "* Microflow *" + failedFlow.action + "* returned " +
        (failedFlow.status || "no response") + " — start here."
    );
  }
  const err = logs.find((l) => l.level === "error");
  if (err) bits.push("* Console error: " + redact(err.text).split("\n")[0].slice(0, 160));
  if (!bits.length) {
    return "h3. Likely cause (auto)\n_No failing microflow or console error detected — likely a UI/content issue; see the screenshot and steps above._";
  }
  return "h3. Likely cause (auto)\n" + bits.join("\n");
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
let zoom = 1;           // canvas display zoom (1 = fit panel width)
let fitWidth = 320;     // canvas display width at zoom 1

// Take a screenshot of the active tab; returns a data URL or null.
function captureTab() {
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab({ format: "png" }, (dataUrl) => {
      resolve(chrome.runtime.lastError ? null : dataUrl);
    });
  });
}

captureButton.addEventListener("click", async () => {
  successBox.style.display = "none";
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
    zoom = 1;
    fitWidth = shotCanvas.parentElement.clientWidth || 320;
    applyZoom();
    redraw();
  };
  annImage.src = dataUrl;
}

// Set the canvas display size from the zoom level (internal resolution is
// unchanged, so the exported image stays full-resolution).
function applyZoom() {
  shotCanvas.style.width = Math.round(fitWidth * zoom) + "px";
  shotCanvas.style.height = "auto";
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

let panning = null;     // active drag-to-pan state when the Pan tool is selected

shotCanvas.addEventListener("mousedown", (e) => {
  if (tool === "pan") {
    // Grab the zoomed image and drag it around inside its scroll box.
    const wrap = shotCanvas.parentElement;
    panning = { x: e.clientX, y: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop };
    shotCanvas.style.cursor = "grabbing";
    e.preventDefault();
    return;
  }
  const p = canvasXY(e);
  drawing = { type: tool, x: p.x, y: p.y, w: 0, h: 0 };
});
shotCanvas.addEventListener("mousemove", (e) => {
  if (panning) {
    const wrap = shotCanvas.parentElement;
    wrap.scrollLeft = panning.sl - (e.clientX - panning.x);
    wrap.scrollTop = panning.st - (e.clientY - panning.y);
    return;
  }
  if (!drawing) return;
  const p = canvasXY(e);
  drawing.w = p.x - drawing.x;
  drawing.h = p.y - drawing.y;
  redraw(drawing);
});
window.addEventListener("mouseup", () => {
  if (panning) {
    panning = null;
    shotCanvas.style.cursor = tool === "pan" ? "grab" : "crosshair";
    return;
  }
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
    shotCanvas.style.cursor = tool === "pan" ? "grab" : "crosshair";
  });
});
document.getElementById("undo").addEventListener("click", () => {
  shapes.pop();
  redraw();
});
document.getElementById("zoomIn").addEventListener("click", () => {
  zoom = Math.min(4, zoom + 0.5);
  applyZoom();
});
document.getElementById("zoomOut").addEventListener("click", () => {
  zoom = Math.max(0.5, zoom - 0.5);
  applyZoom();
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
  successBox.style.display = "none";

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
  const microflowBlock = formatMicroflows(net);
  const dataCallsBlock = formatDataCalls(net);

  let domHtml = null;
  if (includeDomCheck.checked) {
    statusText.textContent = "Capturing DOM…";
    domHtml = await captureDom();
  }

  const elementBlock = formatElementBlock(pickedInfo);

  // A machine-readable fix packet — everything a developer (or Claude, via the
  // Redmine MCP's get_attachment_text) needs to locate and fix the bug, in one
  // structured file rather than scattered across prose.
  const fixPacket = {
    tool: "rapid-reporter",
    version: chrome.runtime.getManifest().version,
    filedAt: new Date().toISOString(),
    title: subject,
    page: pageContext || {},
    steps: actions.map((a) => redact(a.step)),
    microflows: net
      .filter((n) => n.action && n.action.indexOf(".") > 0)
      .map((n) => ({ name: n.action, status: n.status, ms: n.ms, payload: redact(n.raw || "") })),
    dataCalls: net
      .filter(isDataXas)
      .map((n) => ({ action: n.action || "xas", entity: n.entity || "", status: n.status, ms: n.ms, payload: redact(n.raw || "") })),
    failedCalls: net
      .filter((n) => !n.status || n.status >= 400)
      .map((n) => ({ method: n.method, url: redact(n.url), status: n.status, action: n.action || "", ms: n.ms })),
    consoleErrors: logs.filter((l) => l.level === "error").map((l) => redact(l.text)).slice(-20),
    pickedElement: pickedInfo
      ? {
          tag: pickedInfo.tag,
          text: pickedInfo.text,
          mxName: pickedInfo.mxName || "",
          widgetPath: pickedInfo.widgetPath || "",
          selector: pickedInfo.selector,
          html: redact(pickedInfo.html || ""),
          styles: pickedInfo.styles || {},
        }
      : null,
  };

  // Human-readable report, ordered the way a developer fixing it by hand reads:
  // where it happened, how to reproduce, the likely cause, then the supporting
  // detail. (The rapid-reporter.json packet is the separate machine path.)
  const likelyBlock = formatLikelyCause(net, logs);
  const fullContext = [
    contextText,     // Environment — where
    stepsBlock,      // Steps to reproduce — how
    likelyBlock,     // Likely cause — start here
    elementBlock,    // Picked element
    errorsBlock,     // Console errors (with stack traces)
    microflowBlock,  // Microflows / nanoflows called
    dataCallsBlock,  // Data / retrieval xas calls
    failedBlock,     // Failed network calls
  ]
    .filter(Boolean)
    .join("\n\n");

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
    notes: htmlToTextile(notesEditor),
    customFields: collectCustomFields(),
    domHtml: domHtml,
    consoleText: consoleText,
    networkText: networkText,
    fixPacket: fixPacket,
  });

  if (result && result.ok) {
    statusText.textContent = "";
    formBox.style.display = "none"; // hide the whole form; show only the success state
    showSuccess(result.id, result.url);
  } else {
    statusText.textContent = "Error: " + (result ? result.error : "no response");
  }
});

// "File new bug" — clear the form and bring it back for the next report.
newBugButton.addEventListener("click", () => {
  resetForm();
  successBox.style.display = "none";
  formBox.style.display = "";
  titleInput.focus();
});

// Play the success animation and show the link to the new bug.
function showSuccess(id, url) {
  successLink.textContent = "Open #" + id;
  successLink.href = url;
  successBox.style.display = "flex";
  // Restart the CSS animations (they only run on first render otherwise).
  successBox.style.animation = "none";
  void successBox.offsetWidth;
  successBox.style.animation = "";
  successBox.querySelectorAll("circle, path").forEach((el) => {
    el.style.animation = "none";
    void el.offsetWidth;
    el.style.animation = "";
  });
}

// Clear the per-bug inputs for the next report; keep project + classification.
function resetForm() {
  titleInput.value = "";
  notesEditor.innerHTML = "";
  pickedInfo = null;
  pickedBox.style.display = "none";
  pickedBox.textContent = "";
  annImage = null;
  shapes = [];
  annotateBox.style.display = "none";
  dupesBox.classList.remove("show");
  dupesBox.innerHTML = "";
}
