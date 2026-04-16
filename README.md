# 龙爪手 · SDE-Claw 部署指南

**给 @SIOWDS 的一次性部署手册** —— 全程鼠标点击，无需命令行。

部署成功后，你会得到一个网址（形如 `https://sde-claw.siowds.workers.dev`），把它发给任何人，他们打开浏览器就能用。**所有用户共享你的 DeepSeek Key，费用由你承担**。

---

## 🎯 总共三个阶段

```
阶段一：上传代码到 GitHub  （约 5 分钟）
阶段二：Cloudflare 连接并部署 （约 5 分钟）
阶段三：填入 API Key         （约 2 分钟）
```

完成之后，**你得到一个永久运行的公网网址**，以后只要改代码 push 到 GitHub，Cloudflare 会自动重新部署。

---

## 📦 阶段一：上传代码到 GitHub

### 1-1. 登录 GitHub

打开 https://github.com/SIOWDS ，确认已登录。

### 1-2. 创建新仓库

点击右上角 **"+"** → **"New repository"**（新建仓库）。

填写：

| 字段 | 填什么 |
|------|--------|
| Repository name | `sde-claw` |
| Description | 留空或写 `SDE-Claw 龙爪手 · DeepSeek 版` |
| Public / Private | **Private**（私有，推荐——避免别人看到你的代码） |
| Initialize | **不要**勾选任何 "Add a README" 等选项 |

点击右下角绿色的 **"Create repository"**。

### 1-3. 上传 ZIP 解压后的所有文件

创建好仓库后，会看到"Quick setup"页面。**忽略所有命令行指令**，找到页面中间的这句话：

> **"uploading an existing file"**（上传已有的文件）

点击这个蓝色链接。

### 1-4. 拖拽文件

在打开的上传页面：

1. **解压** `sde-claw-cf.zip` 到桌面或任意位置
2. 打开解压出的 `sde-claw-cf` 文件夹
3. **全选**里面的所有文件和文件夹（Ctrl+A）
4. **拖拽**到 GitHub 上传页面的虚线框里

等待上传完成（文件不大，几秒钟）。

### 1-5. 提交

页面底部会有一个 "Commit changes"（提交更改）区域：

- 第一个输入框（commit message）：填 `initial upload` 或随便什么
- 保持默认 "Commit directly to the main branch"
- 点击绿色的 **"Commit changes"** 按钮

完成后，你会看到仓库里所有文件都在了。

---

## ⚡ 阶段二：Cloudflare 连接并部署

### 2-1. 登录 Cloudflare Dashboard

打开 https://dash.cloudflare.com/

登录你的账号（即 `wangdesheng1234567@gmail.com`）。

### 2-2. 进入 Workers & Pages

左侧菜单找到 **"Compute (Workers)"** 或 **"Workers & Pages"**，点进去。

### 2-3. 创建新应用

点击右上角 **"Create"** 或 **"创建应用程序"** 按钮。

选择 **"Import a repository"**（导入仓库）或 **"Connect to Git"**（连接 Git）。

如果是首次使用，会要求你授权 Cloudflare 访问 GitHub：
- 点击 **"Connect GitHub"**
- 跳转到 GitHub 授权页
- 点 **"Authorize Cloudflare"**（授权 Cloudflare）
- 选择你要授权的账号：**SIOWDS**
- 选择 "Only select repositories" → 选 **sde-claw**
- 点 **"Install & Authorize"**

### 2-4. 选择仓库并配置

回到 Cloudflare 页面，你会看到仓库列表。**选择 `sde-claw`**。

接下来 Cloudflare 会让你配置部署设置：

| 字段 | 填什么 |
|------|--------|
| Project name | `sde-claw`（默认即可） |
| Production branch | `main`（默认即可） |
| Framework preset | **选 "None"**（因为我们用的是自定义 Worker 而不是标准框架） |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/`（留空或填斜杠） |

⚠️ **重要**：有些界面下 Cloudflare 会自动识别出 `wrangler.toml`，就直接用它的配置，连上面这些都不用填。

点击最下方的 **"Save and Deploy"**（保存并部署）。

### 2-5. 等待首次部署

你会看到一个日志页面在实时滚动，显示：

```
Cloning repository...
Installing dependencies...
Running: npm run build
Running: npx wrangler deploy
✨ Deployed successfully!
```

大约 2-5 分钟。完成后，页面顶部会显示一个网址，形如：

**`https://sde-claw.siowds.workers.dev`**

这就是你的龙爪手地址！但是——**现在打开它会报错**，因为还没设置 DeepSeek Key。继续下一步。

---

## 🔑 阶段三：设置 DeepSeek API Key

### 3-1. 进入 Worker 设置

在 Cloudflare Dashboard：

左侧 **Workers & Pages** → 找到 **sde-claw** → 点击进入。

顶部找到 **"Settings"**（设置）标签 → 左侧找到 **"Variables and Secrets"**（变量与密钥）。

### 3-2. 添加 Secret

在 **"Secrets"**（密钥）区域，点击 **"Add variable"** 或 **"+ Add"**：

| 字段 | 填什么 |
|------|--------|
| Type | **Secret（密钥）** |
| Variable name | `DEEPSEEK_API_KEY` |
| Value | 粘贴你真实的 DeepSeek API Key（以 `sk-` 开头） |

点击 **"Save and deploy"**（保存并部署）。

⚠️ Cloudflare Secret 一旦保存后不能再查看——你只能再次覆盖/删除。所以把 Key 另存一份。

### 3-3. 完成！

访问 `https://sde-claw.siowds.workers.dev`，龙爪手界面应该加载出来了。

**验证**：

1. 浏览器地址栏加 `/api/health`，即访问 `https://sde-claw.siowds.workers.dev/api/health`
2. 应该看到类似 `{"ok":true,"has_key":true,"model_default":"deepseek-chat",...}` 的 JSON

如果 `has_key` 是 `true`，说明 Key 已注入成功。

3. 回到主页，打开任意模块（比如"前期研究"），测试一下是否能正常调用 DeepSeek。

---

## 📤 如何分发给其他人

**直接把这个网址发给他们**：

```
https://sde-claw.siowds.workers.dev
```

他们会做的事：
- 浏览器打开网址
- **立即可用**，六模块全部可用
- 不用注册、不用装任何东西、不用 Key
- 手机、平板、电脑都能用

---

## 💰 费用情况

两部分成本：

**Cloudflare Workers**：
- 免费额度：每天 10 万次请求
- 对你的使用规模来说，**基本不可能用完**
- 超过的话：每百万次请求 $0.30

**DeepSeek API**：
- 约 ¥0.07-0.17 / 次完整模块调用
- 100 个用户每人用 10 次 = 约 ¥70-170
- 你可以在 https://platform.deepseek.com 监控消费

---

## 🔒 访问控制（可选但推荐）

如果你只想给特定人员使用，不希望网址被分享泄漏后被人刷你的 Key，有两种加防护的方式：

### 方案一：Cloudflare Access（推荐）

- 在 Dashboard → **Zero Trust** → **Access** → 创建 application
- 选择你的 Worker
- 添加规则：只允许特定邮箱登录（Google / GitHub 登录）
- 用户访问网址时需要先登录验证身份

**免费额度 50 人以内**。

### 方案二：简单的访问密码

改一下 `worker/index.js`，在每个 API 请求里验证一个 header 里的访问密码。实现简单但不如 Access 安全。

这一步可以等你先部署跑通了再说。

---

## 🛠 日常更新

**改代码怎么办？**

你不需要任何操作，只需要：

1. 改本地代码
2. 上传到 GitHub（网页拖拽或 Git 客户端）
3. Cloudflare 自动检测到更新，自动重新部署
4. 几分钟后，所有用户看到的网址都更新了

---

## ❓ 常见问题

### Q1：部署过程中 "Build failed"
→ 进入 Cloudflare Dashboard → sde-claw → **Deployments** → 点最新的失败记录 → 看详细日志。把日志截图给我。

### Q2：网址打开了，但点击生成报错 "API 500"
→ 99% 是 Secret 没配对。回到阶段三检查。
→ 也可能 DeepSeek Key 余额不足，去 https://platform.deepseek.com 检查账户余额。

### Q3：可以改默认模型吗？
→ 打开 `src/App.jsx`，找到 `const DEEPSEEK_MODEL = "deepseek-chat"`（约第 766 行），改成 `"deepseek-reasoner"`（R1，更贵但推理更强）。
→ 在 GitHub 网页上编辑文件，保存后 Cloudflare 自动重新部署。

### Q4：自定义域名，比如 `sde-claw.myname.com`
→ 前提：你得在 Cloudflare 托管你的域名（在 Cloudflare 上添加 Site）。
→ 然后 Worker 设置里 → **Triggers** → **Custom Domains** → 添加你的域名。

### Q5：想回滚到旧版本
→ Deployments 页面，找到旧的成功部署，点 **"Rollback to this deployment"**。

---

## 📁 项目文件说明

```
sde-claw-cf/
├── .dev.vars.example     # 本地开发时的 Key 模板（不会被部署）
├── .gitignore            # git 忽略文件
├── package.json          # 依赖和脚本
├── wrangler.toml         # Cloudflare Worker 配置
├── vite.config.js        # 前端构建配置
├── index.html            # HTML 入口
├── src/
│   ├── App.jsx           # 龙爪手主体（~3170 行，六模块完整逻辑）
│   └── main.jsx          # React 入口
└── worker/
    └── index.js          # DeepSeek API 代理 + 静态托管
```

---

**祖师爷保佑部署一次成功。** 🙏

有问题随时回来问。
