# 一念 · 离线优先的思维导图工作空间

单文件 Web 应用：打开 `index.html` 即可使用，不需要服务器、不需要联网、不依赖任何 CDN。

## 员工怎么用

1. 打开 `https://234146326.github.io/yinian-mindmap/`
2. 输入提供者单独发给你的访问密码
3. 数据以 AES-256-GCM 加密后保存在**你自己浏览器**的 IndexedDB 里，不会上传

> 密码由提供者固定，页面里不提供「修改密码 / 注册」入口。忘记密码只能由提供者重新发放。

## 维护者怎么改

```bash
# 1. 改 src/ 下的源码（src/js/*.js、src/app.css、src/shell.html）
# 2. 重新打包
python3 build.py
# 3. 同步到 GitHub Pages 入口文件并提交
cp 思维导图.html index.html
git add -A && git commit -m "..." && git push
```

`build.py` 会把 `src/js/*.js` 按依赖顺序拼进一个 `<script>`，把 `src/app.css` 内联成 `<style>`，
最终输出单个自包含的 `思维导图.html`。

## 访问密码与轮换

密码的**校验值**（PBKDF2 salt / iterations / verifier）在构建时内嵌进页面，页面里没有明文密码。

```bash
python3 build.py auth    # 交互输入新密码，写入 src/auth.json（只含校验值），密钥版本 +1
python3 build.py         # 重新打包，把新校验值内嵌
cp 思维导图.html index.html && git push
```

- `src/auth.json` 可以提交（它只有派生值），**必须保留**，否则每次构建 salt 会变，所有人本地数据都会判定为「过期」。
- 明文密码只存在于本地的 `访问密钥-vN.txt`，该文件已在 `.gitignore` 中。
- 员工离职：换密码（版本 +1）→ 重新部署 → 通知在职员工用新密钥。旧页面留在离职者手里仍可打开，但那是空应用，没有你的内容。
- 环境变量方式（CI 用）：`YINIAN_AUTH_PASSWORD`，配合 `YINIAN_AUTH_SALT` 固定 salt。

## 安全边界（重要）

GitHub Pages 是公开静态托管：**站点本身有链接就能打开**，页面密码是唯一的门槛。
页面里的 verifier 可被读取，理论上可离线爆破，所以密码请用长随机串（当前 26 位）。
如果需要「精确到人、可审计、可立即吊销」，纯静态做不到，应在外层加
Cloudflare Access / 企业网关 / 反向代理 Basic Auth。

## 数据说明

- 本地存储：IndexedDB（库名 `yinian-v1`），所有导图、媒体、快照均为密文
- 交换格式：JSON（可导出单节点、子树、整张导图、全量备份）
- 每个浏览器/域名各自独立，换域名或清缓存前请先导出 JSON 备份

## 目录

| 路径 | 作用 |
|---|---|
| `index.html` | 部署入口，与 `思维导图.html` 内容相同 |
| `思维导图.html` | 构建产物，双击可离线使用 |
| `build.py` | 打包脚本（含 `auth` 子命令） |
| `src/` | 源码：`shell.html` 骨架、`app.css` 样式、`js/` 15 个模块 |
| `tools/` | 开发期测试：单元测试 + Chrome 端到端测试 |
| `src/auth.json` | 密码校验配置（无明文），构建时读取 |
