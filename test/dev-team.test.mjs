/**
 * AI 开发团队模式插件的本地集成测试（v3：风险分级 + 流水线 DAG）。
 *
 * 用假 ctx / 假 Agent Teams 服务真实跑 apply、dev_docs_init（真写盘）与 dev_team_start 的规划路径。
 * 运行（在仓库根目录）：
 *
 *   node --test test/
 *
 * 真实的 preset 激活与模型可见性只能在会话里验证，见 README「验证状态」。
 */
import assert from "node:assert/strict";
import { existsSync, globSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { apply } from "../lib/plugin.js";

const require = createRequire(import.meta.url);
const yaml = require("/home/eric/.dsh/profiles/web/node_modules/yaml");
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = join(ROOT, "tmp");

/** Parsed preset declaration from the shipped patch. */
function realPatch() {
  const patch = yaml.parse(readFileSync(join(ROOT, "cordis.patch.yml"), "utf8"));
  return patch[0].insert[0].config;
}

/** The `dev-team` row config. */
function realConfig() {
  return realPatch().plugins.find((plugin) => plugin.id === "dev-team").config;
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
      const task = {
        id: `t${next++}`,
        revision: 1,
        subject: request.subject,
        description: request.description,
        writeScopes: request.writeScopes ?? [],
        blockedBy: request.blockedBy ?? [],
      };
      calls.tasks.push(task);
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

/** stageId → { taskId, blockedByTaskIds, subject, owner } */
function stageIndex(result) {
  const index = new Map();
  for (const item of result.stages) {
    index.set(item.stage, { taskId: item.taskId, blockedBy: item.blockedBy ?? [], subject: item.title, owner: item.owner });
  }
  return index;
}

/** Compare a stage's blockers by stage name, independent of task numbering. */
function blockersOf(index, stageId) {
  const byTask = new Map([...index.values()].map((item) => [item.taskId, item]));
  return (index.get(stageId)?.blockedBy ?? [])
    .map((taskId) => [...index.entries()].find(([, item]) => item.taskId === taskId)?.[0] ?? taskId)
    .sort();
}

test("蓝图：角色、手册、风险等级、流水线、文档协议、命令、运营模型路径齐全", () => {
  const { sections, start, docs } = install(teamStub());
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, "dev-team:blueprint");
  assert.equal(sections[0].order, 601, "蓝图应排在 Team 策略（600）之后");
  assert.equal(sections[0].interpolate, false, "蓝图是配置里的文档正文，必须关闭提示词变量插值");
  const text = sections[0].text;
  for (const needle of [
    "pm（产品经理）",
    "dev（后端/全栈开发）",
    "qa（测试/验证）",
    "reviewer（代码评审）",
    "architect（架构与技术设计）",
    "security（安全与合规）",
    "release（发布与可观测性）",
    "react-dev（React 前端开发）",
    "miniprogram-dev（微信小程序开发）",
    "T2（默认）",
    "T3 高风险",
    "req 需求与验收标准（pm）",
    "verify 独立验证与报告（qa）",
    "pyjoist",
    "uv run pytest -q",
    "docs/SECURITY.md",
    "docs/RUNBOOK.md",
    "项目文档协议",
    "OPERATING-MODEL.md",
  ]) {
    assert.ok(text.includes(needle), `蓝图缺少 ${needle}`);
  }
  assert.equal(start.name, "dev_team_start");
  assert.equal(docs.name, "dev_docs_init");
  assert.deepEqual(start.parameters.required, ["goal"]);
  assert.deepEqual(Object.keys(start.parameters.properties), ["goal", "project", "risk", "roles"]);
});

/** Locate the newest installed dsh-system-prompt that honors `interpolate: false`; null when none. */
function findSystemPromptModule() {
  if (typeof globSync !== "function") return null;
  const patterns = [
    `${homedir()}/.npm/_npx/*/node_modules/@deepseek-ai/dsh-system-prompt`,
    `${homedir()}/.dsh/profiles/*/node_modules/@deepseek-ai/dsh-system-prompt`,
  ];
  const found = [];
  for (const pattern of patterns) {
    try {
      for (const dir of globSync(pattern)) {
        const entry = join(dir, "lib/index.js");
        const manifest = join(dir, "package.json");
        if (!existsSync(entry) || !existsSync(manifest)) continue;
        // 0.2.0-rc.1 之前的版本无条件插值，不认识 interpolate:false，测不出这个缺陷。
        if (!readFileSync(entry, "utf8").includes("section.interpolate === false")) continue;
        found.push({ entry, version: JSON.parse(readFileSync(manifest, "utf8")).version ?? "0" });
      }
    } catch {
      // 忽略不可读的候选路径
    }
  }
  found.sort((a, b) => compareVersions(b.version, a.version));
  return found.length > 0 ? found[0].entry : null;
}

/** Compare dotted version strings numerically, then their suffixes as text. */
function compareVersions(a, b) {
  const left = String(a).split(".");
  const right = String(b).split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const numeric = (Number.parseInt(left[i] ?? "0", 10) || 0) - (Number.parseInt(right[i] ?? "0", 10) || 0);
    if (numeric !== 0) return numeric;
    const text = String(left[i] ?? "").localeCompare(String(right[i] ?? ""));
    if (text !== 0) return text;
  }
  return 0;
}

const systemPromptModule = findSystemPromptModule();

test(
  "回归：蓝图里的 {{ child }} 模板示例不会被当成提示词变量（装配不抛错）",
  { skip: systemPromptModule === null ? "本机未找到支持 interpolate:false 的 dsh-system-prompt" : false },
  async () => {
    // 用真实的提示词装配函数（不是本地仿写）跑一遍，才能复现用户看到的报错形态。
    const { renderPrompt } = await import(pathToFileURL(systemPromptModule).href);
    const { sections } = install(teamStub());
    const blueprintSection = sections[0];
    assert.equal(blueprintSection.name, "dev-team:blueprint");
    assert.ok(blueprintSection.text.includes("{{ child }}"), "回归用例依赖真实配置里的 Jinja 模板示例（stackRules）");

    // 打开插值就会复现用户报的错——证明这条用例真的守得住这个缺陷。
    assert.throws(
      () => renderPrompt({ sections: [{ ...blueprintSection, interpolate: undefined }], variables: {} }),
      /malformed prompt variable reference .*in section "dev-team:blueprint"/,
    );
    // 关掉插值后整段原样保留，模板示例照常出现在模型提示词里。
    const rendered = renderPrompt({ sections, variables: {} });
    assert.ok(rendered.includes("{{ child }}"), "模板示例必须原样保留给模型");
  },
);

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
  expectThrow({ ...base, roles: [{ ...base.roles[0], skill: "Bad Manual" }] }, "kebab-case");
  expectThrow({ ...base, projectDocs: [...base.projectDocs, { ...base.projectDocs[0] }] }, "路径重复");
  expectThrow(
    { ...base, projectDocs: [...base.projectDocs, { path: "/etc/passwd", title: "x", purpose: "y" }] },
    "相对路径",
  );
  expectThrow({ ...base, roles: [{ ...base.roles[0], docs: ["docs/NOT-DECLARED.md"] }] }, "未声明的文档");
  // 风险等级
  expectThrow({ ...base, riskTiers: [...base.riskTiers, { ...base.riskTiers[1] }] }, "风险等级 id 重复");
  expectThrow(
    { ...base, riskTiers: base.riskTiers.map((tier) => (tier.id === "T1" ? { ...tier, roles: ["ghost"] } : tier)) },
    "未定义的角色：ghost",
  );
  expectThrow(
    { ...base, riskTiers: base.riskTiers.map((tier) => (tier.default ? { ...tier, default: undefined } : { ...tier, default: true })) },
    "只能有一个 default",
  );
  expectThrow(
    { ...base, riskTiers: base.riskTiers.map((tier) => (tier.id === "T1" ? { ...tier, roles: [], solo: false } : tier)) },
    "必须声明 roles",
  );
  // 流水线
  expectThrow({ ...base, pipeline: [...base.pipeline, { ...base.pipeline[0] }] }, "阶段 id 重复");
  expectThrow(
    { ...base, pipeline: base.pipeline.map((s) => (s.id === "impl" ? { ...s, owner: "ghost" } : s)) },
    "不是已定义的角色",
  );
  expectThrow(
    { ...base, pipeline: base.pipeline.map((s) => (s.id === "impl" ? { ...s, dependsOn: ["ghost"] } : s)) },
    "依赖了不存在的阶段",
  );
  expectThrow(
    { ...base, pipeline: base.pipeline.map((s) => (s.id === "impl" ? { ...s, tiers: ["T9"] } : s)) },
    "未定义的风险等级：T9",
  );
  expectThrow(
    {
      ...base,
      pipeline: base.pipeline.map((s) => (s.id === "impl" ? { ...s, dependsOn: ["unit"] } : s)),
    },
    "循环依赖",
  );
  // 一个等级若选不到任何阶段（例如它只列了没有阶段的角色）必须报错
  const dev = base.roles.find((role) => role.name === "dev");
  expectThrow(
    {
      ...base,
      roles: [...base.roles, { ...dev, name: "ops", title: "运维" }],
      riskTiers: [...base.riskTiers, { id: "T9", title: "空车道", when: "x", roles: ["ops"], gates: [] }],
    },
    "选不到任何阶段",
  );
});

test("角色手册（skill）：配置、磁盘文件与提示词三者一致", async () => {
  const config = realConfig();
  const skillsDir = realPatch().plugins.find((plugin) => plugin.id === "skill-filesystem").config.customSkillDirs[0];
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

  const persona = realPatch().plugins.find((plugin) => plugin.id === "persona").config.prefix;
  assert.ok(persona.includes("dev-team-lead"), "persona 应要求 Lead 先加载编排手册");
  assert.ok(existsSync(join(skillsDir, "dev-team-lead", "SKILL.md")), "缺少 dev-team-lead 手册");

  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    assert.ok(existsSync(join(skillsDir, entry.name, "SKILL.md")), `${entry.name} 缺 SKILL.md`);
  }

  const stub = teamStub();
  const { start } = install(stub);
  await start.execute({ goal: "手册接线验证", risk: "T1" }, exec(lead));
  for (const role of config.roles.filter((item) => ["dev", "qa"].includes(item.name))) {
    const spawn = stub.calls.spawns.find((item) => item.name === role.name);
    assert.ok(spawn, `未创建 ${role.name}`);
    assert.ok(spawn.prompt[0].text.includes(`skill(name="${role.skill}")`), `${role.name} 的提示词应要求先加载 ${role.skill}`);
  }
  const { sections } = install(teamStub());
  for (const role of config.roles) {
    assert.ok(sections[0].text.includes(`手册 ${role.skill}`), `蓝图应列出 ${role.name} 的手册名`);
  }
});

test("T2 标准车道：8 个阶段任务按依赖连成 DAG，3 个成员各拿自己的任务", async () => {
  const stub = teamStub();
  const { start } = install(stub);
  const project = freshProject("lane-t2");
  const result = await start.execute({ goal: "给订单列表加按状态筛选与分页", project }, exec(lead));

  assert.equal(result.riskTier.id, "T2");
  assert.deepEqual(result.riskTier.gates, ["契约门", "测试门", "验收门"]);
  assert.equal(result.project, project);
  assert.equal(result.docs.created.length, 13, "建队时应自动补齐 13 份项目文档");
  assert.deepEqual(result.members.map((m) => m.target), ["pm", "dev", "qa"]);
  assert.equal(result.failures.length, 0);

  const index = stageIndex(result);
  assert.deepEqual([...index.keys()], ["req", "contract", "testplan", "schema", "impl", "unit", "verify", "accept"]);
  assert.deepEqual(blockersOf(index, "req"), []);
  assert.deepEqual(blockersOf(index, "contract"), ["req"]);
  assert.deepEqual(blockersOf(index, "testplan"), ["contract"], "测试计划依赖契约（不是依赖实现），才能与实现并行");
  assert.deepEqual(blockersOf(index, "schema"), ["contract"]);
  assert.deepEqual(blockersOf(index, "impl"), ["schema"]);
  assert.deepEqual(blockersOf(index, "unit"), ["impl"]);
  assert.deepEqual(blockersOf(index, "verify"), ["testplan", "unit"]);
  assert.deepEqual(blockersOf(index, "accept"), ["verify"]);
  assert.deepEqual(index.get("accept").owner, "lead", "验收阶段归 Lead");

  // 成员认领的任务集合
  const dev = result.members.find((m) => m.target === "dev");
  assert.deepEqual(dev.taskIds, [
    index.get("contract").taskId,
    index.get("schema").taskId,
    index.get("impl").taskId,
    index.get("unit").taskId,
  ]);
  const qa = result.members.find((m) => m.target === "qa");
  assert.deepEqual(qa.taskIds, [index.get("testplan").taskId, index.get("verify").taskId]);

  // 任务描述：阶段、目标、项目根、依赖、写入范围（带项目前缀）、完成判定
  const implTask = stub.calls.tasks.find((task) => task.subject.startsWith("实现"));
  assert.ok(implTask.description.includes(`项目根目录：${project}`));
  assert.ok(implTask.description.includes("前置阶段（未完成不要开始）：数据模型与迁移"));
  assert.ok(implTask.description.includes("完成判定"));
  assert.ok(implTask.writeScopes.includes(`${project}/app/`), `写范围应带项目前缀：${implTask.writeScopes.join(",")}`);
  const verifyTask = stub.calls.tasks.find((task) => task.subject.startsWith("独立验证"));
  assert.deepEqual(verifyTask.writeScopes.filter((s) => s.includes("tests/")), [`${project}/tests/integration/`]);
  assert.deepEqual(implTask.blockedBy, [index.get("schema").taskId]);

  // 成员提示词：自足 + 手册 + 风险等级 + 它的任务清单与依赖 + 交接格式
  const devText = stub.calls.spawns.find((s) => s.name === "dev").prompt[0].text;
  for (const needle of [
    "你是「AI 开发团队」的后端/全栈开发",
    'skill(name="dev-team-dev")',
    "给订单列表加按状态筛选与分页",
    `项目根目录：${project}`,
    "本轮风险等级：T2",
    index.get("contract").taskId,
    index.get("impl").taskId,
    `${project}/app/`,
    "docs/DATA.md",
    "[交接] 任务",
  ]) {
    assert.ok(devText.includes(needle), `dev 提示词缺少 ${needle}`);
  }
});

test("T1 快车道：跳过需求与契约阶段，dev + qa 两人四步", async () => {
  const stub = teamStub();
  const { start } = install(stub);
  const result = await start.execute({ goal: "修正金额格式化的小数位", risk: "T1" }, exec(lead));

  assert.equal(result.riskTier.id, "T1");
  assert.deepEqual(result.riskTier.gates, ["测试门", "验收门"]);
  const index = stageIndex(result);
  assert.deepEqual([...index.keys()], ["impl", "unit", "verify", "accept"]);
  assert.deepEqual(blockersOf(index, "impl"), [], "快车道里被跳过的契约链不应阻塞实现");
  assert.deepEqual(blockersOf(index, "accept"), ["verify"]);
  assert.deepEqual(result.members.map((m) => m.target), ["dev", "qa"]);
  assert.equal(result.docs, null, "没给 project 就不建文档");
});

test("T3 高风险车道：12 个阶段、7 个成员、六个门禁", async () => {
  const stub = teamStub();
  const { start } = install(stub);
  const project = freshProject("lane-t3");
  const result = await start.execute({ goal: "把登录改成手机号+验证码并迁移用户表", risk: "T3", project }, exec(lead));

  assert.equal(result.riskTier.id, "T3");
  assert.deepEqual(result.riskTier.gates, ["契约门", "测试门", "评审门", "安全门", "发布门", "验收门"]);
  const index = stageIndex(result);
  assert.deepEqual([...index.keys()], [
    "req",
    "design",
    "contract",
    "testplan",
    "schema",
    "impl",
    "unit",
    "verify",
    "review",
    "security",
    "release",
    "accept",
  ]);
  assert.deepEqual(blockersOf(index, "design"), ["req"]);
  assert.deepEqual(blockersOf(index, "contract"), ["design", "req"]);
  assert.deepEqual(blockersOf(index, "verify"), ["testplan", "unit"]);
  assert.deepEqual(blockersOf(index, "review"), ["verify"]);
  assert.deepEqual(blockersOf(index, "security"), ["review"]);
  assert.deepEqual(blockersOf(index, "release"), ["security"]);
  assert.deepEqual(blockersOf(index, "accept"), ["release"]);
  assert.deepEqual(result.members.map((m) => m.target).sort(), [
    "architect",
    "dev",
    "pm",
    "qa",
    "release",
    "reviewer",
    "security",
  ]);
  const releaseText = stub.calls.spawns.find((s) => s.name === "release").prompt[0].text;
  assert.ok(releaseText.includes("docs/RUNBOOK.md") && releaseText.includes("回滚"));
  const securityText = stub.calls.spawns.find((s) => s.name === "security").prompt[0].text;
  assert.ok(securityText.includes("docs/SECURITY.md"));
});

test("风险等级与点名：T0 拒绝建队、未知等级报错、点名角色带进它负责的阶段", async () => {
  const first = install(teamStub());
  await assert.rejects(() => first.start.execute({ goal: "改文案", risk: "T0" }, exec(lead)), /不需要建队/);
  await assert.rejects(() => first.start.execute({ goal: "x", risk: "T9" }, exec(lead)), /未定义的风险等级：T9/);

  // T2 + reviewer：评审阶段被带进来
  const withReviewer = teamStub();
  const second = install(withReviewer);
  const reviewed = await second.start.execute({ goal: "改造订单导出", risk: "T2", roles: ["reviewer"] }, exec(lead));
  const reviewedIndex = stageIndex(reviewed);
  assert.ok(reviewedIndex.has("review"), "点名 reviewer 应带进评审阶段");
  assert.deepEqual(blockersOf(reviewedIndex, "review"), ["verify"]);
  assert.ok(reviewed.members.some((m) => m.target === "reviewer"));

  // T2 + security：连带评审（security 依赖 review）
  const withSecurity = teamStub();
  const third = install(withSecurity);
  const secured = await third.start.execute({ goal: "接入支付回调", risk: "T2", roles: ["security"] }, exec(lead));
  const securedIndex = stageIndex(secured);
  assert.ok(securedIndex.has("security") && securedIndex.has("review"), "security 应连带 review");
  assert.ok(secured.members.some((m) => m.target === "reviewer"), "连带阶段的所有者要进成员表");

  // T1 + react-dev：带进前端阶段与它依赖的契约链
  const withReact = teamStub();
  const fourth = install(withReact);
  const frontend = await fourth.start.execute({ goal: "做一个实时看板孤岛", risk: "T1", roles: ["react-dev"] }, exec(lead));
  const frontendIndex = stageIndex(frontend);
  assert.ok(frontendIndex.has("fe") && frontendIndex.has("contract"), "前端阶段应带进契约阶段");
  assert.deepEqual(blockersOf(frontendIndex, "fe"), ["contract"]);
  assert.ok(frontend.members.some((m) => m.target === "react-dev"));
});

test("智能体工作流：点名 agent-dev 带进「设计→实现→评测」，评测归 qa 且独立验证等它", async () => {
  const stub = teamStub();
  const { start } = install(stub);
  const result = await start.execute({ goal: "做一个工单分流智能体", risk: "T2", roles: ["agent-dev"] }, exec(lead));

  const index = stageIndex(result);
  for (const id of ["agentdesign", "agentimpl", "agenteval"]) assert.ok(index.has(id), `缺少阶段 ${id}`);
  assert.equal(index.get("agentdesign").owner, "agent-dev");
  assert.equal(index.get("agentimpl").owner, "agent-dev");
  assert.equal(index.get("agenteval").owner, "qa", "评测必须归 qa，保持独立验证");
  assert.deepEqual(blockersOf(index, "agentdesign"), ["req"]);
  assert.deepEqual(blockersOf(index, "agentimpl"), ["agentdesign"]);
  assert.deepEqual(blockersOf(index, "agenteval"), ["agentimpl"]);
  assert.deepEqual(blockersOf(index, "verify"), ["agenteval", "testplan", "unit"], "软依赖应让独立验证等评测");
  assert.deepEqual(result.members.map((m) => m.target), ["pm", "dev", "qa", "agent-dev"]);

  const agentText = stub.calls.spawns.find((s) => s.name === "agent-dev").prompt[0].text;
  for (const needle of [
    "你是「AI 开发团队」的智能体架构与开发",
    'skill(name="dev-team-agent-dev")',
    "docs/AGENTIC.md",
    "app/agents/",
    "本轮风险等级：T2",
  ]) {
    assert.ok(agentText.includes(needle), `agent-dev 提示词缺少 ${needle}`);
  }

  // 非智能体运行不受影响：软依赖不产生幻影阻塞
  const plain = teamStub();
  const second = install(plain);
  const plainResult = await second.start.execute({ goal: "普通功能改动", risk: "T2" }, exec(lead));
  assert.deepEqual(blockersOf(stageIndex(plainResult), "verify"), ["testplan", "unit"]);
  assert.equal(plainResult.stages.length, 8, "非智能体 T2 仍然是 8 个阶段");
});

test("dev_docs_init 真写盘：13 份文档、幂等且不覆盖、越界拒绝", () => {
  const { docs } = install(teamStub());
  const project = freshProject("scaffold");
  const first = docs.execute({ project }, exec(lead));
  assert.equal(first.created.length, 13, `应创建 13 个文档，实际 ${first.created.length}`);
  assert.equal(first.existing.length, 0);
  assert.equal(first.missingTemplates.length, 0, "所有文档都应有内置模板");
  for (const path of first.created) assert.ok(existsSync(join(project, path)), `缺少 ${path}`);
  assert.ok(readFileSync(join(project, "docs/PROJECT.md"), "utf8").includes("非目标"));
  assert.ok(readFileSync(join(project, "docs/RUNBOOK.md"), "utf8").includes("回滚"));
  assert.ok(readFileSync(join(project, "docs/AGENTIC.md"), "utf8").includes("LangGraph"));
  assert.ok(readFileSync(join(project, "docs/SECURITY.md"), "utf8").includes("高危项"));
  assert.ok(readFileSync(join(project, "AGENTS.md"), "utf8").includes("pyjoist"));

  writeFileSync(join(project, "docs/PROJECT.md"), "MARKER-人工内容\n", "utf8");
  const second = docs.execute({ project }, exec(lead));
  assert.equal(second.created.length, 0);
  assert.equal(second.existing.length, 13);
  assert.equal(readFileSync(join(project, "docs/PROJECT.md"), "utf8"), "MARKER-人工内容\n");

  const subset = docs.execute({ project, docs: ["docs/REVIEWS.md"] }, exec(lead));
  assert.deepEqual(subset.created, []);
  assert.throws(() => docs.execute({ project, docs: ["docs/NOPE.md"] }, exec(lead)), /未声明的文档/);
  assert.throws(() => docs.execute({ project: join(TMP, "does-not-exist") }, exec(lead)), /项目目录不存在/);
  assert.throws(() => docs.execute({ project: "/etc/dsh-must-refuse" }, exec(lead)), /拒绝/);
});

test("权限与参数校验：仅 Lead 可建队、缺服务/缺 goal/空 project 报错", async () => {
  const { start, docs } = install(teamStub());
  await assert.rejects(() => start.execute({ goal: "x" }, exec({ id: "s-dev", role: "teammate" })), /只有 Team Lead/);
  await assert.rejects(() => start.execute({ goal: "x" }, exec(undefined)), /调用方 Agent/);
  await assert.rejects(() => start.execute({ goal: "  " }, exec(lead)), /goal 不能为空/);
  await assert.rejects(() => start.execute({ goal: "x", roles: ["ops"] }, exec(lead)), /未定义的角色：ops/);
  assert.throws(() => docs.execute({ project: "" }, exec(lead)), /project 不能为空/);

  const bare = install(undefined);
  await assert.rejects(() => bare.start.execute({ goal: "x" }, exec(lead)), /Agent Teams 服务/);
});

test("重名成员跳过、单点失败隔离", async () => {
  const dup = teamStub({ members: [{ name: "pm", role: "teammate", status: "inactive" }] });
  const first = install(dup);
  const mixed = await first.start.execute({ goal: "y", risk: "T2", project: freshProject("dup") }, exec(lead));
  assert.deepEqual(mixed.members.map((m) => m.target), ["dev", "qa"]);
  assert.ok(mixed.failures.some((f) => f.includes("pm") && f.includes("已存在")));

  const all = teamStub({
    members: [
      { name: "pm", role: "teammate", status: "inactive" },
      { name: "dev", role: "teammate", status: "inactive" },
      { name: "qa", role: "teammate", status: "inactive" },
    ],
  });
  const second = install(all);
  await assert.rejects(() => second.start.execute({ goal: "z", risk: "T2" }, exec(lead)), /没有可创建的角色/);

  const failing = teamStub({ failSpawn: ["qa"] });
  const third = install(failing);
  const partial = await third.start.execute({ goal: "w", risk: "T1" }, exec(lead));
  assert.deepEqual(partial.members.map((m) => m.target), ["dev"]);
  assert.ok(partial.failures.some((f) => f.includes("qa") && f.includes("其任务已建")));
  assert.equal(partial.stages.length, 4, "成员失败不应回滚已建的阶段任务");
});

test("团队容量：超编在动手之前失败，并给出可操作选择", async () => {
  const stub = teamStub();
  const { start } = install(stub);
  await assert.rejects(
    () => start.execute({ goal: "T3 加两个客户端角色", risk: "T3", roles: ["react-dev", "miniprogram-dev"] }, exec(lead)),
    (error) => {
      assert.match(error.message, /超过团队上限 maxMembers=8/);
      assert.match(error.message, /去掉点名\/连带角色/);
      assert.match(error.message, /拆成两轮/);
      assert.match(error.message, /两处必须一致/);
      return true;
    },
  );
  assert.equal(stub.calls.tasks.length, 0, "超编时不允许创建任何看板任务");
  assert.equal(stub.calls.spawns.length, 0, "超编时不允许创建任何成员");

  // 边界：正好等于上限可行（T3 的 7 人 + 1 个客户端角色 = 8）
  const atLimit = teamStub();
  const second = install(atLimit);
  const result = await second.start.execute({ goal: "T3 加一个客户端角色", risk: "T3", roles: ["react-dev"] }, exec(lead));
  assert.equal(result.members.length, 8);
  assert.equal(result.failures.length, 0);
});

test("团队容量：静态超编的等级在激活时就报错", () => {
  const base = realConfig();
  // 6 人上限：T2（3 人）仍合法，T3（7 人）报错并点名该等级
  assert.throws(
    () => apply(harness(teamStub()).ctx, { ...base, maxMembers: 6 }),
    /风险等级 T3 的静态名册 7 人超过 maxMembers=6/,
  );
  assert.throws(() => apply(harness(teamStub()).ctx, { ...base, maxMembers: 2 }), /静态名册 \d+ 人超过 maxMembers=2/);
  assert.throws(() => apply(harness(teamStub()).ctx, { ...base, maxMembers: 0 }), /必须是 1–64 的整数/);
  assert.throws(() => apply(harness(teamStub()).ctx, { ...base, maxMembers: "8" }), /必须是 1–64 的整数/);
});

/** Locate the installed agent-team bundle patch; null when this box has none. */
function findTeamPatch() {
  if (typeof globSync !== "function") return null;
  const patterns = [
    `${homedir()}/.dsh/profiles/*/node_modules/@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml`,
    `${homedir()}/.npm/_npx/*/node_modules/@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml`,
  ];
  for (const pattern of patterns) {
    try {
      const hits = globSync(pattern);
      if (hits.length > 0) return hits[0];
    } catch {
      // 忽略不可读的候选路径
    }
  }
  return null;
}

const teamPatchPath = findTeamPatch();

test(
  "maxMembers 与 agent-team 组合包一致（防两边漂移）",
  { skip: teamPatchPath === null ? "本机未找到 agent-team 组合包 patch" : false },
  () => {
    const patch = yaml.parse(readFileSync(teamPatchPath, "utf8"));
    const inserted = patch.flatMap((entry) => (Array.isArray(entry.insert) ? entry.insert : []));
    const row = inserted.find((item) => item.id === "agent-team");
    assert.ok(row, "未在 patch 里找到 agent-team 行");
    assert.equal(
      realConfig().maxMembers,
      row.config.maxMembers,
      "本插件 maxMembers 必须与 agent-team 的 maxMembers 一致：改一处必须改另一处",
    );
  },
);

test("bundle 清单约定：exports 必须导出 cordis.patch.yml（否则设置页显示「加载失败」）", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.ok(existsSync(join(ROOT, "cordis.patch.yml")), "patch 文件必须存在");
  assert.equal(
    manifest.exports["./cordis.patch.yml"],
    "./cordis.patch.yml",
    "带 exports 字段的包必须显式导出 patch 子路径，否则按包名解析会 ERR_PACKAGE_PATH_NOT_EXPORTED",
  );

  // 本机装了 profile 链接时，做一次真实解析验证（找不到则跳过，不影响别的环境）
  const profileDir = join(homedir(), ".dsh", "profiles", "web");
  if (!existsSync(join(profileDir, "node_modules", "@local", "dsh-ai-dev-team"))) return;
  const resolved = require.resolve("@local/dsh-ai-dev-team/cordis.patch.yml", { paths: [profileDir] });
  assert.equal(resolved, join(ROOT, "cordis.patch.yml"), "通过包名解析 patch 必须落到本仓库文件");
});

test("清理测试临时目录", () => {
  rmSync(TMP, { recursive: true, force: true });
  assert.equal(existsSync(TMP), false);
});
