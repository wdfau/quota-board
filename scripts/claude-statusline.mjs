#!/usr/bin/env node
import { mkdir, writeFile, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { claudeSnapshot } from "../core/model.js";

// Each Claude profile must use its own output file. Only quota numbers are written.
const output = process.argv[2];
let input = "";
try {
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1024 * 1024) throw new Error("Status input too large");
  }
  if (!output) throw new Error("Specify an output file");
  const snapshot = claudeSnapshot(JSON.parse(input));
  const path = resolve(output);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
  await rename(temporary, path);
  process.stdout.write(
    snapshot.windows
      .map((window) => `${window.label} 剩余 ${Math.round(window.remaining)}%`)
      .join(" · "),
  );
} catch {
  process.stdout.write("Quota Board · 等待额度数据");
}
