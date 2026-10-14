importScripts("shared.js", "pending-uploads.js");

const Shared = globalThis.CartoonClipperShared;
const PendingUploads = globalThis.CartoonClipperPendingUploads;
const pendingQueue = PendingUploads.createQueue({
  store: PendingUploads.createIndexedDbStore(),
});
const ADMIN_ORIGIN = "https://xhs.typoai.xin";
const ADMIN_PAGE = `${ADMIN_ORIGIN}/admin/cartoon`;
const MENU_ID = "save-cartoon-seed";
const HOVER_SCRIPT_ID = "cartoon-clipper-hover";
const CAPTURE_PERMISSION_ORIGINS = ["<all_urls>"];
const HOVER_MATCHES = ["http://*/*", "https://*/*"];
const MAX_OUTPUT_SIDE = 1400;
let legacyMigration = null;

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "保存到卡通工作台",
    contexts: ["image"],
  });
  const state = await chrome.storage.local.get(["defaultCategory"]);
  if (!state.defaultCategory) await chrome.storage.local.set({ defaultCategory: "未分类" });
  await migrateLegacyQueueToLocalFolder();
  await ensureHoverRegistration();
  await updatePendingState();
  retryPendingUploads().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  migrateLegacyQueueToLocalFolder().catch(() => {});
  ensureHoverRegistration().catch(() => {});
  updatePendingState().catch(() => {});
  retryPendingUploads().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !isAdminSiteUrl(tab?.url)) return;
  retryPendingUploads({ tabId }).catch(() => {});
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!isAdminSiteUrl(tab?.url)) return;
  retryPendingUploads({ tabId }).catch(() => {});
});

chrome.permissions.onRemoved.addListener((permissions) => {
  if (!(permissions.origins || []).some((origin) => CAPTURE_PERMISSION_ORIGINS.includes(origin))) return;
  chrome.storage.local.set({ hoverEnabled: false });
  unregisterHoverCapture().catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  captureImageInTab(tab, info.srcUrl || "").catch((error) => reportCaptureError(tab.id, error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    if (message?.type === "GET_STATE") {
      await migrateLegacyQueueToLocalFolder();
      return publicState();
    }
    if (message?.type === "SAVE_CATEGORY") {
      const defaultCategory = Shared.normalizeCategory(message.category);
      await chrome.storage.local.set({ defaultCategory });
      return publicState();
    }
    if (message?.type === "START_PICK") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      assertCapturableTab(tab);
      startPicker(tab).catch((error) => reportCaptureError(tab.id, error));
      return { ok: true };
    }
    if (message?.type === "START_REGION_PICK") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      assertCapturableTab(tab);
      startRegionPicker(tab).catch((error) => reportCaptureError(tab.id, error));
      return { ok: true };
    }
    if (message?.type === "START_REGION_FROM_HOVER") {
      if (!sender.tab?.id) throw new Error("没有找到当前网页");
      const allowed = await chrome.permissions.contains({ origins: CAPTURE_PERMISSION_ORIGINS });
      if (!allowed) throw new Error("没有获得网页截图权限。请打开插件，重新开启“鼠标悬停时显示快存浮标”，并在 Chrome 提示时点击“允许”。");
      assertCapturableTab(sender.tab);
      startRegionPicker(sender.tab, message.cleanSource || null).catch((error) => reportCaptureError(sender.tab.id, error));
      return { ok: true };
    }
    if (message?.type === "CAPTURE_DESCRIPTOR") {
      if (!sender.tab?.id) throw new Error("没有找到当前网页");
      const allowed = await chrome.permissions.contains({ origins: CAPTURE_PERMISSION_ORIGINS });
      if (!allowed) throw new Error("没有获得网页截图权限。请打开插件，重新开启“鼠标悬停时显示快存浮标”，并在 Chrome 提示时点击“允许”。");
      await captureDescriptor(sender.tab, message.descriptor || {});
      return { ok: true };
    }
    if (message?.type === "SET_HOVER_ENABLED") {
      const hoverEnabled = Boolean(message.enabled);
      await chrome.storage.local.set({ hoverEnabled });
      if (hoverEnabled) {
        await registerHoverCapture({ injectCurrentTab: true });
        await chrome.storage.local.set({ lastError: "" });
      }
      else await unregisterHoverCapture({ notifyTabs: true });
      return publicState();
    }
    if (message?.type === "SHOW_LOCAL_FILE") {
      await showLastLocalFile();
      return publicState();
    }
    if (message?.type === "SYNC_CATEGORIES") {
      await syncCategories({ createTab: true, focus: true });
      return publicState();
    }
    if (message?.type === "RETRY_PENDING") {
      const pendingCount = await pendingQueue.count();
      if (pendingCount) await retryPendingUploads({ createTab: true, focus: true });
      return publicState();
    }
    if (message?.type === "OPEN_ADMIN") {
      await openOrFindAdminTab({ active: true });
      return { ok: true };
    }
    throw new Error("不认识的操作");
  };
  run().then((result) => sendResponse({ ok: true, ...result })).catch(async (error) => {
    const message = Shared.humanizeError(error, "操作没有完成，请稍后重试");
    await chrome.storage.local.set({ lastError: message }).catch(() => {});
    sendResponse({ ok: false, error: message });
  });
  return true;
});

async function publicState() {
  const state = await chrome.storage.local.get(["defaultCategory", "categories", "lastSaved", "lastUploaded", "lastUploadError", "lastError", "hoverEnabled"]);
  const hoverPermission = await chrome.permissions.contains({ origins: CAPTURE_PERMISSION_ORIGINS });
  const pendingCount = await pendingQueue.count();
  return {
    defaultCategory: Shared.normalizeCategory(state.defaultCategory),
    categories: Array.isArray(state.categories) ? state.categories : [],
    lastSaved: state.lastSaved || null,
    lastUploaded: state.lastUploaded || null,
    lastUploadError: state.lastUploadError ? Shared.humanizeError(state.lastUploadError, "后台暂时无法连接") : "",
    lastError: state.lastError ? Shared.humanizeError(state.lastError) : "",
    hoverEnabled: Boolean(state.hoverEnabled && hoverPermission),
    hoverPermission,
    pendingCount,
  };
}

async function ensureHoverRegistration() {
  const state = await chrome.storage.local.get(["hoverEnabled"]);
  const allowed = await chrome.permissions.contains({ origins: CAPTURE_PERMISSION_ORIGINS });
  if (state.hoverEnabled && allowed) await registerHoverCapture();
  else await unregisterHoverCapture();
}

async function registerHoverCapture({ injectCurrentTab = false } = {}) {
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [HOVER_SCRIPT_ID] });
  const definition = {
    id: HOVER_SCRIPT_ID,
    matches: HOVER_MATCHES,
    excludeMatches: [`${ADMIN_ORIGIN}/*`],
    js: ["shared.js", "hover-target.js", "hover-content.js"],
    runAt: "document_idle",
    persistAcrossSessions: true,
  };
  if (registered.length) await chrome.scripting.updateContentScripts([definition]);
  else await chrome.scripting.registerContentScripts([definition]);
  if (!injectCurrentTab) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/^https?:/.test(String(tab.url || "")) || String(tab.url || "").startsWith(`${ADMIN_ORIGIN}/`)) return;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["shared.js", "hover-target.js", "hover-content.js"] }).catch(() => {});
}

async function unregisterHoverCapture({ notifyTabs = false } = {}) {
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [HOVER_SCRIPT_ID] });
  if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [HOVER_SCRIPT_ID] });
  if (!notifyTabs) return;
  const tabs = await chrome.tabs.query({ url: HOVER_MATCHES });
  await Promise.all(tabs.map((tab) => tab.id ? chrome.tabs.sendMessage(tab.id, { type: "HOVER_DISABLE" }).catch(() => {}) : null));
}

async function startPicker(tab) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pickVisibleElement,
  });
  const descriptor = results?.[0]?.result;
  if (!descriptor) return;
  await captureDescriptor(tab, descriptor);
}

function assertCapturableTab(tab) {
  if (!tab?.id || !/^https?:/i.test(String(tab.url || ""))) {
    throw new Error("这个页面不能截图，请换到普通网页");
  }
}

async function startRegionPicker(tab, cleanSource = null) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pickVisibleRegion,
    args: [24],
  });
  const descriptor = results?.[0]?.result;
  if (!descriptor) return;
  if (descriptor.error) throw new Error(descriptor.error);
  if (cleanSource?.kind === "img") descriptor.cleanSource = cleanSource;
  await captureDescriptor(tab, descriptor);
}

async function captureImageInTab(tab, srcUrl) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: findVisibleImage,
    args: [srcUrl],
  });
  const descriptor = results?.[0]?.result;
  if (!descriptor) throw new Error("没有找到这张图片，请改用插件里的“点选图片”");
  await captureDescriptor(tab, descriptor);
}

async function captureDescriptor(tab, descriptor) {
  const screenshot = await captureVisiblePageWithoutExtensionUi(tab, descriptor);
  const dataUrl = await cropAndCompress(screenshot, descriptor);
  const state = await chrome.storage.local.get(["defaultCategory"]);
  const capturedAt = new Date().toISOString();
  const item = {
    id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: Shared.buildDefaultName({ ...descriptor, capturedAt }),
    category: Shared.normalizeCategory(state.defaultCategory),
    dataUrl,
    pageUrl: descriptor.pageUrl || tab.url || "",
    sourceUrl: descriptor.sourceUrl || "",
    capturedAt,
    sourceTabId: tab.id,
  };
  const saved = await saveLocalImage(item);
  await pendingQueue.enqueue(item);
  await chrome.storage.local.set({
    lastSaved: {
      clipId: item.id,
      downloadId: saved.downloadId,
      filename: saved.filename,
      relativePath: saved.relativePath,
      name: item.name,
      category: item.category,
      savedAt: capturedAt,
    },
    lastUploadError: "",
    lastError: "",
  });
  await updatePendingState();
  await showToast(tab.id, `已保存到本地“${item.category}”文件夹，等待上传`, "success");

  const upload = await retryPendingUploads();
  if (upload?.ok && upload.uploadedCount) {
    await showToast(tab.id, `本地已保留，并上传到“${item.category}”`, "success");
  }
}

async function captureVisiblePageWithoutExtensionUi(tab, descriptor = {}) {
  const useCleanSource = descriptor.cleanSource?.kind === "img";
  try {
    if (useCleanSource) await prepareCleanSourceOverlayForCapture(tab.id, descriptor).catch(() => false);
    await hideExtensionUiForCapture(tab.id, true);
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } finally {
    await hideExtensionUiForCapture(tab.id, false).catch(() => {});
    if (useCleanSource) await cleanupCleanSourceOverlayForCapture(tab.id).catch(() => {});
  }
}

async function prepareCleanSourceOverlayForCapture(tabId, descriptor) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["clean-source.js"] });
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (cleanSource, selectionRect) => {
      return globalThis.CartoonClipperCleanSource?.prepareCleanSourceOverlay?.({ cleanSource, selectionRect }) || false;
    },
    args: [descriptor.cleanSource, descriptor.rect],
  });
  return Boolean(results?.[0]?.result);
}

async function cleanupCleanSourceOverlayForCapture(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => globalThis.CartoonClipperCleanSource?.cleanupCleanSourceOverlay?.(),
  });
}

async function hideExtensionUiForCapture(tabId, hidden) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async (shouldHide) => {
      const ids = ["xhs-cartoon-clipper-hover-root", "xhs-cartoon-clipper-toast"];
      ids.forEach((id) => {
        const element = document.getElementById(id);
        if (!element) return;
        if (shouldHide) {
          element.dataset.xhsClipperPreviousVisibility = element.style.visibility || "";
          element.style.setProperty("visibility", "hidden", "important");
        } else {
          const previous = element.dataset.xhsClipperPreviousVisibility || "";
          if (previous) element.style.visibility = previous;
          else element.style.removeProperty("visibility");
          delete element.dataset.xhsClipperPreviousVisibility;
        }
      });
      if (!shouldHide) return;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
    args: [hidden],
  });
}

async function cropAndCompress(screenshotDataUrl, descriptor) {
  const screenshotBlob = await (await fetch(screenshotDataUrl)).blob();
  const bitmap = await createImageBitmap(screenshotBlob);
  const viewportWidth = Number(descriptor.viewportWidth || bitmap.width);
  const viewportHeight = Number(descriptor.viewportHeight || bitmap.height);
  const rect = Shared.clampRect(descriptor.rect, viewportWidth, viewportHeight);
  if (rect.width < 12 || rect.height < 12) throw new Error("图片显示区域太小，请先放大页面里的图片");
  const scaleX = bitmap.width / viewportWidth;
  const scaleY = bitmap.height / viewportHeight;
  const source = {
    x: Math.round(rect.left * scaleX),
    y: Math.round(rect.top * scaleY),
    width: Math.max(1, Math.round(rect.width * scaleX)),
    height: Math.max(1, Math.round(rect.height * scaleY)),
  };
  const outputScale = Math.min(1, MAX_OUTPUT_SIDE / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * outputScale));
  const height = Math.max(1, Math.round(source.height * outputScale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, source.x, source.y, source.width, source.height, 0, 0, width, height);
  bitmap.close();
  const output = await canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
  return blobToDataUrl(output);
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function saveLocalImage(item) {
  const relativePath = Shared.localDownloadPath(item);
  const downloadId = await chrome.downloads.download({
    url: item.dataUrl,
    filename: relativePath,
    conflictAction: "uniquify",
    saveAs: false,
  });
  const matches = await chrome.downloads.search({ id: downloadId });
  return { downloadId, filename: matches[0]?.filename || relativePath, relativePath };
}

async function migrateLegacyQueueToLocalFolder() {
  if (legacyMigration) return legacyMigration;
  legacyMigration = (async () => {
    const state = await chrome.storage.local.get(["queue"]);
    const queue = Array.isArray(state.queue) ? state.queue : [];
    if (!queue.length) return;
    const remaining = [];
    let lastSaved = null;
    for (const item of queue) {
      if (!item?.dataUrl) continue;
      try {
        const saved = await saveLocalImage(item);
        lastSaved = {
          downloadId: saved.downloadId,
          filename: saved.filename,
          relativePath: saved.relativePath,
          name: item.name,
          category: item.category,
          savedAt: item.capturedAt || new Date().toISOString(),
        };
      } catch (error) {
        remaining.push({ ...item, error: Shared.humanizeError(error, "转存到本地文件夹失败") });
      }
    }
    if (remaining.length) {
      await chrome.storage.local.set({ queue: remaining, lastSaved, lastError: `${remaining.length} 张旧图片转存失败，将在下次打开插件时重试` });
    } else {
      await chrome.storage.local.remove(["queue"]);
      if (lastSaved) await chrome.storage.local.set({ lastSaved, lastError: "" });
    }
  })().finally(() => { legacyMigration = null; });
  return legacyMigration;
}

async function showLastLocalFile() {
  const state = await chrome.storage.local.get(["lastSaved"]);
  const downloadId = state.lastSaved?.downloadId;
  if (Number.isInteger(downloadId)) {
    const matches = await chrome.downloads.search({ id: downloadId });
    if (matches[0]?.exists !== false) {
      await chrome.downloads.show(downloadId);
      return;
    }
  }
  await chrome.downloads.showDefaultFolder();
}

async function retryPendingUploads({ tabId = null, createTab = false, focus = false } = {}) {
  const pendingCount = await pendingQueue.count();
  if (!pendingCount) {
    await updatePendingState(0);
    return { ok: true, attempted: false, uploadedCount: 0, pendingCount: 0, error: "" };
  }
  const tab = tabId
    ? await chrome.tabs.get(tabId).catch(() => null)
    : await openOrFindAdminTab({ active: focus, create: createTab });
  if (!tab?.id || !isAdminSiteUrl(tab.url || tab.pendingUrl)) {
    await updatePendingState(pendingCount);
    return { ok: false, attempted: false, uploadedCount: 0, pendingCount, error: "" };
  }
  if (focus) await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  if (tab.status !== "complete") {
    try {
      await waitForTabComplete(tab.id, 15000);
    } catch (error) {
      const message = Shared.humanizeError(error, "后台页面打开超时");
      await chrome.storage.local.set({ lastUploadError: message });
      await updatePendingState();
      return { ok: false, attempted: true, uploadedCount: 0, pendingCount: await pendingQueue.count(), error: message };
    }
  }
  const result = await pendingQueue.flush((item) => uploadPendingItem(tab.id, item));
  if (!result.ok && result.attempted) {
    await chrome.storage.local.set({ lastUploadError: result.error || "后台暂时无法连接" });
  } else if (result.ok) {
    await chrome.storage.local.set({ lastUploadError: "" });
  }
  await updatePendingState(result.pendingCount);
  if (result.uploadedCount) syncCategories({ tabId: tab.id, createTab: false }).catch(() => {});
  return result;
}

async function uploadPendingItem(tabId, item) {
  try {
    const result = await runOnAdminPage(tabId, uploadSeedFromAdminPage, [item]);
    if (!result?.ok) return { attempted: true, ...result };
    await chrome.storage.local.set({
      lastUploaded: {
        clipId: item.id,
        id: result.asset?.id || "",
        name: item.name,
        category: item.category,
        uploadedAt: new Date().toISOString(),
      },
      lastUploadError: "",
    });
    return { attempted: true, ...result };
  } catch (error) {
    return { attempted: true, ok: false, error: Shared.humanizeError(error, "后台暂时无法连接") };
  }
}

async function syncCategories({ tabId = null, createTab = false, focus = false } = {}) {
  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : await openOrFindAdminTab({ active: focus, create: createTab });
  if (!tab?.id) throw new Error("没有找到卡通工作台页面");
  if (tab.status !== "complete") await waitForTabComplete(tab.id, 15000);
  const result = await runOnAdminPage(tab.id, readCategoriesFromAdminPage, []);
  if (!result?.ok) {
    const message = result?.error || "请先登录管理员后台";
    await chrome.storage.local.set({ lastError: message });
    throw new Error(message);
  }
  const categories = [...new Set((result.categories || []).map(Shared.normalizeCategory))];
  const state = await chrome.storage.local.get(["defaultCategory"]);
  const current = Shared.normalizeCategory(state.defaultCategory);
  const defaultCategory = categories.includes(current)
    ? current
    : (categories.find((name) => name === "未分类") || categories[0] || "未分类");
  await chrome.storage.local.set({ categories, defaultCategory, lastError: "" });
  return categories;
}

async function openOrFindAdminTab({ active = false, create = true } = {}) {
  const tabs = await chrome.tabs.query({ url: `${ADMIN_ORIGIN}/*` });
  const existing = tabs.find((tab) => String(tab.url || "").includes("/admin/cartoon")) || tabs[0];
  if (existing) {
    if (active) return chrome.tabs.update(existing.id, { active: true, url: ADMIN_PAGE });
    return existing;
  }
  if (!create) return null;
  return chrome.tabs.create({ url: ADMIN_PAGE, active });
}

function isAdminSiteUrl(url) {
  return String(url || "").startsWith(`${ADMIN_ORIGIN}/`);
}

async function waitForTabComplete(tabId, timeoutMs) {
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (current?.status === "complete") return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("后台页面打开超时"));
    }, timeoutMs);
    const listener = (updatedId, info) => {
      if (updatedId !== tabId || info.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function runOnAdminPage(tabId, func, args) {
  const tab = await chrome.tabs.get(tabId);
  if (!String(tab.url || "").startsWith(`${ADMIN_ORIGIN}/`)) throw new Error("后台地址不正确");
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args,
  });
  return results?.[0]?.result;
}

async function updatePendingState(count = null) {
  const pendingCount = Number.isInteger(count) ? count : await pendingQueue.count();
  await chrome.storage.local.set({ pendingCount });
  await chrome.action.setBadgeBackgroundColor({ color: "#f97316" });
  await chrome.action.setBadgeText({ text: pendingCount ? (pendingCount > 99 ? "99+" : String(pendingCount)) : "" });
  const suffix = pendingCount ? `，${pendingCount} 张等待上传` : "，没有待上传图片";
  await chrome.action.setTitle({ title: `卡通形象快存：图片保存到本地文件夹${suffix}` });
  return pendingCount;
}

async function reportCaptureError(tabId, error) {
  const message = Shared.humanizeError(error);
  await chrome.storage.local.set({ lastError: message });
  if (tabId) await showToast(tabId, message, "error");
}

async function showToast(tabId, message, tone) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (text, kind) => {
        const old = document.getElementById("xhs-cartoon-clipper-toast");
        old?.remove();
        const toast = document.createElement("div");
        toast.id = "xhs-cartoon-clipper-toast";
        toast.textContent = text;
        Object.assign(toast.style, {
          position: "fixed", right: "20px", top: "20px", zIndex: "2147483647",
          maxWidth: "320px", padding: "11px 14px", borderRadius: "10px",
          color: "#fff", background: kind === "error" ? "#b91c1c" : kind === "success" ? "#15803d" : "#334155",
          boxShadow: "0 10px 30px rgba(15,23,42,.24)", font: "14px/1.45 system-ui,sans-serif",
        });
        document.documentElement.appendChild(toast);
        setTimeout(() => toast.remove(), kind === "error" ? 5000 : 3200);
      },
      args: [message, tone],
    });
  } catch (_error) {
    // Restricted pages cannot receive an injected toast; the popup still shows the error.
  }
}

function findVisibleImage(srcUrl) {
  const normalize = (value) => {
    try { return new URL(value, location.href).href; } catch (_error) { return String(value || ""); }
  };
  const wanted = normalize(srcUrl);
  const candidates = [...document.images]
    .filter((image) => normalize(image.currentSrc || image.src) === wanted)
    .map((image) => ({ image, rect: image.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width >= 12 && rect.height >= 12 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth)
    .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));
  if (!candidates.length) return null;
  const image = candidates[0].image;
  const rect = image.getBoundingClientRect();
  return {
    rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    alt: image.alt || image.getAttribute("aria-label") || "",
    imageTitle: image.title || "",
    sourceUrl: image.currentSrc || image.src || srcUrl,
    pageTitle: document.title,
    pageUrl: location.href,
  };
}

function pickVisibleRegion(minSide) {
  const overlayId = "xhs-cartoon-clipper-region-picker";
  if (document.getElementById(overlayId)) {
    return Promise.resolve({ error: "正在框选，请先完成当前操作或按 Esc 取消" });
  }
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    const selection = document.createElement("div");
    const label = document.createElement("div");
    const sizeLabel = document.createElement("div");
    overlay.id = overlayId;
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", zIndex: "2147483647", cursor: "crosshair",
      background: "rgba(15,23,42,.20)", touchAction: "none", userSelect: "none",
    });
    Object.assign(selection.style, {
      position: "fixed", display: "none", pointerEvents: "none", boxSizing: "border-box",
      border: "2px solid #f97316", background: "rgba(255,255,255,.06)",
      boxShadow: "0 0 0 9999px rgba(15,23,42,.48)",
    });
    Object.assign(label.style, {
      position: "fixed", left: "50%", top: "16px", transform: "translateX(-50%)",
      padding: "9px 13px", borderRadius: "9px", color: "#fff", background: "#172033",
      boxShadow: "0 8px 24px rgba(15,23,42,.30)", pointerEvents: "none",
      font: "14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    });
    Object.assign(sizeLabel.style, {
      position: "fixed", display: "none", padding: "4px 7px", borderRadius: "6px",
      color: "#fff", background: "#f97316", pointerEvents: "none",
      font: "12px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    });
    label.textContent = "十字拖动框选要保存的区域 · Esc 取消";
    overlay.append(selection, label, sizeLabel);
    document.documentElement.appendChild(overlay);

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let settled = false;
    const clamp = (value, limit) => Math.max(0, Math.min(Number(value || 0), limit));

    const draw = (x, y) => {
      lastX = clamp(x, innerWidth);
      lastY = clamp(y, innerHeight);
      const left = Math.min(startX, lastX);
      const top = Math.min(startY, lastY);
      const width = Math.abs(lastX - startX);
      const height = Math.abs(lastY - startY);
      overlay.style.background = "transparent";
      Object.assign(selection.style, {
        display: "block", left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
      });
      sizeLabel.textContent = `${Math.round(width)} × ${Math.round(height)}`;
      Object.assign(sizeLabel.style, {
        display: "block",
        left: `${Math.min(innerWidth - 82, Math.max(8, left))}px`,
        top: `${Math.min(innerHeight - 30, Math.max(8, top + height + 7))}px`,
      });
    };

    const cleanup = () => {
      document.removeEventListener("keydown", onKeydown, true);
      overlay.removeEventListener("pointerdown", onPointerDown, true);
      overlay.removeEventListener("pointermove", onPointerMove, true);
      overlay.removeEventListener("pointerup", onPointerUp, true);
      overlay.removeEventListener("pointercancel", onPointerCancel, true);
      overlay.removeEventListener("contextmenu", preventContextMenu, true);
      overlay.remove();
    };

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      resolve(result);
    };

    const onPointerDown = (event) => {
      if (dragging) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dragging = true;
      startX = clamp(event.clientX, innerWidth);
      startY = clamp(event.clientY, innerHeight);
      lastX = startX;
      lastY = startY;
      overlay.setPointerCapture?.(event.pointerId);
      draw(lastX, lastY);
    };

    const onPointerMove = (event) => {
      if (!dragging) return;
      event.preventDefault();
      draw(event.clientX, event.clientY);
    };

    const onPointerUp = (event) => {
      if (!dragging) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dragging = false;
      draw(event.clientX, event.clientY);
      const left = Math.min(startX, lastX);
      const top = Math.min(startY, lastY);
      const right = Math.max(startX, lastX);
      const bottom = Math.max(startY, lastY);
      if (right - left < minSide || bottom - top < minSide) {
        finish({ error: "框选范围太小，请拖出更大的区域" });
        return;
      }
      finish({
        rect: { left, top, right, bottom },
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        alt: "网页框选",
        imageTitle: "",
        sourceUrl: "",
        pageTitle: document.title,
        pageUrl: location.href,
      });
    };

    const onPointerCancel = () => finish(null);
    const onKeydown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(null);
    };
    const preventContextMenu = (event) => event.preventDefault();

    overlay.addEventListener("pointerdown", onPointerDown, true);
    overlay.addEventListener("pointermove", onPointerMove, true);
    overlay.addEventListener("pointerup", onPointerUp, true);
    overlay.addEventListener("pointercancel", onPointerCancel, true);
    overlay.addEventListener("contextmenu", preventContextMenu, true);
    document.addEventListener("keydown", onKeydown, true);
  });
}

function pickVisibleElement() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    const label = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed", zIndex: "2147483646", pointerEvents: "none",
      border: "3px solid #f97316", borderRadius: "8px", background: "rgba(249,115,22,.10)",
      boxSizing: "border-box", display: "none",
    });
    Object.assign(label.style, {
      position: "fixed", zIndex: "2147483647", pointerEvents: "none", left: "50%", top: "16px",
      transform: "translateX(-50%)", padding: "9px 13px", borderRadius: "9px",
      color: "#fff", background: "#1e293b", boxShadow: "0 8px 24px rgba(15,23,42,.24)",
      font: "14px/1.4 system-ui,sans-serif",
    });
    label.textContent = "点击要保存的图片或形象区域 · Esc 取消";
    document.documentElement.append(overlay, label);
    let current = null;

    const pickTarget = (node) => {
      if (!(node instanceof Element) || node === overlay || node === label) return null;
      const media = node.closest("img, canvas, svg, video");
      if (media) return media;
      let candidate = node;
      for (let depth = 0; candidate && depth < 4; depth += 1, candidate = candidate.parentElement) {
        if (getComputedStyle(candidate).backgroundImage !== "none") return candidate;
      }
      return node;
    };

    const move = (event) => {
      current = pickTarget(document.elementFromPoint(event.clientX, event.clientY));
      if (!current) { overlay.style.display = "none"; return; }
      const rect = current.getBoundingClientRect();
      Object.assign(overlay.style, {
        display: "block", left: `${Math.max(0, rect.left)}px`, top: `${Math.max(0, rect.top)}px`,
        width: `${Math.min(innerWidth, rect.right) - Math.max(0, rect.left)}px`,
        height: `${Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)}px`,
      });
    };
    const cleanup = () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", keydown, true);
      overlay.remove();
      label.remove();
    };
    const click = (event) => {
      if (!current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const rect = current.getBoundingClientRect();
      const background = getComputedStyle(current).backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1] || "";
      const result = {
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        alt: current.getAttribute("alt") || current.getAttribute("aria-label") || "",
        imageTitle: current.getAttribute("title") || "",
        sourceUrl: current.currentSrc || current.src || background,
        pageTitle: document.title,
        pageUrl: location.href,
      };
      cleanup();
      resolve(result);
    };
    const keydown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cleanup();
      resolve(null);
    };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", keydown, true);
  });
}

async function uploadSeedFromAdminPage(item) {
  try {
    const response = await fetch("/api/admin/cartoon", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "upload",
        name: item.name,
        category: item.category,
        dataUrl: item.dataUrl,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    return { ok: Boolean(response.ok && payload.ok), status: response.status, asset: payload.asset || null, error: payload.error || (response.status === 401 || response.status === 403 ? "请先登录管理员后台" : "上传失败") };
  } catch (_error) {
    return { ok: false, error: "后台暂时无法连接" };
  }
}

async function readCategoriesFromAdminPage() {
  try {
    const response = await fetch("/api/admin/cartoon/seeds", { credentials: "same-origin" });
    const payload = await response.json().catch(() => ({}));
    return {
      ok: Boolean(response.ok && payload.ok),
      categories: (payload.categories || []).map((item) => item.name).filter(Boolean),
      error: payload.error || (response.status === 401 || response.status === 403 ? "请先登录管理员后台" : "分类读取失败"),
    };
  } catch (_error) {
    return { ok: false, categories: [], error: "后台暂时无法连接" };
  }
}
