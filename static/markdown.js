function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function looksLikeLatex(tex) {
  const t = String(tex || "");
  if (!t.trim()) return false;
  if (/[\\^_{}]/.test(t)) return true;
  if (/\s/.test(t) && !/[\\^_{}]/.test(t)) return false;
  return t.length <= 40;
}

function extractMath(text) {
  const slots = [];
  // Private-use area delimiters: markdown-it replaces NUL with U+FFFD per
  // CommonMark, and no reply text contains these codepoints, so the placeholders
  // survive markdown parsing unchanged and get restored afterwards.
  const push = (tex, display) => {
    const token = `\uE000${slots.length}\uE001`;
    slots.push({ tex: tex.trim(), display });
    return token;
  };
  let i = 0;
  let out = "";
  while (i < text.length) {
    if (text.startsWith("```", i)) {
      const end = text.indexOf("```", i + 3);
      if (end < 0) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, end + 3);
      i = end + 3;
      continue;
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end < 0) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (text.startsWith("$$", i)) {
      const end = text.indexOf("$$", i + 2);
      if (end >= 0) {
        out += push(text.slice(i + 2, end), true);
        i = end + 2;
        continue;
      }
    }
    if (text.startsWith("\\[", i)) {
      const end = text.indexOf("\\]", i + 2);
      if (end >= 0) {
        out += push(text.slice(i + 2, end), true);
        i = end + 2;
        continue;
      }
    }
    if (text.startsWith("\\(", i)) {
      const end = text.indexOf("\\)", i + 2);
      if (end >= 0) {
        out += push(text.slice(i + 2, end), false);
        i = end + 2;
        continue;
      }
    }
    const begin = text.slice(i).match(/^\\begin\{([a-zA-Z*]+)\}/);
    if (begin) {
      const endTag = `\\end{${begin[1]}}`;
      const end = text.indexOf(endTag, i);
      if (end >= 0) {
        out += push(text.slice(i, end + endTag.length), true);
        i = end + endTag.length;
        continue;
      }
    }
    if (text[i] === "$" && text[i + 1] !== "$") {
      let j = i + 1;
      while (j < text.length && text[j] !== "\n") {
        if (text[j] === "$" && text[j - 1] !== "\\") break;
        j++;
      }
      if (j < text.length && text[j] === "$") {
        const inner = text.slice(i + 1, j);
        if (inner && inner === inner.trim() && looksLikeLatex(inner)) {
          out += push(inner, false);
          i = j + 1;
          continue;
        }
      }
    }
    out += text[i];
    i++;
  }
  return { text: out, slots };
}

function renderLatex(tex, display) {
  const katex = globalThis.katex;
  if (!katex) {
    const tag = display ? "div" : "span";
    return `<${tag} class="math-fallback">${escapeHtml(tex)}</${tag}>`;
  }
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
      output: "html"
    });
  } catch {
    return `<span class="math-fallback">${escapeHtml(tex)}</span>`;
  }
}

function restoreMath(html, slots) {
  return html.replace(/\uE000(\d+)\uE001/g, (_, n) => {
    const slot = slots[Number(n)];
    if (!slot) return "";
    return renderLatex(slot.tex, slot.display);
  });
}

function quoteBlock(text) {
  return String(text || "")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

export function conversationToMarkdown(conv) {
  const out = [`# ${conv.title || "Skilldock 对话"}`, ""];
  const meta = [];
  if (conv.createdAt) meta.push(`开始于 ${new Date(conv.createdAt).toLocaleString()}`);
  if (conv.model) meta.push(`模型 ${conv.model}`);
  out.push(`<sub>${meta.join(" · ")}${meta.length ? " · " : ""}由 Skilldock 导出</sub>`, "");
  for (const m of conv.messages || []) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push("## 🧑 用户", "", m.display ?? m.content ?? "");
      const notes = [];
      if (m.images?.length) notes.push(`附带 ${m.images.length} 张图片`);
      if (m.display != null && (m.content || "").length > m.display.length) {
        notes.push("发送时附带了页面 / 文件上下文");
      }
      if (notes.length) out.push("", `*[${notes.join("；")}]*`);
      out.push("");
      continue;
    }
    if (m.role === "tool") {
      out.push(quoteBlock(`🔧 工具 ${m.name || ""}：${String(m.content || "")}`), "");
      continue;
    }
    if (m.role === "assistant") {
      if (m.thinking) {
        out.push("<details>", "<summary>💭 思考过程</summary>", "", quoteBlock(m.thinking), "", "</details>", "");
      }
      if (m.content) {
        out.push("## 🤖 助手", "", m.content, "");
      } else if (m.toolCalls?.length) {
        out.push(quoteBlock(`🤖 调用工具：${m.toolCalls.map((c) => c.name).join("、")}`), "");
      }
    }
  }
  return out.join("\n");
}

// 结构渲染交给 markdown-it（static/vendor/，CommonMark 规范实现）。之前这里是
// 一套自制的块级解析：列表只有 inUl/inOl 两个布尔量、没有层级概念，导致有序
// 列表被反复拆成单元素 <ol>、编号每个都从 1 开始。markdown-it 按规范判定缩进、
// 嵌套与松紧列表，数学管线（extractMath/renderLatex/restoreMath）与之解耦，原样保留。
let mdInstance = null;
const getMarkdownIt = () => {
  if (mdInstance) return mdInstance;
  if (typeof globalThis.markdownit !== "function") return null;
  mdInstance = globalThis.markdownit({
    html: false, // 回复里的原始 HTML 一律转义，与旧行为一致
    linkify: false, // 只有显式 [text](url) 才成为链接
    breaks: false, // 单个换行仍是软换行
    typographer: false
  });
  // 代码块沿用原有的 pre.code + 语言标签结构，CSS 无需改动
  mdInstance.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const lang = (token.info || "").trim().split(/\s+/)[0];
    const code = escapeHtml(token.content.replace(/\n$/, ""));
    return `<pre class="code"><div class="code-lang">${escapeHtml(lang || "code")}</div><code>${code}</code></pre>`;
  };
  mdInstance.renderer.rules.code_block = (tokens, idx) => {
    const code = escapeHtml(tokens[idx].content.replace(/\n$/, ""));
    return `<pre class="code"><code>${code}</code></pre>`;
  };
  return mdInstance;
};

// CommonMark 规定：闭合的 ** 前面是标点、后面紧跟汉字时不能闭合（flanking 规则），
// 于是中文里最常见的「**磁盘核实：**原脚本」会原样留下星号。中文回复大量使用这种
// 写法，这里把漏掉的 **...** 补成 <strong>；代码块内容按 span 切分跳过，绝不触碰。
function boldLiteralEmphasis(html) {
  return html
    .split(/(<code>[\s\S]*?<\/code>)/)
    .map((segment) =>
      segment.startsWith("<code>")
        ? segment
        : segment.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    )
    .join("");
}

export function renderMarkdown(src) {
  const extracted = extractMath(String(src || "").replace(/\r\n/g, "\n"));
  const md = getMarkdownIt();
  // vendor 文件缺失时至少把文本原样显示，页面不至于空白
  let html = md
    ? boldLiteralEmphasis(md.render(extracted.text))
    : `<pre class="code"><code>${escapeHtml(extracted.text)}</code></pre>`;
  // 独立成行的展示公式不能留在 <p> 里：还原出来的是块级元素，<div> 嵌在 <p>
  // 中会被 HTML 解析器拆开。
  html = html.replace(/<p>(\uE000\d+\uE001)<\/p>/g, "$1");
  return restoreMath(html, extracted.slots);
}
