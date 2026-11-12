import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const files = (await readdir("release"))
  .filter(file => /\.(dmg|zip|exe)$/.test(file))
  .sort();
if (!files.length) throw new Error("Build an installer before generating checksums");
const lines = [];
for (const file of files) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join("release", file))) hash.update(chunk);
  lines.push(hash.digest("hex") + "  " + file);
}
await writeFile("release/SHA256SUMS.txt", lines.join("\n") + "\n");
console.log(`Checksums generated for ${files.length} artifacts.`);
