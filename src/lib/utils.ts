/** Joins class names, skipping empty ones. The shadcn-style helper, minus
 *  Tailwind's class merging: this app has plain CSS, not Tailwind. */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
