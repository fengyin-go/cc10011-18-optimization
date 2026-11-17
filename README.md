# 采集调度策略管理工具

离线版采集调度策略配置工具，涵盖站点登记、模板编排、代理轮换、限速调节、反爬策略、增量水位与结果校验规则，所有配置持久化到浏览器本地存储。

这是一个**纯前端**管理平台：React + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 React + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/api/reprocess-service.ts 字段映射增量重算：差异、清单、核验、落盘、恢复
│   ├── src/data/             模块元数据 / 示例数据 / 增量重算状态 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 站点登记 | `site` | 采集站点 | 站点编号、域名地址、站点类型 |
| 模板编排 | `template` | 抽取模板 | 模板编号、入口地址、列表选择器 |
| 代理轮换 | `proxy` | 代理节点 | 节点编号、代理地址、代理协议 |
| 任务编排 | `spider` | 采集作业 | 作业编号、目标站点、抽取模板 |
| 调度编排 | `schedule` | 调度规则 | 规则编号、关联站点、调度表达式 |
| 反爬策略 | `antibot` | 对抗策略 | 策略编号、验证码类型、识别服务 |
| 限速调节 | `ratelimit` | 限速配置 | 配置编号、目标站点、每秒请求上限 |
| 重试机制 | `retry` | 重试策略 | 策略编号、关联任务、最大重试次数 |
| 字段映射 | `extractor` | 映射规则 | 规则编号、源字段名称、目标字段名称 |
| 采集流水线 | `pipeline` | 流水线步骤 | 步骤编号、步骤名称、输入数据源 |
| 结果校验 | `validator` | 校验规则 | 规则编号、校验对象、校验类型 |
| 数据落盘 | `storage` | 存储配置 | 配置编号、存储类型、输出路径 |
| 采集监控 | `monitor` | 监控指标 | 指标编号、关联任务、指标名称 |
| 数据清洗 | `cleanse` | 清洗规则 | 规则编号、目标字段、空值替换 |
| 增量水位 | `delta` | 增量游标 | 游标编号、目标站点、增量字段 |
| 数据分发 | `export` | 分发通道 | 通道编号、输出数据集、目标系统 |
| RPA流程 | `rpaflow` | 自动化流程 | 流程编号、目标页面、操作序列 |
| 登录凭证 | `auth` | 凭证配置 | 凭证编号、目标站点、认证方式 |

## 字段映射增量重算

字段映射改一个目标字段不再重跑全部源记录。相关实现：

- `frontend/src/data/reprocess-seed.ts`：映射版本（V1 完整版 / V2 当前草稿）、源记录、上一版转换结果、
  按目标字段的版本差异计算、成本对比。
- `frontend/src/api/reprocess-service.ts`：生成/刷新增量重算清单、冲突判定、核验、数据落盘、
  中断恢复、复核状态与检索定位。
- `frontend/src/views/extractor/`：字段映射页（增量重算清单 / 差异与冲突判定 / 映射规则）。
- `frontend/src/views/storage/StorageView.tsx`：数据落盘页（写回队列 / 落盘配置），
  按清单替换受影响目标字段，其他列继续引用上一版完整结果。

操作口径：

1. 「按目标字段合并差异后重算」读取新旧映射版本和上一版完整结果，只重算差异字段，生成
   字段映射增量重算清单；同一版本重复执行复用原清单，不会再次列出一批相同记录。
2. 「核验清单」确认未变化目标字段保持原结果、必填标识已处理、受影响记录可定位；未核验不能落盘。
3. 「按清单替换受影响目标字段」整批一次提交：任一条失败则整批回滚，不会只写一部分目标字段。
   落盘页可注入落盘故障或数据质量演练验证这两条边界。
4. 「中断后立即恢复」从最后完整版本续做剩余清单记录；只有全部清单记录写入后才推进完整版本。
5. 同一目标字段同时改类型转换与清洗表达式时，按字段级或整行重算的写入范围不同，需在
   「差异与冲突判定」里记录落库做法与复核依据。

数据保存在 `scraper-strategy-studio:reprocess`（增量重算状态）与
`scraper-strategy-studio:entries`（各模块登记数据）两项 localStorage 中。

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `scraper-strategy-studio:entries` 这一项，或调用 `resetModule(模块)`。

领域：数据工程
子方向：数据采集、爬虫与RPA
