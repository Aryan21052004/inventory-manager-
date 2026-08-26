import "server-only";

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import {
  assertSafeKey,
  type FileStorage,
  type PutFileInput,
  type StoredObject,
} from "@/server/storage/types";

/**
 * Files on the local disk. The development and test implementation.
 *
 * The root directory is outside `public/`, and that is the whole point. Next
 * serves everything under `public/` statically, with no session in the way, so
 * a certificate written there would be downloadable by anyone who guessed —
 * or was told — its filename. Files here are only reachable through `get`,
 * which only the authenticated route handler calls.
 *
 * Swapping this for S3 or Supabase is a matter of writing another `FileStorage`
 * and changing one line in ./index.ts. Nothing above the storage layer knows
 * which implementation it is talking to, because nothing above it is handed
 * anything but a key and a Buffer.
 */

export class LocalFileStorage implements FileStorage {
  readonly name = "local";

  /** Absolute, resolved once, so every path check below compares like with like. */
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * Resolves a key to an absolute path, refusing anything that escapes the root.
   *
   * `assertSafeKey` already rejects `..` and absolute keys, so this is the
   * second of two checks rather than the only one. It is here because the
   * consequence of being wrong is reading or writing an arbitrary file on the
   * server, and because the two checks fail for different reasons: one on the
   * shape of the string, one on where it actually lands after resolution.
   */
  private pathFor(key: string): string {
    assertSafeKey(key);

    const path = resolve(join(this.root, key));

    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error(`Storage key escapes the root directory: ${key}`);
    }

    return path;
  }

  async put({ key, body }: PutFileInput): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<StoredObject | null> {
    const path = this.pathFor(key);

    try {
      const body = await readFile(path);
      return {
        body,
        // The content type is not derivable from the bytes on the way out, and
        // guessing from the extension is exactly the mistake this system avoids
        // elsewhere. It is stored on the certificate row and supplied by the
        // caller, which is where the sniffed value lives.
        contentType: "application/octet-stream",
        size: body.byteLength,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    // `force` makes deleting an absent key a no-op, which the contract requires:
    // callers use delete to clean up after a failure.
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await readFile(this.pathFor(key));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
