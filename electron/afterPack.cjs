// Ad-hoc signs the macOS app as a whole (the app, its frameworks and the bundled anvil) after packaging, so
// Apple silicon runs it. There is no Apple Developer ID: on first launch macOS asks to confirm opening it.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
};
