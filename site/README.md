# eebookk 官网

静态站点，无构建步骤：`index.html` + `styles.css` + `script.js` + `assets/`。视觉沿用桌面端的纸色底、品牌绿 `#07C160` 与雅黑字族。

## 本地预览

在仓库根目录执行：

```powershell
python -m http.server 4173 --bind 127.0.0.1 -d site
```

打开 <http://127.0.0.1:4173/>。不要直接双击 `index.html`，否则下载探测和 WebP 缓存行为会和线上不一致。

整页截图 / 存档时加 `?static=1`，会跳过入场动画并强制加载全部图片：

```
http://127.0.0.1:4173/?static=1
```

## 下载如何分发

下载按钮默认指向 GitHub Releases（`releases/latest`）。页面加载后会 HEAD 探测：

```
site/download/eebookk-0.1.23-setup.exe
```

- **本地 / 自托管**：文件存在 → 按钮直接下载本地安装包，不跳 GitHub。
- **GitHub Pages 等静态托管**：`site/download/` 已被仓库 `.gitignore` 忽略（GitHub 单文件上限 100 MB，安装包 122 MB），文件不存在 → 按钮自动回退到 Releases 页面。

发布新版本时，把 `release/eebookk-*.exe` 上传到 GitHub Releases（tag 建议 `v0.1.23`），再按需把 `site/download/` 里的文件替换成新包。若想固定直链，可把 `index.html` 中 `[data-download]` 的 `href` 改成：

```
https://github.com/Wusshilan/eebookk/releases/download/v0.1.23/eebookk-0.1.23-setup.exe
```

## 部署

把 `site/` 作为发布目录即可（GitHub Pages、Netlify、Cloudflare Pages、任意静态服务器）。

- 仓库里已带 `.github/workflows/deploy-site.yml`：推送到 `main` 且改动 `site/` 时自动发布到 GitHub Pages。首次使用需在仓库 `Settings → Pages → Build and deployment` 把 Source 设为 **GitHub Actions**。
- 也可以手动把 `Settings → Pages` 的目录指到 `/site`（Source 选分支）。安装包走 Releases。
- 分享图 `og:image` 目前是相对路径 `assets/og.png`；部分平台要求绝对地址，绑好域名后改成 `https://你的域名/assets/og.png`。
- `site/download/` 不要提交进 git（已在 `.gitignore` 中）；部署产物里没有它，下载按钮会自动回退到 Releases。

## 更新版本号

发版时需要同步这些位置：

| 位置 | 内容 |
|---|---|
| `index.html` hero 徽标 | `v0.1.23` |
| `index.html` 下载区 | `0.1.23`、安装包名、日期、大小 |
| `index.html` JSON-LD | `softwareVersion` |
| `index.html` `[data-download]` | `data-local` 文件名 |
| `index.html` 页脚 | `版本 0.1.23` |
| `assets/og.png` | 需要时重新生成（见 `.tmp/asset_build.py`） |

## 资源来源

- 界面截图：`docs/screenshots/*.png`，压缩到 1600×900 WebP（quality 82）后放在 `assets/shots/`。
- 品牌图标：`build/icon.png`、`build/icon.ico`；logo 矢量来自 `src/renderer/src/assets/logo.svg`。
- 社交分享图：`assets/og.png`（1200×630）。

## 可访问性

- 产品导览是标准 tablist：支持方向键、Home / End，`aria-selected` 与焦点同步。
- 有跳转主内容的 skip link、可见焦点环、`prefers-reduced-motion` 下关闭入场与浮动动画。
- 对比度：主按钮用深墨字压品牌绿（不使用白字压绿），绿色正文统一用深绿 `#067A41`。
