(function (scope) {
  const GENERIC_NAMES = new Set([
    "image", "img", "photo", "picture", "thumbnail", "avatar", "cover",
    "图片", "图像", "照片", "头像", "封面", "缩略图", "无标题"
  ]);

  function cleanText(value, maxLength = 60) {
    return String(value || "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s._-]+|[\s._-]+$/g, "")
      .slice(0, maxLength)
      .trim();
  }

  function usefulName(value) {
    const cleaned = cleanText(value, 48);
    if (!cleaned || GENERIC_NAMES.has(cleaned.toLowerCase())) return "";
    if (/^[a-f\d_-]{18,}$/i.test(cleaned)) return "";
    return cleaned;
  }

  function filenameFromUrl(value) {
    try {
      const url = new URL(String(value || ""));
      if (!/^https?:$/.test(url.protocol)) return "";
      const part = decodeURIComponent(url.pathname.split("/").pop() || "")
        .replace(/\.(png|jpe?g|webp|gif|avif|bmp)$/i, "");
      return usefulName(part);
    } catch (_error) {
      return "";
    }
  }

  function shortPageTitle(value) {
    const title = cleanText(value, 80);
    if (!title) return "";
    const first = title.split(/\s+[|｜·]\s+|\s+-\s+/)[0];
    return usefulName(first);
  }

  function timestampSuffix(value) {
    const date = new Date(value || Date.now());
    const pad = (number) => String(number).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  }

  function buildDefaultName(meta = {}) {
    const base = usefulName(meta.alt)
      || usefulName(meta.imageTitle)
      || filenameFromUrl(meta.sourceUrl)
      || shortPageTitle(meta.pageTitle)
      || "网页形象";
    const suffix = timestampSuffix(meta.capturedAt);
    return cleanText(`${base}-${suffix}`, 60) || `网页形象-${suffix}`;
  }

  function normalizeCategory(value) {
    return cleanText(value, 40) || "未分类";
  }

  function humanizeError(value, fallback = "图片保存失败，请稍后重试") {
    const raw = typeof value === "string" ? value : value?.message;
    const message = String(raw || "").trim();
    if (!message) return fallback;
    if (/download|file system|filesystem|file.*unavailable/i.test(message)) {
      return "图片没有保存到本地。请检查 Chrome 的下载权限和下载文件夹后再试。";
    }
    if (/permission|activeTab|all_urls|not been granted/i.test(message)) {
      return "没有获得网页截图权限。请打开插件，重新开启“鼠标悬停时显示快存浮标”，并在 Chrome 提示时点击“允许”。";
    }
    if (/extension context invalidated|receiving end does not exist|message port closed/i.test(message)) {
      return "插件刚刚重新加载。请刷新当前网页，再点击“快存”。";
    }
    if (/cannot access|cannot be scripted|chrome:\/\/|edge:\/\//i.test(message)) {
      return "这个页面不允许插件截图，请换到普通网页后再试。";
    }
    if (/capture|screenshot|visible tab/i.test(message)) {
      return "网页截图没有完成。请刷新当前网页后再试。";
    }
    if (/[\u3400-\u9fff]/.test(message)) return message;
    return fallback;
  }

  function safePathSegment(value, fallback, maxLength) {
    const cleaned = cleanText(value, maxLength)
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/^[\s._-]+|[\s._-]+$/g, "")
      .trim();
    if (!cleaned) return fallback;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) return `_${cleaned}`;
    return cleaned;
  }

  function localDownloadPath(meta = {}) {
    const category = safePathSegment(normalizeCategory(meta.category), "未分类", 40);
    const name = safePathSegment(meta.name, "网页形象", 80);
    return `卡通形象快存/${category}/${name}.webp`;
  }

  function clampRect(rect, viewportWidth, viewportHeight) {
    const left = Math.max(0, Math.min(Number(rect?.left || 0), viewportWidth));
    const top = Math.max(0, Math.min(Number(rect?.top || 0), viewportHeight));
    const right = Math.max(left, Math.min(Number(rect?.right || left), viewportWidth));
    const bottom = Math.max(top, Math.min(Number(rect?.bottom || top), viewportHeight));
    return { left, top, width: right - left, height: bottom - top };
  }

  const api = {
    buildDefaultName,
    clampRect,
    cleanText,
    filenameFromUrl,
    humanizeError,
    localDownloadPath,
    normalizeCategory,
    shortPageTitle,
    timestampSuffix,
    usefulName,
  };

  scope.CartoonClipperShared = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
