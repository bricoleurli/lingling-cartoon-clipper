(function () {
  const SCRIPT_VERSION = "0.3.2";
  const staleHost = document.getElementById("xhs-cartoon-clipper-hover-root");
  if (globalThis.__xhsCartoonClipperHoverVersion === SCRIPT_VERSION && staleHost) return;
  staleHost?.remove();
  globalThis.__xhsCartoonClipperHover = true;
  globalThis.__xhsCartoonClipperHoverVersion = SCRIPT_VERSION;
  const Shared = globalThis.CartoonClipperShared;
  const Target = globalThis.CartoonClipperHoverTarget;

  const host = document.createElement("div");
  host.id = "xhs-cartoon-clipper-hover-root";
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483645",
    pointerEvents: "none",
  });
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      button { font: 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      #badge { position: fixed; display: none; align-items: center; gap: 5px; height: 30px; padding: 0 10px; border: 0; border-radius: 999px; color: #fff; background: #f97316; box-shadow: 0 6px 20px rgba(15,23,42,.28); pointer-events: auto; cursor: pointer; font-weight: 700; }
      #badge:hover { background: #ea580c; transform: translateY(-1px); }
      #badge span:first-child { display: grid; place-items: center; width: 17px; height: 17px; border-radius: 5px; color: #f97316; background: #fff; font-size: 11px; }
      #confirm { position: fixed; display: none; width: 270px; padding: 12px; border: 1px solid rgba(148,163,184,.48); border-radius: 12px; color: #172033; background: #fff; box-shadow: 0 14px 38px rgba(15,23,42,.25); pointer-events: auto; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      #confirm strong { display: block; margin-bottom: 4px; font-size: 14px; }
      #confirm p { margin: 0; color: #64748b; }
      #confirm footer { display: flex; justify-content: flex-end; gap: 7px; margin-top: 10px; }
      #confirm button { padding: 7px 11px; border: 1px solid #d5dae3; border-radius: 8px; color: #273449; background: #fff; cursor: pointer; }
      #confirm button[data-save] { border-color: #ea580c; color: #fff; background: #f97316; font-weight: 700; }
      #confirm button[data-region] { border-color: #fdba74; color: #c2410c; background: #fff7ed; font-weight: 700; }
      #confirm button:disabled { cursor: wait; opacity: .6; }
      #notice { position: fixed; display: none; right: 18px; top: 18px; width: min(360px, calc(100vw - 36px)); padding: 11px 14px; border-radius: 10px; color: #fff; background: #b91c1c; box-shadow: 0 10px 30px rgba(15,23,42,.24); pointer-events: none; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    </style>
    <button id="badge" type="button" title="保存到卡通工作台"><span>收</span><span>快存</span></button>
    <section id="confirm" role="dialog" aria-label="保存这个形象">
      <strong>保存这个形象？</strong>
      <p id="category">将保存到当前默认分类</p>
      <footer><button type="button" data-cancel>取消</button><button type="button" data-region>框选局部</button><button type="button" data-save>保存整张</button></footer>
    </section>
    <div id="notice" role="status" aria-live="polite"></div>`;
  document.documentElement.appendChild(host);

  const badge = shadow.getElementById("badge");
  const confirm = shadow.getElementById("confirm");
  const categoryText = shadow.getElementById("category");
  const saveButton = shadow.querySelector("[data-save]");
  const regionButton = shadow.querySelector("[data-region]");
  const cancelButton = shadow.querySelector("[data-cancel]");
  const notice = shadow.getElementById("notice");
  let currentImage = null;
  let defaultCategory = "未分类";
  let confirmOpen = false;
  let saving = false;
  let noticeTimer = 0;

  chrome.storage.local.get(["defaultCategory"]).then((state) => {
    defaultCategory = String(state.defaultCategory || "未分类");
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.defaultCategory) defaultCategory = String(changes.defaultCategory.newValue || "未分类");
  });

  const imageFromEvent = (event) => {
    const pointElements = document.elementsFromPoint?.(event.clientX, event.clientY) || [];
    return Target?.findVisualTarget?.({
      eventPath: event.composedPath(),
      pointElements,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      minSide: 90,
      getStyle: (element) => getComputedStyle(element),
    }) || null;
  };

  const positionBadge = (image) => {
    const rect = image.getBoundingClientRect();
    badge.style.display = "flex";
    badge.style.left = `${Math.max(8, Math.min(innerWidth - 76, rect.right - 70))}px`;
    badge.style.top = `${Math.max(8, rect.top + 8)}px`;
  };

  const onPointerOver = (event) => {
    if (confirmOpen) return;
    const image = imageFromEvent(event);
    if (!image) return;
    currentImage = image;
    positionBadge(image);
  };

  const onPointerMove = (event) => {
    if (confirmOpen || event.composedPath().includes(host)) return;
    const image = imageFromEvent(event);
    if (image) {
      currentImage = image;
      positionBadge(image);
    } else if (currentImage) {
      const rect = currentImage.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) {
        currentImage = null;
        badge.style.display = "none";
      }
    }
  };

  const descriptor = () => {
    if (!currentImage?.isConnected) return null;
    const rect = currentImage.getBoundingClientRect();
    const background = getComputedStyle(currentImage).backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1] || "";
    return {
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      alt: currentImage.alt || currentImage.getAttribute("aria-label") || "",
      imageTitle: currentImage.title || "",
      sourceUrl: currentImage.currentSrc || currentImage.src || background,
      pageTitle: document.title,
      pageUrl: location.href,
    };
  };

  const cleanSourceDescriptor = () => {
    if (String(currentImage?.tagName || "").toUpperCase() !== "IMG") return null;
    const sourceUrl = String(currentImage.currentSrc || currentImage.src || "");
    if (!sourceUrl) return null;
    const rect = currentImage.getBoundingClientRect();
    return {
      kind: "img",
      sourceUrl,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
    };
  };

  badge.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!currentImage) return;
    const rect = currentImage.getBoundingClientRect();
    categoryText.textContent = `保存到“${defaultCategory}”`;
    confirm.style.display = "block";
    confirm.style.left = `${Math.max(8, Math.min(innerWidth - 278, rect.right - 270))}px`;
    confirm.style.top = `${Math.max(8, Math.min(innerHeight - 132, rect.top + 44))}px`;
    badge.style.display = "none";
    confirmOpen = true;
  });

  const closeSaveInteraction = () => {
    confirm.style.display = "none";
    confirmOpen = false;
    saving = false;
    currentImage = null;
    badge.style.display = "none";
    saveButton.disabled = false;
    saveButton.textContent = "保存整张";
    regionButton.disabled = false;
  };

  const showFailure = async (value) => {
    const fallback = "图片没有保存成功，请刷新当前网页后再试。";
    notice.textContent = Shared?.humanizeError?.(value, fallback) || fallback;
    notice.style.display = "block";
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice.style.display = "none"; }, 6500);
  };

  cancelButton.addEventListener("click", closeSaveInteraction);

  regionButton.addEventListener("click", async () => {
    if (saving) return;
    saving = true;
    regionButton.disabled = true;
    regionButton.textContent = "准备框选…";
    const result = await chrome.runtime.sendMessage({
      type: "START_REGION_FROM_HOVER",
      cleanSource: cleanSourceDescriptor(),
    }).catch((error) => ({ ok: false, error }));
    closeSaveInteraction();
    regionButton.textContent = "框选局部";
    if (!result?.ok) await showFailure(result?.error);
  });

  saveButton.addEventListener("click", async () => {
    if (saving) return;
    const payload = descriptor();
    if (!payload) return;
    saving = true;
    saveButton.disabled = true;
    saveButton.textContent = "保存中…";
    const result = await chrome.runtime.sendMessage({ type: "CAPTURE_DESCRIPTOR", descriptor: payload }).catch((error) => ({ ok: false, error }));
    if (!result?.ok) {
      closeSaveInteraction();
      await showFailure(result?.error);
      return;
    }
    closeSaveInteraction();
  });

  const hideOnViewportChange = () => {
    if (confirmOpen) return;
    currentImage = null;
    badge.style.display = "none";
  };

  const disable = () => {
    document.removeEventListener("pointerover", onPointerOver, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("scroll", hideOnViewportChange, true);
    window.removeEventListener("resize", hideOnViewportChange);
    clearTimeout(noticeTimer);
    host.remove();
    delete globalThis.__xhsCartoonClipperHover;
    delete globalThis.__xhsCartoonClipperHoverVersion;
  };

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "HOVER_DISABLE") disable();
  });
  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("scroll", hideOnViewportChange, true);
  window.addEventListener("resize", hideOnViewportChange);
})();
