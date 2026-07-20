// background.js — the background brain. Message types it answers:
//   GET_TRACKERS   -> trackers a project allows (fills the Bug type dropdown)
//   GET_PRIORITIES -> priority levels (fills the Priority dropdown)
//   FILE_BUG       -> upload the screenshot and create the bug

// Open the side panel when the toolbar icon is clicked (instead of a popup).
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_PROJECTS") {
    getProjects().then(sendResponse);
    return true;
  }
  if (message.type === "GET_TRACKERS") {
    getTrackers(message).then(sendResponse);
    return true;
  }
  if (message.type === "GET_PRIORITIES") {
    getPriorities().then(sendResponse);
    return true;
  }
  if (message.type === "GET_MEMBERS") {
    getMembers(message).then(sendResponse);
    return true;
  }
  if (message.type === "GET_CUSTOM_FIELDS") {
    getCustomFields(message).then(sendResponse);
    return true;
  }
  if (message.type === "GET_SIMILAR") {
    getSimilar(message).then(sendResponse);
    return true;
  }
  if (message.type === "FILE_BUG") {
    fileBug(message).then(sendResponse);
    return true;
  }
});

// Read settings once; hand back a clean base URL + key (or null if unset).
async function getConfig() {
  const { redmineUrl, apiKey } = await chrome.storage.local.get(["redmineUrl", "apiKey"]);
  if (!redmineUrl || !apiKey) return null;
  return { base: redmineUrl.replace(/\/$/, ""), apiKey };
}

// The projects the user can see. We use each project's `identifier` as the value
// (that's what the other endpoints and issue creation expect), and its name as
// the label — so the tester never has to know or type the identifier.
async function getProjects() {
  try {
    const cfg = await getConfig();
    if (!cfg) return { ok: false, error: "Set your API key in Options first." };
    const res = await fetch(cfg.base + "/projects.json?limit=100", {
      headers: { "X-Redmine-API-Key": cfg.apiKey },
    });
    if (!res.ok) return { ok: false, error: "HTTP " + res.status };
    const projects = (await res.json()).projects || [];
    return { ok: true, projects: projects.map((p) => ({ id: p.identifier, name: p.name })) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function getTrackers({ projectId }) {
  try {
    const cfg = await getConfig();
    if (!cfg) return { ok: false, error: "Set your API key in Options first." };
    const res = await fetch(
      cfg.base + "/projects/" + encodeURIComponent(projectId) + ".json?include=trackers",
      { headers: { "X-Redmine-API-Key": cfg.apiKey } }
    );
    if (!res.ok) return { ok: false, error: "HTTP " + res.status };
    return { ok: true, trackers: (await res.json()).project.trackers || [] };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function getPriorities() {
  try {
    const cfg = await getConfig();
    if (!cfg) return { ok: false, error: "Set your API key in Options first." };
    const res = await fetch(cfg.base + "/enumerations/issue_priorities.json", {
      headers: { "X-Redmine-API-Key": cfg.apiKey },
    });
    if (!res.ok) return { ok: false, error: "HTTP " + res.status };
    return { ok: true, priorities: (await res.json()).issue_priorities || [] };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Who can be assigned in this project (its members).
async function getMembers({ projectId }) {
  try {
    const cfg = await getConfig();
    if (!cfg) return { ok: false, error: "Set your API key in Options first." };
    const res = await fetch(
      cfg.base + "/projects/" + encodeURIComponent(projectId) + "/memberships.json?limit=100",
      { headers: { "X-Redmine-API-Key": cfg.apiKey } }
    );
    if (!res.ok) return { ok: false, error: "HTTP " + res.status };
    const memberships = (await res.json()).memberships || [];
    // Keep people (skip group memberships); hand back {id, name}.
    const users = memberships
      .filter((m) => m.user)
      .map((m) => ({ id: m.user.id, name: m.user.name }));
    return { ok: true, members: users };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Discover a project's custom fields by sampling its recent issues — which
// fields it uses and the values actually in use. Redmine restricts the clean
// /custom_fields.json endpoint to admins, so this is the non-admin way to build
// the dropdowns. Severity (id=3) is skipped — it has its own dedicated dropdown.
async function getCustomFields({ projectId }) {
  try {
    const cfg = await getConfig();
    if (!cfg) return { ok: false, error: "Set your API key in Options first." };
    const res = await fetch(
      cfg.base +
        "/issues.json?project_id=" +
        encodeURIComponent(projectId) +
        "&status_id=*&sort=updated_on:desc&limit=80",
      { headers: { "X-Redmine-API-Key": cfg.apiKey } }
    );
    if (!res.ok) return { ok: false, error: "HTTP " + res.status };

    const issues = (await res.json()).issues || [];
    const byId = {}; // id -> { id, name, multiple, values:Set }
    for (const issue of issues) {
      for (const cf of issue.custom_fields || []) {
        if (cf.id === 3) continue; // Severity has its own control
        if (!byId[cf.id]) {
          byId[cf.id] = { id: cf.id, name: cf.name, multiple: !!cf.multiple, values: new Set() };
        }
        const v = cf.value;
        if (Array.isArray(v)) v.forEach((x) => x && byId[cf.id].values.add(String(x)));
        else if (v) byId[cf.id].values.add(String(v));
      }
    }
    const fields = Object.values(byId)
      .map((f) => ({ id: f.id, name: f.name, multiple: f.multiple, values: [...f.values].sort() }))
      .filter((f) => f.values.length > 0);
    return { ok: true, fields: fields };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Full-text search for similar OPEN issues in the project, to warn about
// possible duplicates before filing.
async function getSimilar({ projectId, query }) {
  try {
    const cfg = await getConfig();
    if (!cfg) return { ok: false, error: "Set your API key in Options first." };
    const url =
      cfg.base +
      "/projects/" +
      encodeURIComponent(projectId) +
      "/search.json?q=" +
      encodeURIComponent(query) +
      "&issues=1&open_issues=1&limit=6";
    const res = await fetch(url, { headers: { "X-Redmine-API-Key": cfg.apiKey } });
    if (!res.ok) return { ok: false, error: "HTTP " + res.status };

    const results = (await res.json()).results || [];
    const mapped = results
      .map((r) => {
        const m = (r.url || "").match(/\/issues\/(\d+)/);
        return { id: m ? m[1] : "", title: (r.title || "").slice(0, 90), url: cfg.base + (r.url || "") };
      })
      .filter((r) => r.id);
    return { ok: true, results: mapped };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Upload one file to Redmine and return its token.
async function uploadFile(cfg, filename, bytes) {
  const res = await fetch(cfg.base + "/uploads.json?filename=" + encodeURIComponent(filename), {
    method: "POST",
    headers: { "X-Redmine-API-Key": cfg.apiKey, "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  if (!res.ok) throw new Error("Upload of " + filename + " failed (HTTP " + res.status + ")");
  return (await res.json()).upload.token;
}

async function fileBug({ dataUrl, projectId, subject, trackerId, priorityId, severity, assignedToId, contextText, notes, customFields, domHtml, consoleText, networkText }) {
  try {
    const cfg = await getConfig();
    if (!cfg) return { ok: false, error: "Set Redmine URL and API key in Options first." };

    // 1) upload every attachment, collecting a token for each
    const uploads = [];
    const shotBytes = await (await fetch(dataUrl)).arrayBuffer();
    uploads.push({
      token: await uploadFile(cfg, "screenshot.png", shotBytes),
      filename: "screenshot.png",
      content_type: "image/png",
    });
    // DOM snapshot only if the tester opted in. TextEncoder turns the HTML string
    // into the raw bytes the upload expects.
    if (domHtml) {
      const domBytes = new TextEncoder().encode(domHtml);
      uploads.push({
        token: await uploadFile(cfg, "dom.html", domBytes),
        filename: "dom.html",
        content_type: "text/html",
      });
    }

    // Console log (captured on every report).
    if (consoleText) {
      const logBytes = new TextEncoder().encode(consoleText);
      uploads.push({
        token: await uploadFile(cfg, "console.log", logBytes),
        filename: "console.log",
        content_type: "text/plain",
      });
    }

    // Network log (captured on every report).
    if (networkText) {
      const netBytes = new TextEncoder().encode(networkText);
      uploads.push({
        token: await uploadFile(cfg, "network.log", netBytes),
        filename: "network.log",
        content_type: "text/plain",
      });
    }

    // 2) build the issue from whatever the tester chose
    const description =
      (notes ? "h3. Description\n" + notes + "\n\n" : "") +
      (contextText ? contextText + "\n\n" : "") +
      "!screenshot.png!\n\n_Filed by Rapid Reporter._";

    // Severity (id=3) is always sent; the tester's other custom-field choices
    // (Defect Category, Service, Environment, …) come from the dynamic section.
    const cfs = [{ id: 3, value: severity || "Major" }];
    if (Array.isArray(customFields)) cfs.push(...customFields);

    const issue = {
      project_id: projectId,
      subject: subject,
      description: description,
      custom_fields: cfs,
      uploads: uploads,
    };
    if (trackerId) issue.tracker_id = Number(trackerId);
    if (priorityId) issue.priority_id = Number(priorityId);
    if (assignedToId) issue.assigned_to_id = Number(assignedToId);

    // 3) create it
    const issueRes = await fetch(cfg.base + "/issues.json", {
      method: "POST",
      headers: { "X-Redmine-API-Key": cfg.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ issue: issue }),
    });
    if (!issueRes.ok) {
      return { ok: false, error: "Create failed (HTTP " + issueRes.status + "): " + (await issueRes.text()) };
    }
    const id = (await issueRes.json()).issue.id;
    return { ok: true, id: id, url: cfg.base + "/issues/" + id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
