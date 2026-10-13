(function (scope) {
  const EXTENSION_HOST_ID = "xhs-cartoon-clipper-hover-root";

  function tagNameOf(element) {
    return String(element?.tagName || "").toUpperCase();
  }

  function uniqueElements(groups) {
    const seen = new Set();
    const result = [];
    groups.flat().forEach((element) => {
      if (!element || seen.has(element)) return;
      seen.add(element);
      result.push(element);
    });
    return result;
  }

  function imageForElement(element) {
    if (!element) return null;
    if (tagNameOf(element) === "IMG") return element;
    const closestImage = element.closest?.("img");
    if (closestImage) return closestImage;
    const picture = tagNameOf(element) === "PICTURE" ? element : element.closest?.("picture");
    return picture?.querySelector?.("img") || null;
  }

  function isExtensionElement(element) {
    if (String(element?.id || "") === EXTENSION_HOST_ID) return true;
    return Boolean(element?.closest?.(`#${EXTENSION_HOST_ID}`));
  }

  function isLargeVisibleTarget(element, viewportWidth, viewportHeight, minSide) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect) return false;
    const width = Number(rect.width ?? (rect.right - rect.left));
    const height = Number(rect.height ?? (rect.bottom - rect.top));
    return width >= minSide
      && height >= minSide
      && Number(rect.bottom) > 0
      && Number(rect.right) > 0
      && Number(rect.top) < viewportHeight
      && Number(rect.left) < viewportWidth;
  }

  function hasBackgroundImage(element, getStyle) {
    const tagName = tagNameOf(element);
    if (!element || tagName === "HTML" || tagName === "BODY") return false;
    try {
      return /url\(["']?.+?["']?\)/i.test(String(getStyle(element)?.backgroundImage || ""));
    } catch (_error) {
      return false;
    }
  }

  function findVisualTarget({
    eventPath = [],
    pointElements = [],
    viewportWidth = 0,
    viewportHeight = 0,
    minSide = 90,
    getStyle = () => ({ backgroundImage: "none" }),
  } = {}) {
    const candidates = uniqueElements([eventPath, pointElements]).filter((element) => !isExtensionElement(element));
    for (const candidate of candidates) {
      const image = imageForElement(candidate);
      if (isLargeVisibleTarget(image, viewportWidth, viewportHeight, minSide)) return image;
    }
    for (const candidate of candidates) {
      if (isLargeVisibleTarget(candidate, viewportWidth, viewportHeight, minSide) && hasBackgroundImage(candidate, getStyle)) {
        return candidate;
      }
    }
    return null;
  }

  const api = { findVisualTarget, imageForElement, isLargeVisibleTarget };
  scope.CartoonClipperHoverTarget = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
