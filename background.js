// background.js — the background brain. Message types it answers:
//   GET_TRACKERS   -> trackers a project allows (fills the Bug type dropdown)
//   GET_PRIORITIES -> priority levels (fills the Priority dropdown)
//   FILE_BUG       -> upload the screenshot and create the bug

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

async function fileBug({ dataUrl, projectId, subject, trackerId, priorityId, severity, assignedToId, contextText, domHtml, consoleText, networkText }) {
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
      (contextText ? contextText + "\n\n" : "") +
      "!screenshot.png!\n\n_Filed by Rapid Reporter._";

    const issue = {
      project_id: projectId,
      subject: subject,
      description: description,
      custom_fields: [{ id: 3, value: severity || "Major" }], // Severity (id=3)
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
