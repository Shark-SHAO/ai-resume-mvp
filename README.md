# AI Resume MVP

**AI 能力量化平台 — MVP 验证版**

真实 GitHub OAuth + ACI 评分引擎 + Claude 项目分析 + 完整 AI 简历展示

---

## 🚀 5 分钟部署到 Vercel

### 第一步：Fork 或上传项目

将本项目文件上传到你的 GitHub 仓库，或直接在 Vercel 拖拽部署。

### 第二步：在 Vercel 设置环境变量

进入 Vercel 项目 → **Settings → Environment Variables**，添加以下三个变量：

| 变量名 | 值 | 说明 |
|---|---|---|
| `GITHUB_CLIENT_ID` | `Ov23liLyNYTpMt8fL9ns` | GitHub OAuth App Client ID（公开） |
| `GITHUB_CLIENT_SECRET` | `你的 Client Secret` | GitHub OAuth App Secret（保密！） |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Claude API Key（可选，无则使用规则评分） |

### 第三步：更新 GitHub OAuth App 回调地址

进入 GitHub → Settings → Developer Settings → OAuth Apps → AI Resume MVP

将 **Authorization callback URL** 更新为：
```
https://fozmo-ai-resume.vercel.app/api/auth/callback
```

### 第四步：部署

Vercel 会自动检测并部署。完成后访问：
```
https://fozmo-ai-resume.vercel.app
```

---

## 📁 项目结构

```
ai-resume/
├── index.html              # 主 SPA（5 个屏幕的完整流程）
├── vercel.json             # Vercel 配置
├── api/
│   ├── auth/
│   │   └── callback.js     # GitHub OAuth 回调，换取 access_token
│   ├── github.js           # 读取用户仓库、stats、README
│   └── analyze.js          # ACI 评分引擎 + Claude 项目分析
└── README.md
```

---

## 🔄 用户流程

```
Landing → GitHub OAuth → 读取数据 → 8道问卷 → AI 分析 → 简历结果
                ↓                                    ↓
         真实 GitHub 数据                   Claude 项目评分
         commit/语言/仓库                   ACI 综合评分
```

---

## 📊 ACI 评分维度

| 维度 | 权重 | 数据来源 |
|---|---|---|
| D1 模型调用力 | 20% | 问卷 |
| D2 编程工具熟练度 | 25% | GitHub + 问卷（65/35） |
| D3 AI 增强代码贡献 | 20% | GitHub + 问卷（70/30） |
| D4 Prompt 工程能力 | 15% | 问卷 |
| D5 应用构建力 | 15% | GitHub + 问卷（60/40） |
| D6 学习 & 影响力 | 5% | GitHub + 问卷（60/40） |

---

## 🧪 MVP 验证指标

部署后重点追踪：

- **问卷完成率**：第几题流失最多？
- **Badge 复制率**：结果页 Badge 复制 / 完成问卷（目标 >30%）
- **分享率**：点「分享」 / 完成问卷（目标 >15%）
- **整体完成率**：到达结果页 / 开始 OAuth

---

## ⚠️ 安全提示

- `GITHUB_CLIENT_SECRET` 和 `ANTHROPIC_API_KEY` 只能存在 Vercel 环境变量中，不要提交到 git
- 部署后建议在 GitHub 重新 Regenerate 一个新的 Client Secret，并更新 Vercel 环境变量
- 用户 token 仅存储在 sessionStorage，不持久化到服务器
