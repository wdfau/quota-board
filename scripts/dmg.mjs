import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

if (process.platform !== "darwin") {
  throw new Error("DMG creation requires macOS");
}
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const source = join("release", process.arch === "arm64" ? "mac-arm64" : "mac");
await access(join(source, "Quota Board.app"));
const result = spawnSync("hdiutil", [
  "create", "-volname", "Quota Board", "-srcfolder", source,
  "-ov", "-format", "UDZO", join("release", `Quota Board-${version}-${process.arch}.dmg`)
], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status || 1);
