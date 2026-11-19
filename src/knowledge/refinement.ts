import { createHash } from "node:crypto";
import { submissionSchema, type Submission } from "./contract.js";
import { validateOrganization, type KnowledgeOrganization } from "./organization-contract.js";

const stances = {
  explicit: "来源明确表述",
  intent: "计划或意向",
  uncertain: "尚不确定",
  "other-view": "他人观点",
};

/** Source bodies are transient. Only selected evidence accompanies the knowledge. */
export function prepareKnowledgeSubmission(raw: Submission, refinement?: KnowledgeOrganization) {
  const source = submissionSchema.parse(raw);
  if (source.kind === "reference") {
    return { input: source, sourceFingerprint: undefined, refinement: undefined };
  }
  if (!refinement) {
    throw new Error("Knowledge requires source-backed refinement before saving");
  }
  const knowledge = validateOrganization(refinement, source.body);
  if (!knowledge.entries.length) {
    return null;
  }
  const sourceFingerprint = createHash("sha256").update(JSON.stringify(source)).digest("hex");
  const entities = new Map(knowledge.entities?.map((entity) => [entity.id, entity.name]));
  const names = (ids: string[] | undefined) => ids?.map((id) => entities.get(id)!).join("、");
  const body = knowledge.entries
    .map((entry) =>
      [
        `## ${entry.summary}`,
        `归属：${entry.subject}`,
        `立场：${stances[entry.stance]}`,
        ...(entry.speakerIds?.length ? [`说话者：${names(entry.speakerIds)}`] : []),
        ...(entry.addresseeIds?.length ? [`交流对象：${names(entry.addresseeIds)}`] : []),
        ...(entry.aboutIds?.length ? [`谈及对象：${names(entry.aboutIds)}`] : []),
        ...(entry.timeText ? [`来源中的时间表述：${entry.timeText}`] : []),
        "",
        "依据原话：",
        entry.quote,
      ].join("\n"),
    )
    .join("\n\n");
  return {
    sourceFingerprint,
    refinement: knowledge,
    input: submissionSchema.parse({
      ...source,
      title: knowledge.entries[0]!.summary.slice(0, 240),
      body: `${knowledge.topics.length ? `主题：${knowledge.topics.join("、")}\n\n` : ""}${knowledge.context ? `交流语境：${knowledge.context.summary}\n参与者：${names(knowledge.context.participantIds)}\n\n` : ""}${body}\n\n来源：${source.sourceUri}`,
    }),
  };
}

export function sourceFingerprintFromNote(note: string): string | null {
  try {
    const value: unknown = JSON.parse(note);
    if (
      typeof value !== "object" ||
      value === null ||
      !("kind" in value) ||
      value.kind !== "knowledge-refinement" ||
      !("sourceFingerprint" in value)
    ) {
      return null;
    }
    return typeof value.sourceFingerprint === "string" &&
      /^[a-f0-9]{64}$/.test(value.sourceFingerprint)
      ? value.sourceFingerprint
      : null;
  } catch {
    return null;
  }
}
