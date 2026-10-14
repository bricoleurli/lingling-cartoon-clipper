const Shared = globalThis.CartoonClipperShared;
const CAPTURE_PERMISSION_ORIGINS = ["<all_urls>"];
const categoryInput = document.getElementById("category");
const statusCard = document.getElementById("statusCard");
const hoverEnabled = document.getElementById("hoverEnabled");
const retryPending = document.getElementById("retryPending");

document.getElementById("pickImage").addEventListener("click", async () => {
  await saveCategory();
  const result = await send({ type: "START_PICK" });
  if (result.ok) window.close();
  else renderError(result.error);
});

document.getElementById("pickRegion").addEventListener("click", async () => {
  await saveCategory();
  const result = await send({ type: "START_REGION_PICK" });
  if (result.ok) window.close();
  else renderError(result.error);
});

document.getElementById("syncCategories").addEventListener("click", () => runBusy("syncCategories", { type: "SYNC_CATEGORIES" }));
retryPending.addEventListener("click", () => runBusy("retryPending", { type: "RETRY_PENDING" }));
document.getElementById("showLocalFile").addEventListener("click", () => runBusy("showLocalFile", { type: "SHOW_LOCAL_FILE" }));
document.getElementById("openAdmin").addEventListener("click", async () => {
  await send({ type: "OPEN_ADMIN" });
  window.close();
});

categoryInput.addEventListener("change", saveCategory);
hoverEnabled.addEventListener("change", async () => {
  hoverEnabled.disabled = true;
  let result;
  if (hoverEnabled.checked) {
    const granted = await chrome.permissions.request({ origins: CAPTURE_PERMISSION_ORIGINS });
    if (!granted) {
      hoverEnabled.checked = false;
      result = await send({ type: "SET_HOVER_ENABLED", enabled: false });
      hoverEnabled.disabled = false;
      renderError("没有获得网页截图权限，悬停快存尚未开启。再次开启时，请在 Chrome 提示里点击“允许”。");
      return;
    }
    result = await send({ type: "SET_HOVER_ENABLED", enabled: true });
  } else {
    result = await send({ type: "SET_HOVER_ENABLED", enabled: false });
    await chrome.permissions.remove({ origins: CAPTURE_PERMISSION_ORIGINS });
  }
  hoverEnabled.disabled = false;
  if (!result.ok) renderError(result.error);
  else render(result);
});

chrome.storage.onChanged.addListener(() => refresh());
refresh();

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: Shared.humanizeError(error, "插件暂时没有响应，请重新打开后再试") };
  }
}

async function saveCategory() {
  const result = await send({ type: "SAVE_CATEGORY", category: categoryInput.value });
  if (result.ok && document.activeElement !== categoryInput) categoryInput.value = result.defaultCategory;
  return result;
}

async function runBusy(buttonId, message) {
  const button = document.getElementById(buttonId);
  button.disabled = true;
  const result = await send(message);
  button.disabled = false;
  if (!result.ok) renderError(result.error);
  else render(result);
}

async function refresh() {
  const result = await send({ type: "GET_STATE" });
  if (!result.ok) return renderError(result.error);
  render(result);
}

function render(state) {
  if (document.activeElement !== hoverEnabled) hoverEnabled.checked = Boolean(state.hoverEnabled);
  const pendingCount = Number(state.pendingCount || 0);
  retryPending.disabled = pendingCount === 0;
  retryPending.textContent = pendingCount ? `立即补传（${pendingCount}）` : "没有待补传图片";
  const selected = state.defaultCategory || "未分类";
  const names = [...new Set([selected, ...(state.categories || [])])];
  categoryInput.innerHTML = "";
  names.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    categoryInput.appendChild(option);
  });
  categoryInput.value = selected;
  const synced = Number(state.categories?.length || 0);
  if (state.lastSaved) {
    const localPath = state.lastSaved.relativePath || `卡通形象快存/${state.lastSaved.category || "未分类"}`;
    const latestUploaded = state.lastUploaded?.clipId
      ? state.lastUploaded.clipId === state.lastSaved.clipId
      : state.lastUploaded?.name === state.lastSaved.name;
    const uploadStatus = pendingCount
      ? state.lastUploadError
        ? `<br><span class="pending">还有 ${pendingCount} 张待上传：${escapeHtml(state.lastUploadError)}。打开并登录后台后会自动补传。</span>`
        : `<br><span class="pending">还有 ${pendingCount} 张待上传；打开并登录后台后会自动补传。</span>`
      : latestUploaded
      ? `<br><span class="ok">同时已上传卡通工作台</span>`
      : `<br><span>文件已保留在电脑中。</span>`;
    statusCard.innerHTML = `<strong class="ok">最近图片已保存到本地</strong>${escapeHtml(localPath)}${uploadStatus}`;
    return;
  }
  if (state.lastError) {
    statusCard.innerHTML = `<strong class="error">后台暂时没有同步</strong>${escapeHtml(state.lastError)}`;
    return;
  }
  if (state.lastUploaded) {
    statusCard.innerHTML = `<strong class="ok">最近上传成功</strong>${escapeHtml(state.lastUploaded.name)}<br>分类：${escapeHtml(state.lastUploaded.category)}${synced ? `<br>已同步 ${synced} 个后台分类` : ""}`;
    return;
  }
  statusCard.innerHTML = synced
    ? `<strong class="ok">已同步 ${synced} 个后台分类</strong>图片会保存到“下载/卡通形象快存”。`
    : "图片会保存到“下载/卡通形象快存”。<br>点“同步”读取后台现有分类。";
}

function renderError(message) {
  statusCard.innerHTML = `<strong class="error">操作没有完成</strong>${escapeHtml(Shared.humanizeError(message, "请稍后重试"))}`;
}

function escapeHtml(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
