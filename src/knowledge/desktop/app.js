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
// Shared classic-script bindings updated by network-view.js.
// eslint-disable-next-line prefer-const
let view = "knowledge";
// eslint-disable-next-line prefer-const
let selectedEntity = null;
const stanceNames = {
  explicit: "明确表述",
  intent: "计划 / 意向",
  uncertain: "尚不确定",
  "other-view": "他人观点",
};
const basisNames = { remark: "联系人备注", explicit: "明确关系", inferred: "语境推断" };

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
function entityLabel(entity) {
  if (!entity) {
    return "未知对象";
  }
  const remark = entity.identity?.remark || entity.remark;
  const nickname = entity.identity?.nickname || entity.nickname;
  return remark || entity.name || nickname || "未知对象";
}
function names(ids, entities) {
  return (ids || [])
    .map((id) => entityLabel(entities.find((entity) => entity.id === id)))
    .join("、");
}
function historicalQuery() {
  return `includeHistorical=${$("include-historical").checked}`;
}
function renderList() {
  $("list").replaceChildren();
  if (!items.length) {
    $("list").append(
      node(
        "p",
        "list-empty",
        $("search").value.trim()
          ? "没有找到匹配的知识。\n试试更短的关键词。"
          : page
            ? "这一页没有更多知识。"
            : "还没有保存的知识。\n可以手写已提炼的知识，或通过 Agent 提交。",
      ),
    );
  }
  for (const item of items) {
    const card = node("button", "memory-card" + (item.id === currentId ? " selected" : ""));
    if (item.id === currentId) {
      card.setAttribute("aria-current", "true");
    }
    card.append(node("span", "card-title", item.title));
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
  if (view === "network") {
    await loadNetwork();
    return;
  }
  const sequence = ++listRequest;
  const query = $("search").value.trim();
  $("list-caption").textContent = query ? "正在搜索…" : "最近保存";
  $("refresh").disabled = true;
  try {
    const result = await api(
      `materials?offset=${page * 20}&q=${encodeURIComponent(query)}&${historicalQuery()}`,
    );
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
  for (const key of ["knowledge", "history"]) {
    $(key + "-panel").hidden = key !== name;
    if (key === name) {
      $("tab-" + key).setAttribute("aria-current", "page");
    } else {
      $("tab-" + key).removeAttribute("aria-current");
    }
  }
}
function renderDetail(historical) {
  $("network-detail").hidden = true;
  $("empty").hidden = true;
  $("detail").hidden = false;
  $("kind").textContent = current.kind === "text" ? "知识" : "来源链接";
  $("saved-date").textContent = date(current.recordedAt, true);
  $("edit").disabled = historical || current.kind !== "text";
  $("edit").title =
    current.kind === "reference" ? "链接未保存正文，可新增手写知识" : "修改知识并保留历史版本";
  $("delete").disabled = historical;
  $("historical-banner").hidden = !historical;
  $("metadata").replaceChildren();
  for (const [label, value] of [
    ["来源", current.sourceUri],
    ["原作者", current.author === "unknown" ? "未知" : current.author],
    ["来源时间", date(current.observedAt, true)],
    ["保存时间", date(current.recordedAt, true)],
    ["知识编号", current.id],
  ]) {
    $("metadata").append(node("dt", "", label), node("dd", "", value));
  }
  const panel = $("knowledge-content");
  panel.replaceChildren();
  const organization = current.organization;
  const content = organization?.organization;
  const entities = content?.entities || [];
  if (content?.relevance === "historical") {
    panel.append(node("p", "historical-note", "历史资料 · 反映当时的交流与关系"));
  }
  if (content?.context) {
    const context = node("aside", "conversation-context");
    context.append(
      node("h3", "", names(content.context.participantIds, entities)),
      node("p", "", content.context.summary),
    );
    if (content.context.relatedIds?.length) {
      context.append(node("p", "muted", `关联：${names(content.context.relatedIds, entities)}`));
    }
    panel.append(context);
  }
  if (organization?.status === "organized" && organization.organization) {
    if (content.topics.length) {
      panel.append(node("p", "muted", content.topics.join(" · ")));
    }
    for (const entry of content.entries) {
      const card = node("article", "interpretation");
      const speaker = names(entry.speakerIds, entities);
      const addressee = names(entry.addresseeIds, entities);
      const attribution = [speaker || entry.subject, addressee].filter(Boolean).join(" → ");
      card.append(
        node("span", "pill", stanceNames[entry.stance]),
        node("h3", "", entry.summary),
        node("p", "muted", `${attribution}${entry.timeText ? " · " + entry.timeText : ""}`),
      );
      if (entry.aboutIds?.length) {
        card.append(node("p", "muted", `谈及：${names(entry.aboutIds, entities)}`));
      }
      if (entry.relation) {
        card.append(
          node("p", "muted", `${entry.relation.label} · ${basisNames[entry.relation.basis]}`),
        );
      }
      const evidence = node("details", "evidence");
      evidence.append(node("summary", "", "查看依据"), node("blockquote", "", entry.quote));
      card.append(evidence);
      panel.append(card);
    }
  } else {
    panel.append(node("h2", "", current.title));
    panel.append(node("div", "body-text", current.body || "仅保留来源链接，未抓取正文。"));
  }
  tab("knowledge");
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
        node("p", "", historyNote(entry.note)),
      );
      const versionButton = node("button", "secondary", "查看版本");
      versionButton.addEventListener("click", () => {
        void openMaterial(id, entry.revision);
      });
      row.append(copy, versionButton);
      $("history-panel").append(row);
    }
  } catch (error) {
    if (sequence === detailRequest) {
      $("history-panel").textContent = error.message;
    }
  }
}
function historyNote(note) {
  if (!note) {
    return "首次保存";
  }
  try {
    if (JSON.parse(note).kind === "knowledge-refinement") {
      return "知识提炼入库";
    }
  } catch {
    // A user correction note is ordinary text.
  }
  return note;
}
function syncEditor() {
  const reference = editorMode === "new" && $("input-kind").value === "reference";
  $("body-field").hidden = reference;
  $("input-body").required = !reference;
  if (editorMode === "new") {
    $("input-body").maxLength = 2000;
  } else {
    $("input-body").removeAttribute("maxlength");
  }
  $("body-count").textContent = reference
    ? "只保存地址，不抓取正文"
    : editorMode === "new"
      ? `${$("input-body").value.length.toLocaleString()} / 2,000 字`
      : `${new TextEncoder().encode($("input-body").value).length.toLocaleString()} / 262,144 字节`;
}
function openEditor(mode) {
  editorMode = mode;
  editingMaterial = mode === "edit" ? { id: current.id, revision: current.revision } : null;
  returnFocus = document.activeElement;
  $("edit-form").reset();
  $("form-error").hidden = true;
  $("new-fields").hidden = mode !== "new";
  $("input-title").value = mode === "edit" ? current.title : "";
  $("note-field").hidden = mode === "new";
  $("editor-title").textContent = mode === "new" ? "手写知识" : "编辑知识";
  $("edit-description").textContent =
    mode === "new"
      ? "直接记录你已理解、筛选和提炼的知识。聊天、文件等原始材料请通过已连接的 Agent 提炼后提交。"
      : "修改已提炼的知识后会创建新版本，旧版本仍可查看。";
  $("save").textContent = mode === "new" ? "保存知识" : "保存修改";
  requestKey = crypto.randomUUID();
  $("input-body").value = mode === "edit" ? current.body : "";
  if (mode === "edit" && current.organization?.status === "organized") {
    const entries = current.organization.organization.entries;
    if (entries.length === 1 && entries[0].subject === "用户手写知识") {
      $("input-body").value = entries[0].quote;
    }
  }
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
            entryMode: "manual-knowledge",
            title: $("input-title").value.trim(),
            kind: $("input-kind").value,
            body: $("input-kind").value === "reference" ? "" : $("input-body").value,
            sourceUri: $("input-source").value.trim() || "mycortex:manual",
            author: $("input-author").value.trim() || "unknown",
          })
        : await api(`materials/${editingMaterial.id}/correct`, {
            expectedRevision: editingMaterial.revision,
            title: $("input-title").value.trim(),
            body: $("input-body").value,
            note: $("input-note").value.trim() || "用户在客户端修改正文",
          });
    $("editor").close();
    if (view !== "knowledge") {
      setView("knowledge");
    }
    $("search").value = "";
    page = 0;
    message(editorMode === "new" ? "知识已保存。" : "修改已保存，旧版本可在历史中查看。");
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
    message("知识及其全部历史版本已删除。");
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
$("tab-knowledge").addEventListener("click", () => tab("knowledge"));
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
  if (view === "network" && selectedEntity) {
    await openEntity(selectedEntity);
  } else if (view === "knowledge" && currentId) {
    await openMaterial(currentId);
  }
}
$("view-knowledge").addEventListener("click", () => {
  setView("knowledge");
  void loadList();
});
$("view-network").addEventListener("click", () => {
  setView("network");
  void loadList();
});
$("include-historical").addEventListener("change", () => {
  setView(view);
  void loadList();
});
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
  if (innerWidth <= 650) {
    ++detailRequest;
    const historical = !$("historical-banner").hidden;
    $("edit").disabled = !current || historical || current.kind !== "text";
    $("delete").disabled = !current || historical;
    document.querySelector(".workspace").classList.remove("detail-open");
  }
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
    $("connection").textContent = "已连接本地知识库";
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
