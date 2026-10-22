# 文件预览面板 · File Preview Panel

在 CC GUI 的**右侧面板**里浏览当前工作区的文件树，点开文件直接在面板内预览，不再另开主区域标签页（类似 Codex Desktop 的体验）。

> **仅支持 Windows。** 读取文件依赖系统自带的 `powershell`。在 macOS / Linux 上，面板只会显示「仅支持 Windows」。

[English](#english)

## 功能

- **目录树**：外观与宿主文件树一致，图标、行高、缩进都相同。按目录懒加载，显示隐藏文件，目录排在前面；悬停根目录行可以刷新。
- **搜索**：顶部搜索框搜索整个工作区，多个关键词用空格分隔，回车打开第一条结果。
  - git 仓库用 `git ls-files` 搜索，包含未跟踪文件，遵守 `.gitignore`。
  - 非 git 目录回退为递归搜索，跳过 `node_modules`、`.git`、`dist` 等。
- **最近打开**：可折叠，每个工作区分别记最近 8 个文件。
- **Markdown 预览**：使用宿主聊天的排版样式。
  - 支持标题、列表（嵌套、任务列表）、表格、代码块（带复制按钮）、`> [!NOTE]` 提示块、YAML 头信息。
  - 链接：相对路径在面板内打开，可以「返回」上一个文件；http(s) 用系统浏览器打开；`#锚点` 在预览内滚动。
  - 原始 HTML 只按文本显示，不会执行。
- **Mermaid 图表**：```` ```mermaid ```` 代码块渲染成图。
  - 跟随深色/浅色模式，可以切换查看源码。
  - 宽图按面板宽度缩小，最小到 75%，再宽就横向滚动；点击图可全窗口放大。
- **其它文本文件**：用等宽字体显示，编码先试 UTF-8，再试 GBK。
- **二进制文件和超过 1MB 的文件**：先显示文件大小，可选择用默认应用打开、在资源管理器中显示，或仍然在面板打开。

## 权限说明

| 权限 | 用途 |
|---|---|
| `ui:panel-tab` | 注册右侧面板页签 |
| `ui:overlay` | Mermaid 图的全窗口放大浮层，只在点击图后出现 |
| `storage` | 记住每个工作区的「最近打开」列表，以及该分组的折叠状态 |
| `i18n` | 注册中文和英文文案 |
| `assets:bundle` | 加载插件包内自带的 `mermaid.min.js`，只在打开含 Mermaid 的文件时加载，不联网 |
| `exec:git` | 搜索时运行 `git -C <工作区> ls-files` 列出文件 |
| `exec:powershell` | 列目录（`Get-ChildItem`）、分块读取文件内容、用默认应用打开文件或链接（`Invoke-Item` / `Start-Process`）、在资源管理器中定位文件 |

## 数据去向

- **只读**：插件只读取当前工作区内的文件，不写入、不修改、不删除任何文件。
- **不联网**：插件不发起任何网络请求。只有在你点击 http(s) 链接时，才会交给系统默认浏览器打开。
- **路径传递**：所有路径都通过环境变量传给 powershell，不拼接进脚本文本。
- **本地存储**：只有「最近打开」列表（工作区内的相对路径），保存在 CC GUI 为插件隔离的本地存储里。

## 已知限制

- 宿主对单次命令输出有 64KB 上限，所以大文件要分块读取，几百 KB 的文件需要几秒（会显示进度）。
- 不支持公式和语法高亮；相对路径的图片只显示 alt 文字。
- 点击聊天里的文件链接仍会走宿主原来的逻辑（在中间区域打开），插件无法改变这一点。

## 安装

- **插件市场**：上架后在 CC GUI 插件市场搜索「文件预览」。
- **本地安装**：CC GUI 侧边栏「插件」→「从本地目录安装」→ 选择本仓库目录。

## 致谢

- 内置 [Mermaid](https://github.com/mermaid-js/mermaid) 11.17.2（MIT），见 `THIRD_PARTY_NOTICES.md`。
- 本插件包含 AI 辅助生成的代码。

---

## English

Browse the current workspace's file tree in CC GUI's **right-hand panel** and preview files right there, without opening a new center tab (similar to Codex Desktop).

> **Windows only.** File access relies on the built-in `powershell`. On macOS / Linux the panel only shows a "Windows only" notice.

### Features

- **File tree**: looks the same as the host's file tree. Folders load lazily, hidden files are shown, folders come first, and hovering the root row shows a refresh button.
- **Search**: searches the whole workspace. Separate keywords with spaces; Enter opens the first result.
  - In git repositories it uses `git ls-files`, which includes untracked files and respects `.gitignore`.
  - Other folders fall back to a recursive search that skips `node_modules`, `.git`, `dist`, etc.
- **Recent**: a collapsible group with the last 8 files, remembered per workspace.
- **Markdown preview**: uses the host's chat typography.
  - Supports headings, lists (nested and task lists), tables, code blocks with a copy button, `> [!NOTE]` alerts and YAML front matter.
  - Links: relative links open in the panel (with Back history), http(s) links open in your browser, and `#anchor` links scroll within the preview.
  - Raw HTML is shown as text and never executed.
- **Mermaid diagrams**: rendered from ```` ```mermaid ```` blocks.
  - Follows dark/light mode, with a toggle to show the source.
  - Wide diagrams shrink to fit the panel (down to 75%) and then scroll horizontally; click a diagram to view it full-window.
- **Other text files**: shown in a monospace font, decoded as UTF-8 with a GBK fallback.
- **Binary files and files over 1 MB**: the plugin first shows the file size and lets you open it with the default app, show it in Explorer, or open it in the panel anyway.

### Permissions

| Permission | Why |
|---|---|
| `ui:panel-tab` | The right-panel tab |
| `ui:overlay` | Full-window diagram viewer, shown only after you click a diagram |
| `storage` | Per-workspace "Recent" list and its collapsed state |
| `i18n` | Chinese and English strings |
| `assets:bundle` | Loads the bundled `mermaid.min.js`, only when a file contains a diagram; no network access |
| `exec:git` | `git -C <workspace> ls-files` for search |
| `exec:powershell` | List folders (`Get-ChildItem`), read files in chunks, open files or links with the default app (`Invoke-Item` / `Start-Process`), and show a file in Explorer |

### Data

- **Read-only**: the plugin only reads files inside the current workspace. It never writes, modifies or deletes files.
- **No network access**: the plugin makes no network requests. http(s) links are opened by your default browser only when you click them.
- **Paths**: all paths are passed to powershell through environment variables and are never spliced into script text.
- **Stored data**: only the "Recent" list (paths relative to the workspace), kept in CC GUI's per-plugin local storage.

### Limitations

- The host caps each command's output at 64 KB, so large files are read in chunks. Files of a few hundred KB take a few seconds; progress is shown.
- No math rendering or syntax highlighting. Relative image links show their alt text only.
- Clicking file links in the chat still uses the host's default behavior (opens in the center area). A plugin can't change that.

### Credits

- Bundles [Mermaid](https://github.com/mermaid-js/mermaid) 11.17.2 (MIT); see `THIRD_PARTY_NOTICES.md`.
- This plugin contains AI-assisted code.
