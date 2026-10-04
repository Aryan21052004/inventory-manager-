import { toSafeError } from "@/lib/errors";
import { getCertificateFile } from "@/server/certificates";

/**
 * The only way a certificate file reaches a browser.
 *
 * There is no public URL for these documents and there is not meant to be. The
 * bytes live under a storage key that never leaves the server; this route is
 * the single door, and `getCertificateFile` checks the authenticated session before it
 * opens. A signed-out request gets 401 without the storage layer being touched
 * and without learning whether the id exists.
 *
 * The headers matter as much as the check:
 *
 *   `Content-Type` is the type determined by reading the file's leading bytes
 *   on upload — never the browser's claim at upload time, and never guessed
 *   from the filename here.
 *
 *   `X-Content-Type-Options: nosniff` stops a browser second-guessing that and
 *   deciding a file is HTML. Together with the sniffing on the way in, it means
 *   a file cannot be served as something it is not.
 *
 *   `Content-Disposition` defaults to `inline`, so View opens a PDF in the
 *   viewer. `?download=1` switches it to `attachment` for the Download action.
 *
 *   `Cache-Control: private, no-store` keeps a business document out of shared
 *   caches, and out of the disk cache of a machine somebody walks away from.
 */

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const file = await getCertificateFile(id);

    const download = new URL(request.url).searchParams.get("download") === "1";
    const disposition = download ? "attachment" : "inline";

    return new Response(new Uint8Array(file.body), {
      status: 200,
      headers: {
        "Content-Type": file.contentType,
        "Content-Length": String(file.body.byteLength),
        "Content-Disposition": `${disposition}; filename="${file.fileName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store, max-age=0",
        // Belt and braces: even if a document could be coerced into rendering
        // as markup, it renders with nothing available to it.
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    // `toSafeError` passes our own messages through and replaces anything else
    // with a generic line, so a storage or database error cannot describe the
    // server's internals to whoever asked.
    const safe = toSafeError(error, "GET /api/certificates/[id]/file");

    return Response.json(
      { error: safe.message, code: safe.code },
      {
        status:
          safe.code === "UNAUTHORIZED"
            ? 401
            : safe.code === "FORBIDDEN"
              ? 403
              : safe.code === "NOT_FOUND"
                ? 404
                : 500,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
}
