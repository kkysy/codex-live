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
  const push = (tex, display) => {
    const token = `\u0000M${slots.length}\u0000`;
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
  return html.replace(/\u0000M(\d+)\u0000/g, (_, n) => {
    const slot = slots[Number(n)];
    if (!slot) return "";
    return renderLatex(slot.tex, slot.display);
  });
}

function inline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return s;
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

export function renderMarkdown(src) {
  const extracted = extractMath(String(src || "").replace(/\r\n/g, "\n"));
  const text = extracted.text;
  const parts = [];
  const fences = text.split(/```/);
  fences.forEach((chunk, i) => {
    if (i % 2 === 1) {
      const nl = chunk.indexOf("\n");
      const lang = nl >= 0 ? chunk.slice(0, nl).trim() : "";
      const code = nl >= 0 ? chunk.slice(nl + 1) : chunk;
      if (/^(math|latex|tex)$/i.test(lang)) {
        parts.push(renderLatex(code.replace(/\n$/, ""), true));
        return;
      }
      parts.push(
        `<pre class="code"><div class="code-lang">${escapeHtml(lang || "code")}</div><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`
      );
      return;
    }
    const lines = chunk.split("\n");
    let html = "";
    let inUl = false;
    let inOl = false;
    let inTable = false;
    const closeLists = () => {
      if (inUl) {
        html += "</ul>";
        inUl = false;
      }
      if (inOl) {
        html += "</ol>";
        inOl = false;
      }
    };
    const closeTable = () => {
      if (inTable) {
        html += "</tbody></table>";
        inTable = false;
      }
    };
    const renderIndentedCode = (codeLines) => {
      const code = codeLines.map((line) => line.replace(/^(?: {4}|\t)/, "")).join("\n").replace(/\n$/, "");
      html += `<pre class="code"><code>${escapeHtml(code)}</code></pre>`;
    };
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      // Markdown's four-space / tab code blocks are grouped before trimming so
      // indentation is not mistaken for ordinary paragraph whitespace.
      if (/^(?: {4}|\t)/.test(line)) {
        closeLists();
        closeTable();
        const codeLines = [line];
        while (lineIndex + 1 < lines.length) {
          const next = lines[lineIndex + 1];
          if (/^(?: {4}|\t)/.test(next)) {
            codeLines.push(next);
            lineIndex++;
            continue;
          }
          if (!next.trim() && lineIndex + 2 < lines.length && /^(?: {4}|\t)/.test(lines[lineIndex + 2])) {
            codeLines.push(next);
            lineIndex++;
            continue;
          }
          break;
        }
        renderIndentedCode(codeLines);
        continue;
      }
      const t = line.trim();
      if (!t) {
        closeLists();
        closeTable();
        continue;
      }
      if (/^\u0000M\d+\u0000$/.test(t)) {
        closeLists();
        closeTable();
        html += t;
        continue;
      }
      if (t.startsWith("|") && t.endsWith("|")) {
        const cells = t.split("|").slice(1, -1).map((c) => c.trim());
        if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
        if (!inTable) {
          closeLists();
          html += "<table><tbody>";
          inTable = true;
        }
        html += "<tr>" + cells.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
        continue;
      } else {
        closeTable();
      }
      const h = t.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        closeLists();
        const n = h[1].length;
        html += `<h${n}>${inline(h[2])}</h${n}>`;
        continue;
      }
      if (/^[-*]\s+/.test(t)) {
        if (!inUl) {
          closeLists();
          html += "<ul>";
          inUl = true;
        }
        html += `<li>${inline(t.replace(/^[-*]\s+/, ""))}</li>`;
        continue;
      }
      if (/^\d+\.\s+/.test(t)) {
        if (!inOl) {
          closeLists();
          html += "<ol>";
          inOl = true;
        }
        html += `<li>${inline(t.replace(/^\d+\.\s+/, ""))}</li>`;
        continue;
      }
      if (/^>\s+/.test(t)) {
        closeLists();
        html += `<blockquote>${inline(t.replace(/^>\s+/, ""))}</blockquote>`;
        continue;
      }
      closeLists();
      html += `<p>${inline(t)}</p>`;
    }
    closeLists();
    closeTable();
    parts.push(html);
  });
  return restoreMath(parts.join(""), extracted.slots);
}
