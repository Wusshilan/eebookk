# eebookk

给 calibre 书库换一个壳：管库、整理元数据、批量转换、推送 Kindle，都在一个窗口里完成。

版本 **0.1.8** ｜ Windows x64 ｜ Electron 45 + React 19 + TypeScript

---

## 这是什么

calibre 功能全，但界面是 2005 年的。eebookk 不碰 calibre 的源码，只读它的 `metadata.db`、
调用它的命令行工具（`calibredb` / `ebook-convert` / `ebook-polish`），把日常最常用的几件事
重做了一遍：找书、改元数据、批量转换、传 Kindle、直接读。

书库本身仍然是 calibre 的书库。关掉 eebookk，calibre 打开还是原样。

---

## 安装

下载 `eebookk-0.1.8-setup.exe` 直接装。需要本机已装 calibre（本机测试用的是 9.15.0），
程序会自动在常见位置找书库；找不到会提示你指定。

首次启动会读取 calibre 的书库路径，之后可以在设置里看到当前路径。

---

## 界面

左侧是导航，右侧是内容区，底部常驻条显示最近在读和转换进度。

### 首页

顶部三张 banner，下面是三行书。

- **书库** — 你自己书库里的书，点进书库页
- **古登堡** — 实时从 Project Gutenberg 拉取的公共版权书，点封面直接下载并加进书库
- **待整理** — 缺简介的书，点进整理台

banner 里的封面墙会缓慢横向漂移（两排反向，鼠标悬停暂停）。系统开启「减少动态效果」时不动。

### 书库

封面墙或表格两种视图，可按书名 / 作者 / 时间 / 大小 / 评分排序。

- 点卡片进详情，点左上角复选框或按住 Ctrl 点击可多选
- 选中后底部会出现操作条：转换 / 推送 / 加入书单 / 删除
- 「添加书籍」会把本地电子书文件加进 calibre 书库

### 整理台

书库健康度 + 问题清单（缺简介、缺标签、缺封面、疑似重复、没有 EPUB、水印标签）。

点任一问题卡片可以看到对应的书，再点「去处理」直接跳到该页并带上选择。
下方是批量编辑：一次给一批书改系列 / 出版社 / 出版日期 / 语言 / 评分，或给标签加一组、删一组。

### 转换

从书库选书 → 选目标格式 → 入队。可以多本并发（并发数在设置里），进度实时显示，
完成后可点「打开所在文件夹」。

队列会存到磁盘，重启后历史任务还在；上次没跑完的会标为「已中断」。

### 设备

两种推送方式：

- **USB**：插上 Kindle，识别到盘符后选书推送。只复制 EPUB，落在 `documents/eebookk/` 下。
- **邮件**：走 SMTP 发到你的 Kindle 邮箱。账号在设置里配。

### 分组 / 标签、作者

药丸流 + A–Z 索引，支持多选后批量改名、合并、删除。水印标签可以一键清理。

### 收藏内容 / 书单

收藏和书单存在 eebookk 自己的数据目录里（`userData/collections.json`），**不写进 calibre**。
所以 calibre 里看不到，换机器也不会带走。

### 阅读器

EPUB 直接在应用内打开，不跳出去。

目录、上一章 / 下一章、字号 15–30、浅色 / 米黄 / 深色三档、记住读到哪儿。
PDF 和 AZW3 打不开，会提示用系统阅读器。

阅读进度存在 `userData/reading-progress.json`，底部常驻条会跟着更新。

### 设置

横向标签，六个分类：

**通用**
- 恢复上次页面：关窗口时记住停在哪一页，下次启动直接回到那里
- 搜索快捷键：`Ctrl / ⌘ + K`
- 界面语言：简体中文
- 封面圆角：0–16，0 为直角
- 网格密度：舒适 / 紧凑
- 主题：浅色（深色还没做）

**书库**
- 路径：由 calibre 决定。换库要先去 calibre 里切换，再重启 eebookk
- 收录：册数、标签数、作者数、系列数、出版社数
- 重新读取：在 calibre 里改完东西后点一下
- 备份 metadata.db：写库之前先存一份，备份在 `%APPDATA%\eebookk\backups\`
- 打开 calibre：外部程序，不随本应用分发

**转换与元数据**
- 默认目标格式：转换页入队时的默认值，可以临时改
- 同时转换几本：1–4，机器慢就调到 1
- 输出目录：留空则放到 `%APPDATA%\eebookk\exports`
- 附加参数：原样传给 `ebook-convert`，按空格拆
- 作者分隔符：calibre 用 `&` 区分多个作者
- 标签分隔符：calibre 用英文逗号
- 保存后嵌入文件：元数据同时写进书籍文件，拷到别的设备还能看到

**设备与推送**
- 邮件推送开关
- 快速填写：QQ / 163 / Gmail / Outlook 的服务器和端口预设
- 服务器、端口（SSL 一般 465，STARTTLS 用 587）、SSL/TLS
- 账号、授权码（邮箱设置里生成的那个，不是登录密码）
- 发件人：留空就用账号本身
- Kindle 邮箱：在 Amazon 个人文档设置里拿，发件地址要加进已批准列表
- USB 子目录：放在 `documents` 下面哪个文件夹
- 单封上限：超过就报错，不会截断

**书源**
- 列出所有 OPDS 书目源，可以启用 / 停用 / 改地址
- 内置三条：Project Gutenberg（默认开）、Standard Ebooks、Feedbooks 公共版权（默认关）
- 可以自己加任意 OPDS 地址

**更新**
- 版本清单地址：返回 `{ version, url, notes }` 的 JSON，留空则不检查
- 启动时检查
- 立即检查

**关于**
版本、引擎、运行时、许可、日志位置、书库路径。

---

## 书源（OPDS）

只支持 OPDS —— 这是 calibre 自己也用的目录协议，多数公共图书馆都提供。

**应用不内置任何下载站。** 源由你自己在设置里填。内置的三条是公共版权库：

| 源 | 地址 |
|---|---|
| Project Gutenberg | `https://www.gutenberg.org/ebooks.opds/` |
| Standard Ebooks | `https://standardebooks.org/feeds/opds` |
| Feedbooks | `https://catalog.feedbooks.com/catalog/public_domain.atom` |

首页的「古登堡」那一行就是走这条链路拿的，点封面会问你要不要加进书库，
确认后下载 EPUB 并调用 `calibredb add`。

> 网络受限的环境里只有 gutenberg.org 通常可直连；其它源可能需要代理。

---

## 和 calibre 的关系

### 读

直接读 `metadata.db`（SQLite，只读打开）。所以：

- calibre 开着也能读
- 306 本书大约 1ms
- 不需要启动任何进程

### 写

全部走 `calibredb`。原因是 calibre 的 `metadata.db` 上注册了 Python 自定义函数（如
`title_sort`），进程内直接写会报 `no such function: title_sort`。

**calibre 主程序运行时，`calibredb` 会拒绝一切操作** —— 连只读 `list` 都不行，
换 `--with-library` 路径也没用。所以 eebookk 每 4 秒轮询进程状态，顶部会常驻
`编辑已锁定`，所有写入按钮置灰。关掉 calibre 即可编辑。

### 删除

删除前会先把书籍目录复制到 `%APPDATA%\eebookk\trash\<时间戳>\`，再调 `calibredb remove`。
目前没有还原入口，需要时手动拷回去。

---

## 数据存在哪

`%APPDATA%\eebookk\`

| 文件 | 内容 |
|---|---|
| `settings.json` | 全部设置（SMTP 密码用 safeStorage 加密） |
| `collections.json` | 收藏与书单 |
| `reading-progress.json` | 内置阅读器的阅读进度 |
| `convert-jobs.json` | 转换队列（最近 200 条） |
| `backups/metadata-*.db` | 写库前的自动备份 |
| `downloads/` | 外部书源下载的临时文件（用完即删） |
| `trash/<时间戳>/` | 删除书籍前的文件备份 |
| `logs/app.log` | 运行日志（2MB 轮转） |

---

## 已知限制

- **深色主题没做**，设置里明确标着「浅色」
- **ISBN / ASIN 只读** —— calibre 的 identifiers 字段还没接写入
- **阅读器只做流式 EPUB**：没有分页、搜索、书签、批注；固定版式 EPUB 按流式渲染
- **阅读进度不写回 calibre**，所以 calibre 自己的阅读器看不到这里读到哪
- **回收站只进不出**，没有还原 UI
- **没有撤销**，删除和改名都是即时生效
- **没有代码签名**，安装时 Windows SmartScreen 会拦一下

---

## 从源码构建

```bash
npm install
npm run dev        # 开发
npm run build      # 构建
npm run dist:win   # 出安装包到 release/
```

本机如果没有 Electron 二进制（`npm install` 被 allow-scripts 挡住），
需要手动解压 `electron-v45.0.0-win32-x64.zip` 到 `node_modules/electron/dist`，
并写入 `path.txt`（内容 `electron.exe`）。

---

## 许可

MIT。calibre 是 GPLv3 的独立程序，不随本应用分发。

---

## 全网查书 / 找封面

详情页「编辑元数据」上方有搜索框，填书名或 ISBN，一次查三个源：豆瓣读书、微信读书、NeoDB。

- 结果按来源列出，每条显示封面、作者、出版社、出版年月，右侧标着来源名
- 右侧标签是**封面的真实像素**（如 `1080×1693`），这个数字是把图片下下来读文件头算出来的，不是 API 给的
- 点一条 → 填入表单（书名/作者/出版社/出版日期/语言/简介），**不会立刻写库**，确认无误再点保存

封面编辑器里点「全网找封面」，会把各来源的封面按**面积从大到小**排开，每张下面标着分辨率。
点一张直接写进 calibre（`calibredb set_metadata --field cover:`），不再走本地裁剪。

宽度低于「设置 → 全网检索 → 封面最小宽度」的封面会被过滤掉，默认 200px。

**网络**：三个源都要能访问外网。Google Books、Open Library、Goodreads、Amazon 在这台机器上不通，所以没接。
NeoDB 偶尔很慢（单次 15s 超时），失败时那一源就不返回结果，不影响另外两个。
微信读书的封面接口默认给 70×101 缩略图，代码会自动换成 `t9_` 大图（428×616），拿不到才退回原图。

---

## 元数据编辑器字段说明

详情页「编辑元数据」可改：书名、作者、作者排序、系列、系列序号、出版社、出版日期、语言、评分、标签、标识符、自定义列、简介。

- **标识符是整组替换**。calibredb 的 `--field identifiers:` 一次覆盖全部键，只传部分键会删掉其它键。所以这里做整组编辑：表单把当前所有键都列出来，保存时提交完整一组；传空表示全清。
- **作者排序**留空时 calibre 按作者自动重算，不会变成空。
- **自定义列**（库里建了才会出现）支持 text / enumeration / series / bool / rating / datetime / int / 多值 text。bool 必须发 true/false（发 1/0 会报错）；rating 发 0–5 星，calibre 自己 ×2；datetime 要补 `T00:00:00Z`。
- **副标题在这个 calibre 版本不存在**：`--field subtitle:` 报「未知字段」，`books` 表也没有 subtitle 列，所以表单里没有这一项。

---

## 内置电子书编辑器

详情页「编辑书籍」打开，对应 calibre 的 Edit book。

- 左侧按类型分组列出 EPUB 内的文件：书脊（OPF/NCX）、正文、样式、图片、字体
- 点开正文/样式/书脊可直接改，中间是纯文本编辑区
- 保存时**重建整个 zip**：`mimetype` 仍是第一个条目且不压缩（否则 EPUB 校验不过），其余条目保持原有压缩方式
- 每次保存前自动备份到 `%APPDATA%\eebookk\epub-backups\`，保留最近 5 份；「还原上一版」用最新那份覆盖回去
- 图片和字体只列不可改；超过 2MB 的文本文件也不载入
- 写完会重新读回比对，内容不一致就报失败，不会留下半截文件

## 封面编辑器

- 选图、拖拽定位、滑块或滚轮缩放（100%–400%）
- **旋转 90° / 水平翻转**（直接烘进图片，裁剪逻辑不受影响）
- **重置**回到初始位置
- 输出尺寸三档：900×1350 / 1200×1800 / 1600×2400（固定 2:3，和 calibre 一致）
- 全网找封面：按像素面积从大到小列出各来源封面，点一张直接写进书库
