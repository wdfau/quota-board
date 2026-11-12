import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
for (const directory of ["core", "src", "scripts"]) {
  for (const file of readdirSync(directory).filter((file) =>
    /\.(m?js|cjs)$/.test(file),
  )) {
    const result = spawnSync(
      process.execPath,
      ["--check", directory + "/" + file],
      { stdio: "inherit" },
    );
    if (result.status !== 0) process.exit(1);
  }
}
