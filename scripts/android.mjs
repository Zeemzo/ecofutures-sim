// Builds the Android app: the page (vite build) into the APK's assets, anvil for phones (arm64) and the emulator
// (x86_64) as its native library, then Gradle. Writes release/EcoFutures Simulator-<version>-android.apk.
// Needs the Android SDK (ANDROID_HOME, else ~/Library/Android/sdk) and a JDK 17 (JAVA_HOME, else the system's).
import { execSync } from "node:child_process";
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const android = join(root, "android");
const main = join(android, "app", "src", "main");
const run = (cmd, cwd = root, env = {}) => execSync(cmd, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), "Library", "Android", "sdk");
if (!existsSync(sdk)) throw new Error(`No Android SDK at ${sdk}: set ANDROID_HOME.`);
writeFileSync(join(android, "local.properties"), `sdk.dir=${sdk}\n`);

run("npm run abis");
run("npx vite build");
rmSync(join(main, "assets", "www"), { recursive: true, force: true });
mkdirSync(join(main, "assets"), { recursive: true });
cpSync(join(root, "dist"), join(main, "assets", "www"), { recursive: true });

run("node scripts/fetch-anvil.mjs android-arm64 android-x64");
// the launcher that starts anvil with a clean signal state (android/launcher/launch.c), built with the NDK
const ndks = join(sdk, "ndk");
const ndk = existsSync(ndks) ? readdirSync(ndks).sort().pop() : null;
if (!ndk) throw new Error(`No NDK in ${ndks}: install one with the SDK manager.`);
const clang = (triple) => join(ndks, ndk, "toolchains", "llvm", "prebuilt", `${process.platform === "darwin" ? "darwin" : "linux"}-x86_64`, "bin", `${triple}26-clang`);
for (const [abi, dir, triple] of [["arm64-v8a", "android-arm64", "aarch64-linux-android"], ["x86_64", "android-x64", "x86_64-linux-android"]]) {
  mkdirSync(join(main, "jniLibs", abi), { recursive: true });
  copyFileSync(join(root, "resources", "bin", dir, "anvil"), join(main, "jniLibs", abi, "libanvil.so"));
  run(`"${clang(triple)}" -O2 -pie -o "${join(main, "jniLibs", abi, "liblaunch.so")}" android/launcher/launch.c`);
}

run("./gradlew --no-daemon -q assembleRelease", android);
mkdirSync(join(root, "release"), { recursive: true });
const apk = join(root, "release", `EcoFutures Simulator-${version}-android.apk`);
copyFileSync(join(android, "app", "build", "outputs", "apk", "release", "app-release.apk"), apk);
console.log(`android: ${apk}`);
