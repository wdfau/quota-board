import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, "board.json");
    this.state = { configured: false, accounts: [], hidden: [], active: {} };
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  change(edit) {
    const write = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = edit(draft);
      await mkdir(this.directory, { recursive: true });
      const temp = join(this.directory, `board.${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify(draft), { mode: 0o600 });
      await rename(temp, this.file);
      this.state = draft;
      return result;
    });
    this.queue = write.catch(() => {});
    return write;
  }

  publicState() {
    return { ...this.state, accounts: this.state.accounts.map(({ home, snapshotPath, ...account }) => account) };
  }
}
