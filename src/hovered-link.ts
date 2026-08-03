export function getShortcutTargetUrl(): string {
  function findInRoot(root: Document | ShadowRoot): string | null {
    const hoveredLinks = root.querySelectorAll<HTMLAnchorElement>("a[href]:hover");
    const link = hoveredLinks[hoveredLinks.length - 1];
    let hoveredUrl = link?.href || null;

    for (const element of Array.from(root.querySelectorAll<HTMLElement>(":hover"))) {
      if (element.shadowRoot) {
        hoveredUrl = findInRoot(element.shadowRoot) ?? hoveredUrl;
      }
    }

    return hoveredUrl;
  }

  return findInRoot(document) ?? document.location.href;
}
