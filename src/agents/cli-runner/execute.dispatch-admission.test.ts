import { afterEach, beforeEach, expect, it } from "vitest";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);

beforeEach(() => {
  supervisorSpawnMock.mockResolvedValue(
    createManagedRun({ ...createSuccessfulProcessExit(), stdout: "must not dispatch" }),
  );
});

afterEach(() => supervisorSpawnMock.mockReset());

it.each(["process", "plugin"] as const)(
  "rejects %s dispatch when source admission expires during backend preparation",
  async (kind) => {
    const context = buildPreparedCliRunContext({
      backend: {
        command: process.execPath,
        args: [],
        output: "text",
        input: "stdin",
        systemPromptFileArg: undefined,
      },
    });
    let current = true;
    let pluginDispatched = false;
    context.preparedBackend.beforeExecution = async () => {
      await Promise.resolve();
      current = false;
    };
    context.params.prepareDispatch = async () => {
      if (!current) {
        throw new Error("Source withdrawn during backend preparation");
      }
    };
    if (kind === "plugin") {
      context.executionTarget = {
        kind,
        async *execute() {
          pluginDispatched = true;
          yield { type: "result", subtype: "success", result: "must not dispatch" };
        },
      };
    }

    await expect(executePreparedCliRun(context)).rejects.toThrow(
      "Source withdrawn during backend preparation",
    );
    expect(supervisorSpawnMock).not.toHaveBeenCalled();
    expect(pluginDispatched).toBe(false);
  },
);
