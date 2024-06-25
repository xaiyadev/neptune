const electron = require("electron");
const path = require("path");
const Module = require("module");
const fs = require("fs");
const https = require("https");

const logger = new Proxy(console, {
  get: (target, key) =>
    function (...args) {
      return target[key].apply(console, ["[neptune]", ...args]);
    },
});

logger.log("Loading...");

// #region Bundle
const remoteUrl =
  process.env.NEPTUNE_BUNDLE_URL ||
  "https://raw.githubusercontent.com/uwu/neptune-builds/master/neptune.js";
const localBundle = process.env.NEPTUNE_DIST_PATH;

let fetchPromise; // only fetch once

if (!localBundle)
  fetchPromise = new Promise((resolve, reject) => {
    const req = https.get(remoteUrl);

    req.on("response", (res) => {
      const chunks = [];

      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let data = Buffer.concat(chunks).toString("utf-8");

        if (!data.includes("//# sourceMappingURL="))
          data += `\n//# sourceMappingURL=${remoteUrl + ".map"}`;

        resolve(data);
      });
    });

    req.on("error", reject);

    req.end();
  });

const getNeptuneBundle = () =>
  !localBundle
    ? fetchPromise
    : Promise.resolve(
        fs.readFileSync(path.join(localBundle, "neptune.js"), "utf8") +
          `\n//# sourceMappingURL=file:////${path.join(
            localBundle,
            "neptune.js.map"
          )}`
      );
// #endregion

// #region IPC
electron.ipcMain.on("NEPTUNE_ORIGINAL_PRELOAD", (event) => {
  event.returnValue = event.sender.originalPreload;
});

electron.ipcMain.handle("NEPTUNE_BUNDLE_FETCH", getNeptuneBundle);
// #endregion

// #region Redux Devtools
electron.app.whenReady().then(() => {
  electron.session.defaultSession.loadExtension(
    path.join(process.resourcesPath, "app", "redux-devtools")
  );
});
// #endregion

// #region CSP removal
async function attachDebugger(dbg, domain = "desktop.tidal.com") {
  dbg.attach();
  dbg.on("message", async (_, method, params, sessionId) => {
    if (sessionId === "") sessionId = undefined;
    if (method === "Fetch.requestPaused") {
      console.log(params.request.url);
      const res = await dbg.sendCommand(
        "Fetch.getResponseBody",
        {
          requestId: params.requestId,
        },
        sessionId
      );

      let body = res.base64Encoded ? atob(res.body) : res.body;
      body = body.replace(
        /<meta http-equiv="Content-Security-Policy" content=".*?">/,
        "<!-- neptune removed csp -->"
      );

      // Add header to identify patched request in cache
      params.responseHeaders.push({
        name: "x-neptune",
        value: "patched",
      });

      dbg.sendCommand(
        "Fetch.fulfillRequest",
        {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: params.responseHeaders,
          body: btoa(body),
        },
        sessionId
      );
    } else if (method === "Target.attachedToTarget") {
      const { sessionId } = params;

      dbg.sendCommand(
        "Fetch.enable",
        {
          patterns: [
            {
              urlPattern: `https://${domain}/`,
              requestStage: "Response",
            },
            {
              urlPattern: `https://${domain}/index.html`, // Workbox rewrites the URL to include index.html during initial cache build
              requestStage: "Response",
            },
          ],
        },
        sessionId
      );
    }
  });

  dbg.sendCommand("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: "service_worker" }],
  });

  // Enable interception on page itself if service worker hasn't been registered yet.
  dbg.sendCommand("Fetch.enable", {
    patterns: [
      {
        urlPattern: `https://${domain}/`,
        requestStage: "Response",
      },
    ],
  });

  // Delete unpatched index cache entry if it exists
  const { caches } = await dbg.sendCommand("CacheStorage.requestCacheNames", {
    securityOrigin: `https://${domain}`,
  });
  if (caches.length !== 1) return;
  const { cacheId } = caches[0];

  const { cacheDataEntries, returnCount } = await dbg.sendCommand(
    "CacheStorage.requestEntries",
    {
      cacheId,
      pathFilter: "/index.html",
    }
  );
  if (returnCount !== 1) return;
  const entry = cacheDataEntries[0];

  if (!entry.responseHeaders.some((h) => h.name === "x-neptune")) {
    await dbg.sendCommand("CacheStorage.deleteEntry", {
      cacheId,
      request: entry.requestURL,
    });
    // TODO: Make the service worker rebuild the cache entry, otherwise offline mode will not work
  }
}
// #endregion

// #region IPC Bullshit
let evalHandleCount = 0;
let evalHandles = {};
electron.ipcMain.on("NEPTUNE_CREATE_EVAL_SCOPE", (ev, code) => {
  const scopeEval = eval(`(function () {
    try {
      ${code}

      return (code) => eval(code)
    } catch {}

    return eval;
  })()`);

  const id = evalHandleCount++;
  evalHandles[id] = scopeEval;

  ev.returnValue = id;
});

electron.ipcMain.on("NEPTUNE_RUN_IN_EVAL_SCOPE", (ev, scopeId, code) => {
  try {
    const retVal = evalHandles[scopeId](code);

    if (retVal?.then && retVal?.catch) {
      const promiseId = "NEPTUNE_PROMISE_" + Math.random().toString().slice(2);
      ev.returnValue = { type: "promise", value: promiseId };

      try {
        const getAllWindows = () => electron.BrowserWindow.getAllWindows();

        retVal.then((v) =>
          getAllWindows().forEach((w) =>
            w.webContents.send(promiseId, { type: "resolve", value: v })
          )
        );

        retVal.catch((v) =>
          getAllWindows().forEach((w) =>
            w.webContents.send(promiseId, { type: "reject", value: v })
          )
        );
      } catch {}
    }

    ev.returnValue = { type: "success", value: retVal };
  } catch (err) {
    ev.returnValue = { type: "error", value: err };
  }
});

electron.ipcMain.on("NEPTUNE_DELETE_EVAL_SCOPE", (ev, arg) => {
  delete evalHandles[arg];
  ev.returnValue = true;
});
// #endregion

// #region BrowserWindow
const ProxiedBrowserWindow = new Proxy(electron.BrowserWindow, {
  construct(target, args) {
    const options = args[0];
    let originalPreload;

    // tidal-hifi does not set the title, rely on dev tools instead.
    const isTidalWindow =
      options.title == "TIDAL" || options.webPreferences?.devTools;

    if (isTidalWindow) {
      originalPreload = options.webPreferences?.preload;
      // We replace the preload instead of using setPreloads because of some
      // differences in internal behaviour.
      options.webPreferences.preload = path.join(__dirname, "preload.js");

      // Shhh. I can feel your judgement from here. It's okay. Let it out. Everything will be alright in the end.
      // options.webPreferences.contextIsolation = false;
      // options.webPreferences.nodeIntegration = true;
      options.webPreferences.sandbox = false;

      // Allows local plugin loading
      options.webPreferences.allowDisplayingInsecureContent = true;
      options.webPreferences.allowRunningInsecureContent = true;
    }

    const window = new target(options);
    if (!isTidalWindow) return window;

    window.webContents.originalPreload = originalPreload;

    window.webContents.on("did-navigate", () => {
      // Clean up eval handles
      evalHandles = {}
    })

    attachDebugger(
      window.webContents.debugger,
      options.webPreferences?.devTools
        ? "listen.tidal.com"
        : "desktop.tidal.com" // tidal-hifi uses listen.tidal.com
    );
    return window;
  },
});

const electronPath = require.resolve("electron");
delete require.cache[electronPath].exports;
require.cache[electronPath].exports = {
  ...electron,
  BrowserWindow: ProxiedBrowserWindow,
};
// #endregion

// #region Restore DevTools
const originalBuildFromTemplate = electron.Menu.buildFromTemplate;
electron.Menu.buildFromTemplate = (template) => {
  template.push({
    role: "toggleDevTools",
    visible: false,
  });

  return originalBuildFromTemplate(template);
};
// #endregion

// #region Start original
logger.log("Starting original...");

let originalPath = path.join(process.resourcesPath, "app.asar");
if (!fs.existsSync(originalPath))
  originalPath = path.join(process.resourcesPath, "original.asar");

const originalPackage = require(path.resolve(
  path.join(originalPath, "package.json")
));
const startPath = path.join(originalPath, originalPackage.main);

require.main.filename = startPath;
electron.app.setAppPath?.(originalPath);
electron.app.name = originalPackage.name;

Module._load(startPath, null, true);
// #endregion
