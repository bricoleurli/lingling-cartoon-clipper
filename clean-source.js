(function (scope) {
  const CLEAN_SOURCE_ID = "xhs-cartoon-clipper-clean-source";

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function cssNumber(value) {
    const parsed = parseFloat(String(value || "0"));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function normalizedRect(value) {
    const left = number(value?.left);
    const top = number(value?.top);
    const right = number(value?.right);
    const bottom = number(value?.bottom);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function rectContains(outerValue, innerValue, tolerance = 1) {
    const outer = normalizedRect(outerValue);
    const inner = normalizedRect(innerValue);
    return outer.width >= 90
      && outer.height >= 90
      && inner.width >= 12
      && inner.height >= 12
      && inner.left >= outer.left - tolerance
      && inner.top >= outer.top - tolerance
      && inner.right <= outer.right + tolerance
      && inner.bottom <= outer.bottom + tolerance;
  }

  function rectMatches(firstValue, secondValue, tolerance = 8) {
    const first = normalizedRect(firstValue);
    const second = normalizedRect(secondValue);
    return Math.abs(first.left - second.left) <= tolerance
      && Math.abs(first.top - second.top) <= tolerance
      && Math.abs(first.right - second.right) <= tolerance
      && Math.abs(first.bottom - second.bottom) <= tolerance;
  }

  function imageUrl(image) {
    return String(image?.currentSrc || image?.src || "");
  }

  function styleIsSimple(style) {
    if (!style || style.display === "none" || style.visibility === "hidden") return false;
    if (number(style.opacity || 1) < 0.99) return false;
    if (style.transform && style.transform !== "none") return false;
    if (style.mixBlendMode && style.mixBlendMode !== "normal") return false;
    return ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"]
      .every((name) => cssNumber(style[name]) === 0);
  }

  function findSingleImage(documentRef, cleanSource, selectionRect, getStyle) {
    if (cleanSource?.kind !== "img" || !cleanSource.sourceUrl) return null;
    if (!rectContains(cleanSource.rect, selectionRect)) return null;
    const matches = Array.from(documentRef?.images || []).filter((image) => {
      if (String(image?.tagName || "").toUpperCase() !== "IMG" || image.isConnected === false) return false;
      if (imageUrl(image) !== String(cleanSource.sourceUrl)) return false;
      const rect = image.getBoundingClientRect?.();
      if (!rectMatches(rect, cleanSource.rect) || !rectContains(rect, selectionRect)) return false;
      return styleIsSimple(getStyle(image));
    });
    return matches.length === 1 ? matches[0] : null;
  }

  function cleanupCleanSourceOverlay(documentRef = document) {
    documentRef?.getElementById?.(CLEAN_SOURCE_ID)?.remove?.();
  }

  async function defaultWaitForPaint() {
    if (typeof requestAnimationFrame !== "function") return;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  async function prepareCleanSourceOverlay({
    documentRef = document,
    cleanSource,
    selectionRect,
    getStyle = (element) => getComputedStyle(element),
    waitForPaint = defaultWaitForPaint,
  } = {}) {
    cleanupCleanSourceOverlay(documentRef);
    let clone = null;
    try {
      const image = findSingleImage(documentRef, cleanSource, selectionRect, getStyle);
      if (!image) return false;
      const rect = normalizedRect(image.getBoundingClientRect());
      const style = getStyle(image);
      clone = image.cloneNode(false);
      clone.id = CLEAN_SOURCE_ID;
      ["class", "style", "srcset", "sizes", "loading", "id"].forEach((name) => clone.removeAttribute?.(name));
      clone.id = CLEAN_SOURCE_ID;
      clone.setAttribute?.("aria-hidden", "true");
      clone.src = String(cleanSource.sourceUrl);
      clone.draggable = false;
      Object.assign(clone.style, {
        position: "fixed",
        zIndex: "2147483646",
        pointerEvents: "none",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        minWidth: "0",
        minHeight: "0",
        maxWidth: "none",
        maxHeight: "none",
        margin: "0",
        padding: "0",
        border: "0",
        boxSizing: "border-box",
        objectFit: style.objectFit || "fill",
        objectPosition: style.objectPosition || "50% 50%",
        borderRadius: style.borderRadius || "0",
        clipPath: style.clipPath || "none",
        filter: style.filter || "none",
        opacity: style.opacity || "1",
        backgroundColor: style.backgroundColor || "transparent",
      });
      documentRef.documentElement.appendChild(clone);
      try {
        if (typeof clone.decode === "function") {
          await Promise.race([
            clone.decode(),
            new Promise((resolve) => setTimeout(resolve, 800)),
          ]);
        }
      } catch (_error) {
        // A cached image can reject decode and still be renderable; the checks below decide.
      }
      if (clone.complete === false || number(clone.naturalWidth || image.naturalWidth) <= 0) {
        cleanupCleanSourceOverlay(documentRef);
        return false;
      }
      await waitForPaint();
      return true;
    } catch (_error) {
      clone?.remove?.();
      cleanupCleanSourceOverlay(documentRef);
      return false;
    }
  }

  const api = {
    CLEAN_SOURCE_ID,
    cleanupCleanSourceOverlay,
    findSingleImage,
    prepareCleanSourceOverlay,
    rectContains,
  };
  scope.CartoonClipperCleanSource = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
