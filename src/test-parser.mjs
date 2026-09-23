// 解析器自测：node src/test-parser.mjs
// 用用户自己装的 node 跑（见全局 AGENTS.md），不要用 DSH 自带那个。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// parser.js 是普通脚本，用间接 eval 塞进全局作用域
const src = fs.readFileSync(path.join(root, 'app', 'parser.js'), 'utf8');
(0, eval)(src);

const P = globalThis.TiKuParser;
if (!P) { console.error('❌ parser.js 没有导出 TiKuParser'); process.exit(1); }

const file = process.argv[2] || path.join(root, '题库', '示例课程', '示例题库-格式演示.txt');
const text = fs.readFileSync(file, 'utf8');

const r = P.parse(text);
console.log('文件：' + path.basename(file));
console.log('字符数：' + text.length);
console.log('解析出题目：' + r.questions.length + ' 题');
console.log('题型分布：' + JSON.stringify(r.stats.byType, null, 0));
if (r.warnings.length) console.log('⚠️ ' + r.warnings.join(' / '));
console.log('─'.repeat(70));

let bad = 0;
for (const q of r.questions) {
  const opts = q.options.map(o => o.key).join('');
  const mark = [];
  if (!q.stem) { mark.push('空题干'); bad++; }
  if (['single', 'multi'].includes(q.type) && q.options.length < 2) { mark.push('选项不足'); bad++; }
  if (['single', 'multi', 'judge'].includes(q.type) && !q.answer) { mark.push('缺答案'); bad++; }
  console.log(
    `[${String(q.no).padStart(2)}] ${P.TYPES[q.type] || q.type}` +
    `  选项(${q.options.length}):${opts || '无'}` +
    `  答案:${q.answer ? q.answer.slice(0, 24) : '(空)'}` +
    `  解析:${q.explain ? q.explain.length + '字' : '(无)'}` +
    (mark.length ? '   ⚠️ ' + mark.join(',') : '')
  );
  console.log('     题干: ' + q.stem.replace(/\n/g, ' ⏎ ').slice(0, 60));
}
console.log('─'.repeat(70));
console.log(bad === 0 ? '✅ 全部题目字段完整' : `⚠️ 有 ${bad} 处可疑`);
