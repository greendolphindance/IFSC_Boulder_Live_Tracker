# 独立奖牌终局参考器

版本：v1.2（2026-09-05）

## 目的与边界

本目录用有限、确定、可重复的合法终局世界独立核验公开函数 `deriveMedalChances`。参考器只导入公开函数和领域类型，不导入、不调用、不复制 `server/src/state/medalChances.ts` 或 `server/src/state/countback.ts` 的内部 helper，也不把正式算法的区间投影、剪枝、组合生成或文案生成当作 oracle。

本目录只负责审计，不修生产实现。当前测试保留两个回归案例：Lead DNS 文案反例已修复并在当前集成通过；Boulder 进行中把数问题因缺少真实连续样本，以仍会执行断言的显式 `todo/KNOWN-ISSUE` 永久保留，不让默认入口因禁止猜修的问题长期红。

## 与正式算法不同的路径

参考器从每个未决槽位的显式终局原子做完整笛卡尔积，不计算 best/worst 区间，也没有 `PRUNE_K` 或抽样：

1. Boulder 每名选手固定四条路线。终局原子为 `N`、`Z1/Z2`、`T1/T2`，并显式包含 9、10、20、21 把边界的 Zone 和 Top。
2. Boulder 分数用十分之一分的整数累计：Top 为 `250-(attempts-1)`，Zone 为 `100-(attempts-1)`，避免浮点比较。
3. Lead 终局原子显式包含 `42`、`42+`、`43`、`TOP`、`DNS`；分数用四分之一把位的整数累计，内部 `42+` 为 169 单位，仅比较、不显示为小数。
4. 每个世界直接累计最终分数，再按“总分降序、同分 startOrder 降序”产生最终名次；不经过正式投影或正式 countback helper。
5. `locked` 对应所有世界均进入目标名次，`eliminated` 对应所有世界均不能进入，二者之外为混合世界。开赛前与 DIFF-009 登顶门控属于显式策略态，允许保持 `undecided`。
6. 每条正式条件必须匹配一条在 fixture 中独立写出的 world predicate。predicate 成立的所有世界都必须拿牌；只有文案以唯一必要式 `Needs…` 开头时，才额外要求“拿牌当且仅当 predicate”。替代路径使用充分性检查，不误当必要条件。
7. 逻辑断言与英文 golden 完全分文件：`medalChances.logic.test.ts` 检查世界、排名、verdict 和 predicate；`medalChances.copy.test.ts` 检查文案。

`MAX_WORLDS=100000` 是硬上限。乘积一旦超限，参考器在枚举前抛错，并要求拆分场景；不存在静默截断、随机抽样或沿用正式剪枝常量的路径。

## 场景与世界数

| 场景类别 | 命名 fixture | 世界数 |
|---|---|---:|
| Boulder 轮次结束、四人同分 countback | `round-ended-four-way-countback` | 1 |
| Boulder 两人全 waiting、开赛前 | `two-athletes-all-waiting` | 256 |
| Boulder T/Z 的 1、2、9、10、20、21 把必要门槛 | `necessary-last-line-{atom}`（12 个） | 每个 13，共 156 |
| Boulder 已到区仍 climbing | `zone-climbing-vs-finished` | 5 |
| Boulder 两条剩余路线、唯一双 flash 路径 | `two-remaining-routes-necessary-both-flashes` | 4 |
| Boulder 已完赛、纯靠单个对手 | `finished-subject-pure-opponent-path` | 5 |
| Boulder `both` 两对手计数 | `finished-subject-both-opponents-cardinality` | 25 |
| Boulder `all` 三对手逻辑与 ≥3 概括策略 | `finished-subject-all-three-opponents-complexity` | 8 |
| Boulder climbing / waiting / finished、自身+对手替代路径 | `climbing-subject-waiting-opponent-finished-opponent` | 16 |
| Boulder 已失败 9 把的 KNOWN-ISSUE 反例 | `known-issue-in-progress-attempts-constrain-best` | 7 |
| Lead 轮次结束、42+ 同分 countback | `lead-finished-equal-score-countback` | 1 |
| Lead climbing 必须 42+ | `lead-climbing-needs-42-plus` | 4 |
| Lead climbing 必须整数 43 | `lead-climbing-needs-integer-43` | 3 |
| Lead 仅 TOP 可行、DIFF-009 仍关闭 | `lead-top-only-remains-diff009-gated` | 3 |
| Lead DNS 终局 | `lead-dns-is-settled-and-cannot-climb` | 1 |
| Lead 已完赛、纯靠 waiting 对手 | `lead-finished-subject-waiting-opponent` | 4 |
| Lead waiting / climbing / finished 同场 | `lead-waiting-climbing-finished` | 12 |

去重后的命名场景合计包含 511 个有限世界；全矩阵 verdict 测试会再遍历同一批世界。单场最大 256，远低于硬上限。

## 当前永久反例

### KNOWN-ISSUE：进行中失败把数未收窄最好上界

最小比赛结构是两名选手、Ada 只剩第 4 线且已经失败 9 把，Bea 已以 `T2=24.9` 完赛。Ada 的显式合法终局为 `N/Z10/Z20/Z21/T10/T20/T21`，共 7 个世界；最高 `T10=24.1`，所以 7/7 世界均无法拿金，应为 `eliminated`。

基线正式算法仍把该线最好上界当作 flash 25，输出：

```text
needs_conditions: Needs to top her last boulder in 2 attempts or fewer …
```

其中“2 把内”与已经发生的 9 次失败直接冲突。永久回归名为 `KNOWN-ISSUE regression: nine failed attempts make flash-based best impossible`；它标为 `todo`，但 Node 仍会执行其 7 世界断言并报告 todo 诊断。准确生产责任为【执行（后端）】的 `server/src/state/medalChances.ts` 投影逻辑。该反例是合成的有限语义验证，不能替代真实连续 attempts 样本，也不能据此宣称 KNOWN-ISSUE 或 DIFF-009 已闭环。

### COPY：DNS 文案描述不可能发生的未来动作

最小比赛结构是两名选手的单一终局世界：Ada=`DNS`、Bea=`42`。Ada 已终止且金牌确为 `eliminated`，但基线理由为：

```text
Even topping the route cannot reach 1st — Gold is out of contention.
```

verdict 正确，英文原因却让 DNS 选手执行不可能的未来登顶。永久回归名为 `COUNTEREXAMPLE copy regression: DNS must not describe an impossible future top`，其通过态精确 golden 为 `She did not start, so Gold is out of contention.`；准确生产责任为【执行（后端）】的 Lead eliminated reason 文案。

## 运行方式

当前工作树未安装 `node_modules`，本轮也禁止安装依赖。测试使用本机 Node 25 的内建 TypeScript transform；`ts-loader.mjs` 只把源码中缺失的相对 `.js` 发射路径映射到同名 `.ts`，不改写业务逻辑。

```bash
node --experimental-transform-types --loader ./tests/reference/ts-loader.mjs --test --test-reporter=spec tests/reference/medalChances.logic.test.ts tests/reference/medalChances.copy.test.ts
```

当前集成结果：53 项，52 通过，0 失败，1 个已执行且仍失败的 Boulder `todo/KNOWN-ISSUE`。Lead DNS golden 已通过；实验性 loader/transform warning 是 Node 运行时提示，不是测试失败。

后端修复 DNS 文案前曾使用下列历史控制命令，只跳过当时的 DNS gating failure；Boulder todo 仍会执行并显示诊断：

```bash
node --experimental-transform-types --loader ./tests/reference/ts-loader.mjs --test --test-reporter=spec --test-skip-pattern='COUNTEREXAMPLE' tests/reference/medalChances.logic.test.ts tests/reference/medalChances.copy.test.ts
```

当时的控制结果：52 项，51 通过，0 失败，1 个已执行且仍失败的 todo，退出码 0。

集成前复核其他工作树中的生产修复时，可只读设置专用覆盖变量；loader 仅把公开 `medalChances.ts` 入口指向该根目录，其余 reference 代码仍来自审计产物：

```bash
IFSC_REFERENCE_PRODUCTION_ROOT=/absolute/path/to/target-worktree node --experimental-transform-types --loader ./tests/reference/ts-loader.mjs --test --test-reporter=spec tests/reference/medalChances.logic.test.ts tests/reference/medalChances.copy.test.ts
```

审计工作树没有安装依赖；静态类型检查复用主项目已有的本地 TypeScript，仅只读执行、未安装或写入：

```bash
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --types node --typeRoots ./node_modules/@types tests/reference/referenceEngine.ts tests/reference/fixtures/scenarios.ts tests/reference/medalChances.logic.test.ts tests/reference/medalChances.copy.test.ts
```

类型检查结果：退出码 0。

后端修复检查点曾通过上述生产根目录覆盖方式独立复跑：53 项，52 通过，0 失败，1 个按裁定保留且断言仍失败的 Boulder todo，退出码 0。DNS 精确 golden 已转绿；DIFF-009 仍为 `false`。

## 已知盲点与未闭环项

- 有限原子只能证明列出的世界，不能证明未列出的所有真实把数、路线分或参赛人数；新边界必须新增显式原子/fixture。
- 参考器把 startOrder 较大视为半决赛排名更好，这是本轮已确认的领域前提；它不验证适配器是否把上游字段正确转换为 startOrder。
- 不覆盖 appeals、上游解析、缺帧、状态历史、网络 stale 或多人完全相同 startOrder 的异常数据。
- Boulder “已失败若干把但未到区”的 fixture 是合成语义反例。由于没有真实连续 attempts 样本，`KNOWN-ISSUE` 仍未闭环。
- Lead 的 TOP 世界只验证有限终局语义；DIFF-009 仍为 `false`，没有真实连续样本，测试明确要求正式结果保持 `undecided`，绝不把合成 TOP 当作 DIFF-009 修复证据。
- ≥3 对手时，参考器能证明 `all`/计数 predicate；正式展示策略可能退化为概括或 `undecided`，测试分别检查逻辑和展示，不把概括句伪装成精确条件。

## 版本记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-08-31 | 建立独立有限世界参考器、分层逻辑/英文测试、场景证据、两个永久反例与盲点说明。 |
| v1.1 | 2026-08-31 | 更新 Lead DNS 修复后的当前集成状态，并保留修复前控制命令作为历史证据。 |
| v1.2 | 2026-09-05 | 将 reference 类型检查示例改为仓库相对路径，避免披露本机目录并提高可移植性。 |
