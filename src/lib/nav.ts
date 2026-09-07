import {
  ArrowLeftRight,
  BarChart3,
  LayoutDashboard,
  Package,
  PackageOpen,
  Settings,
  ShoppingCart,
  Truck,
  Users,
  Warehouse,
  type LucideIcon,
} from "lucide-react";

/**
 * The single definition of the app's navigation.
 *
 * The sidebar, the mobile drawer, and the header title all read from here, so a
 * new section is added in one place and cannot end up named one thing in the
 * sidebar and another in the header.
 */

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  /** Shown under the title in the mobile drawer and used as the page subtitle. */
  description: string;
}

export interface NavSection {
  /** Null for the first group, which reads better without a heading. */
  label: string | null;
  items: NavItem[];
}

export const navSections: NavSection[] = [
  {
    label: null,
    items: [
      {
        title: "Dashboard",
        href: "/dashboard",
        icon: LayoutDashboard,
        description: "Stock health and activity at a glance",
      },
    ],
  },
  {
    label: "Inventory",
    items: [
      {
        title: "Products",
        href: "/products",
        icon: Package,
        description: "Your catalogue and stock on hand",
      },
      {
        title: "Stock Movements",
        href: "/stock-movements",
        icon: ArrowLeftRight,
        description: "Every change to stock, and what caused it",
      },
    ],
  },
  {
    label: "Operations",
    items: [
      {
        title: "Orders",
        href: "/orders",
        icon: ShoppingCart,
        description: "Customer orders and fulfilment",
      },
      {
        title: "Purchases",
        href: "/purchases",
        icon: Warehouse,
        description: "Restocking and incoming goods",
      },
      {
        title: "Returned Stock",
        href: "/returns",
        icon: PackageOpen,
        description: "Customer returns awaiting inspection",
      },
    ],
  },
  {
    label: "Contacts",
    items: [
      {
        title: "Customers",
        href: "/customers",
        icon: Users,
        description: "Who you sell to",
      },
      {
        title: "Suppliers",
        href: "/suppliers",
        icon: Truck,
        description: "Who you buy from",
      },
    ],
  },
  {
    label: "Insights",
    items: [
      {
        title: "Reports",
        href: "/reports",
        icon: BarChart3,
        description: "Valuation, movement, and sales reporting",
      },
      {
        title: "Settings",
        href: "/settings",
        icon: Settings,
        description: "Workspace, users, and system configuration",
      },
    ],
  },
];

export const navItems: NavItem[] = navSections.flatMap(
  (section) => section.items,
);

/**
 * The nav entry a path belongs to. Matches on prefix so a detail route such as
 * `/products/abc123` still highlights Products in the sidebar.
 */
export function findNavItem(pathname: string): NavItem | undefined {
  return navItems.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
}
