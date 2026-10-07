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
    let stack = [];
    let inTable = false;
    // Each open list level carries its own "an item is open" flag, because a
    // nested list lives inside its parent's <li>: several <li>s can be open at
    // the same time and must be closed in the right order.
    const popLevel = () => {
      const lv = stack.pop();
      if (lv.itemOpen) html += "</li>";
      html += lv.tag === "ul" ? "</ul>" : "</ol>";
    };
    const closeLists = () => {
      while (stack.length) popLevel();
    };
    const closeTable = () => {
      if (inTable) {
        html += "</tbody></table>";
        inTable = false;
      }
    };
    // Leading whitespace in columns; a tab counts as four.
    const indentOf = (line) => {
      let n = 0;
      for (const c of line) {
        if (c === " ") n += 1;
        else if (c === "\t") n += 4;
        else break;
      }
      return n;
    };
    // A list item marker at the current indentation, if any. ChatGPT numbers its
    // lists but writes every item's sub-paragraph (and any nested list) indented
    // by a couple of spaces, so a line only counts as a new item when its marker
    // sits at its own level's column.
    const markerAt = (line) => {
      const indent = indentOf(line);
      const t = line.trim();
      if (/^[-*]\s+/.test(t)) return { indent, tag: "ul", width: indent + 2, text: t.replace(/^[-*]\s+/, "") };
      const m = t.match(/^(\d+)\.\s+(.*)$/s);
      if (m) return { indent, tag: "ol", width: indent + m[1].length + 2, text: m[2] };
      return null;
    };
    const blockStarter = (t) =>
      /^#{1,6}\s+/.test(t) ||
      (t.startsWith("|") && t.endsWith("|")) ||
      /^\u0000M\d+\u0000$/.test(t) ||
      /^>\s+/.test(t);
    const renderIndentedCode = (codeLines, base) => {
      const dedent = new RegExp(`^ {1,${base + 4}}`);
      const code = codeLines
        .map((line) => line.replace(dedent, ""))
        .join("\n")
        .replace(/\n$/, "");
      html += `<pre class="code"><code>${escapeHtml(code)}</code></pre>`;
    };
    const openList = (m) => {
      const tag = m.tag === "ul" ? "<ul>" : "<ol>";
      stack.push({
        tag: m.tag,
        indent: m.indent,
        width: m.width,
        openPos: html.length,
        loose: false,
        itemOpen: false
      });
      html += tag;
    };
    // The open level a marker of this type belongs to, or -1. Ideally a marker
    // sits exactly at its level's column, but ChatGPT indents the first item of
    // a list more often than the rest, so a level up to three columns to the
    // right of the marker still belongs to the same list. The shallowest match
    // wins, so a marker back at the list's own column returns to the outer list
    // instead of staying inside a nested one.
    const joinIndex = (indent, tag) => {
      for (let k = 0; k < stack.length; k++) {
        if (stack[k].tag !== tag) continue;
        if (indent <= stack[k].indent && stack[k].indent <= indent + 3) return k;
      }
      return -1;
    };
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      // Indentation is measured against the enclosing list item's content column
      // ("10. " is four columns, "1. " only three), so a continuation paragraph
      // indented to its marker is not mistaken for a four-space code block.
      const base = stack.length ? stack[stack.length - 1].width : 0;
      const lineIndent = indentOf(line);
      if (lineIndent - base >= 4) {
        closeLists();
        closeTable();
        const codeLines = [line];
        while (lineIndex + 1 < lines.length) {
          const next = lines[lineIndex + 1];
          if (indentOf(next) - base >= 4) {
            codeLines.push(next);
            lineIndex++;
            continue;
          }
          if (!next.trim() && lineIndex + 2 < lines.length && indentOf(lines[lineIndex + 2]) - base >= 4) {
            codeLines.push(next);
            lineIndex++;
            continue;
          }
          break;
        }
        renderIndentedCode(codeLines, base);
        continue;
      }
      const t = line.trim();
      if (!t) {
        // Loose lists (blank lines between items) must stay open: closing and
        // reopening splits one ordered list into several single-item <ol>s,
        // each restarting its numbering at 1. Keep the list open and mark it
        // loose so CSS adds item spacing; spacer <li>s are avoided because
        // every <li> inside an <ol> consumes a number.
        let j = lineIndex + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const nxtMarker = j < lines.length ? markerAt(lines[j]) : null;
        const nxtIndent = j < lines.length ? indentOf(lines[j]) : -1;
        // The list continues if the next non-blank line is a marker of some open
        // level (or a deeper nested one), or an indented line belonging to the
        // outermost list's current item.
        const outer = stack[0];
        const continues =
          (nxtMarker &&
            (joinIndex(nxtMarker.indent, nxtMarker.tag) >= 0 ||
              (outer && nxtMarker.indent > outer.indent))) ||
          (!nxtMarker && outer && nxtIndent > outer.indent);
        if (continues) {
          // Deepest level was pushed last, so inserting from the top of the
          // stack keeps the shallower levels' recorded positions valid.
          for (let k = stack.length - 1; k >= 0; k--) {
            const lv = stack[k];
            if (!lv.loose && lv.openPos >= 0) {
              html =
                html.slice(0, lv.openPos + 3) + ' class="loose"' + html.slice(lv.openPos + 3);
              lv.loose = true;
            }
          }
          continue;
        }
        closeLists();
        closeTable();
        continue;
      }
      const m = markerAt(line);
      if (m) {
        // A marker leaves a level only when it sits four or more columns to the
        // left of that level's own marker — a Markdown-code-block-sized step.
        // Steps of one to three columns are just sloppy indentation of the same
        // list (ChatGPT often indents only its first item), and must not split
        // one ordered list into several single-item lists.
        while (stack.length && m.indent + 4 <= stack[stack.length - 1].indent) popLevel();
        const idx = joinIndex(m.indent, m.tag);
        if (idx < 0) {
          // No open level this marker belongs to: it is either a nested list
          // inside the item still open above, or a list of its own.
          const parent = stack[stack.length - 1];
          if (parent && m.indent > parent.indent) {
            openList(m);
          } else {
            closeLists();
            openList(m);
          }
          html += `<li>${inline(m.text)}`;
          stack[stack.length - 1].itemOpen = true;
          continue;
        }
        while (stack.length > idx + 1) popLevel();
        if (stack[idx].itemOpen) html += "</li>";
        html += `<li>${inline(m.text)}`;
        stack[idx].itemOpen = true;
        continue;
      }
      if (/^\u0000M\d+\u0000$/.test(t)) {
        if (stack.length && lineIndent > 0) {
          // Display math inside a list item belongs to that item; closing the
          // list here would split one ordered list into single-item <ol>s.
          html += t;
          continue;
        }
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
      if (/^>\s+/.test(t)) {
        closeLists();
        html += `<blockquote>${inline(t.replace(/^>\s+/, ""))}</blockquote>`;
        continue;
      }
      // An indented line while a list is open is that item's continuation:
      // emitting it as a top-level paragraph would close the list and split one
      // ordered list into single-item <ol>s, restarting the numbering at 1.
      if (stack.length && lineIndent > 0 && !blockStarter(t)) {
        // Leave nested levels whose content column this line does not reach, so
        // the paragraph lands in the item it visually belongs to.
        while (stack.length > 1 && lineIndent < stack[stack.length - 1].width) popLevel();
        html += `<p>${inline(t)}</p>`;
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
