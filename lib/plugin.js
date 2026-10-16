/**
 * AI 开发团队模式（DSH Agent preset `devteam`）—— v3：风险分级 + 流水线 DAG。
 *
 * 配置即数据（cordis.patch.yml 的 dev-team 行）：
 *   roles        角色契约（职责/交付物/验收/文档/写入范围/角色手册）
 *   riskTiers    风险等级：决定成员与门禁
 *   pipeline     阶段流水线：决定建哪些看板任务、谁负责、谁等谁
 *   projectDocs  项目 md 文档协议
 *   其余         stackSummary / stackRules / commands / workflow / rules
 *
 * 插件做三件事：
 *   1. 把上面这些渲染成常驻 prompt 蓝图（preset 作用域，Lead 与所有成员都看得到）；
 *   2. `dev_team_start(goal, project?, risk?, roles?)`：按等级选阶段 → 建成带依赖的看板任务 → 按角色建成员；
 *   3. `dev_docs_init(project, docs?)`：把 templates/project/** 的文档骨架落到项目里（只创建缺失文件）。
 *
 * 刻意不 import 任何 npm 包（本地 bundle 以 symlink 装进 profile，裸模块名解析会从工作区出发而失败）。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "dev-team";
export const inject = ["tools", "systemPrompt"];

/** Bundle root, used to resolve this mode's bundled project templates. */
const BUNDLE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const CONFIG_KEYS = [
  "teamName",
  "context",
  "freshProvider",
  "forkProvider",
  "stackSummary",
  "stackRules",
  "commands",
  "workflow",
  "rules",
  "projectDocs",
  "templatesDir",
  "operatingModel",
  "maxMembers",
  "riskTiers",
  "pipeline",
  "roles",
];

const ROLE_KEYS = [
  "name",
  "title",
  "description",
  "phase",
  "skill",
  "duties",
  "deliverables",
  "acceptance",
  "docs",
  "writeScopes",
  "create",
];

const DOC_KEYS = ["path", "title", "purpose", "owner"];
const TIER_KEYS = ["id", "title", "when", "roles", "gates", "solo", "default"];
const STAGE_KEYS = ["id", "title", "owner", "dependsOn", "dependsOnSoft", "tiers", "deliverables"];

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const TIER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Trim a configured string, falling back when it is absent or blank. */
function str(value, fallback = "") {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/** Normalize a configured string list, dropping blanks. */
function list(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** Render a markdown bullet list. */
function bullets(items, indent = "") {
  return items.map((item) => `${indent}- ${item}`).join("\n");
}

/** Report one unknown configuration field. */
function rejectUnknown(keys, allowed, where) {
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${where} 里有未知字段：${unknown.join("、")}（可用字段：${allowed.join("、")}）`);
  }
}

/** Validate and normalize one project-document entry. */
function normalizeDoc(raw, index) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`projectDocs[${index}] 必须是对象`);
  }
  rejectUnknown(Object.keys(raw), DOC_KEYS, `projectDocs[${index}]`);
  const doc = {
    path: str(raw.path),
    title: str(raw.title),
    purpose: str(raw.purpose),
    owner: str(raw.owner, "lead"),
  };
  if (doc.path === "") throw new Error(`projectDocs[${index}] 缺少 path`);
  if (isAbsolute(doc.path) || doc.path.split("/").includes("..")) {
    throw new Error(`projectDocs[${index}].path 必须是项目内的相对路径（收到 "${doc.path}"）`);
  }
  if (doc.title === "") throw new Error(`projectDocs[${index}]（${doc.path}）缺少 title`);
  if (doc.purpose === "") throw new Error(`projectDocs[${index}]（${doc.path}）缺少 purpose`);
  return doc;
}

/** Validate and normalize one configured role. */
function normalizeRole(raw, index) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`roles[${index}] 必须是对象`);
  }
  rejectUnknown(Object.keys(raw), ROLE_KEYS, `roles[${index}]`);
  const role = {
    name: str(raw.name),
    title: str(raw.title),
    description: str(raw.description),
    phase: str(raw.phase),
    skill: str(raw.skill),
    duties: list(raw.duties),
    deliverables: list(raw.deliverables),
    acceptance: list(raw.acceptance),
    docs: list(raw.docs),
    writeScopes: list(raw.writeScopes),
    create: raw.create !== false,
  };
  if (role.name === "") throw new Error(`roles[${index}] 缺少 name`);
  if (!NAME_PATTERN.test(role.name)) {
    throw new Error(`roles[${index}].name "${role.name}" 必须是小写 kebab-case（字母数字与连字符，不能有空格）`);
  }
  if (role.title === "") throw new Error(`roles[${index}]（${role.name}）缺少 title`);
  if (role.description === "") throw new Error(`roles[${index}]（${role.name}）缺少 description`);
  if (role.skill !== "" && !NAME_PATTERN.test(role.skill)) {
    throw new Error(`roles[${index}]（${role.name}）.skill "${role.skill}" 必须是小写 kebab-case`);
  }
  return role;
}

/** Validate and normalize one risk tier. */
function normalizeTier(raw, index) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`riskTiers[${index}] 必须是对象`);
  }
  rejectUnknown(Object.keys(raw), TIER_KEYS, `riskTiers[${index}]`);
  const tier = {
    id: str(raw.id),
    title: str(raw.title),
    when: str(raw.when),
    roles: list(raw.roles),
    gates: list(raw.gates),
    solo: raw.solo === true,
    default: raw.default === true,
  };
  if (tier.id === "") throw new Error(`riskTiers[${index}] 缺少 id`);
  if (!TIER_ID_PATTERN.test(tier.id)) {
    throw new Error(`riskTiers[${index}].id "${tier.id}" 只能用字母数字与连字符`);
  }
  if (tier.title === "") throw new Error(`riskTiers[${index}]（${tier.id}）缺少 title`);
  if (!tier.solo && tier.roles.length === 0) {
    throw new Error(`riskTiers[${index}]（${tier.id}）必须声明 roles，或标 solo: true 表示不建队`);
  }
  return tier;
}

/** Validate and normalize one pipeline stage. */
function normalizeStage(raw, index) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`pipeline[${index}] 必须是对象`);
  }
  rejectUnknown(Object.keys(raw), STAGE_KEYS, `pipeline[${index}]`);
  const stage = {
    id: str(raw.id),
    title: str(raw.title),
    owner: str(raw.owner),
    dependsOn: list(raw.dependsOn),
    dependsOnSoft: list(raw.dependsOnSoft),
    tiers: list(raw.tiers),
    deliverables: list(raw.deliverables),
  };
  if (stage.id === "") throw new Error(`pipeline[${index}] 缺少 id`);
  if (!NAME_PATTERN.test(stage.id)) throw new Error(`pipeline[${index}].id "${stage.id}" 必须是小写 kebab-case`);
  if (stage.title === "") throw new Error(`pipeline[${index}]（${stage.id}）缺少 title`);
  if (stage.owner === "") throw new Error(`pipeline[${index}]（${stage.id}）缺少 owner`);
  return stage;
}

/** Validate the whole plugin row config and return a fully defaulted value. */
function normalizeConfig(raw) {
  const config = raw === null || raw === undefined ? {} : raw;
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new Error("dev-team 配置必须是对象");
  }
  rejectUnknown(Object.keys(config), CONFIG_KEYS, "dev-team 配置");
  const context = str(config.context, "fresh");
  if (context !== "fresh" && context !== "fork") {
    throw new Error(`dev-team 配置的 context 只能是 fresh 或 fork，收到 "${context}"`);
  }

  const roles = Array.isArray(config.roles) ? config.roles.map(normalizeRole) : [];
  const roleNames = new Set();
  for (const role of roles) {
    if (roleNames.has(role.name)) throw new Error(`角色名重复：${role.name}`);
    roleNames.add(role.name);
  }

  const projectDocs = Array.isArray(config.projectDocs) ? config.projectDocs.map(normalizeDoc) : [];
  const docPaths = new Set();
  for (const doc of projectDocs) {
    if (docPaths.has(doc.path)) throw new Error(`projectDocs 路径重复：${doc.path}`);
    docPaths.add(doc.path);
  }
  for (const role of roles) {
    for (const path of role.docs) {
      if (!docPaths.has(path)) {
        throw new Error(`角色 ${role.name} 的 docs 引用了未声明的文档：${path}（请先加进 projectDocs）`);
      }
    }
  }

  const riskTiers = Array.isArray(config.riskTiers) ? config.riskTiers.map(normalizeTier) : [];
  const tierIds = new Set();
  let defaults = 0;
  for (const tier of riskTiers) {
    if (tierIds.has(tier.id)) throw new Error(`风险等级 id 重复：${tier.id}`);
    tierIds.add(tier.id);
    if (tier.default) defaults += 1;
    for (const name of tier.roles) {
      if (!roleNames.has(name)) throw new Error(`风险等级 ${tier.id} 引用了未定义的角色：${name}`);
    }
  }
  if (defaults > 1) throw new Error("riskTiers 里只能有一个 default: true");
  const maxMembers = config.maxMembers === undefined ? 8 : config.maxMembers;
  if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 64) {
    throw new Error(`dev-team 配置的 maxMembers 必须是 1–64 的整数，收到 ${JSON.stringify(config.maxMembers)}`);
  }
  for (const tier of riskTiers) {
    if (!tier.solo && tier.roles.length > maxMembers) {
      throw new Error(
        `风险等级 ${tier.id} 的静态名册 ${tier.roles.length} 人超过 maxMembers=${maxMembers}：` +
          "请减少该等级的角色，或在 agent-team 组合包与本插件里同步提高 maxMembers（两处必须一致）",
      );
    }
  }

  const pipeline = Array.isArray(config.pipeline) ? config.pipeline.map(normalizeStage) : [];
  const stageIds = new Set();
  for (const stage of pipeline) {
    if (stageIds.has(stage.id)) throw new Error(`流水线阶段 id 重复：${stage.id}`);
    stageIds.add(stage.id);
    if (stage.owner !== "lead" && !roleNames.has(stage.owner)) {
      throw new Error(`流水线阶段 ${stage.id} 的 owner "${stage.owner}" 不是已定义的角色`);
    }
    for (const dep of [...stage.dependsOn, ...stage.dependsOnSoft]) {
      if (!stageIds.has(dep) && !pipeline.some((item) => item.id === dep)) {
        throw new Error(`流水线阶段 ${stage.id} 依赖了不存在的阶段：${dep}`);
      }
    }
    for (const tier of stage.tiers) {
      if (!tierIds.has(tier)) throw new Error(`流水线阶段 ${stage.id} 引用了未定义的风险等级：${tier}`);
    }
  }
  if (pipeline.length > 0) {
    const byId = new Map(pipeline.map((stage) => [stage.id, stage]));
    const visiting = new Set();
    const done = new Set();
    /** Depth-first cycle detection over the declared stage graph. */
    const visit = (stage) => {
      if (done.has(stage.id)) return;
      if (visiting.has(stage.id)) throw new Error(`流水线存在循环依赖：${stage.id}`);
      visiting.add(stage.id);
      for (const dep of [...stage.dependsOn, ...stage.dependsOnSoft]) {
        const next = byId.get(dep);
        if (next !== undefined) visit(next);
      }
      visiting.delete(stage.id);
      done.add(stage.id);
    };
    for (const stage of pipeline) visit(stage);
    if (riskTiers.some((tier) => !tier.solo)) {
      for (const tier of riskTiers) {
        if (tier.solo) continue;
        const included = pipeline.some(
          (stage) => stage.tiers.includes(tier.id) || tier.roles.includes(stage.owner),
        );
        if (!included) throw new Error(`风险等级 ${tier.id} 在 pipeline 里选不到任何阶段`);
      }
    }
  }

  return {
    teamName: str(config.teamName, "开发团队"),
    context,
    freshProvider: str(config.freshProvider, "spawn"),
    forkProvider: str(config.forkProvider, "fork"),
    stackSummary: str(config.stackSummary),
    stackRules: list(config.stackRules),
    commands: list(config.commands),
    workflow: list(config.workflow),
    rules: list(config.rules),
    projectDocs,
    templatesDir: str(config.templatesDir, "templates/project"),
    operatingModel: str(config.operatingModel),
    maxMembers,
    riskTiers,
    pipeline,
    roles,
  };
}

/** The project documents one role is responsible for keeping current. */
function docsForRole(role, config) {
  if (role.docs.length > 0) return config.projectDocs.filter((doc) => role.docs.includes(doc.path));
  return config.projectDocs.filter((doc) => doc.owner === role.name);
}

/** Prefix scope paths with the project root when the work targets a subdirectory. */
function scoped(scopes, project) {
  if (project === null) return scopes;
  return scopes.map((scope) => `${project.replace(/\/+$/, "")}/${scope}`);
}

/** The tier used when the caller names none. */
function defaultTier(config) {
  if (config.riskTiers.length === 0) return null;
  return config.riskTiers.find((tier) => tier.default) ?? config.riskTiers[config.riskTiers.length - 1];
}

/**
 * Resolve the stages one run covers.
 * Tier-matched stages come first; stages owned by an explicitly requested role join with
 * their whole dependency chain, so a requested reviewer/security/frontend pulls in the
 * contract work it needs instead of starting on sand.
 */
function planStages(config, tier, requested) {
  const byId = new Map(config.pipeline.map((stage) => [stage.id, stage]));
  const included = new Set();
  const base = [];
  for (const stage of config.pipeline) {
    if (stage.tiers.includes(tier.id)) {
      included.add(stage.id);
      base.push(stage);
    }
  }
  const dynamic = config.pipeline.filter(
    (stage) => !included.has(stage.id) && requested.includes(stage.owner),
  );
  /** Add a stage and its declared ancestors. */
  const addChain = (stage) => {
    if (included.has(stage.id)) return;
    included.add(stage.id);
    for (const dep of stage.dependsOn) {
      const next = byId.get(dep);
      if (next !== undefined) addChain(next);
    }
  };
  for (const stage of dynamic) addChain(stage);
  // 点名角色的阶段带进来后，把「后续阶段」也补上——只要它的负责角色已经在队里。
  // 否则会出现断链：例如加了 agent-dev 却漏掉 qa 的智能体评测阶段。
  const dependents = new Map();
  for (const stage of config.pipeline) {
    for (const dep of stage.dependsOn) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(stage.id);
    }
  }
  const roster0 = new Set([...tier.roles, ...requested]);
  for (let changed = true; changed; ) {
    changed = false;
    const owners = new Set([...roster0]);
    for (const id of included) {
      const stage = byId.get(id);
      if (stage !== undefined) owners.add(stage.owner);
    }
    for (const id of [...included]) {
      for (const nextId of dependents.get(id) ?? []) {
        const next = byId.get(nextId);
        if (next !== undefined && !included.has(next.id) && owners.has(next.owner)) {
          included.add(next.id);
          changed = true;
        }
      }
    }
  }
  /**
   * Nearest included prerequisites of one stage: a stage whose declared dependency the
   * tier left out inherits that dependency's prerequisites (so T1 skips the contract chain
   * instead of blocking on it).
   */
  const memo = new Map();
  const effectiveDeps = (stage) => {
    if (memo.has(stage.id)) return memo.get(stage.id);
    const result = [];
    for (const dep of stage.dependsOn) {
      const next = byId.get(dep);
      if (next === undefined) continue;
      if (included.has(next.id)) result.push(next.id);
      else result.push(...effectiveDeps(next));
    }
    // 软依赖：只在它真的进了本轮计划时才成为前置（不递归补链，避免幻影阻塞）
    for (const dep of stage.dependsOnSoft) {
      if (included.has(dep)) result.push(dep);
    }
    const unique = [...new Set(result)];
    memo.set(stage.id, unique);
    return unique;
  };
  const ordered = [];
  const visited = new Set();
  /** Depth-first emission in dependency order (the graph is acyclic by construction). */
  const emit = (stage) => {
    if (visited.has(stage.id)) return;
    visited.add(stage.id);
    for (const dep of effectiveDeps(stage)) {
      const next = byId.get(dep);
      if (next !== undefined) emit(next);
    }
    ordered.push({ stage, dependsOn: effectiveDeps(stage) });
  };
  for (const stage of base) emit(stage);
  for (const stage of dynamic) emit(stage);
  for (const stage of config.pipeline) if (included.has(stage.id)) emit(stage);
  return ordered;
}

/** Render the always-on blueprint for this mode, shared by Lead and teammates. */
function blueprint(config) {
  const blocks = [];
  blocks.push(`## ${config.teamName}（本会话的开发团队模式）`);
  const roster = config.roles.map((role) => {
    const scopes = role.writeScopes.length > 0 ? `；写入范围 ${role.writeScopes.join("、")}` : "";
    const suffix = role.create === false ? "；默认不建，出现这类需求时点名" : "";
    const manual = role.skill === "" ? "" : `；手册 ${role.skill}`;
    return `- ${role.name}（${role.title}）：${role.description}${scopes}${suffix}${manual}`;
  });
  blocks.push(
    [
      "角色、技术栈、工作流与文档协议都来自 preset 配置，不在对话里临时决定。",
      "每个成员开工前先用 skill 工具加载自己的角色手册（名字见下方角色行的「手册」）——手册讲方法、代码模式与检查清单，任务描述与 docs/ 讲契约，冲突时以契约为准。",
      "开工顺序：先定风险等级 → todo_write 拆阶段 → dev_docs_init / dev_team_start（自动补文档、按等级建流水线任务与成员）→ send_message 派活与 steer → 自己复核 diff 并重跑验收 → 汇总给用户。",
      "建队一次即可；同一个小目标不要反复建队，后续用 send_message 继续派活。",
      "",
      "### 角色",
      roster.length > 0 ? roster.join("\n") : "- （未配置角色：请补 cordis.patch.yml 的 roles）",
    ].join("\n"),
  );
  if (config.riskTiers.length > 0) {
    const tiers = config.riskTiers.map((tier) => {
      const who = tier.solo ? "不建队，Lead 自己做" : tier.roles.join(" + ");
      const gates = tier.gates.length > 0 ? `；门禁 ${tier.gates.join("、")}` : "";
      const mark = tier.default ? "（默认）" : "";
      return `- ${tier.id}${mark} ${tier.title}：${tier.when} → ${who}${gates}`;
    });
    blocks.push(
      [
        "### 风险分级（建队前必须定级，拿不准取高一级）",
        "等级写进 dev_team_start(risk=\"...\")；它决定成员、建哪些阶段任务与要过哪些门。",
        "",
        tiers.join("\n"),
      ].join("\n"),
    );
  }
  if (config.pipeline.length > 0) {
    const stages = config.pipeline.map((stage) => {
      const deps = stage.dependsOn.length > 0 ? ` ← ${stage.dependsOn.join(", ")}` : "";
      const tiers = stage.tiers.length > 0 ? `［${stage.tiers.join("/")}］` : "［点名时］";
      return `- ${stage.id} ${stage.title}（${stage.owner}）${deps} ${tiers}`;
    });
    blocks.push(
      [
        "### 流水线阶段（按等级自动建成带依赖的看板任务）",
        "被点名的角色会把它负责的阶段连同其依赖一起带进本轮；看板上的依赖就是谁在等谁。",
        "",
        stages.join("\n"),
      ].join("\n"),
    );
  }
  if (config.projectDocs.length > 0) {
    const docs = config.projectDocs.map((doc) => `- ${doc.path}（**${doc.owner}**）：${doc.purpose}`);
    blocks.push(
      [
        "### 项目文档协议（每个项目都必须有，且持续更新）",
        "重要信息一律落 md，对话里的结论不算记录：需求与范围、接口与数据模型、决策、验证结果、评审结论都必须写进对应文件。",
        "任务与写入范围都以项目根目录为基准；项目根就是该项目的 git 仓库根。",
        "",
        docs.join("\n"),
      ].join("\n"),
    );
  }
  const stack = [];
  if (config.stackSummary !== "") stack.push(config.stackSummary);
  if (config.stackRules.length > 0) stack.push(bullets(config.stackRules));
  if (stack.length > 0) blocks.push(`### 技术栈与工程约定\n${stack.join("\n")}`);
  if (config.commands.length > 0) blocks.push(`### 常用命令\n${bullets(config.commands)}`);
  if (config.workflow.length > 0) {
    blocks.push(`### 工作流（交接顺序）\n${config.workflow.map((step, index) => `${index + 1}. ${step}`).join("\n")}`);
  }
  if (config.rules.length > 0) blocks.push(`### 团队硬约束\n${bullets(config.rules)}`);
  if (config.operatingModel !== "") {
    blocks.push(`### 完整运营模型\n${config.operatingModel}（流水线、质量门、交接协议、证据等级、WIP 与度量、事故通道；需要细节时读它）`);
  }
  return blocks.join("\n\n");
}

/** Describe one stage task in full. */
function stageDescription(entry, role, goal, project, config) {
  const { stage, dependsOn } = entry;
  const blocks = [
    project === null ? `目标：${goal}` : `目标：${goal}\n项目根目录：${project}`,
    `阶段：${stage.title}（${stage.id}）｜负责人：${role.title}`,
    `职责：${role.description}`,
  ];
  if (dependsOn.length > 0) {
    const titles = dependsOn
      .map((id) => config.pipeline.find((item) => item.id === id)?.title ?? id)
      .join("、");
    blocks.push(`前置阶段（未完成不要开始）：${titles}`);
  } else {
    blocks.push("前置阶段：无，可以立即开始。");
  }
  const work = [...(stage.deliverables.length > 0 ? stage.deliverables : []), ...role.duties];
  if (work.length > 0) blocks.push(`本阶段具体工作：\n${bullets(work)}`);
  if (role.deliverables.length > 0) blocks.push(`角色交付物：\n${bullets(role.deliverables)}`);
  const docs = docsForRole(role, config);
  if (docs.length > 0) {
    blocks.push(`必须更新/维护的项目文档：\n${bullets(docs.map((doc) => `${doc.path} —— ${doc.purpose}`))}`);
  }
  if (role.writeScopes.length > 0) blocks.push(`可写范围：${scoped(role.writeScopes, project).join("、")}`);
  if (role.acceptance.length > 0) blocks.push(`完成判定：\n${bullets(role.acceptance)}`);
  blocks.push("认领方式：team_task_get 读取本任务，team_task_update 动作 claim（带当前 revision）；完成后 complete。");
  return blocks.join("\n\n");
}

/** Compose the self-contained initial prompt for one teammate (all of its stage tasks). */
function memberPrompt(role, tasks, tier, goal, project, config, docs) {
  const blocks = [];
  blocks.push(`你是「${config.teamName}」的${role.title}（teammate 名称：${role.name}）。`);
  if (role.skill !== "") {
    blocks.push(
      `开工前先加载你的角色手册：skill(name="${role.skill}")。手册里有工作方法、代码模式、检查清单与常见坑；本任务的描述与 docs/ 是契约，手册是方法，两者冲突时以契约为准。`,
    );
  }
  blocks.push(`职责：${role.description}`);
  blocks.push(project === null ? `本次目标：${goal}` : `本次目标：${goal}\n项目根目录：${project}（所有路径以此为基准）`);
  if (tier !== null) {
    const gates = tier.gates.length > 0 ? `；本轮门禁：${tier.gates.join("、")}` : "";
    blocks.push(`本轮风险等级：${tier.id} ${tier.title}${gates}`);
  }
  const lines = tasks.map((entry, index) => {
    const deps = entry.dependsOn.length > 0 ? `（依赖 ${entry.dependsOn.join("、")}，未完成不要开始）` : "（无前置，可立即开始）";
    return `${index + 1}. ${entry.taskId}｜${entry.stage.title} ${deps}`;
  });
  blocks.push(
    [
      "你的看板任务（已由 Lead 建好，按顺序做，不要自己另建任务）：",
      ...lines,
      "每条都先 team_task_get 读全文、team_task_update 用 claim 认领（带当前 revision）、完成并自检后 complete。",
      "发现计划缺口或依赖不成立时，先 send_message 给 lead，不要擅自改范围。",
    ].join("\n"),
  );
  if (role.duties.length > 0) blocks.push(`角色职责要点：\n${bullets(role.duties)}`);
  if (role.deliverables.length > 0) blocks.push(`角色交付物：\n${bullets(role.deliverables)}`);
  if (role.writeScopes.length > 0) {
    blocks.push(
      `你只能写这些路径：${scoped(role.writeScopes, project).join("、")}。范围外的文件不要动；确需改动时先 send_message 给 lead 说明原因，等确认。`,
    );
  }
  if (docs.length > 0) {
    blocks.push(
      [
        "你的文档职责（重要信息必须写进文件，对话里的结论不算记录）：",
        bullets(docs.map((doc) => `${doc.path} —— ${doc.purpose}`)),
        "每完成一件值得记住的事就更新对应文件，不要攒到最后；追加式文件（DECISIONS/WORKLOG/REVIEWS）只追加，不重写别人的段落。",
      ].join("\n"),
    );
  }
  const stack = [];
  if (config.stackSummary !== "") stack.push(config.stackSummary);
  if (config.stackRules.length > 0) stack.push(bullets(config.stackRules));
  if (stack.length > 0) blocks.push(`技术栈与工程约定：\n${stack.join("\n")}`);
  if (config.commands.length > 0) blocks.push(`常用命令：\n${bullets(config.commands)}`);
  if (config.workflow.length > 0) {
    blocks.push(`团队工作流：\n${config.workflow.map((step, index) => `${index + 1}. ${step}`).join("\n")}`);
  }
  if (role.acceptance.length > 0) blocks.push(`完成判定（自检后再交）：\n${bullets(role.acceptance)}`);
  if (config.rules.length > 0) blocks.push(`团队硬约束：\n${bullets(config.rules)}`);
  if (config.operatingModel !== "") {
    blocks.push(`完整运营模型（质量门、交接协议、证据等级、DoR/DoD）：${config.operatingModel}`);
  }
  blocks.push(
    "收工要求：跑一遍配置里的验证命令，更新你的文档，然后 send_message 给 lead：`[交接] 任务 <id>（<阶段>）→ 状态；改动=<文件与路径>；验证=<命令> → <结果>；文档=<更新了哪些 md>；给下一个人=<从哪开始>；阻塞=<无/具体>`。只写「已完成」不算交付。",
  );
  return blocks.join("\n\n");
}

/** Compact error text for per-role failure reporting. */
function reason(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve a model-supplied project path, refusing anything outside the process
 * working directory or the user's home directory. Scaffolding only ever creates
 * missing files, so this is a containment guard rather than an authorization one.
 */
function resolveProjectDir(value) {
  const target = resolve(process.cwd(), value);
  const inside = (base) => {
    const rel = relative(base, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (!inside(process.cwd()) && !inside(homedir())) {
    throw new Error(
      `拒绝在工作目录（${process.cwd()}）与用户主目录之外写入：${target}；请把项目放在工作目录或主目录下`,
    );
  }
  return target;
}

/** Render the fallback content for a document whose bundled template is missing. */
function stubDoc(doc) {
  return [
    `# ${doc.title}`,
    "",
    `> 所有者：${doc.owner}　用途：${doc.purpose}`,
    "> 本文件由开发团队模式自动创建（未找到内置模板），请按用途补齐内容。",
    "",
    "## 待填",
    "",
    "- [ ] ",
    "",
  ].join("\n");
}

/** Create the missing project documents for one project root. Never overwrites. */
function scaffoldDocs(config, projectArg, only) {
  const projectDir = resolveProjectDir(projectArg);
  if (!existsSync(projectDir)) throw new Error(`项目目录不存在：${projectArg}（先创建仓库目录再建文档）`);
  if (!statSync(projectDir).isDirectory()) throw new Error(`不是目录：${projectArg}`);
  if (only.length > 0) {
    const unknown = only.filter((pathValue) => !config.projectDocs.some((doc) => doc.path === pathValue));
    if (unknown.length > 0) throw new Error(`未声明的文档：${unknown.join("、")}`);
  }
  const wanted = only.length > 0 ? config.projectDocs.filter((doc) => only.includes(doc.path)) : config.projectDocs;
  const templatesDir = resolve(BUNDLE_DIR, config.templatesDir);
  const created = [];
  const existing = [];
  const missingTemplates = [];
  const failed = [];
  for (const doc of wanted) {
    const target = join(projectDir, doc.path);
    if (existsSync(target)) {
      existing.push(doc.path);
      continue;
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      const template = join(templatesDir, doc.path);
      let content;
      if (existsSync(template)) {
        content = readFileSync(template, "utf8");
      } else {
        content = stubDoc(doc);
        missingTemplates.push(doc.path);
      }
      writeFileSync(target, content, "utf8");
      created.push(doc.path);
    } catch (error) {
      failed.push(`${doc.path}：${reason(error)}`);
    }
  }
  return { project: projectArg, created, existing, missingTemplates, failed };
}

/** Model-facing output helper: canonical value plus compact JSON rendering. */
function jsonOutput(schema) {
  return {
    schema,
    render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
  };
}

const DOCS_VALUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    project: { type: "string" },
    created: { type: "array", items: { type: "string" } },
    existing: { type: "array", items: { type: "string" } },
    missingTemplates: { type: "array", items: { type: "string" } },
    failed: { type: "array", items: { type: "string" } },
  },
  required: ["project", "created", "existing"],
};

/** Build `dev_docs_init`, bound to this row's config. */
function createDocsTool(config) {
  if (config.projectDocs.length === 0) return null;
  return {
    name: "dev_docs_init",
    description:
      "为某个项目创建开发团队模式要求的 md 文档骨架（含 AGENTS.md）。只创建缺失的文件，绝不覆盖已有内容；项目目录不存在时会报错。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        project: {
          type: "string",
          description: "项目根目录（相对当前工作目录或绝对路径）。通常就是该项目的 git 仓库根。",
        },
        docs: {
          type: "array",
          items: { type: "string" },
          description: "只创建这些文档路径（配置里声明的 path）。省略则创建全部。",
        },
      },
      required: ["project"],
    },
    output: jsonOutput(DOCS_VALUE_SCHEMA),
    execute(args, exec) {
      if (exec.agent === undefined) throw new Error("dev_docs_init 需要一个调用方 Agent");
      const input = args === null || args === undefined ? {} : args;
      const project = str(input.project);
      if (project === "") throw new Error("project 不能为空");
      return scaffoldDocs(config, project, list(input.docs));
    },
  };
}

/** Build `dev_team_start`, bound to this row's config. */
function createStartTool(ctx, config) {
  const hasPipeline = config.pipeline.length > 0;
  return {
    name: "dev_team_start",
    description:
      "按本模式配置的开发团队一次性建队：选择风险等级 → 补齐项目文档骨架 → 把该等级的流水线阶段建成带依赖的共享看板任务 → 按角色创建同名 teammate。只有 Team Lead 可以调用；一个目标调用一次。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal: {
          type: "string",
          description:
            "本次开发任务的目标、范围与验收标准。必须自足：成员是全新上下文，看不到用户的原话与你的探索过程。",
        },
        project: {
          type: "string",
          description:
            "项目根目录（相对当前工作目录或绝对路径）。给了它，看板范围与成员提示词里的路径都以它为准，并自动补齐缺失的项目文档。省略表示就在当前工作目录里干活。",
        },
        risk: {
          type: "string",
          description: hasPipeline
            ? `风险等级 id（${config.riskTiers.map((tier) => tier.id).join(" / ")}）。决定成员、阶段任务与门禁；省略用默认等级。拿不准取高一级。`
            : "（本配置未声明风险等级，忽略）",
        },
        roles: {
          type: "array",
          items: { type: "string" },
          description:
            "额外点名的角色（配置里的 name），例如 reviewer / security / release / react-dev / miniprogram-dev。会在等级默认成员之上追加，并把它负责的阶段连同依赖一起带进本轮。",
        },
      },
      required: ["goal"],
    },
    output: jsonOutput({
      type: "object",
      additionalProperties: false,
      properties: {
        teamName: { type: "string" },
        riskTier: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            gates: { type: "array", items: { type: "string" } },
          },
          required: ["id", "title", "gates"],
        },
        project: { type: "string" },
        docs: DOCS_VALUE_SCHEMA,
        stages: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              stage: { type: "string" },
              title: { type: "string" },
              owner: { type: "string" },
              taskId: { type: "string" },
              blockedBy: { type: "array", items: { type: "string" } },
            },
            required: ["stage", "title", "owner", "taskId"],
          },
        },
        members: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              target: { type: "string" },
              role: { type: "string" },
              taskIds: { type: "array", items: { type: "string" } },
              status: { type: "string" },
            },
            required: ["target", "role", "taskIds"],
          },
        },
        failures: { type: "array", items: { type: "string" } },
      },
      required: ["teamName", "members", "stages"],
    }),
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined) throw new Error("dev_team_start 需要一个调用方 Agent");
      const teams = ctx.get("agentTeams");
      if (teams === undefined) {
        throw new Error("dev_team_start 需要 Agent Teams 服务：请先启用 dsh-experimental-agent-team-profile 组合包");
      }
      const membership = teams.tryMembership(agent);
      if (membership === undefined || membership.role !== "lead") {
        throw new Error("只有 Team Lead 可以调用 dev_team_start");
      }
      const input = args === null || args === undefined ? {} : args;
      const goal = str(input.goal);
      if (goal === "") throw new Error("goal 不能为空");
      const failures = [];
      const requested = list(input.roles);
      const unknownRequested = requested.filter((wanted) => !config.roles.some((role) => role.name === wanted));
      if (unknownRequested.length > 0) {
        const available = config.roles.map((role) => role.name).join("、");
        throw new Error(`未定义的角色：${unknownRequested.join("、")}；可用角色：${available}`);
      }

      // 1) 风险等级
      const riskArg = str(input.risk);
      let tier = null;
      if (config.riskTiers.length > 0) {
        if (riskArg !== "") {
          tier = config.riskTiers.find((item) => item.id === riskArg) ?? null;
          if (tier === null) {
            const available = config.riskTiers.map((item) => item.id).join("、");
            throw new Error(`未定义的风险等级：${riskArg}；可用等级：${available}`);
          }
        } else {
          tier = defaultTier(config);
        }
        if (tier !== null && tier.solo) {
          throw new Error(
            `${tier.id}（${tier.title}）不需要建队：Lead 自己做完即可。要组队请选更高等级，或显式传 roles 指定成员。`,
          );
        }
      }

      // 2) 项目路径（先不落盘：容量检查不过就什么都不该产生）
      const projectArg = str(input.project);
      const project = projectArg === "" ? null : projectArg.replace(/\/+$/, "");

      // 3) 成员：等级默认 ∪ 点名 ∪ 流水线阶段所有者
      const roster = [];
      const push = (name) => {
        if (name !== "lead" && !roster.includes(name)) roster.push(name);
      };
      if (tier !== null) for (const name of tier.roles) push(name);
      for (const name of requested) push(name);

      // 4) 阶段计划（无 pipeline 时退化为「一角色一任务」）
      const plan =
        tier !== null && hasPipeline
          ? planStages(config, tier, requested)
          : config.roles
              .filter((role) => (requested.length > 0 ? requested.includes(role.name) : role.create))
              .map((role) => ({ stage: { id: role.name, title: role.phase === "" ? role.title : role.phase, owner: role.name, deliverables: [] }, dependsOn: [] }));
      for (const entry of plan) push(entry.stage.owner);
      if (plan.length === 0) {
        throw new Error("本轮没有任何阶段/角色可建：检查 riskTiers.roles 与 pipeline.tiers 配置");
      }

      // 4) 容量检查：必须在写文件、建任务、建成员之前失败，否则会留下半支队伍
      if (roster.length > config.maxMembers) {
        const tierDefault = tier === null ? [] : tier.roles;
        const extra = roster.filter((name) => !tierDefault.includes(name));
        const options = [];
        if (extra.length > 0) {
          options.push(`去掉点名/连带角色：${extra.join("、")}（它们带来的阶段会一并去掉）`);
        }
        options.push(
          tier === null
            ? "换一个名册更小的等级"
            : `降一级（${tier.id} 的静态名册就有 ${tierDefault.length} 人）或把项目拆成两轮：主体一轮、客户端另一轮`,
        );
        options.push(
          `确需 ${roster.length} 人时：把 agent-team 组合包的 maxMembers 与本插件的 maxMembers 一起提高（两处必须一致）`,
        );
        throw new Error(
          `名册 ${roster.length} 人超过团队上限 maxMembers=${config.maxMembers}：${roster.join("、")}。` +
            `可选：${options.map((option, index) => `${index + 1}) ${option}`).join("；")}`,
        );
      }

      // 5) 项目文档骨架（只创建缺失文件）
      let docs = null;
      if (project !== null) {
        docs = scaffoldDocs(config, projectArg, []);
        for (const item of docs.failed) failures.push(`项目文档：${item}`);
      }

      const existingMembers = new Set(teams.listMembers(agent).map((member) => member.name));
      const membersToSpawn = config.roles.filter((role) => roster.includes(role.name) && !existingMembers.has(role.name));
      for (const role of config.roles) {
        if (roster.includes(role.name) && existingMembers.has(role.name)) {
          failures.push(`${role.name}：同名成员已存在，跳过建成员（用 send_message 直接派活）`);
        }
      }
      if (membersToSpawn.length === 0) {
        throw new Error(
          failures.length > 0
            ? `没有可创建的角色：${failures.join("；")}`
            : "配置里没有可创建的角色，也没有指定 roles",
        );
      }

      // 6) 按拓扑顺序建任务并连依赖
      const tasksByStage = new Map();
      const stages = [];
      for (const entry of plan) {
        const role = config.roles.find((item) => item.name === entry.stage.owner);
        const isLeadOwned = entry.stage.owner === "lead" || role === undefined;
        const ownerRole = role ?? {
          name: "lead",
          title: "技术负责人",
          description: "Lead 亲自完成该阶段",
          phase: "",
          skill: "",
          duties: [],
          deliverables: [],
          acceptance: [],
          docs: [],
          writeScopes: [],
          create: false,
        };
        const blockedBy = entry.dependsOn
          .map((dep) => tasksByStage.get(dep))
          .filter((value) => typeof value === "string");
        try {
          const task = await teams.createTask(agent, {
            subject: `${entry.stage.title}｜${ownerRole.title}`,
            description: stageDescription(entry, ownerRole, goal, project, config),
            writeScopes: isLeadOwned ? [] : scoped(ownerRole.writeScopes, project),
            ...(blockedBy.length > 0 ? { blockedBy } : {}),
          });
          tasksByStage.set(entry.stage.id, String(task.id));
          stages.push({
            stage: entry.stage.id,
            title: entry.stage.title,
            owner: entry.stage.owner,
            taskId: String(task.id),
            blockedBy,
          });
        } catch (error) {
          failures.push(`${entry.stage.id}：阶段任务创建失败（${reason(error)}）`);
        }
      }
      if (stages.length === 0) throw new Error(`没有创建任何阶段任务：${failures.join("；")}`);

      // 7) 按角色建成员，每个成员拿到自己的全部阶段任务
      const context = config.context === "fork" ? "fork" : "fresh";
      const provider = context === "fork" ? config.forkProvider : config.freshProvider;
      const members = [];
      for (const role of membersToSpawn) {
        const owned = stages
          .filter((item) => item.owner === role.name)
          .map((item) => ({
            taskId: item.taskId,
            stage: config.pipeline.find((stage) => stage.id === item.stage) ?? { id: item.stage, title: item.title, deliverables: [] },
            dependsOn: item.blockedBy,
          }));
        if (owned.length === 0) continue;
        try {
          const spawned = await teams.spawnTeammate(agent, {
            name: role.name,
            description: role.description,
            prompt: [
              {
                type: "text",
                text: memberPrompt(role, owned, tier, goal, project, config, docsForRole(role, config)),
              },
            ],
            context,
            provider,
            signal: exec.signal,
          });
          members.push({
            target: spawned.member.name,
            role: role.title,
            taskIds: owned.map((item) => item.taskId),
            status: spawned.member.status,
          });
        } catch (error) {
          failures.push(
            `${role.name}：成员创建失败（${reason(error)}）；其任务已建（${owned.map((item) => item.taskId).join("、")}），可用 spawn_teammate 补建`,
          );
        }
      }
      if (members.length === 0) throw new Error(`未能创建任何成员：${failures.join("；")}`);

      return {
        teamName: config.teamName,
        riskTier: tier === null ? { id: "-", title: "未分级", gates: [] } : { id: tier.id, title: tier.title, gates: tier.gates },
        project,
        docs,
        stages,
        members,
        failures,
      };
    },
  };
}

/**
 * Register the mode's prompt blueprint and its tools in the mounting (preset) scope.
 *
 * The blueprint is documentation assembled from user-authored config text (stack rules, docs
 * protocol, workflow steps), so it is registered with `interpolate: false`: the prompt registry
 * would otherwise parse Jinja-style examples such as `{{ child }}` as prompt-variable references
 * and fail assembly with `malformed prompt variable reference ... in section "dev-team:blueprint"`.
 * @param ctx - the preset scope context.
 * @param config - the row config carrying roles, tiers, pipeline, stack, and docs protocol.
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config);
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: "dev-team:blueprint",
        order: ctx.systemPrompt.getSectionOrder("TEAM_POLICY") + 1,
        interpolate: false,
        text: blueprint(resolved),
      }),
    "dev-team.blueprint",
  );
  ctx.effect(() => ctx.tools.register(createStartTool(ctx, resolved)), "dev-team.tool.start");
  const docsTool = createDocsTool(resolved);
  if (docsTool !== null) {
    ctx.effect(() => ctx.tools.register(docsTool), "dev-team.tool.docs");
  }
}
