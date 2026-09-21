# dsh-peakhour-withtiaoxiu

[English](README.md) | 中文

这是我第一次使用AI agent进行代码编写，我做了一个考虑调休的计费时钟，然后我让DeepSeek教我如何提交到GitHub上。
如果有任何问题，敬请谅解。欢迎任何指教，尽管我还不太了解怎么在GitHub上看到别人的评论和消息……
以下全部是AIGC，我正在学习如何使用AI agent、如何编程和如何使用GitHub。

## 它解决什么

DeepSeek 官方计费规则（[价目表](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)，2026-09 抓取原文）：

> 空闲时段价格为高峰时段价格的一半。北京时间**周一至周五（不含中国法定节假日）**9:00 - 12:00、14:00 - 18:00
> 为高峰时段；其余时段，**包括周末及中国法定节假日全天均为空闲时段**。

这句话有两个容易踩的坑，本插件的判定逻辑就是围绕它们写的：

1. **高峰只看「星期几」**，不看政府调休日历。所以**调休调到周末的上班日，仍然全天按谷时计价**。
   （2026-09-20 是周日调休上班日 → 谷时。）
2. **法定节假日落在工作日时，那一整天都不进高峰窗口**。

界面上会直接告诉你现在是峰还是谷、当前单价、还有多久切换。

## 功能

- **侧栏常驻一行**（在「用量」下方）：`峰时/谷时 · 还有 X 小时 Y 分钟转谷/峰` 加上当前输入单价。
  折叠侧栏时自动收成图标。
- **点开政策面板**：完整高峰时段表、当前单价表（缓存命中/未命中/输出，人民币/百万 tokens）、
  数据来源与抓取时间、节假日日历年份，以及「从官网更新政策」按钮。
- **自动同步**：宿主按 `syncIntervalMinutes`（默认 180 分钟）重新读一次官网价目表与节假日日历，
  失败时保留上一份并显式标注，不会静默用错价。
- **不花钱**：同步只抓 1 个 HTML + 最多 2 个 JSON，不调用任何 DeepSeek API，不消耗 token。

## 安装

```sh
dsh plugin --profile web add github:<you>/dsh-peakhour-withtiaoxiu
```

重启 `dsh web` 生效。

## 配置

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `autoSync` | `true` | 是否定时同步 |
| `syncIntervalMinutes` | `180` | 同步周期（分钟） |
| `pollIntervalSec` | `15` | 浏览器端重新拉取状态的周期 |
| `offpeakMultiplier` | `0.5` | 兜底空闲倍率（仅政策里缺该字段时使用） |
| `holidays` | `[]` | 人工追加的节假日日期（`YYYY-MM-DD`） |
| `workdays` | `[]` | 人工追加的调休上班日日期（仅记录，不影响峰谷判定） |
| `override.windows` | — | 覆盖高峰窗口，优先级最高 |
| `override.models` | — | 覆盖单个模型价格 |

## 数据来源

- 政策：[api-docs.deepseek.com 价目表](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)（同步时实时解析；失败会退到英文镜像，再失败保留本地缓存，最后退到内置快照）
- 节假日/调休：[NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn)（源自国务院办公厅通知，文件内带通知原文链接）

## 开发

```sh
npm test     # 47+ 个单测：峰谷判定、调休、节假日、官网解析、同步失败兜底
npm run build  # 把 lib/client.source.js 打成 DSH 浏览器 bundle（lib/client.js）
```

`lib/client.source.js` 是可读的 ESM 源；`lib/client.js` 是构建产物，不要手改。

## 已知限制

- 官网是散文而非结构化数据，解析器按当前措辞工作；措辞大改会**明确报错并保留旧政策**，不会猜。
- 内置快照是 2026-09 的政策；离线首次启动会用它，并在面板里标注来源为「内置快照」。
- 浏览器半区不自己访问第三方站点，所有数据经宿主侧的 `/api/dsh-peakhour/state`。
