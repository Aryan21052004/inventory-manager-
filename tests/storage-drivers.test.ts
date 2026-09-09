import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalFileStorage } from "@/server/storage/local";
import {
  SupabaseFileStorage,
  type FetchLike,
} from "@/server/storage/supabase";
import { assertSafeKey, type FileStorage } from "@/server/storage/types";

/**
 * The two file-storage drivers, against the same contract.
 *
 * `FileStorage` is four operations keyed by an opaque string, and the point of
 * keeping it that small is that a caller cannot tell which implementation it
 * has. So most of what follows is written once and run twice — if the drivers
 * ever disagree about what "missing" means, or about whether deleting an absent
 * key is an error, the shared block is where it shows up rather than in
 * production after a switch of `FILE_STORAGE_DRIVER`.
 *
 * The Supabase driver runs against a fake `fetch`. That is not a compromise:
 * what is worth proving here is the driver's own decisions — which status codes
 * mean absence, that `put` upserts, that a key is validated before it becomes a
 * URL, that a service-role key never reaches an error message — and every one of
 * those is a property of this code rather than of Supabase. Reaching a real
 * project would test their service and need credentials this suite must not
 * have.
 */

const PDF = Buffer.from("%PDF-1.7\nnot really a pdf\n", "utf8");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const KEY = "certificates/11111111-2222-3333-4444-555555555555.pdf";
const OTHER_KEY = "certificates/99999999-8888-7777-6666-555555555555.pdf";

// ---------------------------------------------------------------------------
// A fake Supabase Storage
// ---------------------------------------------------------------------------

interface Request {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array | string;
}

/**
 * Enough of the Storage REST API to drive the contract.
 *
 * Objects live in a Map keyed by the object path, so isolation between keys is
 * a real property of the fake rather than something asserted about a stub. Every
 * request is recorded, which is how the header and upsert assertions are made.
 */
function fakeSupabase(options: { failWith?: number; body?: string } = {}) {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const requests: Request[] = [];

  const respond = (
    status: number,
    body: Buffer | string = "",
    contentType?: string,
  ) => ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer;
    },
    text: async () => (Buffer.isBuffer(body) ? body.toString("utf8") : body),
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? (contentType ?? null) : null,
    },
  });

  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    requests.push({ method, url, headers: init?.headers ?? {}, body: init?.body });

    if (options.failWith) {
      return respond(options.failWith, options.body ?? "storage exploded");
    }

    // DELETE is addressed at the bucket with a `prefixes` array.
    if (method === "DELETE") {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        prefixes?: string[];
      };

      let removed = false;
      for (const prefix of payload.prefixes ?? []) {
        if (objects.delete(encodePath(prefix))) removed = true;
      }

      return removed ? respond(200, "{}") : respond(404, "not_found");
    }

    const path = url.split("/storage/v1/object/")[1] ?? "";
    // Strip the bucket segment; what remains is the object path.
    const objectPath = path.slice(path.indexOf("/") + 1);

    if (method === "POST") {
      objects.set(objectPath, {
        body: Buffer.from(init?.body as Uint8Array),
        contentType: init?.headers?.["Content-Type"] ?? "application/octet-stream",
      });
      return respond(200, "{}");
    }

    const found = objects.get(objectPath);
    if (!found) return respond(404, "not_found");

    if (method === "HEAD") return respond(200, "", found.contentType);
    return respond(200, found.body, found.contentType);
  };

  return { fetchImpl, requests, objects };
}

function encodePath(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

const SUPABASE_CONFIG = {
  url: "https://project.supabase.co",
  serviceRoleKey: "service-role-key-that-must-never-be-logged",
  bucket: "certificates",
};

// ---------------------------------------------------------------------------
// The contract, run against both drivers
// ---------------------------------------------------------------------------

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "inventory-storage-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const drivers: {
  name: string;
  create: () => FileStorage;
}[] = [
  { name: "local", create: () => new LocalFileStorage(scratch) },
  {
    name: "supabase",
    create: () =>
      new SupabaseFileStorage(SUPABASE_CONFIG, fakeSupabase().fetchImpl),
  },
];

for (const driver of drivers) {
  describe(`${driver.name} driver — the FileStorage contract`, () => {
    it("round-trips the bytes exactly", async () => {
      const storage = driver.create();
      await storage.put({ key: KEY, body: PDF, contentType: "application/pdf" });

      const object = await storage.get(KEY);

      expect(object).not.toBeNull();
      expect(object!.body.equals(PDF)).toBe(true);
      expect(object!.size).toBe(PDF.byteLength);
    });

    it("returns null for a key that was never written", async () => {
      // Missing is not an error — `getCertificateFile` turns the null into a
      // message about a row whose bytes did not survive.
      expect(await driver.create().get(KEY)).toBeNull();
    });

    it("reports existence", async () => {
      const storage = driver.create();

      expect(await storage.exists(KEY)).toBe(false);
      await storage.put({ key: KEY, body: PDF, contentType: "application/pdf" });
      expect(await storage.exists(KEY)).toBe(true);
    });

    it("deletes, and deleting an absent key succeeds", async () => {
      const storage = driver.create();
      await storage.put({ key: KEY, body: PDF, contentType: "application/pdf" });

      await storage.delete(KEY);
      expect(await storage.exists(KEY)).toBe(false);

      // Callers use delete to clean up after a failure. A cleanup that throws
      // when there was nothing to clean turns one problem into two.
      await expect(storage.delete(KEY)).resolves.toBeUndefined();
    });

    it("keeps keys isolated from one another", async () => {
      const storage = driver.create();

      await storage.put({ key: KEY, body: PDF, contentType: "application/pdf" });
      await storage.put({ key: OTHER_KEY, body: PNG, contentType: "image/png" });

      expect((await storage.get(KEY))!.body.equals(PDF)).toBe(true);
      expect((await storage.get(OTHER_KEY))!.body.equals(PNG)).toBe(true);

      // Removing one must not reach the other.
      await storage.delete(KEY);
      expect(await storage.exists(KEY)).toBe(false);
      expect(await storage.exists(OTHER_KEY)).toBe(true);
    });

    it("replaces rather than failing when a key is written twice", async () => {
      const storage = driver.create();

      await storage.put({ key: KEY, body: PDF, contentType: "application/pdf" });
      await storage.put({ key: KEY, body: PNG, contentType: "image/png" });

      expect((await storage.get(KEY))!.body.equals(PNG)).toBe(true);
    });

    it("refuses a key that tries to escape", async () => {
      const storage = driver.create();

      /*
       * A key is a filesystem path in one driver and a URL path in the other,
       * and `..` means something in both. Every operation validates, not just
       * the write — a traversal on the way out reads somebody else's file just
       * as effectively.
       */
      const hostile = [
        "../secrets.env",
        "certificates/../../etc/passwd",
        "/etc/passwd",
        "certificates/..%2f..%2fsecret.pdf",
        "",
      ];

      for (const key of hostile) {
        await expect(
          storage.put({ key, body: PDF, contentType: "application/pdf" }),
          `put ${JSON.stringify(key)}`,
        ).rejects.toThrow();

        await expect(
          storage.get(key),
          `get ${JSON.stringify(key)}`,
        ).rejects.toThrow();

        await expect(
          storage.delete(key),
          `delete ${JSON.stringify(key)}`,
        ).rejects.toThrow();

        await expect(
          storage.exists(key),
          `exists ${JSON.stringify(key)}`,
        ).rejects.toThrow();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// What is specific to each
// ---------------------------------------------------------------------------

describe("local driver", () => {
  it("writes inside its root and nowhere else", async () => {
    const storage = new LocalFileStorage(scratch);
    await storage.put({ key: KEY, body: PDF, contentType: "application/pdf" });

    // The bytes are on disk, under the root, at the key's own path.
    const onDisk = await readFile(join(scratch, KEY));
    expect(onDisk.equals(PDF)).toBe(true);
  });

  it("still works unchanged — the development driver is not disturbed", async () => {
    /*
     * The production driver was added beside this one, not in place of it. A
     * developer with no Supabase project keeps a working application, and the
     * six certificate files already on disk are not touched by any of this.
     */
    const storage = new LocalFileStorage(scratch);
    expect(storage.name).toBe("local");

    await storage.put({ key: KEY, body: PDF, contentType: "application/pdf" });
    expect((await storage.get(KEY))!.body.equals(PDF)).toBe(true);
  });
});

describe("supabase driver", () => {
  it("authenticates every request with both headers", async () => {
    const fake = fakeSupabase();
    const storage = new SupabaseFileStorage(SUPABASE_CONFIG, fake.fetchImpl);

    await storage.put({ key: KEY, body: PDF, contentType: "application/pdf" });
    await storage.get(KEY);
    await storage.exists(KEY);
    await storage.delete(KEY);

    expect(fake.requests).toHaveLength(4);

    for (const request of fake.requests) {
      // The gateway routes on `apikey`; the storage service authorises on
      // `Authorization`. Sending one without the other works against some
      // deployments and not others.
      expect(request.headers["apikey"]).toBe(SUPABASE_CONFIG.serviceRoleKey);
      expect(request.headers["Authorization"]).toBe(
        `Bearer ${SUPABASE_CONFIG.serviceRoleKey}`,
      );
    }
  });

  it("upserts, so a repeated key is a replace rather than a 409", async () => {
    const fake = fakeSupabase();
    const storage = new SupabaseFileStorage(SUPABASE_CONFIG, fake.fetchImpl);

    await storage.put({ key: KEY, body: PDF, contentType: "application/pdf" });

    expect(fake.requests[0]!.method).toBe("POST");
    expect(fake.requests[0]!.headers["x-upsert"]).toBe("true");
    expect(fake.requests[0]!.headers["Content-Type"]).toBe("application/pdf");
  });

  it("addresses the object under the configured bucket", async () => {
    const fake = fakeSupabase();
    const storage = new SupabaseFileStorage(SUPABASE_CONFIG, fake.fetchImpl);

    await storage.get(KEY);

    expect(fake.requests[0]!.url).toBe(
      `https://project.supabase.co/storage/v1/object/certificates/${encodePath(KEY)}`,
    );
  });

  it("normalises a trailing slash on the project URL", async () => {
    const fake = fakeSupabase();
    const storage = new SupabaseFileStorage(
      { ...SUPABASE_CONFIG, url: "https://project.supabase.co/" },
      fake.fetchImpl,
    );

    await storage.get(KEY);

    // `//storage/v1/...` is normalised by some proxies and not others.
    expect(fake.requests[0]!.url).not.toContain(".co//storage");
  });

  it("treats a 400 not_found as absence rather than a fault", async () => {
    /*
     * Supabase answers a missing object on some routes with a 400 carrying
     * `{"error":"not_found"}`. Treating that as a fault would make an ordinary
     * absent file throw out of `get` instead of returning null, and the
     * certificate route would report a server error where it should report a
     * missing document.
     */
    const fake = fakeSupabase({ failWith: 400, body: '{"error":"not_found"}' });
    const storage = new SupabaseFileStorage(SUPABASE_CONFIG, fake.fetchImpl);

    expect(await storage.get(KEY)).toBeNull();
    expect(await storage.exists(KEY)).toBe(false);
    await expect(storage.delete(KEY)).resolves.toBeUndefined();
  });

  it("throws on a real failure rather than reporting absence", async () => {
    const fake = fakeSupabase({ failWith: 500, body: "internal error" });
    const storage = new SupabaseFileStorage(SUPABASE_CONFIG, fake.fetchImpl);

    // A 500 must not be swallowed into "no such file" — that would turn an
    // outage into a wave of certificates that appear to have been deleted.
    await expect(storage.get(KEY)).rejects.toThrow(/HTTP 500/);
    await expect(storage.exists(KEY)).rejects.toThrow(/HTTP 500/);
    await expect(storage.delete(KEY)).rejects.toThrow(/HTTP 500/);
    await expect(
      storage.put({ key: KEY, body: PDF, contentType: "application/pdf" }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("never puts the service-role key in an error message", async () => {
    const fake = fakeSupabase({ failWith: 500, body: "internal error" });
    const storage = new SupabaseFileStorage(SUPABASE_CONFIG, fake.fetchImpl);

    /*
     * These messages reach `console.error` by way of `toSafeError`. A driver
     * that interpolated its own headers into one would write the service-role
     * key into the application log, where it would outlive the request and be
     * shipped wherever logs go.
     */
    const failure = await storage.get(KEY).catch((error: Error) => error.message);

    expect(failure).toContain("HTTP 500");
    expect(failure).not.toContain(SUPABASE_CONFIG.serviceRoleKey);
  });

  it("validates the key before it reaches a URL or a delete payload", () => {
    // The same guard the local driver uses, so a traversal cannot become a
    // path segment on one driver and be refused on the other.
    expect(() => assertSafeKey("certificates/../../secret")).toThrow();
    expect(() => assertSafeKey(KEY)).not.toThrow();
  });

  it("hands out no URLs — the contract has none and this adds none", () => {
    const storage = new SupabaseFileStorage(SUPABASE_CONFIG, fakeSupabase().fetchImpl);

    /*
     * The security property the whole subsystem rests on. A driver that minted
     * public or signed URLs would make certificates reachable without a
     * session, which is exactly what the authenticated download route exists to
     * prevent — and it would do so without anything here failing.
     *
     * Asserted on the callable surface rather than on every own property: the
     * project URL is held privately to build request addresses, which is the
     * driver talking to Supabase, not the driver handing an address out.
     */
    const surface = storage as unknown as Record<string, unknown>;

    // Nothing that mints a shareable address. `objectUrl` is private and builds
    // a REST endpoint that is useless without the service-role key — it is the
    // driver talking to Supabase, not an address given to a browser.
    for (const minter of [
      "getPublicUrl",
      "publicUrl",
      "createSignedUrl",
      "signedUrl",
      "getUrl",
    ]) {
      expect(surface[minter], minter).toBeUndefined();
    }

    // And the contract is implemented in full, so nothing above it needs to
    // know which driver it has.
    for (const operation of ["put", "get", "delete", "exists"]) {
      expect(typeof surface[operation], operation).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// Choosing a driver
// ---------------------------------------------------------------------------

/**
 * Which driver runs is an environment decision, and a wrong one must fail loudly.
 *
 * The failure mode being guarded against is the quiet one: selecting `supabase`
 * with no credentials, importing cleanly, and falling over at the first upload
 * — in front of a user, after they had chosen a file. `src/lib/env.ts` refuses
 * at import instead, which is the only moment at which "this deployment is
 * misconfigured" is cheap to say.
 *
 * These reload the environment module rather than mocking it, because the
 * behaviour under test *is* the module's import-time validation.
 */
describe("driver selection", () => {
  /** Re-imports a module under a temporary environment. */
  async function withEnv<T>(
    overrides: Record<string, string | undefined>,
    load: () => Promise<T>,
  ): Promise<T> {
    const previous = new Map<string, string | undefined>();

    for (const [key, value] of Object.entries(overrides)) {
      previous.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    vi.resetModules();

    /*
     * `src/server/storage/index.ts` stashes its instance on `globalThis` so a
     * Next hot reload does not build a second one. `vi.resetModules()` does not
     * reach that, so without this the driver built by the previous case would
     * be handed back here and the assertion would pass or fail on stale state.
     */
    delete (globalThis as { fileStorage?: unknown }).fileStorage;

    try {
      return await load();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete (globalThis as { fileStorage?: unknown }).fileStorage;
      vi.resetModules();
    }
  }

  const SUPABASE_ENV = {
    FILE_STORAGE_DRIVER: "supabase",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    SUPABASE_STORAGE_BUCKET: undefined,
  };

  it("refuses the supabase driver with no credentials", async () => {
    await expect(
      withEnv(
        {
          FILE_STORAGE_DRIVER: "supabase",
          SUPABASE_URL: undefined,
          SUPABASE_SERVICE_ROLE_KEY: undefined,
        },
        () => import("@/lib/env"),
      ),
    ).rejects.toThrow(/SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("refuses the supabase driver with only half the credentials", async () => {
    await expect(
      withEnv(
        {
          FILE_STORAGE_DRIVER: "supabase",
          SUPABASE_URL: "https://project.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: undefined,
        },
        () => import("@/lib/env"),
      ),
    ).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("refuses a driver name nobody implemented", async () => {
    await expect(
      withEnv({ FILE_STORAGE_DRIVER: "s3" }, () => import("@/lib/env")),
    ).rejects.toThrow(/FILE_STORAGE_DRIVER/);
  });

  it("defaults the bucket without requiring it to be set", async () => {
    const { env } = await withEnv(SUPABASE_ENV, () => import("@/lib/env"));

    expect(env.FILE_STORAGE_DRIVER).toBe("supabase");
    expect(env.SUPABASE_STORAGE_BUCKET).toBe("certificates");
  });

  it("builds the supabase driver when the environment selects it", async () => {
    const { fileStorage } = await withEnv(
      SUPABASE_ENV,
      () => import("@/server/storage"),
    );

    // The whole point of the abstraction: one environment variable decides,
    // and nothing above the storage layer changes.
    expect(fileStorage.name).toBe("supabase");
  });

  it("builds the local driver by default, so development is undisturbed", async () => {
    const { fileStorage } = await withEnv(
      { FILE_STORAGE_DRIVER: undefined },
      () => import("@/server/storage"),
    );

    expect(fileStorage.name).toBe("local");
  });

  it("keeps the service-role key out of anything public", async () => {
    /*
     * A `NEXT_PUBLIC_` prefix would have Next inline the value into the browser
     * bundle. The key bypasses row-level security, so that is the one mistake
     * here that cannot be walked back — the credential would be in every
     * visitor's cache before anybody noticed.
     */
    const source = await readFile(
      new URL("../src/lib/env.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(source).not.toMatch(/NEXT_PUBLIC_SUPABASE/);

    // And it is read only through the server-only env module.
    expect(source).toContain('import "server-only"');
  });
});
