import { prisma } from "@/lib/prisma";

/**
 * Empties every table, children first — the foreign keys are Restrict, and a
 * wrong order fails loudly rather than silently orphaning rows.
 */
export async function resetDatabase(): Promise<void> {
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
