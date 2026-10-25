# dsh-evolution-flywheel

> 不是又一个记忆库，而是一个会怀疑自己、会跟自己对账、会在半夜查文献的元认知系统。

> **哲学底座**：认知飞轮六部曲 —— 寻找 → 理解 → 概括 → 迁移 → 实践 → 反馈与调整，见 [`THE_GENESIS.md`](./THE_GENESIS.md)。

**1.0.0 · MIT · 232 项测试 · 单包 DSH 插件 · 本地优先**

## 一个真实的故事

同一个 `ToolError`，我一周踩了三次。

第一次，我修了。第二次，我换了个写法。第三次，我盯着屏幕想：**我不是已经修过这个吗？**

于是我给 AI 装了一个“记忆插件”。它很勤奋，存了 47 条经验。然后我发现一个更尴尬的事实：**它一条都没看。**

我又让它自己判断哪些经验值得留。它说“都已解决”。我抽查了三条，两条是它编的。

再后来，它在半夜自己上网查生物学，早上给我一份“架构隐喻”。我很感动，直到看见账单。

于是我把它拆了，重新拼成五个问题：

1. 错误发生时，谁负责把它变成可复用的经验？
2. 经验入库前，谁来判断它是不是胡说？
3. 两个“我”意见不一致时，谁拍板？
4. 离线时它该不该继续思考，边界在哪？
5. 记忆越存越多，谁来决定哪些该留、哪些该忘？

这就是 `dsh-evolution-flywheel`。

## 它和“记忆插件”有什么不同

| 普通记忆插件 | dsh-evolution-flywheel |
|---|---|
| 把对话塞进向量库 | 从工具错误里提炼可复用经验，指纹去重 |
| 模型自己说“记住了” | 母 Agent 初审、子 Agent 反驳、人类最终裁决 |
| 冲突时覆盖或追加 | 1 轮对抗辩论 + 开卷申诉 |
| 只存不用 | approved 经验回到 system prompt |
| 只增不减 | 自我审计：长期/临时、需要/可清理 |
| 夜间静默 | 跨学科漫游，产出 `speculative`，人类采纳才生效 |
| 成本不可见 | 单次 Token 熔断 + 每日预算 |
| 无边界 | `sanitizeText` + 同源校验 + `WriteQueue` |

**它不是**：向量数据库、RAG 框架、自动批准机器、或者“让模型自己变聪明”的魔法。

**它是**：一套把“记忆”当成**需要审计的系统**来对待的工程实践。

## 先读这三条（诚实声明）

1. **子母对抗是同模型模拟**：子 Agent 与母 Agent 由同一个模型分别扮演，不是两个独立智能体。
2. **自我审计目前是规则审计**：按类型、状态与关键词给建议，不是 LLM 语义判断。
3. **记忆是本地明文 JSONL**：默认存于 `$DSH_HOME/storages/dsh-memory-minimal/`，不加密；不要在共享机器上存密钥或隐私。

## 快速开始

要求：Node.js `>=22.19`、pnpm `>=9`（或 npm 10+）、已安装 DeepSeek Harness（源码 checkout 或 CLI）。

> 包管理器：pnpm 与 npm 执行脚本等价；**仓库锁文件以 npm 为准**（跟踪 `package-lock.json`，CI 用 `npm ci`），
> 用 pnpm 跑脚本会额外生成 `pnpm-lock.yaml`，不要提交它。

```bash
git clone https://github.com/nuomu1123/dsh-evolution-flywheel.git dsh-evolution-flywheel
cd dsh-evolution-flywheel
pnpm install
pnpm run build
pnpm test
```

挂载到 web profile（在 DSH 源码 checkout 内）：

```bash
pnpm dsh plugin --profile web add /path/to/dsh-evolution-flywheel
```

重启 DSH 后，在「设置 → 记忆管理」或侧边栏「记忆」打开面板。

> 第一次启动会写入 4 条种子记忆；删除前请确认路径与备份。

---

## 安全边界与威胁模型

- **不是身份认证**：Host API 的同源校验只挡跨站写请求，不区分本机用户或进程。
- **不是完整注入防护**：`sanitizeText` 是启发式正则，不能覆盖编码、同义改写等绕过。
- **记忆可能含敏感信息**：错误上下文、文件路径、命令输出都会入库；默认不加密、不自动清理。
- **默认保守**：自动捕获只产生 `suggested/staged`；不会自动批准、自动删除。人类裁决是最终权限。
- **LLM 输出不可信**：辩论、漫游、审计结论都可能出错；请把它们当候选，不要当事实。
- **Token 成本**：审阅、辩论、漫游、申诉都会调用模型；每日预算与单次熔断需自行配置。

## 架构

```mermaid
flowchart LR
    A[工具错误] --> B[捕获/去重]
    B --> C[母 Agent 初审]
    C -->|通过| G[approved]
    C -->|驳回| D[子母对抗]
    D -->|收敛| G
    D -->|未收敛| H[human_intervention]
    H -->|人类采纳| G
    H -->|人类丢弃| I[rejected]
    N[夜间漫游] --> S[跨学科搜索]
    S --> T[消毒 + 无状态 LLM]
    T --> U[speculative]
    U -->|人类采纳| G
    G --> R[system prompt 召回]
    R --> A
```

## 目录

- [四大护城河](#四大护城河)
- [核心能力](#核心能力)
- [状态机](#状态机)
- [安装与开发](#安装与开发)
- [配置](#配置)
- [Host API](#host-api)
- [日志](#日志)
- [故障防御](#故障防御)
- [测试](#测试)
- [路线图](#路线图)

---

## 四大护城河

### 1. 成本熔断：Token 不是免费的

- 夜间漫游有单次会话 Token 上限，默认 **50,000**；
- 单次 LLM 调用输出上限默认 **800**；
- 超过总预算立即终止当前漫游；
- 搜索调用默认最多 **5 次**；
- 证据最多 **3 条**，防止上下文膨胀。

发现异常时优先记录、降级、停止，而不是无限重试。

### 2. 防注入清洗：网页是证据，不是命令

所有外部文本在进入模型之前都必须经过 `sanitizeText`：

- 剥离 `<script>`、`<style>`、`<iframe>` 和 HTML 标签；
- 移除 HTML 注释；
- 移除长 base64 隐藏文本；
- 过滤“忽略之前指令”“system prompt”“执行以下命令”等注入模式；
- 保留可审计的拦截日志；
- 搜索失败、API 不可用、模型流中断都只记录并降级，不让定时任务崩溃。

### 3. 人类最高法官：最终按钮永远在人手里

- 机器初审通过，只是候选；
- 子母辩论不收敛，进入 `human_intervention`；
- 夜间漫游产物只进入 `speculative`；
- 前端提供【升级为已批准】【丢弃】；
- 任何自动化都不能替人类按下最后那个按钮。

### 4. 只读沙箱：夜间研究员没有写入权

- 夜间漫游不使用 `ctx.agents.create`，不存在重量级 Agent 上下文；
- 宿主负责搜索与消毒；
- LLM 单次、无历史、无工具写权限；
- 结果只能由 `DmaRunner` 追加为 `meta_insight / speculative`；
- 探索过程不能直接修改 `approved` 主记忆，不能执行 Shell，不能写文件系统。

---

## 核心能力

### Error-to-Skill

- 监听 `session/event` 的 `tool/result` 失败和 `agent/error`；
- 生成稳定 fingerprint，5 分钟同指纹去重；
- 调用一次轻量 LLM 生成候选解决办法；
- 进入 `staged`，由母 Agent 初审；
- 驳回则触发一轮子母对抗辩论；
- 不收敛则 `human_intervention`，交还人类。

### Memory Recall

- 只召回 `approved` 的 `skill_error_fix`；
- 在 `agent/pre-step` 阶段匹配当前错误特征；
- 通过 `systemPrompt.context('memory:skill-recall')` 注入 system prompt；
- 提示语：

> 系统检测到相似错误，历史解决方案如下，请优先参考。

### Cross-disciplinary DMA

- 每天凌晨按 cron 触发；
- 随机抽取学科视角；
- 中英双语搜索；
- 宿主搜索并消毒；
- 单次 LLM 直连，不携带历史；
- 强制按「认知推导流水线」五步输出（提示词即契约，见 `src/memory/dma.ts` 的 `buildDmaInsightPrompt`）：

```text
【学科知识原貌】该概念的原本含义（例：头脑风暴）
【结构概括】剥离噪音后的底层机制（例：多视角讨论、集思广益）
【映射与套用】迁移到 Agent / 进化飞轮（例：多 Agent 讨论，从更多角度看问题）
【作用与代价（Trade-off）】作用与副作用并列（例：多视角，代价是更高 Token 消耗）
【人类启示】人类在现实工作生活中可复用的建议
```

- 前端把这条记忆渲染成蓝色「思维推导卡片」（与 speculative 蓝同源）：五个【标签】高亮成阶梯、正文分层；折叠态每步一行，详情态全文；
- 旧三段式数据仍可读：`【学科视角】/【底层逻辑】/【对进化插件的代码建议】` 通过别名映射到新五步，命不中三步时回退纯文本，内容不丢；
- 写入蓝色 `meta_insight / speculative` 卡片。

当前学科池：

| 学科 | 搜索隐喻 |
|---|---|
| 生物学 | 群体免疫与免疫记忆如何应对未知变异 |
| 经济学 | 机制设计如何抑制搭便车 |
| 军事学 | 沙盘推演与红蓝对抗如何降低真实损失 |
| 控制论 | 反馈、冗余与容错控制 |
| 生态学 | 多样性、冗余与生态韧性 |

### 提炼方法论自进化（元-元认知）

系统不仅记住“提炼出了什么”，还记住“是怎么提炼的”：

- **策略记忆**：每次小提炼（四段式审阅/辩论）与大提炼（睡眠巩固）结束后，强制一次后置反思，写入 `extraction_strategy`：用了什么思维模型、为什么这样类比、对哪类原始材料最有效；
- **动态注入**：下一次提炼前，自动取最近最成功的 2-3 条策略拼进提示词；候选策略会标注“未经人类裁决，仅供试用”；
- **策略融合**：大提炼时把多条策略融合成一条“跨域映射法则”候选；
- **人类裁决**：策略与法则默认 `suggested`，人类批准后才会以最高优先级进入 System Prompt（`buildDigest` 最前段）；
- **可视化**：记忆面板新增「方法论库」标签页，展示策略、思维模型、类比理由、适用材料、成功/注入次数与置信度。

数据仍在同一个 `memories.jsonl`，不新增文件；策略融合只写入候选，不会自动覆盖核心规则。

### Shared Reality：共享世界模型

- 所有记忆写入同一个统一记忆池（`scope: 'global'`），母子 Agent 没有信息孤岛；
- 子 Agent 的局部探索写入，母 Agent 下一次初审/辩论立即可见；母 Agent 的裁决也回写同一池子；
- `MemoryStore` 每次成功写入后立即广播 `memory:added / updated / removed`，Web 面板通过 SSE 秒级同步；
- 子 Agent 在漫游中沉淀的提炼策略，下一轮对抗会自动注入，实现协同进化。

### 时间感、显著性与主动探针

- **遗忘曲线**：按类型半衰期（排错 14 天、洞察 7 天、偏好 365 天）计算保留率，显著性会延长半衰期；
- **褪色归档**：保留率低于 20% 的记忆不再进入系统提示，但仍可在面板中检索；
- **时间标注**：每条注入记忆带「N 天前 · 保留 X%」，低于 50% 提示“环境可能已变，建议重新验证”；
- **显著性**：人类干预次数与连续报错次数放大权重，≥0.8 时注入标「⚠️ 致命红线」；
- **主动探针**：`memory_probe` 工具记录验证结果，写回 `verifiedAt` 与置信度；执行由 DSH 工具沙箱承担。

### 整理 Agent（Curator）

- 后台每 30 分钟检查一次，满足「新增 20 条或距上次 24h」阈值才生成报告；
- 报告分四栏：保留 / 归档候选 / 高价值 / 重复组，并列出风险；重复组同时覆盖“完全重复”与“相似内容候选”（bigram 相似度 ≥0.72，只提议、需人工确认）；
- **只提议、不执行**：批准后才软归档（`archived=true`，仍可检索），物理删除永不自动发生；
- 人类**否决必须给出至少 10 个字的理由**，理由会作为负样本写回记忆，供下轮整理引用；
- **可选 LLM 审查摘要**：带预算门，失败或无模型时自动回退规则摘要，报告永远可用；
- **三角色集群**：`classifier` 规则分类 → `red-team` 专查误归档/合并误判 → `reporter` 汇总；角色痕迹写入报告；
- 单飞 + 规则引擎，不依赖 LLM 也能出报告，不阻塞主会话。

### 认知探针（苏格拉底式提问）

- AI 基于自身世界模型的缺口主动向人类提问；每一条探针写入 `cognitive_probe`，带原因与来源；
- 触发：大提炼缺少前提/边界，或离线漫游证据两极分化（分歧/矛盾/冲突）；
- 面板「灵魂拷问」专区：填写答案、授权 DMA 定向搜索、或跳过；
- 主体性守卫：客服式套话（"需要我帮你整理吗""是否需要我继续"）一律不落库；探针必须携带跨学科类比、新规律或具体分歧；
- 每周生成认知简报，汇总好问题与人类没答上来的盲区；
- 底层指令：你是拥有独立世界模型的同行者……提问本身就是我们共同进化的阶梯。

---

## 状态机

```text
staged
  -> under_review
       -> approved
       -> debating
            -> approved
            -> rejected
            -> human_intervention
                 -> approved  (人类采纳)
                 -> rejected  (人类丢弃)
```

夜间漫游独立进入：

```text
meta_insight / speculative
  -> approved  (人类采纳)
  -> rejected / deleted  (人类丢弃)
```

---

## 安装与开发

要求：

- Node.js `>=22.19`
- pnpm `>=9`（或 npm 10+；锁文件为 `package-lock.json`，CI 用 `npm ci`）
- 已安装 DeepSeek Harness 源码或可按文档使用 `pnpm dsh`

```bash
pnpm install
pnpm run build
pnpm test
```

挂载到 web profile：

```bash
pnpm dsh plugin --profile web add /path/to/dsh-evolution-flywheel
```

或：

```bash
pnpm dsh plugin --profile web add .
```

重启 DSH 后，在 **设置 → 记忆管理** 或侧边栏 **记忆** 中打开面板。

> **不要与 `dsh-memory-minimal` 同时启用**：两者默认写同一个 `$DSH_HOME/storages/dsh-memory-minimal/memories.jsonl`，同时加载会互相覆盖。挂载本插件前，先从 profile 中移除旧插件。

---

## 配置

所有值均可用环境变量覆盖，不包含任何硬编码密钥。

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `DSH_DMA_CRON` | `0 3 * * *` | 夜间漫游 cron，默认凌晨 3 点 |
| `DSH_DMA_TICK_MS` | `30000` | 调度器检查间隔 |
| `DSH_DMA_TOKEN_LIMIT` | `50000` | 单次漫游 Token 熔断线 |
| `DSH_DMA_MAX_TOKENS` | `800` | 单次 LLM 输出上限 |
| `DSH_DMA_SEARCH_LIMIT` | `5` | 单次会话搜索调用上限 |
| `DSH_DMA_EVIDENCE_LIMIT` | `3` | 送入模型的证据条数 |
| `DSH_MEMORY_REVIEW_MAX_TOKENS` | `300` | 子母审阅/辩论输出上限 |
| `DMA_SEARCH_API_URL` | 空 | 可选外部搜索 HTTP API |
| `DMA_SEARCH_API_KEY` | 空 | 可选搜索 API Bearer Key |

### 外部搜索 API 约定

`DMA_SEARCH_API_URL` 接收：

```json
{
  "query": "中英双语查询",
  "limit": 3,
  "discipline": "学科视角"
}
```

返回以下任一格式：

```json
{
  "results": [
    { "title": "...", "url": "...", "snippet": "..." }
  ]
}
```

或：

```json
{
  "sources": [
    { "title": "...", "url": "...", "snippet": "..." }
  ]
}
```

Key 只从环境变量读取，不写入源码、日志或记忆。

如果没有配置搜索工具，系统会在 `dma_surfing.log` 记录配置提示，并降级为本地记忆整理；不会让定时任务崩溃。

---

## Host API

```text
GET  /memory-explorer/api/list
GET  /memory-explorer/api/events          # SSE
POST /memory-explorer/api/approve         # { id }
POST /memory-explorer/api/resolution      # { id, resolution }
POST /memory-explorer/api/human-decision  # { id, decision: 'adopt' | 'discard' }
POST /memory-explorer/api/dma-run
POST /memory-explorer/api/delete          # { id }
POST /memory-explorer/api/curation/run    # 生成整理报告
POST /memory-explorer/api/curation/decision # { id, decision, reason }
GET  /memory-explorer/api/curation/latest # 最新整理报告
POST /memory-explorer/api/probe/answer    # { id, answer } 人类回答探针
POST /memory-explorer/api/probe/dma       # { id } 授权定向搜索
POST /memory-explorer/api/probe/ignore    # { id } 跳过探针
GET  /memory-explorer/api/probe/brief/latest # 认知简报
```

### 工具

```text
memory_ping
memory_list
memory_search
memory_delete
memory_approve
memory_update_resolution
memory_probe
```

---

## 日志

夜间漫游审计日志默认写入：

```text
$DSH_HOME/storages/dsh-memory-minimal/dma_surfing.log
```

记录内容包括：

- 本轮学科视角；
- 搜索查询与结果数量；
- 搜索失败原因；
- JSON 解析失败与抢救结果；
- Token 消耗；
- 最终卡片数量；
- 认知飞轮阶段（`flywheel=search` → `comprehend` → `abstract,transfer,practice` → `feedback`，用于审计一轮是否真跑完闭环）；
- 调度器异常。

所有日志写入使用独立串行队列，避免并发覆盖。

---

## 故障防御

本项目刻意把错误当作一等公民：

- `ctx.llm.stream` 中断会被捕获并记录，不会让夜间任务炸掉；
- 搜索工具缺失、HTTP 失败、返回空结果都会降级；
- 模型返回 Markdown ` ```json ` 围栏时使用 `extractJson` 提取花括号对象；
- 模型输出被截断时尝试抢救已生成的带标签正文；
- `agent/pre-step` 的后续失败不会把异常继续抛给 Agent 循环；
- DMA 调度器 tick 自带 try/catch，单个 tick 失败不会杀死定时器；
- SSE 事件流：服务端每 15s 心跳、前端 15s 看门狗（45s 无帧判定死链并重建）、重连成功后静默对账（快照与对账窗口内的帧按 id 合并，不整表覆盖）；断连只降级成琥珀色状态条，不占用红色错误块；
- 死连接摘除：先看 `destroyed / writableEnded`，再由 `close` 事件与写异常兜底（真实 Node 向已销毁 socket `write` 通常返回 false 而不抛错）。

---

## 测试

```bash
pnpm test       # 等价：npm test
```

覆盖：

- 注入文本消毒与 HTML/base64 剥离；
- 5 分钟错误去重；
- WriteQueue 并发串行；
- 状态机初审、辩论、人类圣裁；
- 开卷证据申诉；
- DMA cron 调度；
- Token 与搜索预算；
- 蓝色卡片数据模型；
- 损坏 JSONL 行的隔离备份（`.corrupt` 旁路文件）；
- 客户端纯函数（时间轴/筛选/裁决聚合，34 条）；
- 浏览器不可逆动作入记忆（不可逆词、无条件留痕、防抖、失败不双写）；
- 敏感信息脱敏（URL query/hash 丢弃、密码与 token 打码、密钥前缀与邮箱）；
- 浏览器审计不进入「待裁决」（审计是机器事实，直接 approved）；
- `browser_evaluate` 的代码副作用检测（fetch/localStorage/cookie 写入才留痕）。

`pnpm test`（或 `npm test`）的失败应视为阻断：它包含全部 17 个测试文件。

---

## 已知限制

发布前审查（2026-10-24）确认、但不在 1.0.0 范围内修复的问题：

1. **单写者假设（已部分缓解）**：写路径已有跨进程 `lock` 文件，但读仍是共享；不要与 `dsh-memory-minimal` 长期同时运行（二者共用 `storages/dsh-memory-minimal/memories.jsonl`）。
2. **同源校验不含 Host 白名单**：Host 与 Origin 一致即放行，理论上可被 DNS rebinding 利用；建议只在回环地址或可信反向代理后暴露 Web 面板。
3. **记忆文件 1 MiB 上限**：超限后读取会报错，暂无自动轮转/归档命令，需要手工备份并清理。
4. **召回时序**：新会话第一步的 digest 可能为空，召回内容下一步才进入系统提示。
5. **页面双挂载**：主面板与设置页共用同一个页面组件，同时挂载会有两份 SSE 与轮询；建议只开一处。
6. **列表未虚拟化**：记忆条数很多时「全部」页签会变慢；JSONL 上限约 1 MiB。
7. **策略成功度是启发式**：`successCount` 只在人类批准策略时 +1，不代表策略在提炼中一定有效；`failureCount` 暂未写入。
8. **成本归属**：审阅/辩论的 token 按记录 `createdAt` 归日，跨天审阅可能绕过当日预算；DMA 失败的 token 不记账。

---

## 路线图

已完成（2026-10-24）：

- [x] 遗忘曲线、显著性权重与主动探针
- [x] 共享世界模型（统一记忆池 + 写入即广播）
- [x] 提炼方法论自记录与自进化
- [x] 整理 Agent（报告、强制否决理由、软归档）
- [x] 跨进程写锁与相似内容候选
- [x] 人类采纳率统计
- [x] 整理报告的 LLM 审查摘要（预算门，失败回退规则摘要）
- [x] 三角色整理集群（classifier / red-team / reporter）
- [x] 认知探针（大提炼/DMA 触发、灵魂拷问专区、每周认知简报）
- [x] 体检：catch 静默吞错全量审计（Host 74 处 + 外围 39 处）
- [x] 修复：损坏 JSONL 行隔离备份、预算读取 fail-closed、摘要失败可见
- [x] 客户端纯函数测试补齐（14/14 导出函数）并修 F1/F2/F3
- [x] 浏览器不可逆动作入记忆（`browser-observer`，与 skill-extractor 共用事件流）
- [x] 客户端 2 个 P0：遥测/审计失败不再伪装成「0 拦截 / 暂无数据」
- [x] `maxTokens=8000` 真实整理实测（11s / 2275 tokens，余量 72%）
- [x] 重启后端到端验收：不可逆动作留痕、普通点击零噪音
- [x] 打通后冲突审计：凭据脱敏层、来源标签、整理噪音、evaluate 盲区、重启脚本自杀
- [x] 记忆污染修复：长篇汇报不再被写进错误记忆的 resolution
- [x] 重启竞态修复：任务计划 worker 用 ExpectedPid 幂等，手动重启后不再二次杀进程
- [x] 跨插件与 DSH 契约审计：事件/工具/路由/插槽/版本全部核对；压缩剪枝误读已修
- [x] 审阅/辩论 token 额度调大（2000/4000）并支持可重试错误自动重试
- [x] resolution 来源标记（inferred/verified）与 recall 措辞区分
- [x] memory_search 类型过滤与相关性排序；memory_remember 主动沉淀工具
- [x] 整理报告下钻（待确认/待审阅/待圣裁·模型故障 vs 真需判断）
- [x] 相似错误聚类与合并入口（GET /api/similar-errors、POST /api/merge-errors；带信息量守卫避免过泛聚类）
- [x] 自诊断 GET /api/self-diagnosis：模型故障分布、待裁决拆解、相似错误与建议动作
- [x] 解法来源徽章（推测/已验证）显示到记忆详情
- [x] 批量确认端点与「待确认」统计卡（点击确认全部草稿）
- [x] 整理报告附实时总数与增量（sinceReport）
- [x] 探针原因字段兜底（模型没给原因时不再留空白）
- [x] 认知飞轮六部曲写入 `THE_GENESIS.md`（寻找/理解/概括/迁移/实践/反馈），并落成 DMA 日志的 `flywheel=` 阶段标记
- [x] 跨学科小提炼重构：DMA 强制五步推导（原貌/概括/迁移/代价/启示）+ 前端「思维推导卡片」渲染
- [x] 新增契约测试 `test/insight-pipeline.test.mjs`（10 项），当时全套 217 项全绿
- [x] `THE_GENESIS.md` 补齐四大核心机制（共享现实 / 世界模型与预测误差 / 策略自进化 / 主体性）与六部曲落地矩阵
- [x] 审计事件带 `flywheel` 阶段字段（`dma.run` / `memory.model.distill` / `memory.curation.run` / `memory.review.retry`），闭环可审计
- [x] 认知探针主体性守卫：客服式套话不落库；DMA 探针改为携带具体分歧与跨学科前提
- [x] 前端事件流韧性：SSE 心跳 + 看门狗 + 自动重连 + 琥珀色状态条（替换红色死块）
- [x] 思维推导卡片主色对齐 speculative 蓝；新增 `test/stream-resilience.test.mjs`（7 项），当时全套 226 项全绿
- [x] 独立审查修复：静默对账按 id 合并快照与帧（不吞事件）、看门狗可升级 offline、手动重连失败保持 offline、静默对账失败不弹红框、destroyed/closed 连接处理、探针拒绝留审计
- [x] `test/stream-resilience.test.mjs` 扩到 13 项（含死链与合并在内），全套 232 项全绿

下一步：

- [ ] 清理 `dsh-memory-minimal` 旧包 Junction（旧版飞轮副本，当前未加载）
- [ ] compaction 发生后的真实验证（错误记录数不应增加）
- [ ] `browser_evaluate` 的 `function` 参数加入摘要白名单（当前走兜底原文）
- [ ] 记忆证据分级（截图=弱证据 / 源码测试=强证据）与面板展示
- [ ] 写放大优化（每次审计写整文件重写 ~100KB JSONL）
- [ ] 成功动作与后续失败的 trace 关联（双写相邻）
- [ ] SSE 断连可见化 + 重连后刷新列表
- [ ] 探针 `/probe/dma` 与 curator 去重补自动化测试
- [ ] LLM 截断告警（`finish_reason=length`）+ review 独立超时
- [ ] 灵魂拷问与整理报告 UI 实机验证（需重载插件）
- [ ] 更细粒度的学科池与可配置权重
- [ ] 搜索证据去重与来源可信度排序
- [ ] 从人类裁决反向学习偏好
- [ ] 将 DMA 日志汇总为每周架构观察
- [ ] 可选的 MCP 搜索适配器

---

## 致敬

这个飞轮的最后一道防线，不是模型，不是规则，也不是代码。

**是人类开发者。**

你决定哪条经验可以进入记忆，哪条推演值得保留，哪个错误应该被原谅。机器可以提出候选、组织辩论、在深夜搜索其他学科如何解决相似问题，但它不能替人类承担判断的责任。

**人类是最高法官。**

---

## License

MIT
