# eebookk · 内置 calibre 版（fix）

这个目录放的是**把 calibre 一起打包进安装包**的版本，用来解决「不想先装 calibre」的场景。

## 产物

| 文件 | 说明 |
|---|---|
| `eebookk-0.1.22-builtin-calibre-setup.exe` | 安装包，内含 electron 运行时 + 一份完整 calibre 9.15 |
| `win-unpacked/` | 免安装解压版，直接跑 `eebookk.exe`（构建时生成，不进 git） |

## 和常规版本的区别

- 常规版：读本机已安装的 calibre（`C:\Program Files\Calibre2`），没装就用不了。
- 内置版：安装包自带 calibre，解压到 `<安装目录>\resources\calibre`，启动时**优先用内置引擎**，本机装没装 calibre 都能跑。
- 首次启动时如果找不到书库，会自动在 `%USERPROFILE%\Calibre 书库` 建一个空书库（调的是内置 `calibredb`），不用先跑一遍 calibre 界面。
- 引擎优先级：`EEBOOKK_CALIBRE_DIR` 指定的目录 → 内置 `resources\calibre` → 系统安装目录 → PATH。

两个版本共用同一个 appId / 安装路径：装内置版会覆盖常规版（书库数据不受影响），反之亦然。设置、收藏、阅读进度都在 `%APPDATA%\eebookk`。

## 构建

```powershell
npm run calibre:vendor   # 把本机 calibre 复制到 vendor/calibre（不进 git）
npm run dist:win:fix     # 产物输出到这个 fix/ 目录
```

`scripts/vendor-calibre.mjs` 只做文件复制，不改 calibre 的任何内容。想换版本就把 `-- "D:\某处\Calibre2"` 传进去。

## 许可

- eebookk 本身：MIT（见仓库根目录 `LICENSE`）。
- calibre：GPLv3 的独立程序，按原样随包分发，不修改、不链接、不 import 它的 Python 包，只通过命令行工具（`calibredb` / `ebook-convert` / `calibre.exe` 等）调用。许可证全文在安装目录 `resources\calibre\LICENSE`。
- calibre 源码：<https://github.com/kovidgoyal/calibre>（对应 tag `v9.15.0`），官方源码下载见 <https://calibre-ebook.com/downloads>。如果要公开分发这个安装包，建议把对应源码包一并放到同一发布页，或提供有效的书面源码提供承诺。
