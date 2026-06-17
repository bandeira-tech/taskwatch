import type { FsExecutor } from "@bandeira-tech/b3nd-save/fs";
import { ensureDir } from "@std/fs";
import { dirname } from "@std/path";

export function createDenoFsExecutor(): FsExecutor {
  return {
    async readFile(path) {
      const file = await Deno.open(path, { read: true });
      return file.readable;
    },
    async writeFile(path, content) {
      await ensureDir(dirname(path));
      if (content instanceof Uint8Array) {
        await Deno.writeFile(path, content);
        return;
      }
      const file = await Deno.open(path, {
        write: true,
        create: true,
        truncate: true,
      });
      await content.pipeTo(file.writable);
    },
    async removeFile(path) {
      await Deno.remove(path);
    },
    async exists(path) {
      try {
        await Deno.stat(path);
        return true;
      } catch {
        return false;
      }
    },
    async listFiles(dir) {
      const out: string[] = [];
      try {
        for await (const entry of Deno.readDir(dir)) {
          if (entry.isFile) out.push(entry.name);
        }
      } catch {
        return [];
      }
      return out;
    },
  };
}
