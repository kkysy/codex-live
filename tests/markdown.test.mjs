// markdown 渲染回归测试：node --test tests/markdown.test.mjs
// 覆盖历史反复出问题的有序列表编号、松紧列表、嵌套、项内续行/公式/代码，
// 以及数学管线与转义。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// markdown.js 从全局取 markdown-it（浏览器里由 index.html 的 script 标签提供），
// 这里用同一份 vendor 文件注入。
globalThis.markdownit = (await import("../static/vendor/markdown-it.min.js")).default;
const { renderMarkdown } = await import("../static/markdown.js");

const here = dirname(fileURLToPath(import.meta.url));
const real = readFileSync(join(here, "fixtures", "sample-reply.md"), "utf-8");

const VOID = new Set(["br", "img", "hr", "input"]);

function assertBalanced(html) {
  const stack = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
    const [, close, tag, selfClose] = m;
    if (VOID.has(tag.toLowerCase()) || selfClose) continue;
    if (close) {
      const top = stack.pop();
      assert.equal(top, tag.toLowerCase(), `mis-matched </${tag}> (open <${top}>) in: ${html}`);
    } else {
      stack.push(tag.toLowerCase());
    }
  }
  assert.equal(stack.length, 0, `unclosed tags: ${stack.join(",")}`);
}

// 每个顶层列表的直接 <li> 子项数——浏览器对 N 个 <li> 的 <ol> 依次编号 1..N
function topLevelItems(html) {
  const counts = [];
  let depth = 0;
  for (const m of html.matchAll(/<(\/?)(ol|ul|li)\b[^>]*>/g)) {
    const close = m[1] === "/";
    const tag = m[2];
    if (tag === "li") {
      if (!close && depth === 1) counts[counts.length - 1] += 1;
      continue;
    }
    if (close) depth -= 1;
    else {
      depth += 1;
      if (depth === 1) counts.push(0);
    }
  }
  return counts;
}

const render = (src) => {
  const html = renderMarkdown(src);
  assertBalanced(html);
  return html;
};

// markdown-it 在标签之间输出换行；结构断言前压掉，只关心标签关系
const flat = (html) => html.replace(/>\s+</g, "><").trim();

test("有序列表：空行分隔的松列表不拆分、编号连续", () => {
  const html = render("1. one\n\n2. two\n\n3. three");
  assert.deepEqual(topLevelItems(html), [3]);
});

test("有序列表：项内缩进续行留在同一个 <li> 里", () => {
  const html = render("1. **first**  \n   continuation\n\n2. second\n\n3. third");
  assert.deepEqual(topLevelItems(html), [3]);
  // 续行属于第一项（跟随硬换行接在同一段里），不是顶层段落
  assert.match(flat(html), /<li><p><strong>first<\/strong><br>\s*continuation<\/p><\/li>/);
});

test("有序列表：两位数编号（10. 的续行缩进 4 空格）仍是同一个列表", () => {
  const src = [];
  for (let i = 1; i <= 12; i++) {
    src.push(`${i}. item ${i}`, `${" ".repeat(String(i).length + 1)} continuation`);
    if (i < 12) src.push("");
  }
  assert.deepEqual(topLevelItems(render(src.join("\n"))), [12]);
});

test("有序列表：从非 1 的数字开始时保留起始编号", () => {
  const html = render("3. three\n4. four");
  assert.match(html, /<ol start="3">/);
  assert.deepEqual(topLevelItems(html), [2]);
});

test("嵌套列表落在父项内部", () => {
  const html = render("1. parent\n   - sub a\n   - sub b\n\n2. parent two");
  assert.deepEqual(topLevelItems(html), [2]);
  assert.match(flat(html), /<li><p>parent<\/p><ul><li>sub a<\/li><li>sub b<\/li><\/ul><\/li>/);
});

test("嵌套列表后跟父级续行", () => {
  const html = render("1. parent one\n   - sub a\n\n   trailing\n\n2. parent two");
  assert.deepEqual(topLevelItems(html), [2]);
});

test("同一列换标记类型会另起列表", () => {
  assert.deepEqual(topLevelItems(render("1. one\n\n- dash\n- dash two")), [1, 2]);
});

test("普通无序列表不受影响", () => {
  const html = render("- a\n- b\n- c");
  assert.deepEqual(topLevelItems(html), [3]);
  assert.match(html, /<ul>/);
});

test("列表周围的普通块不受影响", () => {
  const html = render("# H\n\npara\n\n1. item\n\n## Sub\n\npara two\n\n```\ncode\n```\n\n- bullet");
  assert.deepEqual(topLevelItems(html), [1, 1]);
  assert.match(html, /<h1>H<\/h1>/);
  assert.match(html, /<h2>Sub<\/h2>/);
  assert.match(html, /<pre class="code">/);
});

test("列表项内的展示公式不拆断列表", () => {
  const html = render("1. item with math  \n   \\[\n   |H(f)|=1\n   \\]\n2. next item");
  assert.deepEqual(topLevelItems(html), [2]);
});

test("列表项内的围栏代码不拆断列表", () => {
  const html = render("1. item\n\n   ```python\n   x = 1\n   ```\n\n2. next");
  assert.deepEqual(topLevelItems(html), [2]);
});

test("缩进代码块在列表外仍是代码块", () => {
  const html = render("para\n\n    code line 1\n    code line 2\n\npara");
  assert.match(html, /<pre class="code"><code>code line 1\ncode line 2<\/code><\/pre>/);
});

test("围栏代码块保留语言标签结构", () => {
  const html = render("```python\nprint(1)\n```");
  assert.match(html, /<div class="code-lang">python<\/div><code>print\(1\)<\/code>/);
});

test("表格渲染出表头", () => {
  const html = render("| h1 | h2 |\n|---|---|\n| a | b |");
  assert.match(flat(html), /<table><thead><tr><th>h1<\/th><th>h2<\/th><\/tr><\/thead>/);
});

test("原始 HTML 被转义", () => {
  assert.match(render("<script>x</script>"), /&lt;script&gt;/);
});

test("行内代码里的星号不会被误判为强调", () => {
  const html = render("`code *x*` and *em*");
  assert.match(html, /<code>code \*x\*<\/code>/);
  assert.match(html, /<em>em<\/em>/);
});

test("中文「**标签：**内容」形状的粗体不被 CommonMark flanking 规则吞掉", () => {
  // CommonMark: 闭合 ** 前是全角标点、后接汉字时不能闭合——中文回复最常见的粗体形状
  assert.match(render("**磁盘核实：**原脚本先滤波。"), /<strong>磁盘核实：<\/strong>原脚本先滤波。/);
  assert.match(render("**工作量：**约 2–4 天。"), /<strong>工作量：<\/strong>约/);
  assert.match(render("**判断：**a **b：**c"), /<strong>判断：<\/strong>a/);
});

test("跨行的 **...** 也能补成粗体", () => {
  const html = render("**任务 A、B 需要评估吞吐与延迟；任务 C 检验\n新配置如何改变排队策略。**两者相关。");
  assert.match(html, /<strong>任务 A、B[\s\S]*排队策略。<\/strong>两者相关。/);
});

test("代码块里的 ** 不被补成粗体", () => {
  const html = render("文中 `**不是粗体**` 与\n\n```\n**保持原样**\n```");
  assert.ok(!/<strong>不是粗体<\/strong>/.test(html), "行内代码里的 ** 被误加粗");
  assert.ok(!/<strong>保持原样<\/strong>/.test(html), "代码块里的 ** 被误加粗");
});

test("码点正常的粗体不受补丁影响", () => {
  assert.match(render("普通 **bold** 文本"), /普通 <strong>bold<\/strong> 文本/);
});

test("数学占位符：行内与展示", () => {
  const html = render("inline $x^2$ and\n\n$$y=1$$");
  assert.match(html, /<span class="math-fallback">x\^2<\/span>/);
  assert.match(html, /<div class="math-fallback">y=1<\/div>/);
  // 展示公式独立成行时不被 <p> 包住
  assert.ok(!/<p><div class="math-fallback">/.test(html));
});

test("空输入与纯空白不抛错", () => {
  assert.equal(render(""), "");
  assert.doesNotThrow(() => render("\n\n   \n"));
});

test("样例回复：三节分别是 3/9/3 条，两位数编号项的续行留在该项内", () => {
  const html = render(real);
  assert.deepEqual(topLevelItems(html), [3, 9, 3]);
  // 第 10 条的两位数编号项，续行（缩进 4 空格）仍在该项内
  assert.match(html, /不是必然结果。<\/strong><br>\n只有驱动模式在两条件间保持/);
});

test("样例回复：不残留字面星号、中文粗体标签全部加粗", () => {
  const html = render(real);
  const outsideCode = html.split(/(<code>[\s\S]*?<\/code>)/).filter((s) => !s.startsWith("<code>")).join("");
  assert.doesNotMatch(outsideCode, /\*\*/);
  assert.match(outsideCode, /<strong>磁盘核实：<\/strong>/);
});
