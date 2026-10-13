/**
 * AI 开发团队模式插件的本地集成测试。
 *
 * 用假 ctx / 假 Agent Teams 服务真实跑 apply、dev_docs_init（真写盘）与 dev_team_start 的执行路径。
 * 运行（在仓库根目录）：
 *
 *   node --test test/
 *
 * 真实的 preset 激活与模型可见性只能在会话里验证，见 README「验证状态」。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { apply } from "../lib/index.js";

const require = createRequire(import.meta.url);
const yaml = require("/home/eric/.dsh/profiles/web/node_modules/yaml");
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = join(ROOT, "tmp");

/** Load the real `dev-team` row config from the shipped patch. */
function realConfig() {
  const patch = yaml.parse(readFileSync(join(ROOT, "cordis.patch.yml"), "utf8"));
  return patch[0].insert[0].config.plugins.find((plugin) => plugin.id === "dev-team").config;
}

/** Fresh project directory for scaffolding tests. */
function freshProject(name) {
  const dir = join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Build a fake preset scope that records what the plugin registers. */
function harness(agentTeams) {
  const sections = [];
  const tools = [];
  const ctx = {
    effect: (effect) => effect(),
    systemPrompt: {
      section: (section) => {
        sections.push(section);
        return () => {};
      },
      getSectionOrder: () => 600,
    },
    tools: {
      register: (tool) => {
        tools.push(tool);
        return () => {};
      },
    },
    get: (name) => (name === "agentTeams" ? agentTeams : undefined),
  };
  return { ctx, sections, tools };
}

/** Apply the real config and return the registered blueprint + tools by name. */
function install(agentTeams) {
  const h = harness(agentTeams);
  apply(h.ctx, realConfig());
  const byName = new Map(h.tools.map((tool) => [tool.name, tool]));
  return { ...h, start: byName.get("dev_team_start"), docs: byName.get("dev_docs_init") };
}

/** Minimal recording Agent Teams stub. */
function teamStub(options = {}) {
  const calls = { tasks: [], spawns: [], members: options.members ?? [] };
  let next = 1;
  return {
    calls,
    tryMembership: (agent) => (agent.role === "teammate" ? { role: "teammate" } : { role: "lead" }),
    listMembers: () => calls.members,
    async createTask(_caller, request) {
      const task = { id: `t${next++}`, revision: 1, subject: request.subject, description: request.description, writeScopes: request.writeScopes ?? [] };
      calls.tasks.push(request);
      return task;
    },
    async spawnTeammate(_caller, request) {
      calls.spawns.push(request);
      if (options.failSpawn?.includes(request.name)) throw new Error("提供方失败");
      return { member: { name: request.name, role: "teammate", status: "provisioning", diagnostics: [] } };
    },
  };
}

const lead = { id: "s-lead", role: "lead" };
const exec = (agent) => ({ agent, signal: new AbortController().signal });

test("真实 patch 配置能渲染出蓝图：角色、技术栈、命令、工作流、文档协议", () => {
  const { sections, start, docs } = install(teamStub());
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, "dev-team:blueprint");
  assert.equal(sections[0].order, 601, "蓝图应排在 Team 策略（600）之后");
  const text = sections[0].text;
  for (const needle of [
    "pm（产品经理）",
    "dev（后端/全栈开发）",
    "qa（测试/验证）",
    "reviewer（代码评审）",
    "react-dev（React 前端开发）",
    "miniprogram-dev（微信小程序开发）",
    "pyjoist",
    "import joist",
    "uv run pytest -q",
    "docs/API.md",
    "docs/TESTING.md",
    "项目文档协议",
    "dev_team_start",
  ]) {
    assert.ok(text.includes(needle), `蓝图缺少 ${needle}`);
  }
  assert.equal(start.name, "dev_team_start");
  assert.equal(docs.name, "dev_docs_init");
  assert.deepEqual(start.parameters.required, ["goal"]);
  assert.deepEqual(Object.keys(start.parameters.properties), ["goal", "project", "roles"]);
});

test("配置错误在激活时报出，而不是静默跑歪", () => {
  const base = realConfig();
  const expectThrow = (config, fragment) => {
    const { ctx } = harness(teamStub());
    assert.throws(() => apply(ctx, config), (error) => error.message.includes(fragment), `未拒绝：${fragment}`);
  };
  expectThrow({ ...base, nope: 1 }, "未知字段");
  expectThrow({ ...base, context: "warm" }, "context");
  expectThrow({ ...base, roles: [...base.roles, { ...base.roles[0] }] }, "角色名重复");
  expectThrow({ ...base, roles: [{ name: "Dev Lead", title: "x", description: "y" }] }, "kebab-case");
  expectThrow({ ...base, roles: [{ name: "dev" }] }, "缺少 title");
  expectThrow({ ...base, projectDocs: [...base.projectDocs, { ...base.projectDocs[0] }] }, "路径重复");
  expectThrow(
    { ...base, projectDocs: [...base.projectDocs, { path: "/etc/passwd", title: "x", purpose: "y" }] },
    "相对路径",
  );
  expectThrow(
    { ...base, roles: [{ ...base.roles[0], docs: ["docs/NOT-DECLARED.md"] }] },
    "未声明的文档",
  );
  expectThrow({ ...base, roles: [{ ...base.roles[0], skill: "Bad Manual" }] }, "kebab-case");
});

test("角色手册（skill）：配置、磁盘文件与提示词三者一致", async () => {
  const patch = yaml.parse(readFileSync(join(ROOT, "cordis.patch.yml"), "utf8"));
  const plugins = patch[0].insert[0].config.plugins;
  const config = plugins.find((plugin) => plugin.id === "dev-team").config;
  const skillsDir = plugins.find((plugin) => plugin.id === "skill-filesystem").config.customSkillDirs[0];

  // 1) skill 根目录就是本仓库的 skills/，且被运行时会用到
  assert.equal(skillsDir, join(ROOT, "skills"));
  assert.ok(existsSync(skillsDir), "skills 目录必须存在");

  /** Parse a SKILL.md frontmatter block with the real YAML parser (catches quoting bugs). */
  const frontmatter = (file) => {
    const text = readFileSync(file, "utf8");
    assert.ok(text.startsWith("---\n"), `${file} 应以 YAML frontmatter 开头`);
    const end = text.indexOf("\n---", 4);
    assert.ok(end > 0, `${file} 的 frontmatter 未闭合`);
    const parsed = yaml.parse(text.slice(4, end)) ?? {};
    return { ...parsed, body: text.slice(end + 4) };
  };

  // 2) 每个角色都有手册，且 frontmatter 合法、目录名与 name 一致
  for (const role of config.roles) {
    assert.ok(role.skill, `角色 ${role.name} 应配置 skill`);
    const file = join(skillsDir, role.skill, "SKILL.md");
    assert.ok(existsSync(file), `缺少 ${role.skill}/SKILL.md`);
    const fm = frontmatter(file);
    assert.equal(fm.name, role.skill, `${role.skill} 的 frontmatter name 必须与目录名一致`);
    assert.ok(typeof fm.description === "string" && fm.description.length > 20, `${role.skill} 的 description 要能说明何时加载`);
    assert.ok(typeof fm.whenToUse === "string" && fm.whenToUse.length > 0, `${role.skill} 应写 whenToUse`);
    assert.ok(fm.body.trim().length > 500, `${role.skill} 正文要有实际内容`);
  }

  // 3) Lead 的编排手册：persona 点名 + 文件存在
  const persona = plugins.find((plugin) => plugin.id === "persona").config.prefix;
  assert.ok(persona.includes("dev-team-lead"), "persona 应要求 Lead 先加载编排手册");
  assert.ok(existsSync(join(skillsDir, "dev-team-lead", "SKILL.md")), "缺少 dev-team-lead 手册");

  // 4) 发现规则：skill 只能是 <name>/SKILL.md 一层，不能嵌套
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    assert.ok(existsSync(join(skillsDir, entry.name, "SKILL.md")), `${entry.name} 缺 SKILL.md`);
  }

  // 5) 提示词与蓝图都要指向手册
  const stub = teamStub();
  const { start } = install(stub);
  await start.execute({ goal: "手册接线验证", roles: config.roles.map((role) => role.name) }, exec(lead));
  for (const role of config.roles) {
    const spawn = stub.calls.spawns.find((item) => item.name === role.name);
    assert.ok(spawn, `未创建 ${role.name}`);
    assert.ok(
      spawn.prompt[0].text.includes(`skill(name="${role.skill}")`),
      `${role.name} 的提示词应要求先加载 ${role.skill}`,
    );
  }
  const { sections } = install(teamStub());
  for (const role of config.roles) {
    assert.ok(sections[0].text.includes(`手册 ${role.skill}`), `蓝图应列出 ${role.name} 的手册名`);
  }
  assert.ok(sections[0].text.includes("每个成员开工前先用 skill 工具加载自己的角色手册"));
});

test("dev_docs_init 真写盘：建齐文档、内容来自模板、幂等且不覆盖", () => {
  const { docs } = install(teamStub());
  const project = freshProject("scaffold");
  const first = docs.execute({ project }, exec(lead));
  assert.equal(first.created.length, 10, `应创建 10 个文档，实际 ${first.created.length}`);
  assert.equal(first.existing.length, 0);
  assert.equal(first.missingTemplates.length, 0, "所有文档都应有内置模板");
  for (const path of first.created) {
    assert.ok(existsSync(join(project, path)), `缺少 ${path}`);
  }
  const projectMd = readFileSync(join(project, "docs/PROJECT.md"), "utf8");
  assert.ok(projectMd.includes("项目说明"), "模板内容应被复制");
  assert.ok(projectMd.includes("非目标"), "PROJECT.md 模板应包含非目标小节");
  const agentsMd = readFileSync(join(project, "AGENTS.md"), "utf8");
  assert.ok(agentsMd.includes("pyjoist") && agentsMd.includes("uv run pytest -q"), "AGENTS.md 应含栈与命令");

  // 幂等：第二次全部已存在；且不改写人工内容
  writeFileSync(join(project, "docs/PROJECT.md"), "MARKER-人工内容\n", "utf8");
  const second = docs.execute({ project }, exec(lead));
  assert.equal(second.created.length, 0);
  assert.equal(second.existing.length, 10);
  assert.equal(readFileSync(join(project, "docs/PROJECT.md"), "utf8"), "MARKER-人工内容\n");

  // 子集创建 + 未声明路径 + 目录不存在 + 越界拒绝
  const subset = docs.execute({ project, docs: ["docs/REVIEWS.md"] }, exec(lead));
  assert.deepEqual(subset.created, []);
  assert.throws(() => docs.execute({ project, docs: ["docs/NOPE.md"] }, exec(lead)), /未声明的文档/);
  assert.throws(() => docs.execute({ project: join(TMP, "does-not-exist") }, exec(lead)), /项目目录不存在/);
  assert.throws(() => docs.execute({ project: "/etc/dsh-must-refuse" }, exec(lead)), /拒绝/);
});

test("dev_team_start：带 project 时自动补文档、范围加前缀、角色提示词含项目根与文档职责", async () => {
  const stub = teamStub();
  const { start } = install(stub);
  const project = freshProject("with-project");
  const result = await start.execute({ goal: "给登录页加图形验证码", project }, exec(lead));

  assert.deepEqual(result.members.map((m) => m.target), ["pm", "dev", "qa"]);
  assert.equal(result.failures.length, 0);
  assert.equal(result.project, project);
  assert.equal(result.docs.created.length, 10, "建队时应自动补齐文档");

  // 看板任务：subject 带阶段，writeScopes 带项目前缀，描述含文档职责与验收标准
  assert.equal(stub.calls.tasks[0].subject, "产品经理｜需求");
  const devTask = stub.calls.tasks[1];
  assert.ok(devTask.description.includes(`项目根目录：${project}`));
  assert.ok(devTask.description.includes("docs/API.md"));
  assert.ok(devTask.description.includes("完成判定"));
  assert.ok(devTask.writeScopes.includes(`${project}/app/`), `dev 范围应带项目前缀：${devTask.writeScopes.join(",")}`);
  assert.ok(devTask.writeScopes.includes(`${project}/tests/unit/`));
  const qaTask = stub.calls.tasks[2];
  assert.deepEqual(
    qaTask.writeScopes.filter((scope) => scope.includes("tests/")),
    [`${project}/tests/integration/`],
    "dev 与 qa 的 tests 范围不能重叠",
  );

  // 成员提示词：自足 + 项目根 + 文档职责 + 验收标准 + pyjoist 约定
  const devText = stub.calls.spawns.find((s) => s.name === "dev").prompt[0].text;
  for (const needle of [
    "你是「AI 开发团队」的后端/全栈开发",
    "给登录页加图形验证码",
    `项目根目录：${project}`,
    "t2",
    `${project}/app/`,
    "docs/DATA.md",
    "Alembic",
    "send_message 给 lead",
  ]) {
    assert.ok(devText.includes(needle), `dev 提示词缺少 ${needle}`);
  }
  const pmText = stub.calls.spawns.find((s) => s.name === "pm").prompt[0].text;
  assert.ok(pmText.includes("非目标"), "pm 提示词应强调非目标");
  const qaText = stub.calls.spawns.find((s) => s.name === "qa").prompt[0].text;
  assert.ok(qaText.includes("docs/TESTING.md") && qaText.includes("最小复现"));
});

test("dev_team_start：不带 project 时范围不加前缀；点名与按需角色可用", async () => {
  const stub = teamStub();
  const { start } = install(stub);
  const result = await start.execute({ goal: "修一个后端小 bug" }, exec(lead));
  assert.equal(result.project, null);
  assert.equal(result.docs, null);
  assert.deepEqual(stub.calls.tasks[0].writeScopes, ["docs/PROJECT.md", "docs/DECISIONS.md"]);
  assert.deepEqual(stub.calls.spawns.map((s) => s.name), ["pm", "dev", "qa"]);

  const client = teamStub();
  const second = install(client);
  const clientResult = await second.start.execute(
    { goal: "做一个数据看板 SPA", project: freshProject("spa"), roles: ["dev", "react-dev"] },
    exec(lead),
  );
  assert.deepEqual(clientResult.members.map((m) => m.target), ["dev", "react-dev"]);
  const reactText = client.calls.spawns.find((s) => s.name === "react-dev").prompt[0].text;
  assert.ok(reactText.includes("frontend/") && reactText.includes("docs/FRONTEND.md"));
  const reactTask = client.calls.tasks[1];
  assert.ok(reactTask.description.includes("按需加入") || reactTask.description.includes("富客户端"));
});

test("仅 Lead 可调用 dev_team_start；缺少团队服务时给出可操作错误", async () => {
  const { start, docs } = install(teamStub());
  await assert.rejects(() => start.execute({ goal: "x" }, exec({ id: "s-dev", role: "teammate" })), /只有 Team Lead/);
  await assert.rejects(() => start.execute({ goal: "x" }, exec(undefined)), /调用方 Agent/);
  await assert.rejects(() => start.execute({ goal: "  " }, exec(lead)), /goal 不能为空/);
  assert.throws(() => docs.execute({ project: "" }, exec(lead)), /project 不能为空/);

  const bare = install(undefined);
  await assert.rejects(() => bare.start.execute({ goal: "x" }, exec(lead)), /Agent Teams 服务/);
});

test("未定义角色 / 重名成员跳过 / 单点建队失败", async () => {
  const first = install(teamStub());
  await assert.rejects(() => first.start.execute({ goal: "x", roles: ["ops"] }, exec(lead)), /未定义的角色：ops/);

  const dup = teamStub({ members: [{ name: "pm", role: "teammate", status: "inactive" }] });
  const second = install(dup);
  const mixed = await second.start.execute({ goal: "y", project: freshProject("dup") }, exec(lead));
  assert.deepEqual(mixed.members.map((m) => m.target), ["dev", "qa"]);
  assert.ok(mixed.failures.some((f) => f.includes("pm") && f.includes("已存在")));

  const all = teamStub({
    members: [
      { name: "pm", role: "teammate", status: "inactive" },
      { name: "dev", role: "teammate", status: "inactive" },
      { name: "qa", role: "teammate", status: "inactive" },
    ],
  });
  const third = install(all);
  await assert.rejects(() => third.start.execute({ goal: "z" }, exec(lead)), /没有可创建的角色/);

  const failing = teamStub({ failSpawn: ["qa"] });
  const fourth = install(failing);
  const partial = await fourth.start.execute({ goal: "w" }, exec(lead));
  assert.deepEqual(partial.members.map((m) => m.target), ["pm", "dev"]);
  assert.equal(partial.tasks.length, 3);
  assert.ok(partial.failures.some((f) => f.includes("qa") && f.includes("任务 t3 已建")));
});

test("清理测试临时目录", () => {
  rmSync(TMP, { recursive: true, force: true });
  assert.equal(existsSync(TMP), false);
});
