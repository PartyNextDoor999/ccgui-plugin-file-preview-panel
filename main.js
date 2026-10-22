// 文件预览面板 —— 右侧面板页签：工作区目录树 + Markdown / 文本预览。
// 单文件 ESM：不能 import，组件全部用 ctx.react.createElement 构建。
//
// 读盘只能经 ctx.bridge.invoke("plugin_exec_run")，而宿主对 stdout 有 64KB 上限
// （超出静默截断）且不支持 cwd，所以：
//   - 目录按层懒加载，并分页拉取；
//   - 文件按 45KB 分块读，base64 回传后在 JS 侧拼接解码（同时绕开控制台编码问题）；
//   - 所有路径一律走环境变量传给 powershell，不拼进脚本文本，避免转义/注入问题。

const CHUNK_BYTES = 45000; // base64 后约 60KB，留出余量
const OUTPUT_CAP = 60000; // 接近 64KB 时视为可能被截断
const LARGE_FILE = 1024 * 1024;
const MAX_RECENT = 8;
const MAX_SEARCH_RESULTS = 200;
const MAX_DIR_ENTRIES = 5000;
const SEARCH_SKIP_DIRS = ["node_modules", ".git", "dist", "build", "target", ".next", "out", ".venv", "venv", "__pycache__"];

const PS_PRELUDE =
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" +
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8;";

// ---------------------------------------------------------------------------
// 图标：与宿主 src/features/files/fileIcons.ts 保持同一套 SVG（lucide 路径 + 语言色块）
// ---------------------------------------------------------------------------

const svg16 = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none">${body}</svg>`;
const svg24 = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const FILE_SHAPE = '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>';
const icon_folder = svg24('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>');
const icon_folder_open = svg24('<path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/>');
const icon_file = svg24(FILE_SHAPE);
const icon_file_text = svg24(`${FILE_SHAPE}<path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>`);
const icon_file_code = svg24(`${FILE_SHAPE}<path d="M10 12.5 8 15l2 2.5"/><path d="m14 12.5 2 2.5-2 2.5"/>`);

const badgeText = (bg, fg, label, fontSize) => {
  const size = fontSize ?? (label.length > 2 ? 5.5 : 7);
  const y = size <= 6 ? 10.5 : 10.9;
  return svg16(
    `<rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="${bg}"/><text x="8" y="${y}" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="${size}" font-weight="700" fill="${fg}">${label}</text>`,
  );
};

const icon_js = badgeText("#F5DE19", "#33301C", "JS");
const icon_ts = badgeText("#3178C6", "#FFFFFF", "TS");
const icon_jsx = badgeText("#00D8FF", "#002C33", "JSX");
const icon_tsx = badgeText("#3178C6", "#FFFFFF", "TSX");
const icon_vue = badgeText("#41B883", "#35495E", "Vue");
const icon_python = badgeText("#3776AB", "#FFD43B", "Py");
const icon_rust = badgeText("#CE412B", "#FFFFFF", "RS");
const icon_go = badgeText("#00ADD8", "#FFFFFF", "GO");
const icon_c = badgeText("#659AD2", "#FFFFFF", "C");
const icon_cpp = badgeText("#00599C", "#FFFFFF", "C++");
const icon_cs = badgeText("#178600", "#FFFFFF", "C#");
const icon_java = badgeText("#EA2D2E", "#FFFFFF", "J");
const icon_kotlin = badgeText("#7F52FF", "#FFFFFF", "KT");
const icon_sql = badgeText("#E38C00", "#FFFFFF", "SQL");
const icon_xml = badgeText("#E44D26", "#FFFFFF", "XML");
const icon_php = badgeText("#777BB4", "#FFFFFF", "PHP");
const icon_ruby = badgeText("#CC342D", "#FFFFFF", "RB");
const icon_swift = badgeText("#F05138", "#FFFFFF", "SW");
const icon_json = svg16(
  '<path d="M6.1 2.4c-1.35 0-2 .68-2 2.02v1.5c0 .9-.45 1.5-1.5 1.72v.72c1.05.22 1.5.82 1.5 1.72v1.5c0 1.34.65 2.02 2 2.02" stroke="#D9A62E" stroke-width="1.25" stroke-linecap="round"/><path d="M9.9 2.4c1.35 0 2 .68 2 2.02v1.5c0 .9.45 1.5 1.5 1.72v.72c-1.05.22-1.5.82-1.5 1.72v1.5c0 1.34-.65 2.02-2 2.02" stroke="#D9A62E" stroke-width="1.25" stroke-linecap="round"/>',
);
const icon_git = svg16(
  '<rect x="3.1" y="3.1" width="9.8" height="9.8" rx="1.8" transform="rotate(45 8 8)" fill="#F05133"/><circle cx="8" cy="5.3" r="1.05" fill="#fff"/><circle cx="8" cy="10.7" r="1.05" fill="#fff"/><path d="M8 6.4v3.2" stroke="#fff" stroke-width="1"/>',
);
const icon_markdown = svg16(
  '<rect x="1" y="3.5" width="14" height="9" rx="1.8" fill="#57534E"/><path d="M3.2 10.1V5.9l1.9 2.2 1.9-2.2v4.2" stroke="#fff" stroke-width="1.05" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.3 5.9v4.2m0 0-1.5-1.6m1.5 1.6 1.5-1.6" stroke="#fff" stroke-width="1.05" stroke-linecap="round" stroke-linejoin="round"/>',
);
const icon_lock = svg16(
  '<rect x="3.6" y="7.1" width="8.8" height="6.3" rx="1.6" fill="#E3B341"/><path d="M5.6 7V5.3a2.4 2.4 0 0 1 4.8 0V7" stroke="#E3B341" stroke-width="1.4"/>',
);
const icon_image = svg16(
  '<rect x="2" y="2.75" width="12" height="10.5" rx="1.75" stroke="#4CAF50" stroke-width="1.2"/><circle cx="5.8" cy="6.4" r="1.15" fill="#4CAF50"/><path d="m3.9 12.9 3.3-3.7a.9.9 0 0 1 1.34 0l3.36 3.7" stroke="#4CAF50" stroke-width="1.2" stroke-linecap="round"/>',
);
const icon_css = svg16(
  '<path d="M6.6 2.6 5 13.4M11 2.6 9.4 13.4M3.2 6h10.4M2.4 10h10.4" stroke="#4C97E4" stroke-width="1.25" stroke-linecap="round"/>',
);
const icon_html = svg16(
  '<path d="m5.6 4.6-3.2 3.4 3.2 3.4M10.4 4.6l3.2 3.4-3.2 3.4" stroke="#E44D26" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
);
const icon_shell = svg16(
  '<path d="m2.8 4.6 3.4 3.4-3.4 3.4" stroke="#4CAF50" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.4 11.4h4.8" stroke="#4CAF50" stroke-width="1.3" stroke-linecap="round"/>',
);
const icon_config = svg24(
  '<path d="M3 6h12M19 6h2M3 12h2M9 12h12M3 18h12M19 18h2"/><circle cx="17" cy="6" r="2"/><circle cx="7" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
);

const EXT_ICONS = {
  js: icon_js, cjs: icon_js, mjs: icon_js, jsx: icon_jsx,
  ts: icon_ts, cts: icon_ts, mts: icon_ts, tsx: icon_tsx,
  json: icon_json, jsonc: icon_json, json5: icon_json,
  md: icon_markdown, markdown: icon_markdown, mdx: icon_markdown,
  lock: icon_lock,
  css: icon_css, scss: icon_css, sass: icon_css, less: icon_css,
  html: icon_html, htm: icon_html, svelte: icon_html, astro: icon_html, vue: icon_vue,
  sh: icon_shell, bash: icon_shell, zsh: icon_shell, fish: icon_shell, bat: icon_shell, cmd: icon_shell, ps1: icon_shell,
  yml: icon_config, yaml: icon_config, toml: icon_config, ini: icon_config, cfg: icon_config, conf: icon_config, editorconfig: icon_config,
  java: icon_java, kt: icon_kotlin, kts: icon_kotlin, py: icon_python, pyw: icon_python, rs: icon_rust, go: icon_go,
  c: icon_c, h: icon_c, cpp: icon_cpp, cc: icon_cpp, cxx: icon_cpp, hpp: icon_cpp, hxx: icon_cpp, cs: icon_cs,
  sql: icon_sql, xml: icon_xml, xsd: icon_xml, php: icon_php, rb: icon_ruby, swift: icon_swift,
  png: icon_image, jpg: icon_image, jpeg: icon_image, gif: icon_image, webp: icon_image, ico: icon_image, bmp: icon_image, svg: icon_image, avif: icon_image,
};
const CODE_EXTENSIONS = new Set(["scala", "graphql", "gql", "prisma", "proto", "lua", "zig", "ex", "exs", "erl", "hs", "ml", "clj", "dart", "r", "jl", "pl", "vim", "tf", "hcl", "gradle", "cmake", "nim", "d"]);
const TEXT_EXTENSIONS = new Set(["txt", "log", "csv", "tsv", "rtf", "pdf", "doc", "docx", "tex", "adoc", "rst", "org", "epub"]);
const CODE_FILE_NAMES = new Set(["makefile", "dockerfile", "jenkinsfile", "gemfile", "rakefile", "procfile", "pipfile", "gradlew"]);
const TEXT_FILE_NAMES = new Set(["readme", "license", "licence", "changelog"]);

function fileIconSvg(fileName, isDir, isOpen) {
  if (isDir) return isOpen ? icon_folder_open : icon_folder;
  const name = fileName.toLowerCase();
  if (name === ".git" || name.startsWith(".git")) return icon_git;
  if (name.endsWith(".lock") || name.endsWith(".lockb") || name.includes("-lock.")) return icon_lock;
  const ext = extOf(name);
  if (EXT_ICONS[ext]) return EXT_ICONS[ext];
  if (CODE_FILE_NAMES.has(name) || CODE_EXTENSIONS.has(ext)) return icon_file_code;
  if (TEXT_FILE_NAMES.has(name) || TEXT_EXTENSIONS.has(ext)) return icon_file_text;
  return icon_file;
}

// 工具栏用的 lucide 线框图标（24 视口、currentColor）
const LUCIDE = {
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  folderSearch: '<path d="M10.7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v4.1"/><circle cx="17" cy="17" r="3"/><path d="m21 21-1.5-1.5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  fileText: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
};

// ---------------------------------------------------------------------------
// 纯函数工具
// ---------------------------------------------------------------------------

function extOf(name) {
  const lower = name.toLowerCase();
  const idx = lower.lastIndexOf(".");
  return idx > 0 ? lower.slice(idx + 1) : idx === 0 ? lower.slice(1) : "";
}

function isMarkdownName(name) {
  return ["md", "markdown", "mdx", "mdown", "mkd"].includes(extOf(name));
}

function baseName(p) {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function dirName(rel) {
  const idx = rel.lastIndexOf("/");
  return idx >= 0 ? rel.slice(0, idx) : "";
}

function trimRoot(ws) {
  // 保留 "C:\" 这种盘符根目录的结尾分隔符
  const trimmed = ws.replace(/[\\/]+$/, "");
  return /^[A-Za-z]:$/.test(trimmed) ? trimmed + "\\" : trimmed;
}

function toAbs(ws, rel) {
  const root = trimRoot(ws);
  if (!rel) return root;
  const sep = root.endsWith("\\") || root.endsWith("/") ? "" : "\\";
  return root + sep + rel.replace(/\//g, "\\");
}

// 规范化相对路径：处理 . 与 ..；越出工作区返回 null
function normalizeRel(rel) {
  const out = [];
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const utf8 = new TextDecoder("utf-8");
function b64ToText(b64) {
  return utf8.decode(b64ToBytes(b64));
}

function looksBinary(bytes) {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

// 优先严格 UTF-8；失败再试 GBK（中文 Windows 上的老文件），最后宽松 UTF-8
function decodeText(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("gbk", { fatal: true }).decode(bytes);
    } catch {
      return utf8.decode(bytes);
    }
  }
}

function sortEntries(entries) {
  // 与宿主 list_dir 一致：目录在前，然后按名称字节序
  return entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Markdown → React 元素（自带的简化 GFM 解析器；原始 HTML 一律按文本显示）
// ---------------------------------------------------------------------------

const ALERT_TYPES = { NOTE: "Note", TIP: "Tip", IMPORTANT: "Important", WARNING: "Warning", CAUTION: "Caution" };

const RE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const RE_ATX = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_LIST = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const RE_QUOTE = /^ {0,3}> ?/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const RE_SETEXT = /^ {0,3}(=+|-+)\s*$/;
const RE_REFDEF = /^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+["'(].*["')])?\s*$/;

function isBlank(line) {
  return /^\s*$/.test(line);
}

function indentOf(line) {
  return line.match(/^ */)[0].length;
}

function startsBlock(line) {
  return RE_FENCE.test(line) || RE_ATX.test(line) || RE_HR.test(line) || RE_QUOTE.test(line) || RE_LIST.test(line);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "`") {
      inCode = !inCode;
      cur += c;
    } else if (c === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

// 块级解析：返回 AST 节点数组
function parseBlocks(lines, refs) {
  const nodes = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = line.match(RE_FENCE);
    if (fence) {
      const marker = fence[1];
      const fenceIndent = indentOf(line);
      const body = [];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        const close = l.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) {
          i++;
          break;
        }
        body.push(l.slice(Math.min(fenceIndent, indentOf(l))));
        i++;
      }
      nodes.push({ type: "code", lang: fence[2] || "", text: body.join("\n") });
      continue;
    }

    const atx = line.match(RE_ATX);
    if (atx) {
      nodes.push({ type: "heading", level: atx[1].length, text: atx[2] || "" });
      i++;
      continue;
    }

    if (RE_HR.test(line)) {
      nodes.push({ type: "hr" });
      i++;
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && !isBlank(lines[i])) {
        // 惰性续行：没有 > 的非空行也算进引用
        body.push(lines[i].replace(RE_QUOTE, ""));
        i++;
      }
      const alert = body.length ? body[0].trim().match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i) : null;
      if (alert) {
        nodes.push({ type: "alert", kind: alert[1].toUpperCase(), children: parseBlocks(body.slice(1), refs) });
      } else {
        nodes.push({ type: "quote", children: parseBlocks(body, refs) });
      }
      continue;
    }

    const listMatch = line.match(RE_LIST);
    if (listMatch && !(RE_HR.test(line))) {
      const res = parseList(lines, i, refs);
      nodes.push(res.node);
      i = res.next;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(":");
        const r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : null;
      });
      const rows = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      nodes.push({ type: "table", header, aligns, rows });
      continue;
    }

    const refdef = line.match(RE_REFDEF);
    if (refdef) {
      i++;
      continue;
    }

    // 段落（含 setext 标题）
    const para = [line.trim()];
    i++;
    let setext = 0;
    while (i < lines.length && !isBlank(lines[i])) {
      const l = lines[i];
      const st = l.match(RE_SETEXT);
      if (st) {
        setext = st[1][0] === "=" ? 1 : 2;
        i++;
        break;
      }
      if (startsBlock(l) && !/^ {4,}/.test(l)) break;
      para.push(l.trim());
      i++;
    }
    if (setext) nodes.push({ type: "heading", level: setext, text: para.join(" ") });
    else nodes.push({ type: "para", text: para.join("\n") });
  }
  return nodes;
}

function parseList(lines, start, refs) {
  const first = lines[start].match(RE_LIST);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let loose = false;
  let i = start;

  while (i < lines.length) {
    const m = lines[i].match(RE_LIST);
    if (!m || m[1].length > baseIndent + 3 || m[1].length < baseIndent || /\d/.test(m[2]) !== ordered) break;
    if (RE_HR.test(lines[i])) break;
    const contentIndent = m[1].length + m[2].length + Math.max(1, Math.min(m[3].length, 4));
    const body = [m[4]];
    i++;
    let sawBlank = false;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        // 空行后若下一行仍缩进到内容列，则属于本项（松散列表）
        let j = i + 1;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) >= contentIndent) {
          for (let k = i; k < j; k++) body.push("");
          sawBlank = true;
          i = j;
          continue;
        }
        break;
      }
      const ind = indentOf(l);
      if (ind >= contentIndent) {
        body.push(l.slice(contentIndent));
        i++;
        continue;
      }
      const sub = l.match(RE_LIST);
      if (sub && sub[1].length <= baseIndent) break; // 同级下一项或更外层
      if (sub) {
        // 缩进不足内容列但比本项深的子列表（如 "1. " 下缩进 2 格的 "- "）
        body.push(l.slice(ind));
        i++;
        continue;
      }
      if (startsBlock(l)) break;
      body.push(l.trim()); // 惰性续行
      i++;
    }
    if (sawBlank) loose = true;

    let task = null;
    const taskMatch = body[0].match(/^\[([ xX])\]\s+(.*)$/);
    if (taskMatch) {
      task = taskMatch[1] !== " ";
      body[0] = taskMatch[2];
    }
    items.push({ task, children: parseBlocks(body, refs) });

    // 列表项之间的空行
    let j = i;
    while (j < lines.length && isBlank(lines[j])) j++;
    if (j > i && j < lines.length) {
      const nm = lines[j].match(RE_LIST);
      if (nm && nm[1].length >= baseIndent && nm[1].length <= baseIndent + 3 && /\d/.test(nm[2]) === ordered) {
        loose = true;
        i = j;
        continue;
      }
    }
  }
  return { node: { type: "list", ordered, start: startNum, loose, items }, next: i };
}

function collectRefs(lines) {
  const refs = {};
  let inFence = false;
  for (const line of lines) {
    if (RE_FENCE.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = line.match(RE_REFDEF);
    if (m) refs[m[1].toLowerCase()] = m[2];
  }
  return refs;
}

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function plainText(src) {
  return src
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "");
}

// 行内解析：返回 AST 节点数组
function parseInline(src, refs) {
  const out = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  let i = 0;
  const n = src.length;

  const findClose = (open, from) => {
    // 找与 open 对应的 ]，支持嵌套
    let depth = 1;
    for (let k = from; k < n; k++) {
      const c = src[k];
      if (c === "\\") {
        k++;
        continue;
      }
      if (c === "`") {
        const end = src.indexOf("`", k + 1);
        if (end > 0) k = end;
        continue;
      }
      if (c === open) depth++;
      else if (c === "]" && --depth === 0) return k;
    }
    return -1;
  };

  const parseDest = (from) => {
    // src[from] === "("，返回 { url, end }
    let depth = 1;
    for (let k = from + 1; k < n; k++) {
      const c = src[k];
      if (c === "\\") {
        k++;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) {
        let inner = src.slice(from + 1, k).trim();
        const titled = inner.match(/^(\S+)\s+["'(].*["')]$/);
        if (titled) inner = titled[1];
        if (inner.startsWith("<") && inner.endsWith(">")) inner = inner.slice(1, -1);
        return { url: inner, end: k + 1 };
      }
    }
    return null;
  };

  while (i < n) {
    const c = src[i];

    if (c === "\\" && i + 1 < n && /[!-/:-@[-`{-~]/.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    if (c === "\n") {
      // 行尾两个空格或反斜杠 = 硬换行；否则软换行当空格
      if (buf.endsWith("  ")) {
        buf = buf.replace(/ +$/, "");
        flush();
        out.push({ t: "br" });
      } else buf += " ";
      i++;
      continue;
    }

    if (c === "`") {
      let ticks = 1;
      while (src[i + ticks] === "`") ticks++;
      const fence = "`".repeat(ticks);
      const end = src.indexOf(fence, i + ticks);
      if (end > 0) {
        flush();
        let code = src.slice(i + ticks, end).replace(/\n/g, " ");
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        out.push({ t: "code", v: code });
        i = end + ticks;
        continue;
      }
      buf += fence;
      i += ticks;
      continue;
    }

    if ((c === "!" && src[i + 1] === "[") || c === "[") {
      const isImage = c === "!";
      const open = isImage ? i + 1 : i;
      const close = findClose("[", open + 1);
      if (close > 0) {
        const label = src.slice(open + 1, close);
        let url = null;
        let end = close + 1;
        if (src[close + 1] === "(") {
          const dest = parseDest(close + 1);
          if (dest) {
            url = dest.url;
            end = dest.end;
          }
        } else if (src[close + 1] === "[") {
          const refEnd = src.indexOf("]", close + 2);
          if (refEnd > 0) {
            const key = (src.slice(close + 2, refEnd) || label).toLowerCase();
            if (refs[key]) {
              url = refs[key];
              end = refEnd + 1;
            }
          }
        } else if (refs[label.toLowerCase()]) {
          url = refs[label.toLowerCase()];
        }
        if (url !== null) {
          flush();
          if (isImage) out.push({ t: "img", alt: plainText(label), url });
          else out.push({ t: "link", url, children: parseInline(label, refs) });
          i = end;
          continue;
        }
      }
    }

    if (c === "<") {
      const auto = src.slice(i).match(/^<((?:https?:\/\/|mailto:)[^\s>]+)>/i);
      if (auto) {
        flush();
        out.push({ t: "link", url: auto[1], children: [{ t: "text", v: auto[1] }] });
        i += auto[0].length;
        continue;
      }
    }

    if ((c === "h" || c === "H") && !/[A-Za-z0-9]/.test(src[i - 1] || "")) {
      const bare = src.slice(i).match(/^https?:\/\/[^\s<>()\u3000-\u303f\uff00-\uffef]+/i);
      if (bare) {
        let url = bare[0].replace(/[.,;:!?'"*_~]+$/, "");
        flush();
        out.push({ t: "link", url, children: [{ t: "text", v: url }] });
        i += url.length;
        continue;
      }
    }

    if (c === "~" && src[i + 1] === "~") {
      const end = src.indexOf("~~", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "del", children: parseInline(src.slice(i + 2, end), refs) });
        i = end + 2;
        continue;
      }
    }

    if (c === "*" || c === "_") {
      const prev = src[i - 1] || "";
      const intraword = c === "_" && /[\p{L}\p{N}]/u.test(prev);
      if (!intraword) {
        const dbl = src[i + 1] === c;
        const delim = dbl ? c + c : c;
        const from = i + delim.length;
        if (src[from] && !/\s/.test(src[from])) {
          // 找到不紧跟空白、且（单分隔符时）不属于双分隔符的闭合位置
          let end = -1;
          for (let pos = src.indexOf(delim, from); pos >= 0; pos = src.indexOf(delim, pos + 1)) {
            const before = src[pos - 1];
            const after = src[pos + delim.length] || "";
            const okSingle = dbl || (src[pos + 1] !== c && before !== c);
            const okWord = c !== "_" || !/[\p{L}\p{N}]/u.test(after);
            if (pos > from && !/\s/.test(before) && okSingle && okWord) {
              end = pos;
              break;
            }
          }
          if (end > from) {
            flush();
            out.push({ t: dbl ? "strong" : "em", children: parseInline(src.slice(from, end), refs) });
            i = end + delim.length;
            continue;
          }
        }
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

// AST → React
function renderMarkdown(h, source, handlers) {
  const lines = source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const blocks = [];

  // YAML front matter 按代码块显示
  let body = lines;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      blocks.push({ type: "code", lang: "yaml", text: lines.slice(1, end).join("\n") });
      body = lines.slice(end + 1);
    }
  }
  const refs = collectRefs(body);
  blocks.push(...parseBlocks(body, refs));

  const slugCount = new Map();
  const uniqueSlug = (text) => {
    const base = slugify(plainText(text));
    const count = slugCount.get(base) || 0;
    slugCount.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  };

  let key = 0;
  const k = () => key++;

  const inline = (nodes) =>
    nodes.map((node) => {
      switch (node.t) {
        case "text":
          return node.v;
        case "br":
          return h("br", { key: k() });
        case "code":
          return h("code", { key: k() }, node.v);
        case "strong":
          return h("strong", { key: k() }, inline(node.children));
        case "em":
          return h("em", { key: k() }, inline(node.children));
        case "del":
          return h("del", { key: k() }, inline(node.children));
        case "img":
          return h(
            "span",
            { key: k(), className: "fp-md-img", title: node.url },
            node.alt ? t("image", { alt: node.alt }) : t("imageNoAlt"),
          );
        case "link":
          return h(
            "a",
            {
              key: k(),
              role: "link",
              tabIndex: 0,
              title: node.url,
              onClick: (e) => {
                e.preventDefault();
                handlers.onLink(node.url);
              },
              onKeyDown: (e) => {
                if (e.key === "Enter") handlers.onLink(node.url);
              },
            },
            inline(node.children),
          );
        default:
          return null;
      }
    });

  const block = (node, tight) => {
    switch (node.type) {
      case "heading": {
        const slug = uniqueSlug(node.text);
        return h(`h${node.level}`, { key: k(), "data-fp-anchor": slug }, inline(parseInline(node.text, refs)));
      }
      case "para":
        return tight
          ? h(Fragment, { key: k() }, inline(parseInline(node.text, refs)))
          : h("p", { key: k() }, inline(parseInline(node.text, refs)));
      case "hr":
        return h("hr", { key: k() });
      case "code":
        if (MermaidBlock && /^(mermaid|mmd)$/i.test(node.lang)) return h(MermaidBlock, { key: k(), text: node.text });
        return h(CodeBlock, { key: k(), lang: node.lang, text: node.text });
      case "quote":
        return h("blockquote", { key: k() }, node.children.map((c) => block(c, false)));
      case "alert":
        return h(
          "blockquote",
          { key: k(), className: `md-alert md-alert-${node.kind.toLowerCase()}` },
          h("div", { className: "md-alert-title" }, ALERT_TYPES[node.kind]),
          node.children.map((c) => block(c, false)),
        );
      case "list": {
        const items = node.items.map((item) =>
          h(
            "li",
            { key: k(), className: item.task === null ? undefined : "fp-task" },
            item.task === null ? null : h("input", { type: "checkbox", checked: item.task, readOnly: true, disabled: true }),
            item.children.map((c) => block(c, !node.loose)),
          ),
        );
        return node.ordered
          ? h("ol", { key: k(), start: node.start !== 1 ? node.start : undefined }, items)
          : h("ul", { key: k() }, items);
      }
      case "table":
        return h(
          "table",
          { key: k() },
          h(
            "thead",
            null,
            h("tr", null, node.header.map((cell, ci) => h("th", { key: ci, style: node.aligns[ci] ? { textAlign: node.aligns[ci] } : undefined }, inline(parseInline(cell, refs))))),
          ),
          h(
            "tbody",
            null,
            node.rows.map((row, ri) =>
              h(
                "tr",
                { key: ri },
                node.header.map((_, ci) =>
                  h("td", { key: ci, style: node.aligns[ci] ? { textAlign: node.aligns[ci] } : undefined }, inline(parseInline(row[ci] || "", refs))),
                ),
              ),
            ),
          ),
        );
      default:
        return null;
    }
  };

  return blocks.map((b) => block(b, false));
}

// ---------------------------------------------------------------------------
// i18n：文案同时注册进宿主 i18next（ctx.i18n.addBundle）；插件侧按 ctx.host.locale 取用
// ---------------------------------------------------------------------------

const I18N_NS = "file-preview-panel";
const MESSAGES = {
  "zh-CN": {
    tabLabel: "文件预览",
    windowsOnly: "文件预览面板目前仅支持 Windows。",
    noWorkspace: "当前会话没有关联工作区",
    image: "［图片：{alt}］",
    imageNoAlt: "［图片］",
    psExit: "powershell 退出码 {code}",
    copy: "复制",
    copied: "已复制",
    mermaidNoGlobal: "mermaid 脚本已加载但没有挂载全局对象",
    mermaidLoadFailed: "mermaid.min.js 加载失败",
    viewChart: "查看图表",
    viewSource: "查看源码",
    chartFailed: "图表渲染失败：{error}",
    chartRendering: "正在渲染图表…",
    clickToZoom: "点击放大",
    zoomDialog: "图表放大查看",
    chart: "图表",
    closeEsc: "关闭（Esc）",
    refresh: "刷新",
    readFailed: "读取失败：{error}",
    dirTruncated: "仅显示前 {n} 项",
    searchPlaceholder: "搜索文件…",
    clear: "清除",
    searching: "搜索中…",
    searchFailed: "搜索失败：{error}",
    noMatches: "没有匹配的文件",
    searchTruncated: "结果较多，仅显示前 {n} 条，请输入更具体的关键词",
    recent: "最近打开",
    linkOutside: "链接指向工作区之外，已忽略",
    openDefault: "用默认应用打开",
    reveal: "在资源管理器中显示",
    back: "返回",
    reload: "重新读取",
    reading: "读取中…",
    readingProgress: "读取中… {pct}%",
    binary: "这是二进制文件（{size}），无法在面板中预览。",
    large: "文件较大（{size}），在面板中打开可能需要较长时间。",
    openAnyway: "仍然在面板打开",
  },
  en: {
    tabLabel: "File Preview",
    windowsOnly: "File Preview currently supports Windows only.",
    noWorkspace: "This session has no workspace",
    image: "[Image: {alt}]",
    imageNoAlt: "[Image]",
    psExit: "powershell exited with code {code}",
    copy: "Copy",
    copied: "Copied",
    mermaidNoGlobal: "mermaid script loaded but no global object was found",
    mermaidLoadFailed: "Failed to load mermaid.min.js",
    viewChart: "Show diagram",
    viewSource: "Show source",
    chartFailed: "Diagram failed to render: {error}",
    chartRendering: "Rendering diagram…",
    clickToZoom: "Click to zoom",
    zoomDialog: "Diagram viewer",
    chart: "Diagram",
    closeEsc: "Close (Esc)",
    refresh: "Refresh",
    readFailed: "Failed to read: {error}",
    dirTruncated: "Showing the first {n} entries",
    searchPlaceholder: "Search files…",
    clear: "Clear",
    searching: "Searching…",
    searchFailed: "Search failed: {error}",
    noMatches: "No matching files",
    searchTruncated: "Too many results, showing the first {n}. Try a more specific query.",
    recent: "Recent",
    linkOutside: "The link points outside the workspace and was ignored",
    openDefault: "Open with default app",
    reveal: "Show in Explorer",
    back: "Back",
    reload: "Reload",
    reading: "Reading…",
    readingProgress: "Reading… {pct}%",
    binary: "Binary file ({size}), which cannot be previewed in the panel.",
    large: "Large file ({size}). Opening it in the panel may take a while.",
    openAnyway: "Open in panel anyway",
  },
};

let localeGetter = () => "zh";
function currentLang() {
  return String(localeGetter() || "zh").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}
function t(key, vars) {
  let text = MESSAGES[currentLang()][key] ?? MESSAGES["zh-CN"][key] ?? key;
  if (vars) text = text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
  return text;
}

const IS_WINDOWS = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

// 由 activate 注入，供上面的渲染函数使用
let Fragment = null;
let CodeBlock = null;
let MermaidBlock = null;

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------

export default function activate(ctx) {
  const React = ctx.react;
  const { createElement: h, useState, useEffect, useRef, useCallback, useMemo } = React;
  Fragment = React.Fragment;

  localeGetter = () => ctx.host.locale;
  // 宿主 i18next 的语言码是 zh / en；zh 与 zh-CN 指向同一份文案
  ctx.i18n.addBundle("zh-CN", I18N_NS, MESSAGES["zh-CN"]);
  ctx.i18n.addBundle("zh", I18N_NS, MESSAGES["zh-CN"]);
  ctx.i18n.addBundle("en", I18N_NS, MESSAGES.en);

  // 宿主切换语言时会更新 <html lang>，据此触发重渲染
  function useLocale() {
    const [, setLang] = useState(currentLang);
    useEffect(() => {
      const observer = new MutationObserver(() => setLang(currentLang()));
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
      return () => observer.disconnect();
    }, []);
  }

  // ---- 进程调用 -----------------------------------------------------------

  async function ps(script, env, timeoutMs = 30000) {
    const res = await ctx.bridge.invoke("plugin_exec_run", {
      bin: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_PRELUDE + script],
      env: env || {},
      timeoutMs,
    });
    if (res.code !== 0) {
      const msg = (res.stderr || "").trim().split(/\r?\n/)[0];
      throw new Error(msg || t("psExit", { code: res.code }));
    }
    return res.stdout || "";
  }

  const PS_LIST_DIR =
    "$items=@(Get-ChildItem -LiteralPath $env:CCFP_PATH -Force);" +
    "'total|'+$items.Count;" +
    "foreach($i in ($items|Select-Object -Skip ([int]$env:CCFP_SKIP) -First 800)){" +
    "$t=if($i.PSIsContainer){'d'}else{'f'};$s=if($i.PSIsContainer){0}else{$i.Length};" +
    "$t+'|'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($i.Name))+'|'+$s}";

  async function listDir(abs) {
    const entries = [];
    let total = Infinity;
    while (entries.length < total && entries.length < MAX_DIR_ENTRIES) {
      const out = await ps(PS_LIST_DIR, { CCFP_PATH: abs, CCFP_SKIP: String(entries.length) });
      let lines = out.split(/\r?\n/).filter(Boolean);
      // 输出接近上限时最后一行可能被截断，丢弃后下一页重新拉
      if (out.length >= OUTPUT_CAP) lines = lines.slice(0, -1);
      let added = 0;
      for (const line of lines) {
        const parts = line.split("|");
        if (parts[0] === "total") {
          total = parseInt(parts[1], 10) || 0;
          continue;
        }
        if (parts.length !== 3) continue;
        entries.push({ name: b64ToText(parts[1]), isDir: parts[0] === "d", size: Number(parts[2]) || 0 });
        added++;
      }
      if (!added) break;
    }
    return { entries: sortEntries(entries), truncated: entries.length < total };
  }

  const PS_READ_CHUNK =
    "$fs=[IO.File]::Open($env:CCFP_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);" +
    "try{$size=$fs.Length;$off=[int64]$env:CCFP_OFF;" +
    "if($off -lt $size){[void]$fs.Seek($off,[IO.SeekOrigin]::Begin)};" +
    `$buf=New-Object byte[] ${CHUNK_BYTES};$n=0;if($off -lt $size){$n=$fs.Read($buf,0,$buf.Length)};` +
    "[string]$size;[Convert]::ToBase64String($buf,0,$n)}finally{$fs.Dispose()}";

  async function readChunk(abs, offset) {
    const out = await ps(PS_READ_CHUNK, { CCFP_PATH: abs, CCFP_OFF: String(offset) });
    const [sizeLine, b64 = ""] = out.split(/\r?\n/);
    return { size: Number(sizeLine) || 0, bytes: b64ToBytes(b64.trim()) };
  }

  // 返回 { size, bytes } 或 { size, tooLarge: true }；isCancelled() 为真时提前中止
  async function readFile(abs, { force, onProgress, isCancelled }) {
    const first = await readChunk(abs, 0);
    const size = first.size;
    if (size > LARGE_FILE && !force) return { size, tooLarge: true, head: first.bytes };
    if (looksBinary(first.bytes)) return { size, binary: true };
    const parts = [first.bytes];
    let got = first.bytes.length;
    while (got < size && first.bytes.length) {
      if (isCancelled()) return null;
      onProgress(got / size);
      const next = await readChunk(abs, got);
      if (!next.bytes.length) break;
      parts.push(next.bytes);
      got += next.bytes.length;
    }
    const all = new Uint8Array(got);
    let off = 0;
    for (const p of parts) {
      all.set(p, off);
      off += p.length;
    }
    return { size, bytes: all };
  }

  function openWithDefault(abs) {
    return ps("Invoke-Item -LiteralPath $env:CCFP_PATH", { CCFP_PATH: abs });
  }

  function revealInExplorer(abs) {
    return ps("Start-Process -FilePath 'explorer.exe' -ArgumentList ('/select,'+[char]34+$env:CCFP_PATH+[char]34)", { CCFP_PATH: abs });
  }

  function openUrl(url) {
    return ps("Start-Process -FilePath $env:CCFP_URL", { CCFP_URL: url });
  }

  // ---- 搜索 ---------------------------------------------------------------

  const escapeGlob = (s) => s.replace(/[\\*?[\]]/g, "\\$&");

  async function searchGit(ws, token) {
    const res = await ctx.bridge.invoke("plugin_exec_run", {
      bin: "git",
      args: ["-C", trimRoot(ws), "ls-files", "-co", "--exclude-standard", "-z", "--", `:(icase)*${escapeGlob(token)}*`],
      timeoutMs: 20000,
    });
    if (res.code !== 0) return null; // 非 git 仓库等：交给回退方案
    const out = res.stdout || "";
    let paths = out.split("\0").filter(Boolean);
    const truncated = out.length >= OUTPUT_CAP;
    if (truncated) paths = paths.slice(0, -1);
    return { paths: [...new Set(paths)], truncated };
  }

  const PS_SEARCH =
    "$root=$env:CCFP_PATH;$q=$env:CCFP_Q;$skip=$env:CCFP_SKIPDIRS.Split('|');" +
    "$stack=New-Object System.Collections.Stack;$stack.Push($root);$hits=0;$seen=0;" +
    `while($stack.Count -gt 0 -and $hits -lt ${MAX_SEARCH_RESULTS} -and $seen -lt 30000){` +
    "$d=$stack.Pop();try{$items=@(Get-ChildItem -LiteralPath $d -Force -ErrorAction Stop)}catch{continue};" +
    "foreach($i in $items){$seen++;if($i.PSIsContainer){if($skip -notcontains $i.Name){$stack.Push($i.FullName)}}" +
    "else{$rel=$i.FullName.Substring($root.Length).TrimStart([char[]]@([char]92,[char]47));" +
    "if($rel.IndexOf($q,[StringComparison]::OrdinalIgnoreCase) -ge 0){$hits++;" +
    "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($rel))}}}};" +
    "if($stack.Count -gt 0){'more'}";

  async function searchFallback(ws, token) {
    const out = await ps(
      PS_SEARCH,
      { CCFP_PATH: trimRoot(ws), CCFP_Q: token, CCFP_SKIPDIRS: SEARCH_SKIP_DIRS.join("|") },
      60000,
    );
    const lines = out.split(/\r?\n/).filter(Boolean);
    const truncated = lines[lines.length - 1] === "more" || lines.length > MAX_SEARCH_RESULTS;
    const paths = lines.filter((l) => l !== "more").map((l) => b64ToText(l).replace(/\\/g, "/"));
    return { paths, truncated };
  }

  async function searchFiles(ws, query) {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return { paths: [], truncated: false };
    let res = null;
    try {
      res = await searchGit(ws, tokens[0]);
    } catch {
      res = null; // git 不存在或启动失败
    }
    if (!res) res = await searchFallback(ws, tokens[0]);
    const matched = res.paths.filter((p) => {
      const lower = p.toLowerCase();
      return tokens.every((t) => lower.includes(t));
    });
    const score = (p) => (baseName(p).toLowerCase().includes(tokens[0]) ? 0 : 1);
    matched.sort((a, b) => score(a) - score(b) || a.length - b.length || (a < b ? -1 : 1));
    return {
      paths: matched.slice(0, MAX_SEARCH_RESULTS),
      truncated: res.truncated || matched.length > MAX_SEARCH_RESULTS,
    };
  }

  // ---- 小组件 -------------------------------------------------------------

  function Lucide({ name, className, size = 16, spin }) {
    return h("span", {
      className: `fp-lucide${spin ? " animate-spin" : ""}${className ? " " + className : ""}`,
      style: { width: size, height: size },
      "aria-hidden": true,
      dangerouslySetInnerHTML: {
        __html: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${LUCIDE[name]}</svg>`,
      },
    });
  }

  function IconButton({ icon, title, onClick, disabled, spin }) {
    return h(
      "button",
      { type: "button", className: "fp-icon-btn", title, "aria-label": title, onClick, disabled },
      h(Lucide, { name: icon, spin }),
    );
  }

  function FileIcon({ name, isDir, open }) {
    return h("span", {
      className: `size-4 shrink-0 [&>svg]:size-4 ${isDir ? "text-foreground-icon-secondary" : "text-foreground-icon-tertiary"}`,
      "aria-hidden": true,
      dangerouslySetInnerHTML: { __html: fileIconSvg(name, isDir, open) },
    });
  }

  function CopyButton({ text }) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
      if (!copied) return undefined;
      const t = setTimeout(() => setCopied(false), 1500);
      return () => clearTimeout(t);
    }, [copied]);
    return h(
      "button",
      {
        type: "button",
        className: "md-codeblock-copy",
        title: copied ? t("copied") : t("copy"),
        onClick: () => {
          navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {});
        },
      },
      h(Lucide, { name: copied ? "check" : "copy", size: 14 }),
    );
  }

  CodeBlock = function CodeBlockImpl({ lang, text }) {
    return h(
      "div",
      { className: "md-codeblock" },
      h(
        "div",
        { className: "md-codeblock-header" },
        h("span", { className: "md-codeblock-language" }, lang || "text"),
        h(CopyButton, { text }),
      ),
      h("pre", null, h("code", null, text)),
    );
  };

  // ---- Mermaid ------------------------------------------------------------
  //
  // mermaid.min.js 随包分发，经 ctx.assets.bundleUrl 懒加载（只有打开含图的文件才加载）。
  // globalThis.mermaid 可能与「Mermaid 图表」等插件共享同一实例，所以这里从不调用
  // mermaid.initialize 改全局配置：主题等只通过每张图前置的 %%{init}%% 指令传入。

  const mermaidState = { instance: null, promise: null };
  let mermaidQueue = Promise.resolve();
  let mermaidSeq = 0;

  function loadMermaid() {
    if (mermaidState.instance) return Promise.resolve(mermaidState.instance);
    if (mermaidState.promise) return mermaidState.promise;
    mermaidState.promise = new Promise((resolve, reject) => {
      if (globalThis.mermaid) {
        resolve(globalThis.mermaid);
        return;
      }
      const script = document.createElement("script");
      script.src = ctx.assets.bundleUrl("mermaid.min.js");
      script.async = true;
      script.onload = () => (globalThis.mermaid ? resolve(globalThis.mermaid) : reject(new Error(t("mermaidNoGlobal"))));
      script.onerror = () => reject(new Error(t("mermaidLoadFailed")));
      document.head.append(script);
    }).then(
      (m) => {
        mermaidState.instance = m;
        return m;
      },
      (err) => {
        mermaidState.promise = null; // 允许下次重试
        throw err;
      },
    );
    return mermaidState.promise;
  }

  function currentTheme() {
    return document.documentElement.classList.contains("dark") ? "dark" : "default";
  }

  // 跟随宿主深浅色切换（<html class="dark">）
  function useTheme() {
    const [theme, setTheme] = useState(currentTheme);
    useEffect(() => {
      const observer = new MutationObserver(() => setTheme(currentTheme()));
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      return () => observer.disconnect();
    }, []);
    return theme;
  }

  function renderMermaid(code, theme) {
    const task = async () => {
      const mermaid = await loadMermaid();
      const init = { theme, fontFamily: getComputedStyle(document.body).fontFamily || "inherit" };
      const id = `fp-mermaid-${++mermaidSeq}`;
      try {
        // 先 parse：语法错误直接抛出，不会在页面上留下 mermaid 的错误图
        await mermaid.parse(code);
        const { svg } = await mermaid.render(id, `%%{init: ${JSON.stringify(init)}}%%\n${code}`);
        return svg;
      } finally {
        for (const nodeId of [`d${id}`, id]) document.getElementById(nodeId)?.remove();
      }
    };
    const result = mermaidQueue.then(task, task);
    mermaidQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  // fitFloor > 0：按容器宽度缩小但不低于原始宽度 × fitFloor，再宽则由容器横向滚动；
  // fitFloor = 0：放大视图，按原始宽度显示。
  function mountSvg(host, svg, fitFloor) {
    const root = new DOMParser().parseFromString(svg, "text/html").querySelector("svg");
    if (!root) return;
    const viewBox = (root.getAttribute("viewBox") || "").split(/\s+/).map(Number);
    const naturalWidth = viewBox.length === 4 && viewBox[2] > 0 ? viewBox[2] : null;
    if (naturalWidth) {
      root.style.width = `${Math.round(naturalWidth)}px`;
      root.style.minWidth = `${Math.round(naturalWidth * fitFloor)}px`;
      root.style.maxWidth = fitFloor > 0 ? "100%" : "none";
      root.style.height = "auto";
      root.style.display = "block";
      root.style.marginInline = "auto";
    }
    host.replaceChildren(document.importNode(root, true));
  }

  // 放大查看：面板里的图与全窗口浮层是两个挂载点，经这份共享状态互通
  const zoom = { svg: null, listeners: new Set() };
  function setZoom(svg) {
    zoom.svg = svg;
    for (const fn of zoom.listeners) fn(svg);
  }

  function MermaidSvg({ svg, fitFloor, className, onClick, title }) {
    const ref = useRef(null);
    useEffect(() => {
      if (ref.current) mountSvg(ref.current, svg, fitFloor);
    }, [svg, fitFloor]);
    return h("div", { ref, className, onClick, title });
  }

  MermaidBlock = function MermaidBlockImpl({ text }) {
    const theme = useTheme();
    const [state, setState] = useState({ status: "loading" });
    const [showSource, setShowSource] = useState(false);

    useEffect(() => {
      let cancelled = false;
      setState({ status: "loading" });
      renderMermaid(text, theme).then(
        (svg) => !cancelled && setState({ status: "ok", svg }),
        (err) => !cancelled && setState({ status: "error", error: String((err && err.message) || err) }),
      );
      return () => {
        cancelled = true;
      };
    }, [text, theme]);

    const source = showSource || state.status === "error";
    return h(
      "div",
      { className: "md-codeblock" },
      h(
        "div",
        { className: "md-codeblock-header" },
        h("span", { className: "md-codeblock-language" }, "mermaid"),
        h(
          "div",
          { className: "fp-codeblock-tools" },
          state.status === "error"
            ? null
            : h(
                "button",
                { type: "button", className: "fp-toggle", onClick: () => setShowSource((v) => !v) },
                showSource ? t("viewChart") : t("viewSource"),
              ),
          h(CopyButton, { text }),
        ),
      ),
      state.status === "error" ? h("div", { className: "fp-mermaid-error" }, t("chartFailed", { error: state.error.split("\n")[0] })) : null,
      source
        ? h("pre", null, h("code", null, text))
        : state.status === "loading"
          ? h("div", { className: "fp-mermaid-loading" }, t("chartRendering"))
          : h(MermaidSvg, { svg: state.svg, fitFloor: 0.75, className: "fp-mermaid", title: t("clickToZoom"), onClick: () => setZoom(state.svg) }),
    );
  };

  function ZoomOverlay() {
    useLocale();
    const [svg, setSvg] = useState(zoom.svg);
    useEffect(() => {
      zoom.listeners.add(setSvg);
      return () => {
        zoom.listeners.delete(setSvg);
      };
    }, []);
    useEffect(() => {
      if (!svg) return undefined;
      const onKey = (e) => e.key === "Escape" && setZoom(null);
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, [svg]);
    if (!svg) return null;
    return h(
      "div",
      { className: "fp-zoom-backdrop", role: "dialog", "aria-modal": "true", "aria-label": t("zoomDialog"), onClick: () => setZoom(null) },
      h(
        "div",
        { className: "fp-zoom-panel", onClick: (e) => e.stopPropagation() },
        h(
          "div",
          { className: "fp-zoom-header" },
          h("span", null, t("chart")),
          h(IconButton, { icon: "x", title: t("closeEsc"), onClick: () => setZoom(null) }),
        ),
        h(MermaidSvg, { svg, fitFloor: 0, className: "fp-zoom-body" }),
      ),
    );
  }

  ctx.ui.registerOverlay({ key: "mermaid-zoom", component: ZoomOverlay });

  // 宿主 FileTreeRow 的同款行
  function TreeRow({ depth, name, isDir, open, loading, selected, title, onClick, extra, actions, muted }) {
    return h(
      "div",
      {
        className:
          "group flex h-7 w-full items-center rounded-md pr-1 text-body-medium hover:bg-background-primary-hover " +
          (selected ? "bg-background-primary-active text-text-primary" : "text-text-primary"),
        style: { paddingLeft: 14 + depth * 14 },
      },
      h(
        "button",
        {
          type: "button",
          onClick,
          className:
            "flex min-w-0 flex-1 items-center gap-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
          title,
        },
        loading
          ? h(Lucide, { name: "loader", spin: true, className: "text-foreground-icon-tertiary" })
          : h(FileIcon, { name, isDir, open }),
        h("span", { className: "min-w-0 max-w-full shrink-0 truncate" + (muted ? " fp-muted" : "") }, name),
        extra ? h("span", { className: "fp-row-extra" }, extra) : null,
      ),
      actions || null,
    );
  }

  function Notice({ children }) {
    return h("div", { className: "px-3 py-2 text-caption-1-regular text-text-tertiary" }, children);
  }

  // ---- 文件树视图 ---------------------------------------------------------

  function TreeView({ workspacePath, recent, recentCollapsed, onToggleRecent, onOpen, selected }) {
    const [dirs, setDirs] = useState({}); // rel -> { status, entries, truncated, error }
    const [expanded, setExpanded] = useState(() => new Set([""]));
    const [query, setQuery] = useState("");
    const [search, setSearch] = useState({ status: "idle", paths: [], truncated: false, error: null });
    const alive = useRef(true);
    const searchSeq = useRef(0);

    useEffect(() => {
      alive.current = true;
      return () => {
        alive.current = false;
      };
    }, []);

    const loadDir = useCallback(
      (rel) => {
        setDirs((d) => ({ ...d, [rel]: { ...(d[rel] || {}), status: "loading" } }));
        listDir(toAbs(workspacePath, rel)).then(
          (res) => alive.current && setDirs((d) => ({ ...d, [rel]: { status: "ok", ...res } })),
          (err) => alive.current && setDirs((d) => ({ ...d, [rel]: { status: "error", error: String(err.message || err) } })),
        );
      },
      [workspacePath],
    );

    useEffect(() => {
      loadDir("");
    }, [loadDir]);

    const toggle = (rel) => {
      if (expanded.has(rel)) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(rel);
          return next;
        });
        return;
      }
      setExpanded((prev) => new Set(prev).add(rel));
      if (!dirs[rel] || dirs[rel].status === "error") loadDir(rel);
    };

    const refreshAll = () => {
      setDirs({});
      for (const rel of expanded) loadDir(rel);
    };

    // 搜索：250ms 防抖，旧请求结果丢弃
    useEffect(() => {
      const q = query.trim();
      const seq = ++searchSeq.current;
      if (!q) {
        setSearch({ status: "idle", paths: [], truncated: false, error: null });
        return undefined;
      }
      setSearch((s) => ({ ...s, status: "loading" }));
      const t = setTimeout(() => {
        searchFiles(workspacePath, q).then(
          (res) => alive.current && seq === searchSeq.current && setSearch({ status: "ok", ...res, error: null }),
          (err) =>
            alive.current &&
            seq === searchSeq.current &&
            setSearch({ status: "error", paths: [], truncated: false, error: String(err.message || err) }),
        );
      }, 250);
      return () => clearTimeout(t);
    }, [query, workspacePath]);

    // 把展开的目录拍平成行
    const rows = [];
    const rootName = baseName(trimRoot(workspacePath)) || workspacePath;
    const rootState = dirs[""];
    rows.push(
      h(TreeRow, {
        key: "\u0000root",
        depth: 0,
        name: rootName,
        isDir: true,
        open: expanded.has(""),
        loading: rootState?.status === "loading",
        title: workspacePath,
        onClick: () => toggle(""),
        actions: h(
          "button",
          {
            type: "button",
            className:
              "hidden size-5 shrink-0 cursor-pointer items-center justify-center rounded text-foreground-icon-tertiary hover:bg-background-primary-active hover:text-text-primary group-hover:flex focus-visible:flex",
            title: t("refresh"),
            onClick: refreshAll,
          },
          h(Lucide, { name: "refresh", size: 14 }),
        ),
      }),
    );
    const walk = (rel, depth) => {
      const st = dirs[rel];
      if (!st || !expanded.has(rel)) return;
      if (st.status === "error") {
        rows.push(h("div", { key: `${rel}\u0000err`, className: "fp-row-error", style: { paddingLeft: 14 + depth * 14 } }, t("readFailed", { error: st.error })));
        return;
      }
      if (!st.entries) return;
      for (const e of st.entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        const childState = dirs[childRel];
        rows.push(
          h(TreeRow, {
            key: childRel,
            depth,
            name: e.name,
            isDir: e.isDir,
            open: e.isDir && expanded.has(childRel),
            loading: e.isDir && expanded.has(childRel) && childState?.status === "loading",
            selected: !e.isDir && selected === childRel,
            title: childRel,
            onClick: () => (e.isDir ? toggle(childRel) : onOpen(childRel, e.size)),
          }),
        );
        if (e.isDir) walk(childRel, depth + 1);
      }
      if (st.truncated) {
        rows.push(h("div", { key: `${rel}\u0000more`, className: "fp-row-note", style: { paddingLeft: 14 + depth * 14 } }, t("dirTruncated", { n: MAX_DIR_ENTRIES })));
      }
    };
    walk("", 1);

    const searching = query.trim().length > 0;

    return h(
      "div",
      { className: "fp-view" },
      h(
        "div",
        { className: "fp-search" },
        h(Lucide, { name: "search", size: 14, className: "fp-search-icon" }),
        h("input", {
          className: "fp-search-input",
          placeholder: t("searchPlaceholder"),
          value: query,
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Escape") setQuery("");
            if (e.key === "Enter" && search.paths.length) onOpen(search.paths[0]);
          },
          spellCheck: false,
        }),
        query ? h(IconButton, { icon: "x", title: t("clear"), onClick: () => setQuery("") }) : null,
      ),
      h(
        "div",
        { className: "min-h-0 flex-1 overflow-auto py-1" },
        searching
          ? h(
              Fragment,
              null,
              search.status === "loading" && !search.paths.length ? h(Notice, null, t("searching")) : null,
              search.status === "error" ? h(Notice, null, t("searchFailed", { error: search.error })) : null,
              search.status === "ok" && !search.paths.length ? h(Notice, null, t("noMatches")) : null,
              search.paths.map((p) =>
                h(
                  "div",
                  { key: p, className: "px-1" },
                  h(TreeRow, {
                    depth: -0.5,
                    name: baseName(p),
                    isDir: false,
                    selected: selected === p,
                    title: p,
                    extra: dirName(p),
                    onClick: () => onOpen(p),
                  }),
                ),
              ),
              search.truncated ? h(Notice, null, t("searchTruncated", { n: MAX_SEARCH_RESULTS })) : null,
            )
          : h(
              Fragment,
              null,
              recent.length
                ? h(
                    "div",
                    { className: "fp-recent" },
                    h(
                      "button",
                      { type: "button", className: "fp-section-title", onClick: onToggleRecent },
                      h(Lucide, { name: recentCollapsed ? "chevronRight" : "chevronDown", size: 14 }),
                      t("recent"),
                    ),
                    recentCollapsed
                      ? null
                      : recent.map((p) =>
                          h(
                            "div",
                            { key: p, className: "px-1" },
                            h(TreeRow, {
                              depth: -0.5,
                              name: baseName(p),
                              isDir: false,
                              selected: selected === p,
                              title: p,
                              extra: dirName(p),
                              onClick: () => onOpen(p),
                            }),
                          ),
                        ),
                  )
                : null,
              rows.map((row) => h("div", { key: row.key, className: "px-1" }, row)),
            ),
      ),
    );
  }

  // ---- 预览视图 -----------------------------------------------------------

  function PreviewView({ workspacePath, rel, onBack, onOpenRel }) {
    const abs = toAbs(workspacePath, rel);
    const [state, setState] = useState({ status: "loading", progress: 0 });
    const [force, setForce] = useState(false);
    const [reloadTick, setReloadTick] = useState(0);
    const [actionError, setActionError] = useState(null);
    const scrollRef = useRef(null);

    useEffect(() => {
      let cancelled = false;
      setState({ status: "loading", progress: 0 });
      setActionError(null);
      readFile(abs, {
        force,
        isCancelled: () => cancelled,
        onProgress: (p) => !cancelled && setState({ status: "loading", progress: p }),
      }).then(
        (res) => {
          if (cancelled || !res) return;
          if (res.tooLarge) setState({ status: "large", size: res.size });
          else if (res.binary) setState({ status: "binary", size: res.size });
          else setState({ status: "ok", size: res.size, text: decodeText(res.bytes) });
        },
        (err) => !cancelled && setState({ status: "error", error: String(err.message || err) }),
      );
      return () => {
        cancelled = true;
      };
    }, [abs, force, reloadTick]);

    useEffect(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }, [abs]);

    const run = (p) => p.catch((err) => setActionError(String(err.message || err)));

    const onLink = useCallback(
      (url) => {
        if (/^(https?:|mailto:)/i.test(url)) {
          run(openUrl(url));
          return;
        }
        if (url.startsWith("#")) {
          const id = decodeURIComponent(url.slice(1));
          const el = scrollRef.current?.querySelector(`[data-fp-anchor="${CSS.escape(id)}"]`);
          el?.scrollIntoView({ block: "start", behavior: "smooth" });
          return;
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return; // file: / javascript: 等一律忽略
        let path = url.split("#")[0].split("?")[0];
        try {
          path = decodeURIComponent(path);
        } catch {
          // 保持原样
        }
        path = path.replace(/\\/g, "/");
        const target = normalizeRel(path.startsWith("/") ? path : `${dirName(rel)}/${path}`);
        if (target === null) {
          setActionError(t("linkOutside"));
          return;
        }
        if (target) onOpenRel(target);
      },
      [rel, onOpenRel],
    );

    const isMd = isMarkdownName(rel);
    const content = useMemo(() => {
      if (state.status !== "ok") return null;
      if (isMd) {
        return h("div", { className: "prose-chat prose-plugin-readme text-body-regular text-text-primary fp-md" }, renderMarkdown(h, state.text, { onLink }));
      }
      return h("pre", { className: "fp-plain" }, state.text);
    }, [state, isMd, onLink, currentLang()]);

    const actionButtons = h(
      "div",
      { className: "fp-actions" },
      h("button", { type: "button", className: "fp-btn", onClick: () => run(openWithDefault(abs)) }, t("openDefault")),
      h("button", { type: "button", className: "fp-btn", onClick: () => run(revealInExplorer(abs)) }, t("reveal")),
    );

    return h(
      "div",
      { className: "fp-view" },
      h(
        "div",
        { className: "fp-header" },
        h(IconButton, { icon: "arrowLeft", title: t("back"), onClick: onBack }),
        h(
          "div",
          { className: "fp-title", title: rel },
          h(FileIcon, { name: baseName(rel), isDir: false }),
          h("span", { className: "fp-title-name" }, baseName(rel)),
          dirName(rel) ? h("span", { className: "fp-title-dir" }, dirName(rel)) : null,
        ),
        h(IconButton, { icon: "refresh", title: t("reload"), onClick: () => setReloadTick((t) => t + 1), spin: state.status === "loading" }),
        h(IconButton, { icon: "external", title: t("openDefault"), onClick: () => run(openWithDefault(abs)) }),
        h(IconButton, { icon: "folderSearch", title: t("reveal"), onClick: () => run(revealInExplorer(abs)) }),
      ),
      actionError ? h("div", { className: "fp-banner" }, actionError) : null,
      h(
        "div",
        { ref: scrollRef, className: "fp-scroll" },
        state.status === "loading"
          ? h(Notice, null, state.progress > 0 ? t("readingProgress", { pct: Math.round(state.progress * 100) }) : t("reading"))
          : state.status === "error"
            ? h("div", { className: "fp-center" }, h("p", null, t("readFailed", { error: state.error })), actionButtons)
            : state.status === "binary"
              ? h("div", { className: "fp-center" }, h("p", null, t("binary", { size: formatSize(state.size) })), actionButtons)
              : state.status === "large"
                ? h(
                    "div",
                    { className: "fp-center" },
                    h("p", null, t("large", { size: formatSize(state.size) })),
                    h(
                      "div",
                      { className: "fp-actions" },
                      h("button", { type: "button", className: "fp-btn", onClick: () => run(openWithDefault(abs)) }, t("openDefault")),
                      h("button", { type: "button", className: "fp-btn", onClick: () => run(revealInExplorer(abs)) }, t("reveal")),
                      h("button", { type: "button", className: "fp-btn", onClick: () => setForce(true) }, t("openAnyway")),
                    ),
                  )
                : content,
      ),
    );
  }

  // ---- 面板根组件 ---------------------------------------------------------

  function PanelInner({ workspacePath }) {
    const recentKey = `recent:${workspacePath}`;
    const [recent, setRecent] = useState([]);
    const [recentCollapsed, setRecentCollapsed] = useState(false);
    const [stack, setStack] = useState([]); // 预览历史；空 = 显示文件树

    useEffect(() => {
      let alive = true;
      ctx.storage.get(recentKey).then((v) => alive && Array.isArray(v) && setRecent(v));
      ctx.storage.get("recentCollapsed").then((v) => alive && typeof v === "boolean" && setRecentCollapsed(v));
      return () => {
        alive = false;
      };
    }, [recentKey]);

    const remember = useCallback(
      (rel) => {
        setRecent((prev) => {
          const next = [rel, ...prev.filter((p) => p !== rel)].slice(0, MAX_RECENT);
          void ctx.storage.set(recentKey, next);
          return next;
        });
      },
      [recentKey],
    );

    const openFromTree = useCallback(
      (rel) => {
        remember(rel);
        setStack([rel]);
      },
      [remember],
    );

    const openFromLink = useCallback(
      (rel) => {
        remember(rel);
        setStack((s) => [...s, rel]);
      },
      [remember],
    );

    const back = useCallback(() => setStack((s) => s.slice(0, -1)), []);

    const toggleRecent = () => {
      setRecentCollapsed((v) => {
        void ctx.storage.set("recentCollapsed", !v);
        return !v;
      });
    };

    const current = stack[stack.length - 1];
    return h(
      "div",
      { className: "fp-root" },
      // 文件树保持挂载（只隐藏），返回时展开状态与滚动位置都还在
      h(
        "div",
        { className: current ? "fp-hidden" : "fp-fill" },
        h(TreeView, {
          workspacePath,
          recent,
          recentCollapsed,
          onToggleRecent: toggleRecent,
          onOpen: openFromTree,
          selected: current || recent[0],
        }),
      ),
      current ? h(PreviewView, { key: `${stack.length}:${current}`, workspacePath, rel: current, onBack: back, onOpenRel: openFromLink }) : null,
    );
  }

  // 宿主切换工作区时只改 prop、不重挂载：用 key 强制重置全部状态
  function Panel({ workspacePath }) {
    useLocale();
    if (!IS_WINDOWS) return h(Notice, null, t("windowsOnly"));
    if (!workspacePath) return h(Notice, null, t("noWorkspace"));
    return h(PanelInner, { key: workspacePath, workspacePath });
  }

  function PanelIcon({ className }) {
    return h(
      "svg",
      {
        className,
        xmlns: "http://www.w3.org/2000/svg",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
      },
      h("path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" }),
      h("path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }),
      h("path", { d: "M10 9H8" }),
      h("path", { d: "M16 13H8" }),
      h("path", { d: "M16 17H8" }),
    );
  }

  ctx.ui.registerPanelTab({ key: "preview", label: () => t("tabLabel"), icon: PanelIcon, component: Panel, order: 50 });
}
