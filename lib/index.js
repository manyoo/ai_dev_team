/**
 * AI 开发团队模式（DSH Agent preset `devteam`）。
 *
 * 这个插件把「一支开发团队」变成配置数据：角色表、技术栈、命令、工作流、协作约定、项目文档协议
 * 全部写在 cordis.patch.yml 的 `config` 里。插件负责三件事：
 *   1. 渲染常驻 prompt 蓝图（preset 作用域，Lead 与所有成员都看得到）；
 *   2. `dev_docs_init`：把项目文档骨架（templates/project/**）落到某个项目目录；
 *   3. `dev_team_start`：按角色表建看板任务 + 建成员，成员提示词里带项目根、文档职责与验收标准。
 *
 * 刻意不 import 任何 npm 包（本地 bundle 以 symlink 装进 profile，裸模块名解析会从工作区出发而
 * 失败）；只用 node: 内置模块与手写 JSON Schema。
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

const ROLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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
  if (!ROLE_NAME_PATTERN.test(role.name)) {
    throw new Error(`roles[${index}].name "${role.name}" 必须是小写 kebab-case（字母数字与连字符，不能有空格）`);
  }
  if (role.title === "") throw new Error(`roles[${index}]（${role.name}）缺少 title`);
  if (role.description === "") throw new Error(`roles[${index}]（${role.name}）缺少 description`);
  if (role.skill !== "" && !ROLE_NAME_PATTERN.test(role.skill)) {
    throw new Error(`roles[${index}]（${role.name}）.skill "${role.skill}" 必须是小写 kebab-case`);
  }
  return role;
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
  const seen = new Set();
  for (const role of roles) {
    if (seen.has(role.name)) throw new Error(`角色名重复：${role.name}`);
    seen.add(role.name);
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
      "开工顺序：todo_write 拆阶段 → dev_docs_init（新项目建文档骨架，dev_team_start 会自动补齐）→ dev_team_start（建看板任务 + 建成员）→ send_message 派活与 steer → 自己复核 diff 并重跑验收 → 汇总给用户。",
      "建队一次即可；同一个小目标不要反复建队，后续用 send_message 继续派活。",
      "",
      "### 角色",
      roster.length > 0 ? roster.join("\n") : "- （未配置角色：请补 cordis.patch.yml 的 roles）",
    ].join("\n"),
  );
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
  return blocks.join("\n\n");
}

/** Describe one role's board task. */
function taskSubject(role) {
  return role.phase === "" ? role.title : `${role.title}｜${role.phase}`;
}

/** Describe one role's board task in full, including goal, scope, docs, and acceptance bar. */
function taskDescription(role, goal, project, config) {
  const blocks = [
    project === null ? `目标：${goal}` : `目标：${goal}\n项目根目录：${project}`,
    `职责：${role.description}`,
  ];
  if (role.duties.length > 0) blocks.push(`具体工作：\n${bullets(role.duties)}`);
  if (role.deliverables.length > 0) blocks.push(`交付物：\n${bullets(role.deliverables)}`);
  const docs = docsForRole(role, config);
  if (docs.length > 0) {
    blocks.push(`必须更新/维护的项目文档：\n${bullets(docs.map((doc) => `${doc.path} —— ${doc.purpose}`))}`);
  }
  if (role.writeScopes.length > 0) blocks.push(`可写范围：${scoped(role.writeScopes, project).join("、")}`);
  if (role.acceptance.length > 0) blocks.push(`完成判定：\n${bullets(role.acceptance)}`);
  blocks.push("认领方式：team_task_get 读取本任务，team_task_update 动作 claim（带当前 revision）；完成后 complete。");
  return blocks.join("\n\n");
}

/** Compose the self-contained initial prompt for one teammate. */
function rolePrompt(role, goal, task, project, config, docs) {
  const blocks = [];
  blocks.push(`你是「${config.teamName}」的${role.title}（teammate 名称：${role.name}）。`);
  if (role.skill !== "") {
    blocks.push(
      `开工前先加载你的角色手册：skill(name="${role.skill}")。手册里有工作方法、代码模式、检查清单与常见坑；本任务的描述与 docs/ 是契约，手册是方法，两者冲突时以契约为准。`,
    );
  }
  blocks.push(`职责：${role.description}`);
  blocks.push(project === null ? `本次目标：${goal}` : `本次目标：${goal}\n项目根目录：${project}（所有路径以此为基准）`);
  blocks.push(
    `你的看板任务：${String(task.id)}（${task.subject}）。先 team_task_get 读取，再用 team_task_update 动作 claim（带当前 revision）认领；完成并自检后 complete 收尾。`,
  );
  if (role.duties.length > 0) blocks.push(`具体工作：\n${bullets(role.duties)}`);
  if (role.deliverables.length > 0) blocks.push(`交付物：\n${bullets(role.deliverables)}`);
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
  blocks.push(
    "收工要求：自己跑一遍配置里的验证命令，更新你的文档，然后 send_message 给 lead，内容为「状态 / 改动文件与路径 / 跑过的命令与结果 / 文档更新 / 阻塞或风险」。不要只写“已完成”。",
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
  return {
    name: "dev_team_start",
    description:
      "按本模式配置的开发团队一次性建队：补齐项目文档骨架，为当前目标创建每个角色的共享看板任务，并按角色手册创建同名 teammate。只有 Team Lead 可以调用；一个目标调用一次。",
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
        roles: {
          type: "array",
          items: { type: "string" },
          description: "要创建的角色名（配置里的 name）。省略则创建配置中 create !== false 的全部角色。",
        },
      },
      required: ["goal"],
    },
    output: jsonOutput({
      type: "object",
      additionalProperties: false,
      properties: {
        teamName: { type: "string" },
        project: { type: "string" },
        docs: DOCS_VALUE_SCHEMA,
        members: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              target: { type: "string" },
              role: { type: "string" },
              taskId: { type: "string" },
              status: { type: "string" },
            },
            required: ["target", "role"],
          },
        },
        tasks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              subject: { type: "string" },
              role: { type: "string" },
            },
            required: ["id", "subject"],
          },
        },
        failures: { type: "array", items: { type: "string" } },
      },
      required: ["teamName", "members", "tasks"],
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
      const projectArg = str(input.project);
      const failures = [];

      let project = null;
      let docs = null;
      if (projectArg !== "") {
        docs = scaffoldDocs(config, projectArg, []);
        for (const item of docs.failed) failures.push(`项目文档：${item}`);
        project = projectArg.replace(/\/+$/, "");
      }

      const requested = list(input.roles);
      const unknown = requested.filter((wanted) => !config.roles.some((role) => role.name === wanted));
      if (unknown.length > 0) {
        const available = config.roles.map((role) => role.name).join("、");
        throw new Error(`未定义的角色：${unknown.join("、")}；可用角色：${available}`);
      }
      const wanted = requested.length > 0 ? requested : config.roles.filter((role) => role.create).map((role) => role.name);
      const existing = new Set(teams.listMembers(agent).map((member) => member.name));
      const pending = [];
      for (const role of config.roles) {
        if (!wanted.includes(role.name)) continue;
        if (existing.has(role.name)) {
          failures.push(`${role.name}：同名成员已存在，跳过（用 send_message 直接派活）`);
          continue;
        }
        pending.push(role);
      }
      if (pending.length === 0) {
        throw new Error(
          failures.length > 0
            ? `没有可创建的角色：${failures.join("；")}`
            : "配置里没有 create !== false 的角色，也没有指定 roles",
        );
      }
      const context = config.context === "fork" ? "fork" : "fresh";
      const provider = context === "fork" ? config.forkProvider : config.freshProvider;
      const tasks = [];
      const members = [];
      for (const role of pending) {
        let task;
        try {
          task = await teams.createTask(agent, {
            subject: taskSubject(role),
            description: taskDescription(role, goal, project, config),
            writeScopes: scoped(role.writeScopes, project),
          });
        } catch (error) {
          failures.push(`${role.name}：看板任务创建失败（${reason(error)}）`);
          continue;
        }
        tasks.push({ id: String(task.id), subject: task.subject, role: role.name });
        try {
          const spawned = await teams.spawnTeammate(agent, {
            name: role.name,
            description: role.description,
            prompt: [{ type: "text", text: rolePrompt(role, goal, task, project, config, docsForRole(role, config)) }],
            context,
            provider,
            signal: exec.signal,
          });
          members.push({
            target: spawned.member.name,
            role: role.title,
            taskId: String(task.id),
            status: spawned.member.status,
          });
        } catch (error) {
          failures.push(
            `${role.name}：成员创建失败（${reason(error)}）；任务 ${String(task.id)} 已建，可用 spawn_teammate 补建`,
          );
        }
      }
      if (members.length === 0) {
        throw new Error(`未能创建任何成员：${failures.join("；")}`);
      }
      return { teamName: config.teamName, project, docs, members, tasks, failures };
    },
  };
}

/**
 * Register the mode's prompt blueprint and its tools in the mounting (preset) scope.
 * @param ctx - the preset scope context.
 * @param config - the row config carrying roles, stack, workflow, and the docs protocol.
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config);
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: "dev-team:blueprint",
        order: ctx.systemPrompt.getSectionOrder("TEAM_POLICY") + 1,
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
