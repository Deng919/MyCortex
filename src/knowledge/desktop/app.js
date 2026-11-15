/* Materials are rendered only as text; the existing store owns versions and deletion. */
const $ = (id) => document.getElementById(id);
const token = location.hash.slice(1) || sessionStorage.getItem("mycortex-token");
if (token) {
  sessionStorage.setItem("mycortex-token", token);
}
history.replaceState(null, "", location.pathname);
let items = [];
let current = null;
let currentId = null;
let page = 0;
let listRequest = 0;
let detailRequest = 0;
let editorMode = "new";
let requestKey = "";
let saving = false;
let deleting = false;
let returnFocus = null;
let directory = "";
let editingMaterial = null;
let deletingMaterial = null;
const statusNames = {
  pending: "尚未整理",
  organized: "已整理",
  empty: "暂无整理条目",
  failed: "整理失败，原文已保留",
  skipped: "已跳过整理",
};
const stanceNames = {
  explicit: "明确表述",
  intent: "计划 / 意向",
  uncertain: "尚不确定",
  "other-view": "他人观点",
};

async function api(route, data) {
  const response = await fetch(`/api/${route}`, {
    method: data === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || "操作失败，请重试。");
  }
  return result;
}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}
function date(value, full = false) {
  if (!value) {
    return "未记录";
  }
  return new Date(value).toLocaleString(
    "zh-CN",
    full ? { dateStyle: "medium", timeStyle: "short" } : { month: "short", day: "numeric" },
  );
}
function message(text, error = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
  $("message").hidden = !text;
}
function renderList() {
  $("list").replaceChildren();
  if (!items.length) {
    $("list").append(
      node(
        "p",
        "list-empty",
        $("search").value.trim()
          ? "没有找到匹配的记忆。\n试试更短的关键词。"
          : page
            ? "这一页没有更多记忆。"
            : "还没有保存的记忆。\n从一段文字开始吧。",
      ),
    );
  }
  for (const item of items) {
    const card = node("button", "memory-card" + (item.id === currentId ? " selected" : ""));
    if (item.id === currentId) {
      card.setAttribute("aria-current", "true");
    }
    card.append(
      node("span", "card-title", item.title),
      node("span", "card-excerpt", item.excerpt || "仅保存来源链接"),
    );
    const bottom = node("span", "card-bottom");
    bottom.append(node("span", "", item.sourceUri), node("span", "", date(item.recordedAt)));
    card.append(bottom);
    card.addEventListener("click", () => {
      void openMaterial(item.id);
    });
    $("list").append(card);
  }
}
async function loadList() {
  const sequence = ++listRequest;
  const query = $("search").value.trim();
  $("list-caption").textContent = query ? "正在搜索…" : "最近保存";
  $("refresh").disabled = true;
  try {
    const result = await api(`materials?offset=${page * 20}&q=${encodeURIComponent(query)}`);
    if (sequence !== listRequest) {
      return;
    }
    items = result.items;
    renderList();
    $("list-caption").textContent = query ? `匹配结果 · ${items.length} 条` : "最近保存";
    $("search-hint").hidden = !query;
    $("previous").disabled = Boolean(query) || page === 0;
    $("next").disabled = Boolean(query) || !result.hasMore;
    $("page-number").textContent = query ? "最多 10 条" : `第 ${page + 1} 页`;
  } catch (error) {
    if (sequence === listRequest) {
      message(error.message, true);
      $("list-caption").textContent = "加载失败";
    }
  } finally {
    if (sequence === listRequest) {
      $("refresh").disabled = false;
    }
  }
}
function tab(name) {
  for (const key of ["original", "organization", "history"]) {
    $(key + "-panel").hidden = key !== name;
    if (key === name) {
      $("tab-" + key).setAttribute("aria-current", "page");
    } else {
      $("tab-" + key).removeAttribute("aria-current");
    }
  }
}
function renderDetail(historical) {
  $("empty").hidden = true;
  $("detail").hidden = false;
  $("title").textContent = current.title;
  $("kind").textContent = current.kind === "text" ? "文字记忆" : "来源链接";
  $("saved-date").textContent = date(current.recordedAt, true);
  $("version-label").textContent =
    `版本 ${current.revision} · ${historical ? "历史内容，只读" : "当前保存的内容"}`;
  $("edit").disabled = historical || current.kind !== "text";
  $("edit").title =
    current.kind === "reference" ? "链接未保存正文，可新增文字记忆" : "修改正文并保留历史版本";
  $("delete").disabled = historical;
  $("body").textContent = current.body || "这条记忆只保存了来源地址，尚未抓取或保存正文。";
  $("historical-banner").hidden = !historical;
  $("metadata").replaceChildren();
  for (const [label, value] of [
    ["来源", current.sourceUri],
    ["原作者", current.author === "unknown" ? "未知" : current.author],
    ["来源时间", date(current.observedAt, true)],
    ["保存时间", date(current.recordedAt, true)],
    ["材料编号", current.id],
  ]) {
    $("metadata").append(node("dt", "", label), node("dd", "", value));
  }
  $("organization-panel").replaceChildren();
  const organization = current.organization;
  $("organization-panel").append(
    node(
      "p",
      "interpretation-note",
      "整理结果是对原文的解读，保留观点归属和引用。核对内容时，请以原文为依据。",
    ),
  );
  $("organization-panel").append(
    node("span", "pill", organization ? statusNames[organization.status] : "该版本没有整理结果"),
  );
  if (organization?.organization) {
    const content = JSON.parse(organization.organization);
    if (content.topics.length) {
      $("organization-panel").append(node("p", "muted", content.topics.join(" · ")));
    }
    for (const entry of content.entries) {
      const card = node("article", "interpretation");
      card.append(
        node("span", "pill", stanceNames[entry.stance]),
        node("h3", "", entry.summary),
        node("p", "muted", `主体：${entry.subject}${entry.timeText ? " · " + entry.timeText : ""}`),
        node("blockquote", "", entry.quote),
      );
      $("organization-panel").append(card);
    }
  }
  tab("original");
  document.querySelector(".workspace").classList.add("detail-open");
  renderList();
}
async function openMaterial(id, revision) {
  const sequence = ++detailRequest;
  $("edit").disabled = true;
  $("delete").disabled = true;
  try {
    const material = await api(`materials/${id}${revision ? "?revision=" + revision : ""}`);
    if (sequence !== detailRequest) {
      return;
    }
    currentId = id;
    current = material;
    renderDetail(revision !== undefined);
  } catch (error) {
    if (sequence !== detailRequest) {
      return;
    }
    current = null;
    currentId = null;
    $("detail").hidden = true;
    $("empty").hidden = false;
    renderList();
    message(error.message, true);
  }
}
async function showHistory() {
  if (!current) {
    return;
  }
  const id = current.id;
  const sequence = detailRequest;
  tab("history");
  $("history-panel").textContent = "正在读取历史…";
  try {
    const revisions = await api(`materials/${id}/history`);
    if (sequence !== detailRequest) {
      return;
    }
    $("history-panel").replaceChildren(
      node("p", "interpretation-note", "显示最近 50 个版本。历史内容只读，编辑请返回当前版本。"),
    );
    for (const entry of revisions) {
      const row = node("article", "history-item");
      const copy = node("div");
      copy.append(
        node("h3", "", `版本 ${entry.revision}`),
        node("p", "", date(entry.recordedAt, true)),
        node("p", "", entry.note || "首次保存"),
      );
      const view = node("button", "secondary", "查看版本");
      view.addEventListener("click", () => {
        void openMaterial(id, entry.revision);
      });
      row.append(copy, view);
      $("history-panel").append(row);
    }
  } catch (error) {
    if (sequence === detailRequest) {
      $("history-panel").textContent = error.message;
    }
  }
}
function syncEditor() {
  const reference = editorMode === "new" && $("input-kind").value === "reference";
  $("body-field").hidden = reference;
  $("input-body").required = !reference;
  $("body-count").textContent = reference
    ? "只保存地址，不抓取正文"
    : `${new TextEncoder().encode($("input-body").value).length.toLocaleString()} / 262,144 字节`;
}
function openEditor(mode) {
  editorMode = mode;
  editingMaterial = mode === "edit" ? { id: current.id, revision: current.revision } : null;
  returnFocus = document.activeElement;
  $("edit-form").reset();
  $("form-error").hidden = true;
  $("new-fields").hidden = mode !== "new";
  $("input-title").required = mode === "new";
  $("note-field").hidden = mode === "new";
  $("editor-title").textContent = mode === "new" ? "新增记忆" : "编辑记忆";
  $("edit-description").textContent =
    mode === "new"
      ? "保留此刻想留下的内容，之后随时查看。"
      : "修改正文后会创建新版本；标题、来源与原作者保留，旧版本仍可查看。";
  $("save").textContent = mode === "new" ? "保存记忆" : "保存修改";
  requestKey = crypto.randomUUID();
  $("input-body").value = mode === "edit" ? current.body : "";
  syncEditor();
  $("editor").showModal();
  (mode === "new" ? $("input-title") : $("input-body")).focus();
}
function closeEditor() {
  if (saving) {
    return;
  }
  $("editor").close();
  returnFocus?.focus();
}
async function saveMaterial() {
  if (saving) {
    return;
  }
  saving = true;
  for (const control of $("edit-form").querySelectorAll("input, textarea, select, button")) {
    control.disabled = true;
  }
  $("form-error").hidden = true;
  try {
    const result =
      editorMode === "new"
        ? await api("materials", {
            requestKey,
            title: $("input-title").value.trim(),
            kind: $("input-kind").value,
            body: $("input-kind").value === "reference" ? "" : $("input-body").value,
            sourceUri: $("input-source").value.trim() || "mycortex:manual",
            author: $("input-author").value.trim() || "unknown",
          })
        : await api(`materials/${editingMaterial.id}/correct`, {
            expectedRevision: editingMaterial.revision,
            body: $("input-body").value,
            note: $("input-note").value.trim() || "用户在客户端修改正文",
          });
    $("editor").close();
    $("search").value = "";
    page = 0;
    message(editorMode === "new" ? "记忆已保存。" : "修改已保存，旧版本可在历史中查看。");
    await loadList();
    await openMaterial(result.id);
    $("edit").focus();
  } catch (error) {
    $("form-error").textContent = error.message;
    $("form-error").hidden = false;
  } finally {
    saving = false;
    for (const control of $("edit-form").querySelectorAll("input, textarea, select, button")) {
      control.disabled = false;
    }
  }
}
$("edit-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void saveMaterial();
});
$("delete").addEventListener("click", () => {
  if (!current) {
    return;
  }
  deletingMaterial = { id: current.id, revision: current.revision };
  $("delete-title").textContent = current.title;
  $("delete-error").hidden = true;
  $("delete-dialog").showModal();
  $("cancel-delete").focus();
});
async function deleteMaterial() {
  if (deleting) {
    return;
  }
  deleting = true;
  $("confirm-delete").disabled = true;
  try {
    await api(`materials/${deletingMaterial.id}/delete`, {
      expectedRevision: deletingMaterial.revision,
    });
    ++detailRequest;
    current = null;
    currentId = null;
    $("delete-dialog").close();
    $("detail").hidden = true;
    $("empty").hidden = false;
    message("记忆及其全部历史版本已删除。");
    page = 0;
    await loadList();
    if (innerWidth <= 650) {
      document.querySelector(".workspace").classList.remove("detail-open");
    }
    $("new").focus();
  } catch (error) {
    $("delete-error").textContent = error.message;
    $("delete-error").hidden = false;
  } finally {
    deleting = false;
    $("confirm-delete").disabled = false;
  }
}
$("delete-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void deleteMaterial();
});
$("editor").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeEditor();
});
$("delete-dialog").addEventListener("cancel", (event) => {
  if (deleting) {
    event.preventDefault();
  }
});
$("cancel-delete").addEventListener("click", () => {
  if (!deleting) {
    $("delete-dialog").close();
    $("delete").focus();
  }
});
$("close-editor").addEventListener("click", closeEditor);
$("cancel-editor").addEventListener("click", closeEditor);
$("new").addEventListener("click", () => openEditor("new"));
$("empty-new").addEventListener("click", () => openEditor("new"));
$("edit").addEventListener("click", () => openEditor("edit"));
$("input-kind").addEventListener("change", syncEditor);
$("input-body").addEventListener("input", syncEditor);
$("tab-original").addEventListener("click", () => tab("original"));
$("tab-organization").addEventListener("click", () => tab("organization"));
$("tab-history").addEventListener("click", () => {
  void showHistory();
});
$("return-current").addEventListener("click", () => {
  void openMaterial(currentId);
});
$("back").addEventListener("click", () =>
  document.querySelector(".workspace").classList.remove("detail-open"),
);
async function refresh() {
  message("");
  await loadList();
  if (currentId) {
    await openMaterial(currentId);
  }
}
$("refresh").addEventListener("click", () => {
  void refresh();
});
$("previous").addEventListener("click", () => {
  page = Math.max(0, page - 1);
  void loadList();
});
$("next").addEventListener("click", () => {
  page += 1;
  void loadList();
});
let searchTimer;
$("search").addEventListener("input", () => {
  ++listRequest;
  clearTimeout(searchTimer);
  page = 0;
  searchTimer = setTimeout(loadList, 220);
});
$("store-info").addEventListener("click", () => {
  $("store-path").textContent = directory;
  $("store-dialog").showModal();
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) &&
    !document.querySelector("dialog[open]")
  ) {
    event.preventDefault();
    $("search").focus();
  }
});
async function initialize() {
  try {
    const info = await api("info");
    directory = info.directory;
    $("connection").textContent = "已连接本地记忆库";
    await loadList();
  } catch (error) {
    $("connection").textContent = "连接失败";
    message(error.message, true);
  }
}
void initialize();
setInterval(() => {
  api("info").catch(() => {
    $("connection").textContent = "连接已断开，请重新打开客户端";
  });
}, 30000);
