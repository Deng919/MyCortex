const privacyNames = { normal: "普通", personal: "个人", "highly-sensitive": "高度敏感" };
const kindNames = {
  person: "人物",
  organization: "组织",
  project: "项目",
  assistant: "助手",
  unknown: "对象",
};

async function loadNetwork() {
  const sequence = ++listRequest;
  $("list-caption").textContent = "正在读取人物…";
  $("refresh").disabled = true;
  try {
    const result = await api(`network?limit=50&offset=${page * 50}&${historicalQuery()}`);
    if (sequence !== listRequest || view !== "network") {
      return;
    }
    $("list").replaceChildren();
    for (const entity of result.entities) {
      const card = node(
        "button",
        "memory-card" + (entity.id === selectedEntity ? " selected" : ""),
      );
      card.dataset.entityId = entity.id;
      if (entity.id === selectedEntity) {
        card.setAttribute("aria-current", "true");
      }
      card.append(
        node("span", "card-title", entityLabel(entity)),
        node("span", "muted", kindNames[entity.kind]),
      );
      card.addEventListener("click", () => {
        void openEntity(entity.id);
      });
      $("list").append(card);
    }
    if (!result.entities.length) {
      $("list").append(
        node("p", "list-empty", "这一页没有人物与关系。\n已提炼知识中的人物将在这里显示。"),
      );
    }
    $("list-caption").textContent = `人物与对象 · ${result.entities.length} 个`;
    $("search-hint").hidden = true;
    $("previous").disabled = page === 0;
    $("next").disabled = !result.truncated || result.entities.length < 50;
    $("page-number").textContent = `第 ${page + 1} 页`;
  } catch (error) {
    if (sequence === listRequest) {
      message(error.message, true);
    }
  } finally {
    if (sequence === listRequest) {
      $("refresh").disabled = false;
    }
  }
}

window.loadNetwork = loadNetwork;
function setView(next) {
  view = next;
  ++listRequest;
  ++detailRequest;
  clearTimeout(searchTimer);
  page = 0;
  for (const key of ["knowledge", "network"]) {
    if (key === view) {
      $("view-" + key).setAttribute("aria-current", "page");
    } else {
      $("view-" + key).removeAttribute("aria-current");
    }
  }
  $("collection-title").textContent = view === "network" ? "人物与关系" : "我的知识";
  $("search").disabled = view === "network";
  $("search").placeholder = view === "network" ? "从人物列表查看关系" : "搜索知识";
  $("detail").hidden = true;
  $("network-detail").hidden = true;
  $("empty").hidden = view === "network";
  $("back").textContent = view === "network" ? "← 人物列表" : "← 知识列表";
  document.querySelector(".workspace").classList.remove("detail-open");
  if (view === "network") {
    $("network-detail").replaceChildren(
      node("h2", "", "从交流语境理解人物"),
      node(
        "p",
        "muted",
        "选择人物，查看有知识依据的关系与共同会话。默认只显示近况和背景，联系人备注与语境推断分别标注。",
      ),
    );
    $("network-detail").hidden = false;
  }
}
function evidenceButton(materialId) {
  const button = node("button", "text-button", "查看依据 →");
  button.addEventListener("click", () => {
    setView("knowledge");
    void loadList();
    void openMaterial(materialId);
  });
  return button;
}
async function openEntity(id) {
  const sequence = ++detailRequest;
  try {
    const result = await api(
      `network?entityId=${encodeURIComponent(id)}&limit=50&${historicalQuery()}`,
    );
    if (sequence !== detailRequest || view !== "network") {
      return;
    }
    selectedEntity = id;
    const entity = result.entities.find((item) => item.id === id);
    const panel = $("network-detail");
    panel.replaceChildren(node("h2", "", entityLabel(entity)));
    if (!entity) {
      panel.append(node("p", "muted", "当前范围内已无此人物的知识依据，请刷新人物列表。"));
    } else {
      panel.append(
        node(
          "p",
          "muted",
          [
            kindNames[entity.kind],
            entity.platform,
            entity.identity?.nativeId ? `账号：${entity.identity.nativeId}` : "",
            entity.identity?.accountScope ? `账号范围：${entity.identity.accountScope}` : "",
            entity.aliases.length ? `别名：${entity.aliases.join("、")}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        ),
        node(
          "p",
          "muted",
          `栏目隐私级别：${privacyNames[result.privacyLevel] || result.privacyLevel}`,
        ),
      );
      panel.append(node("h3", "network-heading", "相关关系"));
      const relations = result.relations.filter(
        (relation) => relation.fromId === id || relation.toId === id || relation.scopeId === id,
      );
      if (!relations.length) {
        panel.append(node("p", "muted", "尚无提炼出的关系陈述。"));
      }
      for (const relation of relations) {
        const card = node("article", "network-card");
        card.append(
          node(
            "h3",
            "",
            `${names([relation.fromId], result.entities)} → ${names([relation.toId], result.entities)}：${relation.label}`,
          ),
          node(
            "p",
            "muted",
            `${basisNames[relation.basis]} · ${stanceNames[relation.stance]} · ${date(relation.observedAt, true)}`,
          ),
          node("p", "", relation.summary),
        );
        if (relation.scopeId) {
          card.append(
            node("p", "muted", `适用语境：${names([relation.scopeId], result.entities)}`),
          );
        }
        card.append(evidenceButton(relation.materialId));
        panel.append(card);
      }
      panel.append(node("h3", "network-heading", "共同会话与项目语境"));
      const conversations = result.conversations.filter(
        (context) => context.participantIds.includes(id) || context.relatedIds?.includes(id),
      );
      if (!conversations.length) {
        panel.append(node("p", "muted", "尚无记录的共同会话语境。"));
      }
      for (const context of conversations) {
        const card = node("article", "network-card");
        card.append(
          node("p", "", context.summary),
          node(
            "p",
            "muted",
            `${names(context.participantIds, result.entities)} · ${date(context.observedAt, true)}`,
          ),
        );
        if (context.relatedIds?.length) {
          card.append(node("p", "muted", `关联：${names(context.relatedIds, result.entities)}`));
        }
        card.append(evidenceButton(context.materialId));
        panel.append(card);
      }
      if (result.truncated) {
        panel.append(
          node("p", "muted", "当前展示部分关系与语境；可从其他人物或知识依据继续查看。"),
        );
      }
    }
    $("empty").hidden = true;
    $("detail").hidden = true;
    panel.hidden = false;
    document.querySelector(".workspace").classList.add("detail-open");
    for (const card of $("list").querySelectorAll("button")) {
      const selected = card.dataset.entityId === id;
      card.classList.toggle("selected", selected);
      if (selected) {
        card.setAttribute("aria-current", "true");
      } else {
        card.removeAttribute("aria-current");
      }
    }
  } catch (error) {
    if (sequence === detailRequest) {
      message(error.message, true);
    }
  }
}
