import { qqDigestBundleSchema, type QqDigestBundle } from "./qqdigest-contract.js";
import type { KnowledgeStore } from "./store.js";

type QqDigestCandidate = QqDigestBundle["candidates"][number];

function submission(candidate: QqDigestCandidate) {
  return {
    requestKey: candidate.requestKey,
    title: candidate.title,
    body: candidate.body,
    sourceUri: candidate.sourceUri,
    author: candidate.author,
    submittedBy: "qq-digest",
    observedAt: candidate.observedAt,
    kind: "text" as const,
  };
}

function equalCurrent(
  current: ReturnType<KnowledgeStore["read"]>,
  next: ReturnType<typeof submission>,
): boolean {
  return (
    current.title === next.title &&
    current.body === next.body &&
    current.sourceUri === next.sourceUri &&
    current.author === next.author &&
    current.submittedBy === next.submittedBy &&
    current.observedAt === next.observedAt &&
    current.kind === next.kind
  );
}

export function importQqDigestBundle(store: KnowledgeStore, raw: unknown) {
  const bundle = qqDigestBundleSchema.parse(raw);
  let imported = 0;
  let updated = 0;
  let unchanged = 0;
  const materials: Array<{
    candidateId: number;
    materialId: string;
    revision: number;
    status: string;
  }> = [];

  for (const candidate of bundle.candidates) {
    const next = submission(candidate);
    const current = store.findByRequestKey(candidate.requestKey);
    if (!current) {
      const saved = store.submit(next);
      imported += 1;
      materials.push({
        candidateId: candidate.candidateId,
        materialId: saved.id,
        revision: saved.revision,
        status: "imported",
      });
      continue;
    }
    if (equalCurrent(current, next)) {
      unchanged += 1;
      materials.push({
        candidateId: candidate.candidateId,
        materialId: current.id,
        revision: current.revision,
        status: "unchanged",
      });
      continue;
    }
    const saved = store.correct(current.id, current.revision, {
      body: next.body,
      note: `QQ Digest 候选 ${candidate.candidateId} 更新至候选版本 ${candidate.candidateRevision}`,
      submittedBy: next.submittedBy,
    });
    updated += 1;
    materials.push({
      candidateId: candidate.candidateId,
      materialId: saved.id,
      revision: saved.revision,
      status: "updated",
    });
  }

  return {
    format: bundle.format,
    version: bundle.version,
    candidates: bundle.candidates.length,
    imported,
    updated,
    unchanged,
    materials,
  };
}
