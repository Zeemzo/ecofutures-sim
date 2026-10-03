// The desktop app: starts its own anvil chain on a free port, opens the simulator against it, and stops the
// chain when the app quits. Nothing else needs installing: anvil ships inside the app.
const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");

let anvil = null;

function anvilPath() {
  const exe = process.platform === "win32" ? "anvil.exe" : "anvil";
  if (app.isPackaged) return path.join(process.resourcesPath, "bin", exe);
  const os = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
  const local = path.join(__dirname, "..", "resources", "bin", `${os}-${process.arch}`, exe);
  return fs.existsSync(local) ? local : exe; // in development, fall back to anvil on the PATH
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitForChain(rpc, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("The local chain did not start.");
}

async function start() {
  const port = await freePort();
  const rpc = `http://127.0.0.1:${port}`;
  // 1 January 2027, a block gas limit large enough to deploy the contracts, recent states in memory only
  anvil = spawn(anvilPath(), ["--auto-impersonate", "--timestamp", "1798761600", "--port", String(port), "--gas-limit", "100000000", "--prune-history", "64", "--silent"], { stdio: "ignore" });
  anvil.on("error", (e) => dialog.showErrorBox("EcoFutures Simulator", `Could not start the local chain: ${e.message}`));
  await waitForChain(rpc);

  const win = new BrowserWindow({
    width: 1500, height: 960, minWidth: 400, minHeight: 560, title: "EcoFutures Simulator", backgroundColor: "#0e1512",
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  await win.loadFile(path.join(__dirname, "..", "dist", "index.html"), { query: { rpc } });
}

app.whenReady().then(() => start().catch((e) => { dialog.showErrorBox("EcoFutures Simulator", String(e.message ?? e)); app.quit(); }));
app.on("window-all-closed", () => app.quit());
app.on("quit", () => { if (anvil) anvil.kill(); });
process.on("exit", () => { if (anvil) anvil.kill(); }); // a crash or a forced exit stops the chain too
