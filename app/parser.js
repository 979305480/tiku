/* ============================================================
   题库 · 题目解析引擎
   把「一段文字」解析成结构化题目。
   TXT 和 Word(.docx) 都先转成纯文字，再走这里的同一套规则。

   支持的题型：单选题 / 多选题 / 判断题 / 填空题 / 名词解释 / 简答题 / 论述题 / 案例分析题

   识别规则（宽松，容错优先）：
     · 章节标题   一、单项选择题  二、多选题  三、简答题 …  → 决定后面题目的题型
     · 题号       1.  1、  1）  (1)  第1题
     · 选项       A.甲  A、甲  A）甲  （A）甲  A 甲   （也支持 A.甲 B.乙 C.丙 D.丁 挤在一行）
     · 答案       答案：B   【答案】B   正确答案:ACD   （简答/论述的答案可以是一整段）
     · 解析       解析：…   答案解析：…   【解析】…   答案与解析：…
     · 答案在后   文末「参考答案」段落里写  1.B  2.ACD  3.ABD
   ============================================================ */
;(function (global) {
  'use strict';

  var TYPES = {
    single: '单选题',
    multi: '多选题',
    judge: '判断题',
    blank: '填空题',
    term: '名词解释',
    short: '简答题',
    essay: '论述题',
    case: '案例分析题',
    other: '其他'
  };

  var SECTION_TYPES = [
    ['不定项', 'multi'], ['多项选择', 'multi'], ['多选题', 'multi'], ['多选', 'multi'],
    ['单项选择', 'single'], ['单选题', 'single'], ['单选', 'single'],
    ['判断题', 'judge'], ['判断', 'judge'],
    ['填空题', 'blank'], ['填空', 'blank'],
    ['名词解释', 'term'],
    ['简答题', 'short'], ['简述题', 'short'], ['简答', 'short'], ['简述', 'short'],
    ['论述题', 'essay'], ['论述', 'essay'], ['论析', 'essay'], ['试述', 'essay'], ['阐述', 'essay'],
    ['案例分析题', 'case'], ['案例分析', 'case'], ['案例', 'case'],
    ['设计题', 'case'], ['计算题', 'case'], ['综合题', 'case'], ['材料分析', 'case']
  ];

  var TYPE_WORD = '(?:单项选择题|单项选择|单选题|单选|多项选择题|多项选择|多选题|多选|不定项选择题|不定项|判断题|判断|填空题|填空|名词解释|简答题|简述题|简答|简述|论述题|论述|论析|试述|阐述|案例分析题|案例分析|案例|设计题|计算题|综合题|材料分析)';

  // —— 正则 ——
  var RE_PAGE_MARK = /^[=\-*]{2,}\s*(PAGE|第\s*\d+\s*页|页)\s*\d*\s*[=\-*]{2,}$/i;

  /* 🔴 章节标题只认「中文数字编号」或「纯题型词」。
     绝不能把 `8.简述工作分析的基本流程。` 这种题号行吞掉 —— 踩过这个坑。
     所以：编号部分不放行阿拉伯数字，且整行不许出现句号。 */
  var RE_SECTION = new RegExp(
    '^[\\s（(【\\[]*(?:[一二三四五六七八九十]+)\\s*[）)】\\]]?\\s*[、.．,，:：]?\\s*' + TYPE_WORD
  );
  var RE_SECTION_PLAIN = new RegExp('^[\\s（(【\\[]*(?:第?[一二三四五六七八九十]+[部分章节]\\s*[、.．,，:：]?\\s*)?' + TYPE_WORD + '\\s*[）)】\\]]?\\s*[：:]?\\s*$');

  // 「参考答案」大标题（整行只有这几个字）
  var RE_ANSWER_SECTION = /^[\s（(【\[]*(?:[一二三四五六七八九十]+|\d{1,2})\s*[）)】\]]?\s*[、.．,，:：]?\s*(?:参考答案|标准答案|试题答案|答案与解析|答案及解析|参考答案与解析|答案)\s*[）)】\]]?\s*[：:]?\s*$/;

  /* 🔴 题号只认「数字 + 后置分隔符」：1.  1、  1）  1]  【1】
     绝不认带前括号的 （1） / (1) —— 那是案例题、论述题里的「小题号」，
     当成新题会把上一题的答案挂错地方。（踩过：官方样题 2 道案例题的答案全错位）
     允许前括号的只有【和[这两种方括号。 */
  var RE_QNUM = /^[\s【\[]*(\d{1,4})\s*[、.．,，:：)）\]】]\s*(?!\d)(.*)$/;
  var RE_QNUM2 = /^第\s*(\d{1,4})\s*题\s*[、.．,，:：]?\s*(.*)$/;

  var RE_OPT = /^[\s（(【\[]*([A-Ha-h])\s*(?:[）)】\]]|[、.．,，:：]|\s)\s*(.+)$/;

  var RE_EXP = /^[\s【\[（(]*\s*(?:答案解析|答案与解析|答案及解析|试题解析|解析|解答|详解|评分标准|考点)\s*[】\]）)]*\s*[：:、.．]?\s*(.*)$/;
  var RE_ANS = /^[\s【\[（(]*\s*(?:参考答案|正确答案|标准答案|答案)\s*[】\]）)]*\s*[：:、.．]?\s*(.*)$/;

  // 文末答案段里的一条：1.B   2、ACD   3.ABCD
  var RE_ANS_LINE = /^\s*(\d{1,4})\s*[、.．,，:：)）]\s*([A-Ha-h](?:\s*[、,，]?\s*[A-Ha-h]){0,7}|对|错|√|×|正确|错误|是|否)\s*$/;
  // 解析段里的一条：1.【解析】… 或 1.解析：…
  var RE_ANS_EXP_LINE = /^\s*(\d{1,4})\s*[、.．,，:：)）]\s*[【\[（(]?\s*(?:答案解析|答案与解析|解析|解答)\s*[】\]）)]*\s*[：:]?\s*(.+)$/;

  // ---------- 预处理 ----------

  function normalize(text) {
    if (!text) return '';
    return String(text)
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u3000\u00A0\u2007\u202F]/g, ' ')
      .replace(/[ \t]+$/gm, '');
  }

  // 把一行里挤在一起的多个选项拆成多行：A.甲 B.乙 C.丙 D.丁
  function splitInlineOptions(line) {
    var re = /([A-Ha-h])\s*(?:[）)】\]]|[、.．,，:：])/g;
    var marks = [], m;
    while ((m = re.exec(line)) !== null) {
      if (m.index === 0) continue;                 // 行首那个不当分隔点
      marks.push({ idx: m.index, letter: m[1].toUpperCase() });
    }
    if (marks.length < 1) return [line];
    // 必须是 A 开头的连续字母序列，才认为是选项串
    var expect = 'A';
    for (var i = 0; i < marks.length; i++) {
      if (marks[i].letter !== expect) return [line];
      expect = String.fromCharCode(expect.charCodeAt(0) + 1);
    }
    var out = [];
    var lead = line.slice(0, marks[0].idx);
    if (lead.replace(/[\s（(【\[]/g, '').length > 0) out.push(lead);
    for (var j = 0; j < marks.length; j++) {
      var end = (j + 1 < marks.length) ? marks[j + 1].idx : line.length;
      out.push(line.slice(marks[j].idx, end).trim());
    }
    return out;
  }

  // 把行中间的「答案」「解析」标记切开
  function splitAnswerMarks(text) {
    return text
      .replace(/[【\[]\s*(答案与解析|答案及解析|答案解析|参考答案|正确答案|答案|解析|解答)\s*[】\]]/g, '\n【$1】')
      .replace(/([。．.；;）)】])\s*(?=(?:参考答案|正确答案|答案与解析|答案解析|解析)\s*[：:])/g, '$1\n');
  }

  // PDF 抽取出来的文字常常整段没换行 → 在题号/选项前补换行
  function unwrapParagraphs(text) {
    var lines = text.split('\n'), longLines = 0, nonEmpty = 0;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim().length === 0) continue;
      nonEmpty++;
      if (lines[i].length > 120) longLines++;
    }
    if (nonEmpty === 0 || longLines / nonEmpty < 0.5) return text;   // 本来就有换行，不动

    return text
      .replace(/(?<=[）)】。．.；;\s])\s*(?=[A-H]\s*[、.．)）])/g, '\n')
      .replace(/(?<=[。．.；;）)】\s])\s*(?=(?:第)?\d{1,3}\s*[、.．]\s*(?!\d))/g, '\n')
      .replace(/\s*(?=(?:参考答案|正确答案|答案解析|答案与解析|解析)\s*[：:])/g, '\n');
  }

  // ---------- 主解析 ----------

  function parse(rawText) {
    var text = normalize(rawText);
    text = splitAnswerMarks(text);
    text = unwrapParagraphs(text);

    var rawLines = text.split('\n');
    var lines = [];
    for (var i = 0; i < rawLines.length; i++) {
      var ln = rawLines[i].replace(/^\s+/, '').replace(/\s+$/, '');
      if (ln.length === 0) { lines.push(''); continue; }
      if (RE_PAGE_MARK.test(ln)) continue;                 // 丢掉 ===== PAGE 3 ===== 这类
      var pieces = splitInlineOptions(ln);
      for (var k = 0; k < pieces.length; k++) lines.push(pieces[k].replace(/^\s+/, '').replace(/\s+$/, ''));
    }

    var questions = [];
    var warnings = [];
    var curType = 'single';
    var cur = null;
    var phase = 'body';          // body | answerBlock

    function finish() {
      if (!cur) return;
      if (!cur.stem && !cur.options.length) { cur = null; return; }
      var ansLetters = (cur.answer || '').toUpperCase().replace(/[^A-H]/g, '');
      if (cur.type === 'single' && ansLetters.length > 1) cur.type = 'multi';
      if (!cur.type) cur.type = cur.options.length ? 'single' : 'short';
      questions.push(cur);
      cur = null;
    }

    function typeFromSection(txt) {
      for (var i = 0; i < SECTION_TYPES.length; i++) {
        if (txt.indexOf(SECTION_TYPES[i][0]) >= 0) return SECTION_TYPES[i][1];
      }
      return null;
    }

    for (var n = 0; n < lines.length; n++) {
      var line = lines[n];

      if (line === '') {
        if (cur && cur.explain) cur.explain += '\n';
        continue;
      }

      // ① 「参考答案」大标题 → 进入文末答案段
      if (RE_ANSWER_SECTION.test(line)) {
        finish();
        phase = 'answerBlock';
        continue;
      }

      // ② 文末答案段
      if (phase === 'answerBlock') {
        var ae = RE_ANS_EXP_LINE.exec(line);
        if (ae) {
          var q1 = byNum(questions, parseInt(ae[1], 10));
          if (q1) { q1.explain = (q1.explain ? q1.explain + '\n' : '') + ae[2]; continue; }
        }
        var a = RE_ANS_LINE.exec(line);
        if (a) {
          var q2 = byNum(questions, parseInt(a[1], 10));
          if (q2) { q2.answer = cleanAnswer(a[2]); continue; }
        }
        continue;
      }

      // ③ 新题号（🔴 必须排在章节标题前面，否则 `8.简述…` 会被当标题吞掉）
      var qn = RE_QNUM.exec(line) || RE_QNUM2.exec(line);
      if (qn) {
        var num = parseInt(qn[1], 10);
        var content = (qn[2] || '').trim();
        var isOption = /^[A-Ha-h]\s*(?:[）)】\]]|[、.．,，:：]|\s)/.test(content);
        if (!isOption && content.length >= 2) {
          var accept;
          if (!cur) accept = true;
          else {
            var cn = cur._num || 0;
            if (num === cn + 1) accept = true;                       // 正常连号
            else if (num > cn && (cur.answer || cur.explain)) accept = true;  // 跳号但上一题已完整
            else accept = false;                                     // 多半是解析里的编号 → 当续行
          }
          if (accept) {
            finish();
            cur = newQuestion(curType, num, content);
            continue;
          }
        }
      }

      // ④ 章节标题
      if (line.indexOf('。') < 0 && (RE_SECTION.test(line) || RE_SECTION_PLAIN.test(line))) {
        var sec = RE_SECTION.exec(line);
        var t = typeFromSection(sec ? sec[0] : line);
        if (t) {
          finish();
          curType = t;
          continue;
        }
      }

      // ⑤ 解析（必须先于「答案」，「答案与解析」才不会被截断）
      var ex = RE_EXP.exec(line);
      if (ex && cur) {
        cur.explain = (cur.explain ? cur.explain + '\n' : '') + ex[1];
        continue;
      }

      // ⑥ 答案
      var an = RE_ANS.exec(line);
      if (an && cur) {
        var body = an[1].trim();
        var hasOpts = cur.options.length > 0;
        // 选择题的答案必须是短字母串；简答/论述的答案允许整段文字
        if ((!hasOpts || body.length <= 20) && (body.length > 0 || !hasOpts)) {
          if (hasOpts && body.length <= 60) {
            var mx = /[【\[（(]?\s*(?:答案解析|答案与解析|解析|解答)\s*[】\]）)]*\s*[：:]?\s*([\s\S]*)$/.exec(body);
            if (mx && mx.index > 0) {
              cur.answer = cleanAnswer(body.slice(0, mx.index));
              cur.explain = (cur.explain ? cur.explain + '\n' : '') + mx[1].trim();
              continue;
            }
          }
          cur.answer = cleanAnswer(body);
          continue;
        }
      }

      // ⑦ 选项
      var op = RE_OPT.exec(line);
      if (op && cur) {
        var letter = op[1].toUpperCase();
        var expect = String.fromCharCode(65 + cur.options.length);
        if (letter === expect) {
          cur.options.push({ key: letter, text: op[2].trim() });
          continue;
        }
        if (cur.options.length === 0 && letter === 'A') {
          cur.options.push({ key: letter, text: op[2].trim() });
          continue;
        }
      }

      // ⑧ 续行：解析 → 答案（无选项时）→ 最后一个选项 → 题干
      if (!cur) continue;
      if (cur.explain) cur.explain += '\n' + line;
      else if (cur.answer && cur.options.length === 0) cur.answer += '\n' + line;
      else if (cur.options.length) cur.options[cur.options.length - 1].text += '\n' + line;
      else cur.stem += (cur.stem ? '\n' : '') + line;
    }

    finish();

    // 试卷格式一题都没解出来 → 退回「问答清单」模式（笔记 / 背诵清单）
    if (questions.length === 0) {
      var qa = parseQA(text);
      if (qa.length > 0) {
        questions = qa;
        warnings.push('未识别到试卷式题号与选项，已按「问答清单」模式导入 ' + qa.length + ' 题');
      }
    }

    // 收尾：编号、题型兜底
    var seq = 0;
    for (var q = 0; q < questions.length; q++) {
      var item = questions[q];
      seq++;
      item.no = seq;
      item.id = 'q' + seq;
      if (!item.type) item.type = item.options.length ? 'single' : 'short';
      if (item.options.length === 0 && (item.type === 'single' || item.type === 'multi')) {
        item.type = 'short';                     // 有答案没选项 → 当简答处理
      }
      if (item.options.length > 0 && (item.type === 'short' || item.type === 'essay' ||
          item.type === 'case' || item.type === 'term' || item.type === 'blank')) {
        item.type = ((item.answer || '').replace(/[^A-Ha-h]/g, '').length > 1) ? 'multi' : 'single';
      }
      delete item._num;
    }

    if (questions.length === 0) warnings.push('没有解析出任何题目，请检查文件格式（可参考「导入格式说明.md」）');

    var stats = { total: questions.length, byType: {} };
    for (var s = 0; s < questions.length; s++) {
      var tp = questions[s].type;
      stats.byType[tp] = (stats.byType[tp] || 0) + 1;
    }
    return { questions: questions, warnings: warnings, stats: stats };
  }

  /* ---------- 问答清单模式 ----------
     给「笔记 / 背诵清单」用（例如学习助手的章节 .md）：
       ### Q1 人力资源规划是什么？（领会）
       按组织**战略目标**…（这一段就是答案）
       **题 1（综合应用 · 限时 40 分钟）**   ← 这种是「要你自己写」的题，正文算题干
     保留 **加粗** 和表格原样，界面里会渲染出来（关键词加粗是刻意标的）。 */

  var RE_QA_NUM = /^#{0,6}\s*\**\s*(?:Q|问|问题|题目)\s*(\d{1,3})\s*\**\s*[.、:：]?\s*(.*)$/i;
  var RE_QA_TI = /^#{0,6}\s*\**\s*题\s*(\d{1,3})\s*\**\s*(.*)$/;
  var RE_QA_ASK = /^#{0,6}\s*\**\s*(?:问|题目)\s*\**\s*[：:]\s*(.*)$/;
  var RE_QA_ANS = /^#{0,6}\s*\**\s*(?:答|答案|参考答案|解答)\s*\**\s*[：:]\s*(.*)$/;
  var RE_MD_HEAD = /^#{1,6}\s+/;
  var RE_LEVEL = /[（(]\s*(?:识记|领会|简单应用|综合应用|重点|难点|理解|掌握|应用|了解)[^）)]*[）)]\s*$/;

  function stripLevel(s) {
    var t = String(s || '').replace(/\*+/g, '').replace(/[🔴🔵⚪✍️📋🧹]/g, '').trim();
    while (RE_LEVEL.test(t)) t = t.replace(RE_LEVEL, '').trim();
    return t.replace(/[。，,；;]+$/, '').trim();
  }

  function inferQAType(s) {
    if (/案例分析|材料分析|案例/.test(s)) return 'case';
    if (/论述|试述|论析|阐述|编制一份|编制.{0,6}方案|设计方案|撰写/.test(s)) return 'essay';
    if (/名词解释/.test(s)) return 'term';
    if (/填空题|填空/.test(s)) return 'blank';
    if (/判断题|判断正误/.test(s)) return 'judge';
    return 'short';
  }

  function parseQA(rawText) {
    var text = normalize(rawText);
    var lines = text.split('\n');
    var out = [], cur = null, mode = 'answer';

    function append(s) { if (cur) cur[mode] += (cur[mode] ? '\n' : '') + s; }
    function push() {
      if (!cur) return;
      cur.stem = (cur.stem || '').replace(/^\s+|\s+$/g, '');
      cur.answer = (cur.answer || '').replace(/^\s+|\s+$/g, '');
      if (cur.stem.length >= 2) {
        cur.type = cur._forceType || inferQAType(cur.stem + ' ' + (cur._meta || ''));
        cur.options = [];
        cur.explain = '';
        delete cur._meta; delete cur._forceType;
        out.push(cur);
      }
      cur = null;
    }
    function fresh(stem, m) {
      return { stem: stem || '', answer: '', options: [], explain: '', type: '', _meta: m || '' };
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i].replace(/\s+$/, '');
      if (raw.trim() === '') { if (cur) append(''); continue; }
      if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) continue;        // --- / *** 分隔线
      if (/^\s*>/.test(raw)) continue;                       // 引用块是批注，不进题目
      var line = raw.replace(/^\s+/, '');
      var m;

      if ((m = RE_QA_TI.exec(line))) {                       // 题 N（…）→ 正文并入题干
        push();
        var meta = m[2] || '';
        var inner = /[（(]([^）)]*)[）)]/.exec(meta);
        cur = fresh('', inner ? inner[1] : '');
        mode = 'stem';
        var rest = stripLevel(meta.replace(/[（(][^）)]*[）)]/g, ''));
        if (rest) cur.stem = rest;
        continue;
      }
      if ((m = RE_QA_NUM.exec(line))) {                      // Q1 / 问1 / 问题1
        push();
        cur = fresh(stripLevel(m[2]));
        mode = 'answer';
        continue;
      }
      if ((m = RE_QA_ASK.exec(line))) {                      // **问**：…
        push();
        cur = fresh(stripLevel(m[1]));
        mode = 'answer';
        continue;
      }
      if ((m = RE_QA_ANS.exec(line))) {                      // **答**：…
        if (!cur) { cur = fresh(''); mode = 'answer'; }
        mode = 'answer';
        append(m[1]);
        continue;
      }
      if (RE_MD_HEAD.test(line)) {                           // 其他 Markdown 标题 = 分节，丢弃
        push();
        continue;
      }
      if (!cur) continue;
      append(stripLevelKeepBold(line));
    }
    push();
    return out;
  }

  // 只去掉标题/层级标记，保留 ** 加粗（界面要渲染关键词）
  function stripLevelKeepBold(s) {
    return String(s)
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/[🔴🔵⚪]/g, '')
      .replace(/\s+$/, '');
  }

  function newQuestion(type, num, stem) {
    return { type: type, stem: stem || '', options: [], answer: '', explain: '', _num: num };
  }

  function byNum(list, num) {
    for (var i = 0; i < list.length; i++) if (list[i]._num === num || list[i].no === num) return list[i];
    return null;
  }

  function cleanAnswer(s) {
    if (!s) return '';
    var t = String(s).trim();
    if (/^(对|正确|是|√|T|true|Y)$/i.test(t)) return '对';
    if (/^(错|错误|否|×|x|F|false|N)$/i.test(t)) return '错';
    var letters = t.toUpperCase().replace(/[^A-H]/g, '');
    // 只有「纯字母/标点组成」的短串才当选项答案，否则原文保留（简答/论述）
    if (letters.length > 0 && t.replace(/[A-Ha-h\s、,，.．:：;；]/g, '').length === 0) {
      var seen = {}, out = '';
      for (var i = 0; i < letters.length; i++) {
        if (!seen[letters[i]]) { seen[letters[i]] = 1; out += letters[i]; }
      }
      return out.split('').sort().join('');
    }
    if (/^(对|错)$/.test(t)) return t;
    return t;
  }

  global.TiKuParser = {
    parse: parse,
    normalize: normalize,
    TYPES: TYPES,
    cleanAnswer: cleanAnswer
  };
})(typeof window !== 'undefined' ? window : globalThis);
