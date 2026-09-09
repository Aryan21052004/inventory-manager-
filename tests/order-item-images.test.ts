import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { prisma } from "@/lib/prisma";
import {
  MAX_IMAGE_BYTES,
  sanitiseImageName,
} from "@/lib/validation/order-item-image";
import {
  attachOrderItemImages,
  getOrderItemImageFile,
  listOrderItemImages,
  removeOrderItemImage,
  sniffImageType,
} from "@/server/order-item-images";
import {
  cancelOrder,
  completeOrder,
  confirmOrder,
  createOrder,
  setOrderStatus,
} from "@/server/orders";

import { signOut } from "./clerk-mock";
import {
  expectFulfilmentReconciles,
  expectLotsReconcile,
  quoted,
  resetDatabase,
  seedCustomer,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * Photographs attached to an order line.
 *
 * Two things are being protected here, and neither is the happy path.
 *
 * The first is **isolation**. An image is addressed by a line *and* an id, and
 * most of what follows checks that the pair is genuinely the access control
 * rather than decoration: a picture on one line must be unreachable through
 * another line, through another order, and through a guessed id.
 *
 * The second is **that this feature does nothing to inventory**. Uploading and
 * deleting a photograph must leave quantities, fulfilment, returns, costing and
 * the stock ledger byte-identical, so several tests here assert what did *not*
 * change rather than what did.
 *
 * The status rule is the third strand. Images live only on CONFIRMED and
 * COMPLETED orders, because `updateOrder` replaces an editable order's lines
 * wholesale and the cascade would take the images with them.
 */

beforeEach(async () => {
  signOut();
  await resetDatabase();
});

// ---------------------------------------------------------------------------
// Fixtures: real files, built byte by byte
// ---------------------------------------------------------------------------

/** Padding so a fixture is a plausible size rather than a bare signature. */
function pad(header: readonly number[], total = 64): Buffer {
  const body = Buffer.alloc(total, 0x20);
  Buffer.from(header).copy(body, 0);
  return body;
}

const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF87 = pad([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]);
const GIF89 = pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

/** "RIFF" .... "WEBP" — the second window is what makes it a WebP, not a WAV. */
const WEBP = (() => {
  const body = Buffer.alloc(64, 0x20);
  Buffer.from([0x52, 0x49, 0x46, 0x46]).copy(body, 0);
  Buffer.from([0x57, 0x45, 0x42, 0x50]).copy(body, 8);
  return body;
})();

/** A RIFF container that is *not* a WebP — a WAV. Must be refused. */
const WAV = (() => {
  const body = Buffer.alloc(64, 0x20);
  Buffer.from([0x52, 0x49, 0x46, 0x46]).copy(body, 0);
  Buffer.from([0x57, 0x41, 0x56, 0x45]).copy(body, 8);
  return body;
})();

const PDF = pad([0x25, 0x50, 0x44, 0x46]);
const TEXT = Buffer.from("<html><script>alert(1)</script></html>", "utf8");

function file(name: string, body: Buffer, type = "image/png"): File {
  return new File([new Uint8Array(body)], name, { type });
}

/** An order confirmed against stock, so it lands in CONFIRMED with a real line. */
async function confirmedOrder(sku: string, quantity = 2) {
  const product = await seedProduct({
    sku,
    stockQuantity: 10,
    lotUnitCost: "10.00",
    sellingPrice: "50.00",
  });
  const customer = await seedCustomer({ name: `Buyer ${sku}` });

  const order = await createOrder({
    customerId: customer.id,
    items: await quoted([{ productId: product.id, quantity }]),
  });
  await confirmOrder(order.id);

  const line = await prisma.orderItem.findFirstOrThrow({
    where: { orderId: order.id },
  });

  return { product, order, line };
}

/** A draft order — lines exist, but `updateOrder` may replace them. */
async function draftOrder(sku: string) {
  const product = await seedProduct({ sku, stockQuantity: 10, sellingPrice: "50.00" });
  const customer = await seedCustomer({ name: `Draft ${sku}` });

  const order = await createOrder({
    customerId: customer.id,
    items: await quoted([{ productId: product.id, quantity: 1 }]),
  });

  const line = await prisma.orderItem.findFirstOrThrow({
    where: { orderId: order.id },
  });

  return { product, order, line };
}

async function imageCount() {
  return prisma.orderItemImage.count();
}

// ---------------------------------------------------------------------------
// The signature check, on its own
// ---------------------------------------------------------------------------

describe("what a file actually is", () => {
  it("recognises every accepted format", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(GIF87)).toBe("image/gif");
    expect(sniffImageType(GIF89)).toBe("image/gif");
  });

  it("refuses anything else, including a lookalike container", () => {
    // A WAV is RIFF too. Checking only the first four bytes would accept it.
    expect(sniffImageType(WAV)).toBeNull();
    expect(sniffImageType(PDF)).toBeNull();
    expect(sniffImageType(TEXT)).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
    // Shorter than the signature it would have to match.
    expect(sniffImageType(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

describe("filenames", () => {
  it("strips path separators and control characters", () => {
    expect(sanitiseImageName("../../etc/passwd")).toBe("passwd");
    expect(sanitiseImageName("C:\\Windows\\evil.png")).toBe("evil.png");
    expect(sanitiseImageName("head\r\nX-Injected: 1.png")).toBe("headX-Injected: 1.png");
    expect(sanitiseImageName("   ")).toBe("image");
    expect(sanitiseImageName("a".repeat(300)).length).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

describe("storing images", () => {
  it("starts with none, and a line with none is ordinary", async () => {
    await signInWithRole("STAFF");
    const { order, line } = await confirmedOrder("IMG-ZERO");

    expect(await imageCount()).toBe(0);
    expect((await listOrderItemImages(order.id)).get(line.id)).toBeUndefined();
  });

  it("keeps the bytes and the metadata exactly", async () => {
    await signInWithRole("STAFF");
    const { line } = await confirmedOrder("IMG-BYTES");

    await attachOrderItemImages(line.id, [file("bench.png", PNG)]);

    const stored = await prisma.orderItemImage.findFirstOrThrow({
      where: { orderItemId: line.id },
    });

    expect(Buffer.from(stored.data).equals(PNG)).toBe(true);
    expect(stored.fileName).toBe("bench.png");
    expect(stored.contentType).toBe("image/png");
    expect(stored.fileSize).toBe(PNG.byteLength);
    expect(stored.orderItemId).toBe(line.id);
  });

  it("adds without overwriting, in one batch or several", async () => {
    await signInWithRole("STAFF");
    const { line } = await confirmedOrder("IMG-MANY");

    await attachOrderItemImages(line.id, [
      file("one.png", PNG),
      file("two.jpg", JPEG),
    ]);
    await attachOrderItemImages(line.id, [file("three.gif", GIF89)]);

    const stored = await prisma.orderItemImage.findMany({
      where: { orderItemId: line.id },
      orderBy: { createdAt: "asc" },
    });

    expect(stored.map((image) => image.fileName)).toEqual([
      "one.png",
      "two.jpg",
      "three.gif",
    ]);
    expect(stored.map((image) => image.contentType)).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
    ]);
  });

  it("keeps two lines' images independent", async () => {
    await signInWithRole("STAFF");
    const productB = await seedProduct({
      sku: "IMG-B",
      stockQuantity: 10,
      lotUnitCost: "5.00",
      sellingPrice: "20.00",
    });
    const { order, line: lineA } = await confirmedOrder("IMG-A");

    // A second line on the *same* order, so this is not two orders in disguise.
    const lineB = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: productB.id,
        quantity: 1,
        unitPrice: "20.00",
        total: "20.00",
      },
    });

    await attachOrderItemImages(lineA.id, [file("a.png", PNG)]);
    await attachOrderItemImages(lineB.id, [
      file("b1.png", PNG),
      file("b2.jpg", JPEG),
    ]);

    const byLine = await listOrderItemImages(order.id);
    expect(byLine.get(lineA.id)).toHaveLength(1);
    expect(byLine.get(lineB.id)).toHaveLength(2);
    expect(byLine.get(lineA.id)![0]!.fileName).toBe("a.png");
  });

  it("removes one and leaves the rest alone", async () => {
    await signInWithRole("STAFF");
    const { line } = await confirmedOrder("IMG-RM");

    await attachOrderItemImages(line.id, [
      file("keep-1.png", PNG),
      file("drop.jpg", JPEG),
      file("keep-2.gif", GIF89),
    ]);

    const doomed = await prisma.orderItemImage.findFirstOrThrow({
      where: { orderItemId: line.id, fileName: "drop.jpg" },
    });

    await removeOrderItemImage(line.id, doomed.id);

    const left = await prisma.orderItemImage.findMany({
      where: { orderItemId: line.id },
      orderBy: { createdAt: "asc" },
    });

    expect(left.map((image) => image.fileName)).toEqual([
      "keep-1.png",
      "keep-2.gif",
    ]);
  });

  it("cascades when the line itself goes", async () => {
    await signInWithRole("STAFF");
    const { line } = await confirmedOrder("IMG-CASCADE");
    await attachOrderItemImages(line.id, [file("x.png", PNG)]);

    expect(await imageCount()).toBe(1);

    // Deleting a line is not something the application does — orders are
    // cancelled, not dismantled — but the FK has to behave if it ever happens.
    await prisma.orderItem.delete({ where: { id: line.id } });

    expect(await imageCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("upload validation", () => {
  it("accepts every supported format", async () => {
    await signInWithRole("STAFF");
    const { line } = await confirmedOrder("IMG-FORMATS");

    const outcome = await attachOrderItemImages(line.id, [
      file("a.jpeg", JPEG),
      file("b.jpg", JPEG),
      file("c.png", PNG),
      file("d.webp", WEBP),
      file("e.gif", GIF89),
    ]);

    expect(outcome.images).toHaveLength(5);
    expect(outcome.images.map((image) => image.contentType)).toEqual([
      "image/jpeg",
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
    ]);
  });

  it("refuses an unsupported type however it is labelled", async () => {
    await signInWithRole("STAFF");
    const { line } = await confirmedOrder("IMG-BAD");

    for (const bad of [
      file("doc.pdf", PDF, "application/pdf"),
      file("page.html", TEXT, "text/html"),
      file("sound.wav", WAV, "audio/wav"),
    ]) {
      await expect(
        attachOrderItemImages(line.id, [bad]),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }

    expect(await imageCount()).toBe(0);
  });

  it("cannot be fooled by the filename or the declared type", async () => {
    await signInWithRole("STAFF");
    const { line } = await confirmedOrder("IMG-DISGUISE");

    // An HTML document called .png, announcing itself as image/png. Both of
    // the client's claims say image; the bytes say otherwise, and the bytes win.
    await expect(
      attachOrderItemImages(line.id, [file("payload.png", TEXT, "image/png")]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // And the reverse: a real PNG with a misleading name is still a PNG.
    const outcome = await attachOrderItemImages(line.id, [
      file("not-really.txt", PNG, "text/plain"),
    ]);
    expect(outcome.images[0]!.contentType).toBe("image/png");
  });

  it("holds the 5 MB boundary", async () => {
    await signInWithRole("STAFF");
    const { line } = await confirmedOrder("IMG-SIZE");

    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);

    // Exactly at the limit is accepted.
    const atLimit = Buffer.alloc(MAX_IMAGE_BYTES, 0x20);
    PNG.copy(atLimit, 0, 0, 8);
    const ok = await attachOrderItemImages(line.id, [file("edge.png", atLimit)]);
    expect(ok.images[0]!.fileSize).toBe(MAX_IMAGE_BYTES);

    // One byte over is not.
    const overLimit = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0x20);
    PNG.copy(overLimit, 0, 0, 8);
    await expect(
      attachOrderItemImages(line.id, [file("over.png", overLimit)]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await imageCount()).toBe(1);
  });

  it("stores none of a batch when one file is bad", async () => {
    await signInWithRole("STAFF");
    const { line } = await confirmedOrder("IMG-ATOMIC");

    await expect(
      attachOrderItemImages(line.id, [
        file("good.png", PNG),
        file("bad.pdf", PDF),
      ]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // A partial upload would leave somebody working out which files landed.
    expect(await imageCount()).toBe(0);
  });

  it("refuses an empty or malformed upload", async () => {
    await signInWithRole("STAFF");
    const { line } = await confirmedOrder("IMG-EMPTY");

    await expect(attachOrderItemImages(line.id, [])).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      attachOrderItemImages(line.id, [file("empty.png", Buffer.alloc(0))]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      attachOrderItemImages(line.id, ["not a file"]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ---------------------------------------------------------------------------
// Order status
// ---------------------------------------------------------------------------

describe("the order-status rule", () => {
  it("allows a confirmed order", async () => {
    await signInWithRole("STAFF");
    const { line } = await confirmedOrder("ST-CONF");

    const outcome = await attachOrderItemImages(line.id, [file("a.png", PNG)]);
    expect(outcome.images).toHaveLength(1);
  });

  it("allows a completed order", async () => {
    await signInWithRole("STAFF");
    const { order, line } = await confirmedOrder("ST-COMP");
    await completeOrder(order.id);

    const outcome = await attachOrderItemImages(line.id, [file("a.png", PNG)]);
    expect(outcome.images).toHaveLength(1);
  });

  it("refuses a draft order", async () => {
    await signInWithRole("STAFF");
    const { line } = await draftOrder("ST-DRAFT");

    /*
     * The important one. `updateOrder` replaces a draft's lines wholesale, and
     * the images cascade — so allowing this would mean an edit silently
     * destroyed them.
     */
    await expect(
      attachOrderItemImages(line.id, [file("a.png", PNG)]),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await imageCount()).toBe(0);
  });

  it("refuses a pending order", async () => {
    await signInWithRole("STAFF");
    const { order, line } = await draftOrder("ST-PEND");
    await setOrderStatus(order.id, "PENDING");

    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.status).toBe("PENDING");

    await expect(
      attachOrderItemImages(line.id, [file("a.png", PNG)]),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await imageCount()).toBe(0);
  });

  it("refuses a cancelled order, for adding and for removing", async () => {
    await signInWithRole("STAFF");
    const { order, line } = await confirmedOrder("ST-CANC");

    // Attached while confirmed, so there is something to try to remove later.
    await attachOrderItemImages(line.id, [file("a.png", PNG)]);
    const image = await prisma.orderItemImage.findFirstOrThrow({
      where: { orderItemId: line.id },
    });

    await cancelOrder(order.id, "Customer changed their mind");

    await expect(
      attachOrderItemImages(line.id, [file("b.png", PNG)]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      removeOrderItemImage(line.id, image.id),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // The picture of what shipped survives the cancellation, and stays readable.
    expect(await imageCount()).toBe(1);
    const file2 = await getOrderItemImageFile(line.id, image.id);
    expect(file2.contentType).toBe("image/png");
  });

  it("becomes possible the moment the order is confirmed", async () => {
    await signInWithRole("STAFF");
    const { order, line } = await draftOrder("ST-THEN");

    await expect(
      attachOrderItemImages(line.id, [file("a.png", PNG)]),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await confirmOrder(order.id);

    // Confirmation does not replace lines, so the id is still good.
    const outcome = await attachOrderItemImages(line.id, [file("a.png", PNG)]);
    expect(outcome.images).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

describe("authorisation", () => {
  it("refuses a signed-out caller on every operation", async () => {
    await signInWithRole("STAFF");
    const { line } = await confirmedOrder("AUTH-OUT");
    await attachOrderItemImages(line.id, [file("a.png", PNG)]);
    const image = await prisma.orderItemImage.findFirstOrThrow({
      where: { orderItemId: line.id },
    });

    signOut();

    await expect(
      attachOrderItemImages(line.id, [file("b.png", PNG)]),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      getOrderItemImageFile(line.id, image.id),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      removeOrderItemImage(line.id, image.id),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(await imageCount()).toBe(1);
  });

  it("lets STAFF upload, view and delete", async () => {
    await signInWithRole("STAFF");
    const { line } = await confirmedOrder("AUTH-STAFF");

    const added = await attachOrderItemImages(line.id, [file("s.png", PNG)]);
    const view = await getOrderItemImageFile(line.id, added.images[0]!.id);
    expect(view.body.equals(PNG)).toBe(true);

    await removeOrderItemImage(line.id, added.images[0]!.id);
    expect(await imageCount()).toBe(0);
  });

  it("lets ADMIN upload, view and delete", async () => {
    await signInWithRole("ADMIN");
    const { line } = await confirmedOrder("AUTH-ADMIN");

    const added = await attachOrderItemImages(line.id, [file("a.png", PNG)]);
    const view = await getOrderItemImageFile(line.id, added.images[0]!.id);
    expect(view.body.equals(PNG)).toBe(true);

    await removeOrderItemImage(line.id, added.images[0]!.id);
    expect(await imageCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe("isolation", () => {
  /** Two confirmed orders, each with one line carrying one image. */
  async function twoOrders() {
    const a = await confirmedOrder("ISO-A");
    const b = await confirmedOrder("ISO-B");

    const imageA = (await attachOrderItemImages(a.line.id, [file("a.png", PNG)]))
      .images[0]!;
    const imageB = (await attachOrderItemImages(b.line.id, [file("b.jpg", JPEG)]))
      .images[0]!;

    return { a, b, imageA, imageB };
  }

  it("will not serve one line's image through another line", async () => {
    await signInWithRole("STAFF");
    const { a, b, imageB } = await twoOrders();

    // B's image, asked for through A's line. The pair matches nothing.
    await expect(
      getOrderItemImageFile(a.line.id, imageB.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // And it is genuinely reachable through its own line, so the refusal above
    // is about the pairing rather than the image being missing.
    expect((await getOrderItemImageFile(b.line.id, imageB.id)).contentType).toBe(
      "image/jpeg",
    );
  });

  it("will not delete one line's image through another line", async () => {
    await signInWithRole("STAFF");
    const { a, imageB } = await twoOrders();

    await expect(
      removeOrderItemImage(a.line.id, imageB.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Nothing was removed from either side.
    expect(await imageCount()).toBe(2);
  });

  it("keeps one order's gallery out of another's", async () => {
    await signInWithRole("STAFF");
    const { a, b, imageA, imageB } = await twoOrders();

    const galleryA = await listOrderItemImages(a.order.id);
    const galleryB = await listOrderItemImages(b.order.id);

    expect([...galleryA.values()].flat().map((image) => image.id)).toEqual([
      imageA.id,
    ]);
    expect([...galleryB.values()].flat().map((image) => image.id)).toEqual([
      imageB.id,
    ]);
  });

  it("does not touch another line when one image is deleted", async () => {
    await signInWithRole("STAFF");
    const { a, b, imageA, imageB } = await twoOrders();

    await removeOrderItemImage(a.line.id, imageA.id);

    expect(
      await prisma.orderItemImage.count({ where: { orderItemId: b.line.id } }),
    ).toBe(1);
    expect((await getOrderItemImageFile(b.line.id, imageB.id)).fileName).toBe(
      "b.jpg",
    );
  });

  it("fails safely on ids that were never issued", async () => {
    await signInWithRole("STAFF");
    const { line } = await confirmedOrder("ISO-MISSING");

    await expect(
      getOrderItemImageFile(line.id, "does-not-exist"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      removeOrderItemImage(line.id, "does-not-exist"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      getOrderItemImageFile("no-such-line", "no-such-image"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      attachOrderItemImages("no-such-line", [file("a.png", PNG)]),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      getOrderItemImageFile(line.id, ""),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// The line this feature must not cross
// ---------------------------------------------------------------------------

describe("images change nothing else", () => {
  it("moves no stock and alters no quantity", async () => {
    await signInWithRole("STAFF");
    const { product, order, line } = await confirmedOrder("NEU-1", 3);

    const before = {
      line: await prisma.orderItem.findUniqueOrThrow({ where: { id: line.id } }),
      order: await prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      product: await prisma.product.findUniqueOrThrow({ where: { id: product.id } }),
      movements: await prisma.stockTransaction.count(),
      lots: await prisma.stockLot.count(),
      consumptions: await prisma.stockLotConsumption.count(),
    };

    const added = await attachOrderItemImages(line.id, [
      file("a.png", PNG),
      file("b.jpg", JPEG),
    ]);
    await removeOrderItemImage(line.id, added.images[0]!.id);

    // Every column of the line, including the ones this feature has no business
    // near: quantity, fulfilment, returns and cost.
    expect(
      await prisma.orderItem.findUniqueOrThrow({ where: { id: line.id } }),
    ).toEqual(before.line);
    expect(
      await prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
    ).toEqual(before.order);
    expect(
      await prisma.product.findUniqueOrThrow({ where: { id: product.id } }),
    ).toEqual(before.product);

    // And nothing was written to the ledger or the valuation layer.
    expect(await prisma.stockTransaction.count()).toBe(before.movements);
    expect(await prisma.stockLot.count()).toBe(before.lots);
    expect(await prisma.stockLotConsumption.count()).toBe(before.consumptions);

    await expectLotsReconcile();
    await expectFulfilmentReconciles();
  });

  it("leaves an order cancellable, and the images with it", async () => {
    await signInWithRole("STAFF");
    const { order, line } = await confirmedOrder("NEU-2", 2);
    await attachOrderItemImages(line.id, [file("a.png", PNG)]);

    // Cancellation restores stock and must not be blocked by an attachment.
    const outcome = await cancelOrder(order.id, "Not needed");
    expect(outcome.status).toBe("CANCELLED");

    // The line survives a cancellation, so its photographs do too.
    expect(await imageCount()).toBe(1);

    await expectLotsReconcile();
    await expectFulfilmentReconciles();
  });
});
