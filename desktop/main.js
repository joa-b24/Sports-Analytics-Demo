// Rendimiento as a desktop app: runs the Next server of web/ (copied by stage.mjs) with Electron's own Node and opens
// it in a window. Unlike the web version it can read and write the project folder (videos, tracking, segments.csv),
// the same as `npm run dev` on the laptop. The folder is asked for once and remembered.
const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

// A fixed port: the app's data lives in the browser storage of this origin, so it must not change between runs.
const PORT = 3939;
const HOST = "127.0.0.1";
let server = null;

const configPath = () => path.join(app.getPath("userData"), "config.json");
const readConfig = () => {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
};
const isProject = (dir) => !!dir && fs.existsSync(path.join(dir, "matches")) && fs.existsSync(path.join(dir, "config"));

async function projectRoot() {
  const saved = readConfig().root;
  if (isProject(saved)) return saved;
  for (;;) {
    const r = await dialog.showOpenDialog({
      title: "Elige la carpeta del proyecto (la que tiene matches/ y config/)",
      properties: ["openDirectory"],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    if (isProject(r.filePaths[0])) {
      fs.mkdirSync(app.getPath("userData"), { recursive: true });
      fs.writeFileSync(configPath(), JSON.stringify({ ...readConfig(), root: r.filePaths[0] }, null, 1));
      return r.filePaths[0];
    }
    await dialog.showMessageBox({ type: "warning", message: "Esa carpeta no tiene matches/ ni config/. Elige la carpeta demo del proyecto." });
  }
}

function startServer(root) {
  const dir = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(__dirname, "server");
  server = spawn(process.execPath, [path.join(dir, "server.js")], {
    cwd: dir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production", PORT: String(PORT), HOSTNAME: HOST, SPORTSAN_LOCAL: "1", SPORTSAN_ROOT: root },
    stdio: "ignore",
    windowsHide: true,
  });
}

const ready = () =>
  new Promise((resolve) => {
    const started = Date.now();
    const tryOnce = () => {
      const req = http.get({ host: HOST, port: PORT, path: "/" }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => (Date.now() - started > 30000 ? resolve(false) : setTimeout(tryOnce, 250)));
    };
    tryOnce();
  });

async function main() {
  const root = await projectRoot();
  if (!root) return app.quit();
  startServer(root);
  if (!(await ready())) {
    await dialog.showMessageBox({ type: "error", message: `No arrancó el servidor de la app en el puerto ${PORT}. ¿Hay otra copia abierta?` });
    return app.quit();
  }
  const win = new BrowserWindow({ width: 1440, height: 900, backgroundColor: "#0c0c0d", title: "Rendimiento", autoHideMenuBar: true });
  // Links out of the app (YouTube, Strava) open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://${HOST}:${PORT}`)) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  await win.loadURL(`http://${HOST}:${PORT}/`);
}

app.whenReady().then(main);
app.on("window-all-closed", () => app.quit());
app.on("quit", () => server?.kill());
