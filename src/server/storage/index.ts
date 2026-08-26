import "server-only";

import { randomUUID } from "node:crypto";

import { env } from "@/lib/env";
import { LocalFileStorage } from "@/server/storage/local";
import type { FileStorage } from "@/server/storage/types";

/**
 * The one place a storage provider is chosen.
 *
 * Everything above this line takes a `FileStorage` and never learns which one
 * it has. Moving certificates to S3, Supabase Storage or Cloudinary means
 * writing one more class that implements the interface and adding a case to the
 * switch below — no call site changes, because no call site knows there is a
 * choice.
 *
 * The driver is read from the environment rather than inferred from
 * `NODE_ENV`, so a staging deployment can point at real object storage without
 * pretending to be production, and a production instance cannot silently fall
 * back to the local disk because a variable was missing — an unknown driver
 * name throws at startup rather than writing customer documents somewhere
 * nobody intended.
 */

function createStorage(): FileStorage {
  switch (env.FILE_STORAGE_DRIVER) {
    case "local":
      return new LocalFileStorage(env.FILE_STORAGE_DIR);

    /*
     * The shape the next one takes:
     *
     *   case "s3":
     *     return new S3FileStorage({
     *       bucket: env.S3_BUCKET,
     *       region: env.S3_REGION,
     *     });
     *
     * Note that it would not return signed URLs. Certificates are served
     * through an authenticated route that reads the bytes and streams them,
     * precisely so that access is a decision this application makes on every
     * request rather than something a URL grants until it expires.
     */

    default: {
      // Exhaustiveness: adding a driver to the env enum without handling it
      // here becomes a compile error rather than a runtime surprise.
      const unreachable: never = env.FILE_STORAGE_DRIVER;
      throw new Error(`Unsupported FILE_STORAGE_DRIVER: ${unreachable}`);
    }
  }
}

/**
 * One instance per process, for the same reason the Prisma client is: a driver
 * may hold a connection pool or an SDK client, and building one per request
 * would leak them across hot reloads in development.
 */
const globalForStorage = globalThis as unknown as {
  fileStorage: FileStorage | undefined;
};

export const fileStorage: FileStorage =
  globalForStorage.fileStorage ?? createStorage();

if (env.NODE_ENV !== "production") {
  globalForStorage.fileStorage = fileStorage;
}

/**
 * A storage key for a newly uploaded certificate.
 *
 * The uploader's filename is not part of it, and that is deliberate three times
 * over: a filename can contain path separators, it can collide with another
 * upload, and it can carry information the person who uploaded it would not
 * expect to be reflected back in a URL. The original name is kept on the
 * certificate row for display; the key is a random id and the extension the
 * server determined by reading the file.
 *
 * `randomUUID` rather than a counter or a hash of the contents: the key must
 * not be guessable from anything an outsider could know, and two identical
 * files uploaded for two different products must not share a key.
 */
export function certificateStorageKey(extension: string): string {
  return `certificates/${randomUUID()}.${extension}`;
}

export type { FileStorage } from "@/server/storage/types";
