# 发布文案草稿

> 仓库地址已填入；npm 包尚未发布，发布后再替换 `<你的 npm 包地址>`。不要编造 star 数或用户量。

## 一、V2EX

### 标题候选

1. 我给自己的 AI 加了一个会跟它吵架的妈
2. 为了不让 AI 半夜搜索烧钱，我给它加了 Token 熔断
3. 市面上的 AI 记忆插件，大多只解决了“存”，没解决“信”

### 正文

同一个 `ToolError`，我一周踩了三次。

第一次我修了，第二次换了个写法，第三次我盯着屏幕想：我不是已经修过这个吗？

于是我给自己的 Agent 写了一个记忆插件。它很勤奋，存了 47 条经验。然后我发现：**它一条都没看。**

我又让它自己判断哪些经验值得留。它说“都已解决”。我抽查三条，两条是编的。

再后来，它半夜自己上网查生物学，早上给我一份“架构隐喻”。我很感动，直到看见账单。

所以我把“记忆”拆成五个问题：

1. 错误发生时，谁负责把它变成可复用的经验？
2. 经验入库前，谁来判断它是不是胡说？
3. 两个“我”意见不一致时，谁拍板？
4. 离线时它该不该继续思考，边界在哪？
5. 记忆越存越多，谁来决定哪些该留、哪些该忘？

这个项目就是我的答案：`dsh-evolution-flywheel`。

它做四件事：

- **错误感知**：工具报错 → 指纹去重 → 候选经验，不靠模型“自觉记住”；
- **子母对抗**：母 Agent 初审驳回，子 Agent 顶嘴，最多一轮，不收敛交人类；
- **人类最高法官**：红色呼吸灯 + 强制采纳/驳回 + 再查证据；
- **夜间漫游**：跨学科搜索 + 无状态 LLM，产出标记为 `speculative`，人类采纳才生效。

还有两个我没想到会这么有用的东西：

- **Token 熔断**：单次漫游上限 + 每日预算。现在它思考前会先看余额。
- **自我审计**：把记忆分成长期/临时、需要/可清理。它不会自动删，只给建议。

诚实说明：子母对抗是**同一个模型扮演双方**，不是两个独立 Agent；自我审计目前是**规则**，不是 LLM 语义判断；记忆是**本地明文 JSONL**，不加密。

1.0.0，MIT，118 项测试，单包 DSH 插件。

仓库：https://github.com/nuomu1123/dsh-evolution-flywheel
npm：尚未发布

如果你也在给 Agent 做记忆，欢迎来挑刺。尤其是“到底该不该让模型自己批准自己”这个问题。

## 二、掘金

### 标题候选

1. 别再给 AI 加记忆了：它需要的是一个会自我对抗、会认错的元认知系统
2. 从 ToolError 到人类裁决：我如何给 Agent 造一个不撒谎的记忆系统
3. 我给 AI 的记忆加了“对抗、账单和审计”，然后它开始承认自己不知道

### 正文结构

1. **痛点：三种“假记忆”**
   - 只存不用：向量库很满，上下文里没有；
   - 只增不减：错误、测试噪音、一次性经验全入库；
   - 模型自证：让模型判断自己对不对，幻觉闭环。
2. **设计：把记忆当成需要审计的系统**
   - 状态机：staged → under_review → debating → approved/rejected/human_intervention；
   - 对抗：母 Agent 初审 + 子 Agent 反驳 + 1 轮辩论 + 开卷申诉；
   - 人类裁决：最终权限，不可绕过；
   - 漫游：speculative 与事实隔离；
   - 成本：Token 熔断 + 每日预算；
   - 安全：sanitizeText、同源校验、WriteQueue。
3. **踩坑**
   - 同模型模拟对抗的局限；
   - 规则审计不是语义审计；
   - 记忆明文存储的隐私边界。
4. **结果与限制**
   - 118 项测试、1.0.0、MIT；
   - 已知未做：虚拟滚动、标签检索、真正的多模型对抗。

## 三、Twitter / X

### Thread

1. Most “AI memory” plugins just store more text.
   Mine argues with itself, then asks a human to judge.
2. The failure mode nobody talks about: the model says “remembered”, but the memory never enters the next prompt.
3. So I built a flywheel: tool error → candidate → mother-agent review → child-agent rebuttal → human verdict.
4. It also goes on late-night interdisciplinary walks. The output is marked speculative, and a human must adopt it.
5. To stop it from burning money at 3am, I added a token fuse and a daily budget. Now it checks the bill before thinking.
6. Honest limits: the debate is one model playing both sides; self-audit is rule-based; memory is local plaintext JSONL.
7. 1.0.0, MIT, 118 tests, single DSH plugin. Repo: https://github.com/nuomu1123/dsh-evolution-flywheel

## 四、GitHub Topics

```
agent-memory
dsh-plugin
deepseek-harness
self-evolving
meta-cognition
multi-agent
llm-memory
human-in-the-loop
self-audit
token-budget
local-first
typescript
ai-agents
memory-management
cognitive-architecture
```

设置命令：

```bash
gh repo edit --add-topic agent-memory,dsh-plugin,deepseek-harness,self-evolving,meta-cognition,multi-agent,llm-memory,human-in-the-loop,self-audit,token-budget,local-first,typescript,ai-agents,memory-management,cognitive-architecture
```

## 五、发布检查

- [x] 替换 README 与本文的仓库地址（npm 包待发布后替换 `<你的 npm 包地址>`）
- [ ] 补 3 张截图：记忆面板、辩论空间、自我审计
- [ ] npm 包名可用（已确认 404）
- [x] `pnpm test` 118/118
- [ ] 发帖后 24 小时内回复评论，不要只丢链接
