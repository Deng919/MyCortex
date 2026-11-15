import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const wrapper = path.resolve("scripts/knowledge.ps1");

for (const shell of ["powershell.exe", "pwsh.exe"]) {
  it.skipIf(process.platform !== "win32")(
    `${shell} preserves quoted Unicode arguments, relative paths, and exit codes`,
    () => {
      const directory = temps.make("mycortex-powershell-");
      const cwd = path.join(directory, "调用者 空间");
      fs.mkdirSync(cwd);
      fs.writeFileSync(path.join(cwd, "合成 笔记.txt"), "合成正文：仅测试参数传递。", "utf8");
      function run(...args: string[]) {
        const code = `
          $ErrorActionPreference = 'Stop'
          $ProgressPreference = 'SilentlyContinue'
          [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
          $OutputEncoding = [Console]::OutputEncoding
          $knowledgeArguments = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MYCORTEX_TEST_ARGUMENTS)))
          $knowledgeOutput = & '${wrapper.replaceAll("'", "''")}' @knowledgeArguments
          if ($LASTEXITCODE -eq 0) {
            $knowledgeOutput -join [Environment]::NewLine | ConvertFrom-Json | ConvertTo-Json -Depth 10
          }
          exit $LASTEXITCODE
        `;
        return spawnSync(
          shell,
          [
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            Buffer.from(code, "utf16le").toString("base64"),
          ],
          {
            cwd,
            encoding: "utf8",
            env: {
              ...process.env,
              MYCORTEX_TEST_ARGUMENTS: Buffer.from(
                JSON.stringify(["--store", "知识 空间", ...args]),
              ).toString("base64"),
            },
            timeout: 20000,
          },
        );
      }
      const initialized = run("init");
      expect(initialized.status, initialized.stderr).toBe(0);
      const title = '合成"引号" 标题';
      const sourceUri = 'synthetic:含 空格/\\"来源"/末尾\\';
      const saved = run(
        "add",
        "--file",
        "合成 笔记.txt",
        "--title",
        title,
        "--source",
        sourceUri,
        "--author",
        "合成 作者",
        "--request",
        "quoted-1",
      );
      expect(saved.status, saved.stderr).toBe(0);
      const material = JSON.parse(saved.stdout) as { id: string };
      expect(material).toMatchObject({
        title,
        sourceUri,
        author: "合成 作者",
        body: "合成正文：仅测试参数传递。",
      });
      expect(fs.existsSync(path.join(cwd, "知识 空间", "knowledge.sqlite"))).toBe(true);
      const read = run("read", material.id);
      expect(read.status, read.stderr).toBe(0);
      expect(JSON.parse(read.stdout)).toMatchObject({ title, sourceUri });
      const failed = run("read", "missing-material");
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("Material not found");
    },
    60000,
  );
}
