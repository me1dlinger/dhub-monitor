# Docker Hub Monitor

监控 Docker Hub 仓库的累计拉取量，按天归一化出「每日新增」并可视化展示。后端为 Flask + SQLite，采集由独立调度进程负责；前端为无构建步骤的原生 HTML/CSS/JS + 本地内置 ApexCharts。

## 功能

- 监控任意 Docker Hub 仓库（`namespace/name`），添加时校验仓库是否存在
- 累计拉取趋势、每日拉取速率、拉取分布、镜像排行
- 单镜像详情：累计趋势、每日速率、版本（标签）列表
- 采集日志：每次执行的来源、状态、耗时，可展开查看逐镜像结果
- 可插拔的调度进程与手动刷新，二者共用文件锁避免重叠
- 浅色 / 深色主题切换，响应式布局
- 访问密钥鉴权（可选）、登录限流、严格 CSP

## 快速开始

### 本地开发

```bash
pip install -r python/requirements.txt
cp .env.example python/.env
cd python
python app.py          # http://localhost:5000（默认内置调度，直接可用）
```

如需把调度拆成独立进程（与生产一致），设置 `EMBEDDED_SCHEDULER=false` 后运行 `python app.py` 与 `python scheduler.py`。

### Docker 部署

```bash
cp .env.example .env   # 在项目根目录填写 AUTH_SECRET 等配置
docker compose up -d --build
```

访问 `http://<host>:19843`。容器内由 supervisord 守护 `web`（gunicorn）与 `scheduler` 两个进程。

## 配置

在 `.env` 中设置（完整列表见 `.env.example`）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AUTH_SECRET` | (空) | 访问密钥。留空则关闭鉴权（不建议公网使用）；Docker 部署时 compose 要求必须设置 |
| `REFRESH_INTERVAL` | 6 | 自动刷新间隔（小时） |
| `EMBEDDED_SCHEDULER` | true | 是否在 web 进程内运行调度；Docker 由 compose 设为 false |
| `DEFAULT_DAYS` | 14 | 图表默认时间范围（天） |
| `FETCH_WORKERS` | 4 | 并发采集线程数 |
| `REQUEST_TIMEOUT` | 20 | Docker Hub 读超时（秒） |
| `DOCKER_HUB_TOKEN` | (空) | Docker Hub Personal Access Token，提高速率限制、减少限流（不能绕过网络封锁） |
| `DOCKER_HUB_API` | hub.docker.com/v2/repositories | 元数据端点，可指向自建网关 |
| `HTTP_PROXY` / `HTTPS_PROXY` | (空) | 出站代理，无法直连 Docker Hub 时使用 |
| `TZ` | Asia/Shanghai | 统计使用的时区 |

> 本地开发读取 `python/.env`；Docker 部署读取项目根目录 `.env`（compose 同时用于变量替换）。

## 接口

| 路径 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/` `/manage` `/logs` | GET | 否 | 仪表盘 / 镜像管理 / 刷新日志 |
| `/api/auth/login` | POST | 否 | 密钥换取 token |
| `/api/auth/verify` | POST | 否 | 校验 token |
| `/api/health` | GET | 否 | 健康状态与调度心跳 |
| `/api/overview` | GET | 是 | 仪表盘汇总数据（`?days=`） |
| `/api/images` | GET/POST | 是 | 列出 / 添加镜像 |
| `/api/images/:id` | DELETE | 是 | 移除镜像 |
| `/api/images/:id/refresh` | POST | 是 | 刷新单个镜像 |
| `/api/images/:id/tags` | GET | 是 | 标签列表（`?force=1` 强制刷新） |
| `/api/refresh` | POST | 是 | 全量刷新 |
| `/api/logs` | GET | 是 | 刷新日志 |

## 架构

```
python/
├── config.py          集中配置 / 时区 / 时间工具
├── database.py        SQLite（WAL）schema 与查询
├── docker_service.py  Docker Hub 客户端（重试、超时、404 区分）
├── refresh.py         采集编排（文件锁 + 线程池）
├── scheduling.py      调度任务定义（内置/独立共用）
├── lock.py            跨进程文件锁
├── app.py             Flask Web 与 JSON API（可选内置调度）
├── scheduler.py       独立调度进程
├── templates/         静态页面外壳
└── static/
    ├── css/style.css  设计系统
    ├── js/            主题、公共库、各页面脚本
    └── vendor/        本地 ApexCharts
```

**指标口径**：Docker Hub 只提供累计 `pull_count`。系统按本地自然日记录最后一次观测，并以「相邻观测日累计差值 ÷ 间隔天数」计算每日新增，因此漏采或停机不会产生虚假尖峰。同时拉取量被强制单调：读到 `0` 或比此前更低的值时沿用已确认的最高值，启动时也会自动修正历史数据。

> 拉取量只存在于 Docker Hub 的元数据 API，没有可直接替代的来源；若网络无法直连 `hub.docker.com`，需要配置代理。

## 安全

- `AUTH_SECRET` 无已知默认值，未配置即关闭鉴权；Docker compose 强制要求配置
- 恒定时间令牌比较、登录失败限流、严格 CSP 与安全响应头
- 输入校验与输出转义，容器以非 root 用户运行
