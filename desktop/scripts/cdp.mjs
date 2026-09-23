// Minimal CDP client for the octaview Studio Electron app — no dependencies,
// uses Node's built-in fetch + WebSocket (Node >= 21).
//
// Start the app with the debug port enabled (see OCTAVIEW_DEBUG_PORT in
// desktop/main.js), then attach:
//   OCTAVIEW_DEBUG_PORT=9222 <app>            # launch with the CDP port open
//
// Commands:
//   node cdp.mjs targets                  — the page target's title + url
//   node cdp.mjs gpu                       — GPU backend + per-feature accel status
//   node cdp.mjs eval '<js expression>'   — evaluate in the page, print result
//   node cdp.mjs poll [seconds] [ms]      — low-overhead: read globalThis.octaviewPerfLast
//                                           every [ms] (default 2000) for [seconds] (default 60).
//                                           Reads the [perf] snapshot without a console
//                                           subscription, so it does not perturb main-thread timings.
//   node cdp.mjs console [seconds] [rx]   — stream console messages matching optional regex.
//                                           Higher overhead (serializes every console call) —
//                                           prefer `poll` for perf measurement.
// Env: CDP_PORT (default 9222)

const port = process.env.CDP_PORT ?? "9222";
const [, , cmd, ...rest] = process.argv;

async function pageTarget() {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  if (!page) {
    console.error("No page target. Targets:", targets.map((t) => `${t.type} ${t.url}`));
    process.exit(1);
  }
  return page;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const msgId = ++id;
            pending.set(msgId, { res, rej });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          }),
        onEvent: (fn) => listeners.push(fn),
        close: () => ws.close(),
      });
    ws.onerror = (e) => reject(new Error(`ws error: ${e.message ?? e}`));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != undefined && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method != undefined) {
        for (const fn of listeners) fn(msg);
      }
    };
  });
}

if (cmd === "gpu") {
  // SystemInfo is a browser-level domain — connect to the browser endpoint.
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const b = await connect(ver.webSocketDebuggerUrl);
  const { gpu } = await b.send("SystemInfo.getInfo");
  const aux = gpu.auxAttributes ?? {};
  console.log("gl_renderer:", aux.glRenderer ?? aux.gl_renderer ?? "?");
  console.log("gl_vendor:", aux.glVendor ?? aux.gl_vendor ?? "?");
  console.log("passthrough:", aux.passthroughCmdDecoder ?? aux.passthrough_cmd_decoder);
  console.log("featureStatus:");
  for (const [k, v] of Object.entries(gpu.featureStatus ?? {})) {
    console.log(`  ${k}: ${v}`);
  }
  b.close();
  process.exit(0);
}

const page = await pageTarget();

if (cmd === "targets") {
  console.log(page.title, "—", page.url);
  process.exit(0);
}

const cdp = await connect(page.webSocketDebuggerUrl);

if (cmd === "eval") {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression: rest.join(" "),
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    console.error("EXCEPTION:", exceptionDetails.exception?.description ?? exceptionDetails.text);
    process.exit(1);
  }
  console.log(JSON.stringify(result.value, undefined, 2));
  cdp.close();
} else if (cmd === "console") {
  const seconds = Number(rest[0] ?? 30);
  const pattern = rest[1] ? new RegExp(rest[1]) : undefined;
  await cdp.send("Runtime.enable");
  cdp.onEvent((msg) => {
    if (msg.method !== "Runtime.consoleAPICalled") return;
    const text = msg.params.args
      .map((a) => (a.value != undefined ? String(a.value) : a.description ?? a.type))
      .join(" ");
    if (!pattern || pattern.test(text)) console.log(`[${msg.params.type}] ${text}`);
  });
  setTimeout(() => {
    cdp.close();
    process.exit(0);
  }, seconds * 1000);
} else if (cmd === "poll") {
  // Low-overhead: read the stashed perf snapshot (globalThis.octaviewPerfLast) every
  // intervalMs via Runtime.evaluate. No console subscription, so it does not
  // serialize the app's console traffic on the main thread. Only main-thread
  // counters are captured (worker counters live in worker contexts).
  const seconds = Number(rest[0] ?? 60);
  const intervalMs = Number(rest[1] ?? 2000);
  const deadline = Date.now() + seconds * 1000;
  let last = "";
  while (Date.now() < deadline) {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: "JSON.stringify(globalThis.octaviewPerfLast ?? null)",
      returnByValue: true,
    });
    const val = result.value;
    if (val && val !== last) {
      last = val;
      console.log(new Date().toISOString().slice(11, 19), val);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  cdp.close();
} else {
  console.error("usage: node cdp.mjs eval|console|poll|gpu|targets ...");
  process.exit(1);
}
