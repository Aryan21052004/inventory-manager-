import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind classes so later ones win.
 *
 * `clsx` resolves conditionals; `twMerge` then drops earlier classes that
 * conflict with later ones, which is what lets a component accept a `className`
 * override without fighting its own defaults.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
