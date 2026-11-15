import type { MessagePort } from "node:worker_threads";
import type { Correction, Material, Submission } from "./contract.js";
import type { OrganizationResult } from "./organization-contract.js";
import type { KnowledgeStore } from "./store.js";

export type KnowledgeCommand =
  | { operation: "submit"; input: Submission }
  | {
      operation: "read";
      input: { id: string; revision?: number; offset?: number; length?: number };
    }
  | { operation: "search"; input: { terms: string[]; limit?: number } }
  | { operation: "list"; input: { limit?: number; offset?: number } }
  | { operation: "history"; input: { id: string } }
  | {
      operation: "correct";
      input: { id: string; expectedRevision: number; correction: Correction };
    }
  | { operation: "delete"; input: { id: string; expectedRevision: number } }
  | { operation: "pending"; input: { limit?: number } }
  | { operation: "organization"; input: { id: string } }
  | {
      operation: "organize";
      input: {
        id: string;
        expectedRevision: number;
        result: OrganizationResult;
        manual?: boolean;
        expectedOrganizationRevision?: number;
      };
    };

export type KnowledgeOutputs = {
  submit: Material;
  read: ReturnType<KnowledgeStore["readSlice"]>;
  search: ReturnType<KnowledgeStore["searchMany"]>;
  list: ReturnType<KnowledgeStore["list"]>;
  history: ReturnType<KnowledgeStore["history"]>;
  correct: Material;
  delete: { deleted: true; id: string };
  pending: ReturnType<KnowledgeStore["pendingOrganizations"]>;
  organization: ReturnType<KnowledgeStore["organization"]>;
  organize: ReturnType<KnowledgeStore["commitOrganization"]>;
};
export type KnowledgeResult<C extends KnowledgeCommand> = KnowledgeOutputs[C["operation"]];
export type KnowledgeWorkerInput = {
  directory: string;
  command: KnowledgeCommand;
  admission: MessagePort;
};
export type KnowledgeWorkerReply =
  | { ok: true; value: KnowledgeOutputs[keyof KnowledgeOutputs] }
  | { ok: false; message: string };
