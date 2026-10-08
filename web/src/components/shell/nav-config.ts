import {
  Boxes,
  FileStack,
  MessageSquareText,
  Settings2,
  type LucideIcon,
} from "lucide-react";

/**
 * Primary navigation.
 *
 * Only destinations that exist as routes appear here. Product terminology is
 * deliberate: "Ask" (a one-off question over everything in the workspace),
 * "Spaces" (a knowledge set whose sources you control), "Documents" (the
 * corpus being searched), "Settings".
 */
export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** One-line explanation, surfaced as the page description or a tooltip. */
  hint: string;
};

export const NAV_ITEMS: NavItem[] = [
  {
    href: "/ask",
    label: "Ask",
    icon: MessageSquareText,
    hint: "Ask a question across every document in this workspace.",
  },
  {
    href: "/notebooks",
    label: "Spaces",
    icon: Boxes,
    hint: "Knowledge sets that answer only from the sources you choose.",
  },
  {
    href: "/documents",
    label: "Documents",
    icon: FileStack,
    hint: "The documents being searched, and their processing state.",
  },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings2,
    hint: "Workspace and retrieval configuration.",
  },
];

export function isNavItemActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Breadcrumb label for the current path.
 *
 * Nav destinations resolve normally; the two dynamic routes that are not nav
 * destinations (a single conversation, and nothing else today) resolve to a
 * real label rather than the old "Not found" fallback.
 */
export function activeNavItem(pathname: string): NavItem | undefined {
  const match = NAV_ITEMS.find((item) => isNavItemActive(pathname, item.href));
  if (match) return match;
  if (pathname.startsWith("/c/")) {
    return {
      href: pathname,
      label: "Conversation",
      icon: MessageSquareText,
      hint: "A saved question and answer.",
    };
  }
  return undefined;
}
