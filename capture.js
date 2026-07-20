// capture.js — runs INSIDE the page, in its MAIN world, from document_start.
//
// It wraps the page's console methods and error events so that everything logged
// is kept in a small rolling buffer on window.__rapidReporter. Because it starts
// at page load, an error that happened before the tester clicks "Report" is still
// in the buffer when we read it.

(function () {
  // Guard against installing twice (e.g. if injected again).
  if (window.__rapidReporter) return;

  var MAX = 100; // keep only the most recent 100 entries (a "ring buffer")
  var logs = [];

  function safeStringify(value) {
    try {
      // Error objects don't JSON-serialize (they'd become "{}"), yet the stack
      // trace is exactly what a developer needs — keep it verbatim.
      if (value instanceof Error) return value.stack || value.name + ": " + value.message;
      return typeof value === "string" ? value : JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }

  function push(level, args) {
    try {
      var parts = [];
      for (var i = 0; i < args.length; i++) parts.push(safeStringify(args[i]));
      logs.push({ level: level, text: parts.join(" "), time: new Date().toISOString() });
      if (logs.length > MAX) logs.shift(); // drop the oldest
    } catch (e) {}
  }

  // Wrap each console method: record it, then call the real one so the page's
  // own console still works normally.
  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      push(level, arguments);
      return original.apply(console, arguments);
    };
  });

  // Uncaught errors and unhandled promise rejections.
  window.addEventListener("error", function (e) {
    var where = e.filename ? " @ " + e.filename + ":" + e.lineno + ":" + (e.colno || 0) : "";
    var stack = e.error && e.error.stack ? "\n" + e.error.stack : "";
    push("error", [(e.message || "Error") + where + stack]);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    var detail = r && r.stack ? r.stack : safeStringify(r);
    push("error", ["Unhandled promise rejection: " + detail]);
  });

  // ---- Network buffer -----------------------------------------------------
  // We record only metadata (method, url, status, timing) — never response
  // bodies. For Mendix /xas/ calls we also pull the ACTION name (which
  // microflow ran), not the data it ran on.
  var net = [];
  var NETMAX = 50;
  function pushNet(entry) {
    net.push(entry);
    if (net.length > NETMAX) net.shift();
  }
  function nowMs() {
    return window.performance && performance.now ? performance.now() : Date.now();
  }
  // Turn a request body into the Mendix operation metadata a developer cares
  // about: the action (microflow/nanoflow name or operation type), the entity it
  // touched, and a short raw payload preview so the real operation is always
  // recoverable — even when a Mendix version uses a body shape we don't yet parse.
  function mendixBody(url, body) {
    // Both the classic XAS client (/xas/) and the newer runtime client
    // (/runtime/... , runtimeOperation envelope) are worth decoding.
    if (!url || (url.indexOf("/xas") === -1 && url.indexOf("/runtime") === -1)) return null;
    var s = typeof body === "string" ? body : "";
    if (!s && body) {
      try {
        s = JSON.stringify(body);
      } catch (e) {}
    }
    return s || "";
  }
  function mendixMeta(url, body) {
    var s = mendixBody(url, body);
    if (s == null) return { action: "", entity: "", raw: "" };
    if (!s) return { action: "", entity: "", raw: "" };
    // Microflow / nanoflow name. The classic client uses lowercase "actionname";
    // the newer runtime client uses camelCase / different keys — accept them all,
    // case-insensitively, wherever they sit in the (possibly nested) body.
    var name = s.match(
      /"(?:actionname|actionName|microflowName|nanoflowName|microflow|nanoflow)"\s*:\s*"([^"]+)"/i
    );
    var action = name ? name[1] : "";
    if (!action) {
      // Fall back to the operation/action type (retrieve_by_xpath, commit,
      // runtimeOperation, keepalive, …).
      var a = s.match(/"(?:action|operation|operationName|requestType|type)"\s*:\s*"([^"]+)"/i);
      action = a ? a[1] : "";
    }
    // Entity (Module.Entity) — from an xpath (//Module.Entity) or a typed field.
    var ent =
      s.match(/\/\/([A-Za-z_]\w*\.[A-Za-z_]\w*)/) ||
      s.match(/"(?:objectType|entity|entityName|entityType)"\s*:\s*"([A-Za-z_]\w*\.[A-Za-z_]\w*)"/i);
    // A short, structural preview of the payload for verification (redacted in
    // the popup before it's ever attached).
    return { action: action, entity: ent ? ent[1] : "", raw: s.slice(0, 240) };
  }

  // Wrap fetch.
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = (init && init.method) || (input && input.method) || "GET";
      var body = init && init.body;
      var t0 = nowMs();
      var meta = mendixMeta(url, body);
      return origFetch.apply(this, arguments).then(
        function (res) {
          pushNet({ method: method, url: url, status: res.status, ms: Math.round(nowMs() - t0), action: meta.action, entity: meta.entity, raw: meta.raw });
          return res;
        },
        function (err) {
          pushNet({ method: method, url: url, status: 0, ms: Math.round(nowMs() - t0), action: meta.action, entity: meta.entity, raw: meta.raw });
          throw err;
        }
      );
    };
  }

  // Wrap XMLHttpRequest (this is what Mendix uses for /xas/).
  var OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    var open = OrigXHR.prototype.open;
    var send = OrigXHR.prototype.send;
    OrigXHR.prototype.open = function (method, url) {
      this.__rr = { method: method, url: url };
      return open.apply(this, arguments);
    };
    OrigXHR.prototype.send = function (body) {
      var self = this;
      var info = self.__rr || {};
      var t0 = nowMs();
      var meta = mendixMeta(info.url || "", body);
      self.addEventListener("loadend", function () {
        pushNet({ method: info.method, url: info.url, status: self.status, ms: Math.round(nowMs() - t0), action: meta.action, entity: meta.entity, raw: meta.raw });
      });
      return send.apply(this, arguments);
    };
  }

  // ---- Action trail (auto "steps to reproduce") --------------------------
  // Records WHAT the tester did (clicked X, entered a field, navigated) — never
  // the values they typed. For Mendix widgets it captures the mx-name.
  var actions = [];
  var ACTMAX = 30;
  function pushAction(step) {
    if (!step) return;
    var last = actions[actions.length - 1];
    if (last && last.step === step) return; // drop consecutive duplicates
    actions.push({ step: step });
    if (actions.length > ACTMAX) actions.shift();
  }
  function mxNameOf(el) {
    var node = el;
    while (node && node.classList) {
      for (var i = 0; i < node.classList.length; i++) {
        if (node.classList[i].indexOf("mx-name-") === 0) return node.classList[i].slice(8);
      }
      node = node.parentElement;
    }
    return "";
  }
  function describe(el) {
    if (!el || el.nodeType !== 1) return "an element";
    var tag = (el.tagName || "").toLowerCase();
    var role = el.getAttribute && el.getAttribute("role");
    var isBtn =
      tag === "button" || role === "button" || (el.classList && el.classList.contains("mx-button"));
    var kind =
      isBtn ? "button"
        : tag === "a" ? "link"
        : tag === "input" || tag === "select" || tag === "textarea" ? "field"
        : tag === "label" ? "option"
        : "";
    var label =
      (el.getAttribute &&
        (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder"))) ||
      "";
    // For buttons/links the visible text is the clearest name; strip icon alt/whitespace.
    var text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    var name = label || text || mxNameOf(el);
    return (name ? "'" + name + "'" : "the element") + (kind ? " " + kind : "");
  }
  function fieldName(el) {
    var label = el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("placeholder"));
    if (!label && el.id) {
      var lab = document.querySelector('label[for="' + el.id + '"]');
      if (lab) label = lab.textContent.trim();
    }
    if (!label) label = el.name || mxNameOf(el) || "field";
    return "'" + String(label).replace(/\s+/g, " ").slice(0, 30) + "'";
  }

  document.addEventListener(
    "click",
    function (e) {
      var t = e.target;
      // Only log clicks that land on something actionable — a button, link,
      // menu item, or checkbox/radio label. Clicks on plain containers or text
      // are noise and make the steps harder to read.
      var clickable = t.closest
        ? t.closest("button, a, [role=button], [role=menuitem], .mx-button, [data-button-id], [onclick]")
        : null;
      if (!clickable) return;
      pushAction("Clicked " + describe(clickable));
    },
    true
  );
  document.addEventListener(
    "change",
    function (e) {
      var tag = (e.target.tagName || "").toLowerCase();
      if (tag === "select") pushAction("Changed " + fieldName(e.target));
      else if (tag === "input" || tag === "textarea") pushAction("Entered text in " + fieldName(e.target));
    },
    true
  );
  function recordNav() { pushAction("Navigated to " + location.pathname + location.hash); }
  var _pushState = history.pushState;
  history.pushState = function () {
    var r = _pushState.apply(this, arguments);
    recordNav();
    return r;
  };
  window.addEventListener("popstate", recordNav);
  window.addEventListener("hashchange", recordNav);

  // Expose all buffers so the popup can read them later.
  window.__rapidReporter = { logs: logs, network: net, actions: actions };
})();
