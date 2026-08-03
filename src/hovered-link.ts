export function getHoveredLinkUrl(): string | null {
  const hoveredLinks = document.querySelectorAll<HTMLAnchorElement>("a[href]:hover");
  const link = hoveredLinks[hoveredLinks.length - 1];
  return link?.href || null;
}
