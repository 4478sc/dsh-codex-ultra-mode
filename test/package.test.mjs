import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("manifest and bundle patch agree on the plugin name", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const patch = await readFile(resolve(root, "cordis.patch.yml"), "utf8");
  assert.equal(manifest.name, "dsh-codex-ultra-mode");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.match(patch, /id: codex-ultra-mode/u);
  assert.match(patch, /name: dsh-codex-ultra-mode/u);
  assert.equal(typeof manifest.dependencies?.["@deepseek-ai/schemastery"], "string");
  assert.equal(typeof manifest.devDependencies?.["@deepseek-ai/dsh-tools"], "string");
  for (const hostRuntime of ["@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-session", "@deepseek-ai/dsh-tools"]) {
    assert.equal(manifest.dependencies?.[hostRuntime], undefined);
  }
  for (const published of manifest.files) {
    assert.equal(typeof published, "string");
    assert.notEqual(published, "test");
    assert.notEqual(published, "chatlogs");
  }
});

test("English and Chinese READMEs state the compatibility boundary and link to each other", async () => {
  const [readme, chineseReadme] = await Promise.all([
    readFile(resolve(root, "README.md"), "utf8"),
    readFile(resolve(root, "README.zh-CN.md"), "utf8"),
  ]);

  assert.match(readme, /<a href="\.\/README\.zh-CN\.md">简体中文<\/a>/u);
  assert.match(readme, /contains no OpenAI private code/iu);
  assert.match(readme, /Known differences from Codex Ultra/u);
  assert.match(readme, /single-writer/iu);

  assert.match(chineseReadme, /<a href="\.\/README\.md">English<\/a>/u);
  assert.match(chineseReadme, /不包含 OpenAI 私有代码/u);
  assert.match(chineseReadme, /已知差异/u);
  assert.match(chineseReadme, /single-writer/u);
});
