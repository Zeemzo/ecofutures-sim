// Downloads anvil (Foundry v1.5.1, the version the simulator is tested on) for each platform into
// resources/bin/<os>-<arch>/, which electron-builder ships inside the desktop app and android.mjs inside the APK.
import { execSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "v1.5.1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "bin");
const targets = [
  ["mac-arm64", `foundry_${VERSION}_darwin_arm64.tar.gz`, "anvil"],
  ["mac-x64", `foundry_${VERSION}_darwin_amd64.tar.gz`, "anvil"],
  ["win-x64", `foundry_${VERSION}_win32_amd64.zip`, "anvil.exe"],
  ["linux-x64", `foundry_${VERSION}_linux_amd64.tar.gz`, "anvil"],
  ["linux-arm64", `foundry_${VERSION}_linux_arm64.tar.gz`, "anvil"],
  // Android: the Alpine builds, linked statically, so they run without the glibc Android does not have
  ["android-arm64", `foundry_${VERSION}_alpine_arm64.tar.gz`, "anvil"],
  ["android-x64", `foundry_${VERSION}_alpine_amd64.tar.gz`, "anvil"],
];
const only = process.argv.slice(2);
for (const [dir, asset, bin] of targets) {
  if (only.length && !only.includes(dir)) continue;
  const out = join(root, dir);
  if (existsSync(join(out, bin))) { console.log(`${dir}: present`); continue; }
  mkdirSync(out, { recursive: true });
  const tmp = join(out, asset);
  console.log(`${dir}: downloading ${asset}`);
  execSync(`curl -sSL -o "${tmp}" https://github.com/foundry-rs/foundry/releases/download/${VERSION}/${asset}`, { stdio: "inherit" });
  if (asset.endsWith(".zip")) execSync(`unzip -o -j "${tmp}" ${bin} -d "${out}"`, { stdio: "inherit" });
  else execSync(`tar -xzf "${tmp}" -C "${out}" ${bin}`, { stdio: "inherit" });
  rmSync(tmp);
  if (!asset.endsWith(".zip")) execSync(`chmod +x "${join(out, bin)}"`);
  console.log(`${dir}: ${bin} ready`);
}
