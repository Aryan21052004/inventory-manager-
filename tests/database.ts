import { prisma } from "@/lib/prisma";

import { fakeClerkUser, signInAs } from "./clerk-mock";

/**
 * Empties every table, children first — the foreign keys are Restrict, and a
 * wrong order fails loudly rather than silently orphaning rows.
 */
export async function resetDatabase(): Promise<void> {
  await prisma.certificate.deleteMany();
  await prisma.stockTransaction.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.purchaseItem.deleteMany();
  await prisma.purchase.deleteMany();
  await prisma.product.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.user.deleteMany();
}

/** A product with a known opening balance to move stock against. */
export async function createProduct(stockQuantity = 100) {
  return prisma.product.create({
    data: {
      sku: `TEST-${Math.random().toString(36).slice(2, 10)}`,
      name: "Test Widget",
      category: "Testing",
      costPrice: "5.00",
      sellingPrice: "12.50",
      stockQuantity,
      minimumStock: 10,
    },
  });
}

/**
 * A product written straight to the table, bypassing the stock engine.
 *
 * Only for fixtures. The tests that care about *how* stock gets written call
 * the real functions; the ones that only need a row in a particular state —
 * a catalogue to search, a quantity sitting at its minimum — set it up here so
 * the arrangement does not depend on the code under test.
 */
export async function seedProduct(overrides: {
  sku: string;
  name?: string;
  category?: string;
  costPrice?: string;
  sellingPrice?: string;
  stockQuantity?: number;
  minimumStock?: number;
  status?: "ACTIVE" | "INACTIVE" | "DISCONTINUED";
  supplierId?: string | null;
}) {
  return prisma.product.create({
    data: {
      name: overrides.name ?? `Product ${overrides.sku}`,
      sku: overrides.sku,
      category: overrides.category ?? "General",
      costPrice: overrides.costPrice ?? "5.00",
      sellingPrice: overrides.sellingPrice ?? "12.50",
      stockQuantity: overrides.stockQuantity ?? 100,
      minimumStock: overrides.minimumStock ?? 10,
      status: overrides.status ?? "ACTIVE",
      supplierId: overrides.supplierId ?? null,
    },
  });
}

export async function createSupplier(name = "Acme Supply Co") {
  return prisma.supplier.create({
    data: { name, email: `${Math.random().toString(36).slice(2, 10)}@example.com` },
  });
}

/**
 * Signs in as a Clerk user backed by a local record with the given role.
 *
 * The two halves matter: the Clerk session supplies the identity, and the local
 * row supplies the role and the id that foreign keys point at. Tests that skip
 * the local row are testing something else — that the first request from a new
 * Clerk account creates one.
 */
export async function signInWithRole(role: "ADMIN" | "STAFF") {
  const local = await prisma.user.create({
    data: {
      clerkId: `user_${role.toLowerCase()}_${Math.random().toString(36).slice(2, 8)}`,
      name: `${role} Person`,
      email: `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
      role,
    },
  });

  signInAs(fakeClerkUser(local.clerkId, local.email));
  return local;
}
