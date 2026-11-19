import type { KnowledgeOrganization } from "./organization-contract.js";

export type NetworkOptions = {
  entityId?: string;
  includeHistorical?: boolean;
  limit?: number;
  offset?: number;
};
export type NetworkSource = {
  materialId: string;
  revision: number;
  observedAt: string | null;
  organization: KnowledgeOrganization;
};
export type NetworkPrivacyLevel = "normal" | "personal" | "highly-sensitive";
export type NetworkEntity = {
  id: string;
  name: string;
  kind: NonNullable<KnowledgeOrganization["entities"]>[number]["kind"];
  aliases: string[];
  identity?: NonNullable<KnowledgeOrganization["entities"]>[number]["identity"];
  nickname?: string;
  remark?: string;
  platform?: string;
  materialIds: string[];
};
type Relation = NonNullable<KnowledgeOrganization["entries"][number]["relation"]> & {
  summary: string;
  stance: KnowledgeOrganization["entries"][number]["stance"];
  materialId: string;
  revision: number;
  observedAt: string | null;
};
type Conversation = NonNullable<KnowledgeOrganization["context"]> & {
  materialId: string;
  revision: number;
  observedAt: string | null;
};

/** A projection of permitted current knowledge, never a second relationship store. */
export function buildKnowledgeNetwork(sources: NetworkSource[], options: NetworkOptions = {}) {
  const limit = options.limit ?? 30;
  const offset = options.offset ?? 0;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new Error("Network needs limit 1–50 and a nonnegative offset");
  }
  const entities = new Map<string, NetworkEntity>();
  const relations: Relation[] = [];
  const conversations: Conversation[] = [];
  const privacyRank: Record<NetworkPrivacyLevel, number> = {
    normal: 0,
    personal: 1,
    "highly-sensitive": 2,
  };
  let privacyLevel: NetworkPrivacyLevel = "normal";
  const selected = sources
    .filter(
      ({ organization }) =>
        (options.includeHistorical || organization.relevance !== "historical") &&
        (!options.entityId ||
          organization.entities?.some((entity) => entity.id === options.entityId)),
    )
    .toSorted(
      (a, b) => (Date.parse(b.observedAt ?? "") || 0) - (Date.parse(a.observedAt ?? "") || 0),
    );
  for (const { organization, ...evidence } of selected) {
    const sourcePrivacy = organization.privacyLevel ?? "normal";
    if (privacyRank[sourcePrivacy] > privacyRank[privacyLevel]) {
      privacyLevel = sourcePrivacy;
    }
    for (const entity of organization.entities ?? []) {
      const existing = entities.get(entity.id);
      const aliases = new Set([
        ...(existing?.aliases ?? []),
        entity.name,
        ...(entity.aliases ?? []),
      ]);
      if (existing) {
        existing.aliases = [...aliases].filter((name) => name !== existing.name).slice(0, 24);
        if (!existing.materialIds.includes(evidence.materialId)) {
          existing.materialIds.push(evidence.materialId);
        }
      } else {
        entities.set(entity.id, {
          id: entity.id,
          name: entity.name,
          kind: entity.kind,
          aliases: [...aliases].filter((name) => name !== entity.name).slice(0, 24),
          ...(entity.identity
            ? {
                identity: entity.identity,
                nickname: entity.identity.nickname,
                remark: entity.identity.remark,
                platform: entity.identity.platform,
              }
            : {}),
          materialIds: [evidence.materialId],
        });
      }
    }
    if (organization.context) {
      conversations.push({ ...organization.context, ...evidence });
    }
    for (const entry of organization.entries) {
      if (entry.relation) {
        relations.push({
          ...entry.relation,
          summary: entry.summary,
          stance: entry.stance,
          ...evidence,
        });
      }
    }
  }
  const all = [...entities.values()].toSorted((a, b) => {
    if (a.id === options.entityId) {
      return -1;
    }
    if (b.id === options.entityId) {
      return 1;
    }
    return a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id);
  });
  const page = all.slice(offset, offset + limit);
  const visible = new Set(page.map((entity) => entity.id));
  const visibleRelations = relations.filter(
    (relation) =>
      visible.has(relation.fromId) &&
      visible.has(relation.toId) &&
      (!relation.scopeId || visible.has(relation.scopeId)),
  );
  const visibleConversations = conversations.filter((conversation) =>
    conversation.participantIds.every((id) => visible.has(id)),
  );
  return {
    privacyLevel,
    entities: page,
    relations: visibleRelations.slice(0, 100),
    conversations: visibleConversations.slice(0, 100),
    truncated:
      all.length > offset + limit ||
      offset > 0 ||
      relations.length > visibleRelations.length ||
      visibleRelations.length > 100 ||
      conversations.length > visibleConversations.length ||
      visibleConversations.length > 100,
  };
}
