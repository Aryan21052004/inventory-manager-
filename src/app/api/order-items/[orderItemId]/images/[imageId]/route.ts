import { toSafeError } from "@/lib/errors";
import { getOrderItemImageFile } from "@/server/order-item-images";

/**
 * The only way an order-line photograph reaches a browser.
 *
 * There is no public URL for these images and there is not meant to be. The
 * bytes live in Postgres and never leave the server except through this route,
 * which checks the Clerk session before it reads a row. A signed-out request
 * gets 401 without the database being asked for the image, and without learning
 * whether the id exists.
 *
 * **The path is the access control.** Both ids are required, and
 * `getOrderItemImageFile` looks the image up by the pair — so an image id from
 * another line, or another order entirely, matches nothing. Guessing an id
 * returns the same 404 as an id that was never issued, which is what stops the
 * route confirming that somebody else's photograph exists.
 *
 * The headers matter as much as the check, and are the certificate route's:
 *
 *   `Content-Type` is the type determined by reading the file's leading bytes
 *   on upload — never the browser's claim, and never guessed from the filename.
 *
 *   `X-Content-Type-Options: nosniff` stops a browser second-guessing that and
 *   deciding a file is HTML. With the sniffing on the way in, a file cannot be
 *   served as something it is not.
 *
 *   `Content-Disposition: inline` so a photograph opens in a tab; `?download=1`
 *   switches it to `attachment` for a Save action.
 *
 *   `Cache-Control: private, no-store` keeps a customer's goods out of shared
 *   caches, and off the disk of a machine somebody walks away from.
 *
 *   A `Content-Security-Policy` of `default-src 'none'; sandbox`, so that even
 *   if some format could be coerced into rendering as markup, it renders with
 *   nothing available to it.
 */

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orderItemId: string; imageId: string }> },
) {
  const { orderItemId, imageId } = await params;

  try {
    const file = await getOrderItemImageFile(orderItemId, imageId);

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
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    /*
     * `toSafeError` passes our own messages through and replaces anything else
     * with a generic line, so a database error cannot describe the server's
     * internals — a connection string among them — to whoever asked.
     */
    const safe = toSafeError(
      error,
      "GET /api/order-items/[orderItemId]/images/[imageId]",
    );

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
