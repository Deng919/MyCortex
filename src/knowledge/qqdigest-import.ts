import { qqDigestBundleSchema, type QqDigestBundle } from "./qqdigest-contract.js";
import { prepareKnowledgeSubmission } from "./refinement.js";
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

export function importQqDigestBundle(store: KnowledgeStore, raw: unknown) {
  const bundle = qqDigestBundleSchema.parse(raw);
  // Validate every refinement before any write; old raw-only exports are not knowledge.
  const prepared = bundle.candidates.map((candidate) =>
    prepareKnowledgeSubmission(submission(candidate), candidate.organization),
  );
  let imported = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  const materials: Array<{
    candidateId: number;
    materialId: string;
    revision: number;
    status: string;
  }> = [];

  for (const [index, candidate] of bundle.candidates.entries()) {
    const refined = prepared[index];
    if (!refined) {
      skipped++;
      continue;
    }
    const current = store.findByRequestKey(candidate.requestKey);
    if (!current) {
      const saved = store.submitKnowledge(submission(candidate), candidate.organization)!;
      imported += 1;
      materials.push({
        candidateId: candidate.candidateId,
        materialId: saved.id,
        revision: saved.revision,
        status: "imported",
      });
      continue;
    }
    const saved = store.updateKnowledge(
      current.id,
      current.revision,
      submission(candidate),
      candidate.organization!,
    );
    if (saved?.revision === current.revision) {
      unchanged += 1;
      materials.push({
        candidateId: candidate.candidateId,
        materialId: current.id,
        revision: current.revision,
        status: "unchanged",
      });
      continue;
    }
    updated += 1;
    materials.push({
      candidateId: candidate.candidateId,
      materialId: saved!.id,
      revision: saved!.revision,
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
    skipped,
    materials,
  };
}
