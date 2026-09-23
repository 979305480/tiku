/* ============================================================
   题库 · 界面逻辑 v2
   结构：顶栏 + 左侧功能栏 + 右侧内容区
   数据：课程（=题库下的文件夹）→ 试卷（=文件）→ 题目
   ============================================================ */
(function () {
  'use strict';

  var P = window.TiKuParser;

  /* ================= 小工具 ================= */
  function $(s, r) { return (r || document).querySelector(s); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function qkey(q) { return 'h' + hash(q.stem + '|' + (q.options || []).map(function (o) { return o.text; }).join('')); }
  function letters(s) { return String(s || '').toUpperCase().replace(/[^A-H]/g, '').split('').sort().join(''); }
  function isChoice(t) { return t === 'single' || t === 'multi'; }
  function isSubjective(t) { return !isChoice(t) && t !== 'judge'; }
  function pct(a, b) { return b > 0 ? (a / b * 100) : 0; }
  function f1(n) { return (Math.round(n * 10) / 10).toString(); }

  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2400);
  }

  /* ================= Markdown（加粗 + 表格 + 代码） ================= */
  function inlineMd(s) {
    return esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function mdToHtml(src) {
    if (!src) return '';
    var lines = String(src).split('\n'), out = [], table = null;
    function flush() {
      if (!table) return;
      var h = '<table>';
      for (var i = 0; i < table.length; i++) {
        h += '<tr>';
        for (var j = 0; j < table[i].length; j++)
          h += (i === 0 ? '<th>' : '<td>') + inlineMd(table[i][j]) + (i === 0 ? '</th>' : '</td>');
        h += '</tr>';
      }
      out.push(h + '</table>'); table = null;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (/^\|.*\|$/.test(line)) {
        var cells = line.replace(/^\||\|$/g, '').split('|'), isSep = true;
        for (var c = 0; c < cells.length; c++) if (!/^\s*:?-{2,}:?\s*$/.test(cells[c])) { isSep = false; break; }
        if (isSep) continue;
        if (!table) table = [];
        table.push(cells.map(function (x) { return x.trim(); }));
        continue;
      }
      flush();
      out.push(line === '' ? '' : inlineMd(line));
    }
    flush();
    return out.join('<br>').replace(/(<br>){3,}/g, '<br><br>');
  }

  /* ================= 状态 ================= */
  var S = {
    screen: 'home',
    tab: 'practice',            // 课程页的子标签
    courses: [],
    bankDir: '',
    defBankDir: '',
    course: '',                 // 当前课程 key（'' = 未分类）
    paper: '',                  // 当前试卷文件名
    questions: [],
    order: [], index: 0, mode: 'order',
    stats: null, warnings: [],
    catalogBusy: 0,             // 还在统计的试卷数
    data: null
  };

  function blankData() {
    return { v: 2, settings: { courses: {} }, papers: {}, wrong: {}, catalog: {} };
  }
  function migrate(d) {
    if (!d || typeof d !== 'object') return blankData();
    if (d.v === 2) {
      if (!d.settings) d.settings = { courses: {} };
      if (!d.settings.courses) d.settings.courses = {};
      if (!d.papers) d.papers = {};
      if (!d.wrong) d.wrong = {};
      if (!d.catalog) d.catalog = {};
      return d;
    }
    // v1 → v2：老数据 key 是纯文件名，当作「未分类」下的试卷搬过来
    var n = blankData();
    var old = d.banks || {}, oldWrong = d.wrong || {};
    for (var k in old) if (old.hasOwnProperty(k)) n.papers['/' + k] = old[k];
    for (var k2 in oldWrong) if (oldWrong.hasOwnProperty(k2)) n.wrong['/' + k2] = oldWrong[k2];
    return n;
  }

  function paper(key) {
    if (!S.data.papers[key]) S.data.papers[key] = { answers: {}, self: {}, revealed: {}, result: {}, starred: {}, index: 0, submitted: false };
    var p = S.data.papers[key];
    if (!p.answers) p.answers = {};
    if (!p.self) p.self = {};
    if (!p.revealed) p.revealed = {};
    if (!p.result) p.result = {};
    if (!p.starred) p.starred = {};
    return p;
  }
  function wrongOf(key) { if (!S.data.wrong[key]) S.data.wrong[key] = {}; return S.data.wrong[key]; }
  function curKey() { return S.course + '/' + S.paper; }
  function curPaper() { return paper(curKey()); }
  function curWrong() { return wrongOf(curKey()); }

  function courseName(key) {
    var c = S.data.settings.courses[key];
    return (c && c.name) ? c.name : (key === '' ? '未分类' : key);
  }

  var saveTimer = null;
  function save(now) {
    clearTimeout(saveTimer);
    function doIt() {
      fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(S.data) })
        .catch(function () { });
    }
    if (now) doIt(); else saveTimer = setTimeout(doIt, 700);
  }

  /* ================= 判定 ================= */
  function userAns(q) { var a = curPaper().answers[qkey(q)]; return a == null ? '' : a; }
  function isAnswered(q) {
    if (isChoice(q.type) || q.type === 'judge') return userAns(q) !== '';
    return curPaper().self[qkey(q)] !== undefined;
  }
  function isCorrect(q) {
    var r = curPaper().result[qkey(q)];
    return r === undefined ? null : r;
  }
  function isRevealed(q) { return !!curPaper().revealed[qkey(q)]; }
  function isStarred(q) { return !!curPaper().starred[qkey(q)]; }
  function optionsOf(q) {
    if (q.options && q.options.length) return q.options;
    if (q.type === 'judge') return [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }];
    return [];
  }
  function grade(q) {
    if (isChoice(q.type)) return letters(userAns(q)) === letters(q.answer) && letters(q.answer) !== '';
    if (q.type === 'judge') {
      // 🔴 判断题：界面上自动生成「A 正确 / B 错误」两个选项，用户点的是 A/B；
      //    而文件里的答案可能写成「对/错」也可能写成「A/B」—— 两边都必须归一化再比。
      //    （曾经直接拿 'A' 和 '对' 比，导致判断题永远判错。）
      var ua = judgeNorm(userAns(q)), ans = judgeNorm(q.answer);
      return ua !== '' && ua === ans;
    }
    return curPaper().self[qkey(q)] === true;
  }

  // 把「对/错」的各种写法（含 A=正确、B=错误）统一成 '对' / '错'
  function judgeNorm(v) {
    var s = String(v == null ? '' : v).trim();
    if (/^(A|对|正确|是|√|T|true|Y)$/i.test(s)) return '对';
    if (/^(B|错|错误|否|×|x|F|false|N)$/i.test(s)) return '错';
    return '';
  }

  // 把「正确答案」换算成选项字母（判断题的 对/错 → A/B），供界面高亮用
  function answerLetters(q) {
    if (q.type === 'judge') {
      var n = judgeNorm(q.answer);
      return n === '对' ? 'A' : (n === '错' ? 'B' : '');
    }
    return letters(q.answer);
  }

  /* ================= 统计 ================= */
  function paperStats(key) {
    var cat = S.data.catalog[key] || {};
    var total = cat.total || 0;
    var p = S.data.papers[key] || {};
    var res = p.result || {};
    // 「已做」= 已判定过的题（答对 + 做错），口径与参考答案站一致：
    // 已做 = 答对 + 做错；完成率 = 已做 ÷ 总题数；正确率 = 答对 ÷ 已做
    var done = 0, right = 0, wrong = 0, k;
    for (k in res) { done++; if (res[k]) right++; else wrong++; }
    return {
      total: total, done: done, right: right, wrong: wrong,
      complete: pct(done, total), acc: pct(right, done)
    };
  }
  function courseStats(courseKey) {
    var t = 0, d = 0, r = 0, w = 0, papers = 0;
    var c = findCourse(courseKey);
    if (!c) return { total: 0, done: 0, right: 0, wrong: 0, complete: 0, acc: 0, papers: 0 };
    for (var i = 0; i < c.papers.length; i++) {
      var st = paperStats(courseKey + '/' + c.papers[i].name);
      t += st.total; d += st.done; r += st.right; w += st.wrong; papers++;
    }
    return { total: t, done: d, right: r, wrong: w, papers: papers, complete: pct(d, t), acc: pct(r, d) };
  }
  function globalStats() {
    var t = 0, d = 0, r = 0, w = 0, pn = 0, cn = 0;
    for (var i = 0; i < S.courses.length; i++) {
      var c = S.courses[i];
      var cs = courseStats(c.key);
      t += cs.total; d += cs.done; r += cs.right; w += cs.wrong; pn += cs.papers;
      if (c.papers.length) cn++;
    }
    return { total: t, done: d, right: r, wrong: w, papers: pn, courses: cn, complete: pct(d, t), acc: pct(r, d) };
  }
  function findCourse(key) {
    for (var i = 0; i < S.courses.length; i++) if (S.courses[i].key === key) return S.courses[i];
    return null;
  }
  function wrongCount(courseKey) {
    var c = findCourse(courseKey), n = 0;
    if (!c) return 0;
    for (var i = 0; i < c.papers.length; i++) {
      var w = S.data.wrong[courseKey + '/' + c.papers[i].name] || {};
      n += Object.keys(w).length;
    }
    return n;
  }
  function starCount(courseKey) {
    var c = findCourse(courseKey), n = 0;
    if (!c) return 0;
    for (var i = 0; i < c.papers.length; i++) {
      var s = (S.data.papers[courseKey + '/' + c.papers[i].name] || {}).starred || {};
      n += Object.keys(s).length;
    }
    return n;
  }

  /* ================= API ================= */
  function getJSON(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
    });
  }
  function getBuf(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer();
    });
  }
  function decodeSmart(buf) {
    var u8 = new Uint8Array(buf);
    if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) u8 = u8.subarray(3);
    var txt = new TextDecoder('utf-8', { fatal: false }).decode(u8);
    if (txt.indexOf('\uFFFD') < 0) return txt;
    try { return new TextDecoder('gbk', { fatal: false }).decode(u8); } catch (e) { return txt; }
  }

  /* ================= .docx ================= */
  function unzip(buf) {
    var dv = new DataView(buf), u8 = new Uint8Array(buf), eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--)
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('这个文件不是有效的 .docx（是 .doc 老格式吗？请在 Word 里另存为 .docx）');
    var count = dv.getUint16(eocd + 10, true), p = dv.getUint32(eocd + 16, true), map = {};
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true), compSize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), cmtLen = dv.getUint16(p + 32, true);
      var localOff = dv.getUint32(p + 42, true);
      var name = new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nameLen));
      map[name] = { method: method, compSize: compSize, localOff: localOff };
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return {
      get: function (name) {
        var e = map[name];
        if (!e) return Promise.resolve(null);
        var lp = e.localOff;
        if (dv.getUint32(lp, true) !== 0x04034b50) return Promise.resolve(null);
        var lN = dv.getUint16(lp + 26, true), lE = dv.getUint16(lp + 28, true);
        var start = lp + 30 + lN + lE, raw = u8.subarray(start, start + e.compSize);
        if (e.method === 0) return Promise.resolve(raw);
        if (e.method !== 8) return Promise.reject(new Error('docx 用了不支持的压缩方式 ' + e.method));
        if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('当前浏览器不支持解压 .docx'));
        var stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
      }
    };
  }
  function docxXmlToText(xml) {
    var s = xml.replace(/<w:tab\b[^>]*\/?>/g, '\t').replace(/<w:br\b[^>]*\/?>/g, '\n').replace(/<\/w:p>/g, '\n');
    s = s.replace(/<[^>]+>/g, '');
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }
  function parseDocx(buf) {
    return unzip(buf).get('word/document.xml').then(function (data) {
      if (!data) throw new Error('这个 .docx 里没有正文（word/document.xml）');
      return docxXmlToText(new TextDecoder('utf-8').decode(data));
    });
  }
  function toText(name, buf) {
    return /\.docx$/i.test(name) ? parseDocx(buf) : Promise.resolve(decodeSmart(buf));
  }

  /* ================= 题库目录 ================= */
  function loadCourses(showToast) {
    return getJSON('/api/list').then(function (d) {
      S.courses = d.courses || [];
      S.bankDir = d.dir || '';
      S.defBankDir = d.defdir || '';
      render();
      buildCatalog();
      if (showToast) toast('已刷新：' + S.courses.length + ' 门课程');
    }).catch(function () {
      S.courses = []; render();
    });
  }

  // 后台把每张试卷解析一遍，拿到「共多少题」并缓存（按修改时间失效）
  function buildCatalog() {
    var jobs = [];
    for (var i = 0; i < S.courses.length; i++) {
      var c = S.courses[i];
      for (var j = 0; j < c.papers.length; j++) {
        var key = c.key + '/' + c.papers[j].name;
        var cat = S.data.catalog[key];
        if (!cat || cat.ticks !== c.papers[j].ticks) jobs.push({ key: key, course: c.key, name: c.papers[j].name, ticks: c.papers[j].ticks });
      }
    }
    if (!jobs.length) return;
    S.catalogBusy = jobs.length;
    render();

    var idx = 0, running = 0, MAX = 3;
    function next() {
      while (running < MAX && idx < jobs.length) {
        var jb = jobs[idx++]; running++;
        (function (jb) {
          getBuf('/api/read?c=' + encodeURIComponent(jb.course) + '&f=' + encodeURIComponent(jb.name))
            .then(function (buf) { return toText(jb.name, buf); })
            .then(function (text) {
              var r = P.parse(text);
              S.data.catalog[jb.key] = { ticks: jb.ticks, total: r.questions.length, byType: r.stats.byType };
            })
            .catch(function () { S.data.catalog[jb.key] = { ticks: jb.ticks, total: 0, byType: {}, err: 1 }; })
            .then(function () {
              running--; S.catalogBusy--;
              save();
              // 只在「看得见统计数字」的页面上重绘，免得打断用户正在输入的表单
              if (S.screen === 'home' || S.screen === 'records' || S.screen === 'course') render();
              if (S.catalogBusy <= 0) { S.catalogBusy = 0; save(true); render(); }
              next();
            });
        })(jb);
      }
    }
    next();
  }

  /* ================= 打开试卷 / 练习 ================= */
  function openPaper(course, name, mode) {
    S.screen = 'loading'; render();
    return getBuf('/api/read?c=' + encodeURIComponent(course) + '&f=' + encodeURIComponent(name))
      .then(function (buf) { return toText(name, buf); })
      .then(function (text) {
        var r = P.parse(text);
        S.course = course; S.paper = name;
        S.questions = r.questions; S.stats = r.stats; S.warnings = r.warnings;
        if (!S.data.catalog[course + '/' + name]) {
          var ticks = 0, c = findCourse(course);
          if (c) for (var i = 0; i < c.papers.length; i++) if (c.papers[i].name === name) ticks = c.papers[i].ticks;
          S.data.catalog[course + '/' + name] = { ticks: ticks, total: r.questions.length, byType: r.stats.byType };
          save();
        }
        startPractice(mode || 'order');
      })
      .catch(function (e) { S.screen = 'course'; render(); toast('打开失败：' + e.message); });
  }

  function startPractice(mode) {
    var n = S.questions.length;
    if (!n) { toast('这张试卷里没有解析出题目'); return; }
    var idx = [], i;
    for (i = 0; i < n; i++) idx.push(i);
    if (mode === 'random') {
      for (i = idx.length - 1; i > 0; i--) { var k = Math.floor(Math.random() * (i + 1)), t = idx[i]; idx[i] = idx[k]; idx[k] = t; }
    } else if (mode === 'wrong') {
      var w = curWrong();
      idx = idx.filter(function (x) { return w[qkey(S.questions[x])]; });
      if (!idx.length) { toast('这张试卷没有错题'); return; }
    } else if (mode === 'star') {
      var p = curPaper();
      idx = idx.filter(function (x) { return p.starred[qkey(S.questions[x])]; });
      if (!idx.length) { toast('这张试卷还没有收藏的题'); return; }
    }
    S.order = idx; S.index = 0; S.mode = mode; S.screen = 'practice';
    curPaper().submitted = false;
    syncIndex(); render();
  }
  function curQ() { return S.questions[S.order[S.index]]; }
  function syncIndex() { curPaper().index = S.index; save(); }
  function goto(i) {
    if (i < 0 || i >= S.order.length) return;
    S.index = i; syncIndex(); render();
    var b = $('.body'); if (b) b.scrollTop = 0;
  }
  function jumpToQuestion(qi) {
    if (qi < 0 || qi >= S.questions.length) return;
    var p = S.order.indexOf(qi);
    if (p < 0) { S.order = S.questions.map(function (_, i) { return i; }); S.mode = 'order'; p = qi; }
    S.screen = 'practice'; goto(p);
  }

  function recordChoice(q, letter) {
    var pp = curPaper(), k = qkey(q);
    if (pp.revealed[k]) return;
    if (q.type === 'multi') {
      var arr = letters(pp.answers[k] || '').split('');
      var pos = arr.indexOf(letter);
      if (pos >= 0) arr.splice(pos, 1); else arr.push(letter);
      arr.sort(); pp.answers[k] = arr.join('');
      save(); render();
    } else {
      pp.answers[k] = letter; pp.revealed[k] = true;
      pp.result[k] = grade(q); markWrong(q); save(); render();
    }
  }
  function submitMulti(q) {
    var pp = curPaper(), k = qkey(q);
    if (!pp.answers[k]) { toast('先选一个或多个选项'); return; }
    pp.revealed[k] = true; pp.result[k] = grade(q); markWrong(q); save(); render();
  }
  function reveal(q) { curPaper().revealed[qkey(q)] = true; save(); render(); }
  function selfGrade(q, ok) {
    var pp = curPaper(), k = qkey(q);
    pp.self[k] = ok; pp.revealed[k] = true; pp.result[k] = ok; markWrong(q); save(); render();
  }
  function markWrong(q) {
    var w = curWrong(), k = qkey(q);
    if (curPaper().result[k] === false) w[k] = true; else delete w[k];
  }
  function toggleStar(q) {
    var pp = curPaper(), k = qkey(q);
    if (pp.starred[k]) delete pp.starred[k]; else pp.starred[k] = true;
    save(); render();
  }
  function submitAll() { curPaper().submitted = true; save(true); S.screen = 'report'; render(); }

  /* ================= 渲染骨架 ================= */
  function render() {
    var app = $('#app');
    if (S.screen === 'loading') { app.innerHTML = '<div class="loading">正在读取…</div>'; return; }

    var inCourse = (S.screen === 'course' || S.screen === 'practice' || S.screen === 'toc' || S.screen === 'report');
    var side = inCourse ? courseNavHtml() : globalNavHtml();
    var main = '';
    if (S.screen === 'home') main = viewHome();
    else if (S.screen === 'import') main = viewImport();
    else if (S.screen === 'export') main = viewExport();
    else if (S.screen === 'records') main = viewRecordsGlobal();
    else if (S.screen === 'settings') main = viewSettingsGlobal();
    else if (S.screen === 'help') main = viewHelp();
    else if (S.screen === 'course') main = viewCourse();
    else if (S.screen === 'practice') main = viewPractice();
    else if (S.screen === 'toc') main = viewToc();
    else if (S.screen === 'report') main = viewReport();

    app.innerHTML = '<div class="topbar">' + topbarHtml() + '</div>' +
      '<div class="shell"><div class="side">' + side + '</div><div class="main">' + main + '</div></div>';
  }

  function topbarHtml() {
    var showBack = S.screen !== 'home';
    var crumb = '';
    if (S.screen === 'home' || S.screen === 'import' || S.screen === 'export' ||
        S.screen === 'records' || S.screen === 'settings' || S.screen === 'help') {
      crumb = '<b>题库</b>';
    } else {
      crumb = '<b>' + esc(courseName(S.course)) + '</b>';
      if (S.paper) crumb += '<i>›</i>' + esc(S.paper);
    }
    var meta = '';
    if (S.catalogBusy > 0) meta = '正在统计题库…剩余 <b>' + S.catalogBusy + '</b> 张';
    else if (S.screen === 'practice') meta = '第 <b>' + (S.index + 1) + '</b> / ' + S.order.length + ' 题';
    return (showBack ? '<button class="back" data-act="back">← 返回</button>' : '') +
      '<div class="crumb">' + crumb + '</div><div class="meta">' + meta + '</div>';
  }

  function navItem(act, ico, label, count, hot) {
    var on = '';
    return '<button class="navitem" data-act="' + act + '"><span class="ico">' + ico + '</span>' + label +
      (count != null && count !== '' ? '<span class="cnt' + (hot ? ' hot' : '') + '">' + count + '</span>' : '') + '</button>';
  }
  function globalNavHtml() {
    var g = globalStats();
    function on(scr) { return S.screen === scr ? ' on' : ''; }
    return '<div class="brand">📚 题库 <small>本地刷题</small></div><div class="nav">' +
      '<button class="navitem' + on('home') + '" data-act="nav" data-v="home"><span class="ico">📖</span>题库列表<span class="cnt">' + g.courses + '</span></button>' +
      '<button class="navitem' + on('import') + '" data-act="nav" data-v="import"><span class="ico">📥</span>导入文件</button>' +
      '<button class="navitem' + on('export') + '" data-act="nav" data-v="export"><span class="ico">📤</span>导出文件</button>' +
      '<button class="navitem' + on('records') + '" data-act="nav" data-v="records"><span class="ico">📊</span>学习记录</button>' +
      '<button class="navitem' + on('settings') + '" data-act="nav" data-v="settings"><span class="ico">⚙️</span>设置</button>' +
      '<button class="navitem' + on('help') + '" data-act="nav" data-v="help"><span class="ico">❓</span>使用说明</button>' +
      '</div><div class="sep"></div><div class="nav">' +
      '<button class="navitem" data-act="refresh"><span class="ico">🔄</span>刷新题库</button>' +
      '</div>' +
      '<div class="sidenote">题库文件夹<br>' + esc(S.bankDir || '题库') + '</div>';
  }
  function courseNavHtml() {
    function on(t) { return (S.screen === 'course' && S.tab === t) ? ' on' : ''; }
    var wc = wrongCount(S.course), sc = starCount(S.course);
    return '<div class="brand" style="font-size:15px">📘 ' + esc(courseName(S.course)) + '</div><div class="nav">' +
      '<button class="navitem" data-act="backtocourses"><span class="ico">↩︎</span>返回题库列表</button>' +
      '</div><div class="sep"></div><div class="nav">' +
      '<button class="navitem' + on('practice') + '" data-act="tab" data-v="practice"><span class="ico">📝</span>练习模式</button>' +
      '<button class="navitem' + on('mock') + '" data-act="tab" data-v="mock"><span class="ico">🎯</span>真题模拟</button>' +
      '<button class="navitem' + on('wrong') + '" data-act="tab" data-v="wrong"><span class="ico">❌</span>只练错题' +
        (wc ? '<span class="cnt hot">' + wc + '</span>' : '') + '</button>' +
      '<button class="navitem' + on('star') + '" data-act="tab" data-v="star"><span class="ico">⭐</span>收藏题目' +
        (sc ? '<span class="cnt">' + sc + '</span>' : '') + '</button>' +
      '<button class="navitem' + on('records') + '" data-act="tab" data-v="records"><span class="ico">📊</span>学习记录</button>' +
      '<button class="navitem' + on('settings') + '" data-act="tab" data-v="settings"><span class="ico">⚙️</span>本课设置</button>' +
      '</div>';
  }

  /* ================= 视图：题库列表 ================= */
  function viewHome() {
    var h = '<div class="body"><div class="wrap">';
    h += '<div class="pagehead"><h2>题库列表</h2><span class="sub">' +
      (S.catalogBusy > 0 ? '正在统计题目…' : '共 ' + S.courses.length + ' 门课程') + '</span></div>';
    h += '<div class="hint">一门课 = 题库文件夹里的一个子文件夹。点课程进入 → 再选试卷开始练习。</div>';

    if (!S.courses.length) {
      h += '<div class="empty"><div class="big">📂</div>' +
        '<p>题库文件夹还是空的</p>' +
        '<p style="font-size:13px">位置：<code>' + esc(S.bankDir || '题库') + '</code></p>' +
        '<div class="btnrow center" style="margin-top:18px">' +
        '<button class="btn primary" data-act="nav" data-v="import">去导入文件</button></div></div>';
    } else {
      h += '<div class="cards">';
      for (var i = 0; i < S.courses.length; i++) {
        var c = S.courses[i], cs = courseStats(c.key);
        var cov = 'c' + ((i % 6) + 1);
        var letter = courseName(c.key).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').charAt(0) || '课';
        h += '<div class="card" data-act="opencourse" data-key="' + esc(c.key) + '">' +
          '<div class="cover ' + cov + '">' + esc(letter) + '</div>' +
          '<div class="info"><div class="title">' + esc(courseName(c.key)) + '</div>' +
          '<div class="desc">' + cs.papers + ' 张试卷<em style="font-style:normal;color:#c3ccd6"> · </em>' +
          '共 <b>' + cs.total + '</b> 题' +
          (cs.done ? '<em style="font-style:normal;color:#c3ccd6"> · </em>已做 ' + f1(cs.done) + ' 题' +
            '<em style="font-style:normal;color:#c3ccd6"> · </em>正确率 <b>' + cs.acc.toFixed(1) + '%</b>' : '') +
          '</div>' +
          (cs.total ? '<div class="bar' + (cs.complete >= 100 ? ' done' : '') + '"><i style="width:' + Math.min(100, cs.complete).toFixed(1) + '%"></i></div>' : '') +
          '</div><div class="go">进入 ›</div></div>';
      }
      h += '</div>';
    }
    h += '</div></div>';
    return h;
  }

  /* ================= 视图：课程页 ================= */
  function viewCourse() {
    var c = findCourse(S.course);
    if (!c) { S.screen = 'home'; return viewHome(); }
    var t = S.tab;
    var h = '<div class="body"><div class="wrap">';

    if (t === 'records') return viewRecordsCourse();

    if (t === 'settings') {
      h += '<div class="pagehead"><h2>本课设置</h2></div>';
      h += '<div class="hint">这里改的是**显示名称**，不会动文件夹名（更安全，随时能改回来）。</div>';
      h += '<div class="field"><label>课程显示名称</label>' +
        '<input type="text" id="cname" value="' + esc(courseName(c.key)) + '" maxlength="40">' +
        '<div class="hint2">对应的文件夹：<code>' + esc(c.key || '(根目录)') + '</code></div></div>';
      h += '<div class="btnrow"><button class="btn primary" data-act="renamecourse" data-key="' + esc(c.key) + '">保存名称</button>' +
        '<button class="btn ghost" data-act="resetcourse" data-key="' + esc(c.key) + '">恢复成文件夹名</button></div>';
      h += '<div class="divider">危险操作</div>';
      h += '<div class="btnrow"><button class="btn danger" data-act="resetcourseprogress" data-key="' + esc(c.key) + '">清空本课全部答题记录</button></div>';
      h += '<div class="hint" style="margin-top:10px">只清记录，不删题目文件。</div>';
      h += '</div></div>';
      return h;
    }

    var modeOf = { practice: 'order', mock: 'random', wrong: 'wrong', star: 'star' };
    var titleOf = { practice: '练习模式', mock: '真题模拟', wrong: '只练错题', star: '收藏题目' };
    var subOf = {
      practice: '顺序做完整张试卷，做完自动判分',
      mock: '打乱题目顺序，模拟真实考试',
      wrong: '只做做错过的题，反复攻克',
      star: '只做你星标收藏的题'
    };
    h += '<div class="pagehead"><h2>' + titleOf[t] + '</h2><span class="sub">' + esc(courseName(c.key)) + '</span></div>';
    h += '<div class="hint">' + subOf[t] + '　—— 点下面的试卷开始。</div>';

    var list = [];
    for (var i = 0; i < c.papers.length; i++) {
      var p = c.papers[i], key = c.key + '/' + p.name, st = paperStats(key);
      if (t === 'wrong' && !wrongCount2(key)) continue;
      if (t === 'star' && !starCount2(key)) continue;
      list.push({ p: p, key: key, st: st });
    }
    if (!list.length) {
      h += '<div class="empty"><div class="big">' + (t === 'wrong' ? '🎉' : '📄') + '</div><p>' +
        (t === 'wrong' ? '这门课还没有错题' : t === 'star' ? '还没有收藏的题目' : '这门课还没有试卷') + '</p>' +
        (c.papers.length ? '' : '<p style="font-size:13px">去「导入文件」加试卷</p>') + '</div>';
      h += '</div></div>';
      return h;
    }

    h += '<div class="cards">';
    for (var j = 0; j < list.length; j++) {
      var it = list[j], st2 = it.st;
      var dotCls = st2.total && st2.done >= st2.total ? ' full' : (st2.done > 0 ? ' part' : '');
      var tag = t === 'mock' ? '【真题模拟】' : t === 'wrong' ? '【错题】' : t === 'star' ? '【收藏】' : '【练习模式】';
      h += '<div class="paper">' +
        '<div class="dot' + dotCls + '"></div>' +
        '<div class="pinfo">' +
        '<div class="pname"><span class="tagm">' + tag + '</span>' + esc(it.p.name) + '</div>' +
        metaLine(st2) +
        '<div class="bar' + (st2.complete >= 100 ? ' done' : '') + '"><i style="width:' + Math.min(100, st2.complete).toFixed(1) + '%"></i></div>' +
        '</div>' +
        '<div class="pacts">' +
        '<button class="btn sm primary" data-act="openpaper" data-c="' + esc(c.key) + '" data-f="' + esc(it.p.name) + '" data-m="' + modeOf[t] + '">开始</button>' +
        '<button class="btn sm" data-act="openpaper" data-c="' + esc(c.key) + '" data-f="' + esc(it.p.name) + '" data-m="order">从头</button>' +
        '</div></div>';
    }
    h += '</div>';
    h += '</div></div>';
    return h;
  }
  function wrongCount2(key) { return Object.keys(S.data.wrong[key] || {}).length; }
  function starCount2(key) { return Object.keys((S.data.papers[key] || {}).starred || {}).length; }

  // 试卷行里那串指标；解析不出题目时给个明确提示，别让人对着「总 0 题」发懵
  function metaLine(st) {
    if (!st.total) return '<div class="pmeta"><span style="color:#e67e22">⚠️ 没能解析出题目 —— 检查一下文件格式（见「使用说明」）</span></div>';
    return '<div class="pmeta">总 ' + st.total + ' 题<em>|</em>已做 ' + f1(st.done) + ' 题<em>|</em>完成率 ' +
      st.complete.toFixed(1) + '%<em>|</em><span style="color:#27ae60">答对 ' + f1(st.right) + '</span><em>|</em>' +
      '<span style="color:#e74c3c">做错 ' + f1(st.wrong) + '</span><em>|</em>正确率 ' + st.acc.toFixed(2) + '%</div>';
  }

  /* ================= 视图：学习记录 ================= */
  function statCard(v, k, cls) { return '<div class="stat"><div class="v ' + (cls || '') + '">' + v + '</div><div class="k">' + k + '</div></div>'; }

  function viewRecordsGlobal() {
    var g = globalStats();
    var h = '<div class="body"><div class="wrap">';
    h += '<div class="pagehead"><h2>学习记录</h2><span class="sub">全部课程汇总</span></div>';
    h += '<div class="statgrid">' +
      statCard('总 ' + g.total + ' 题', '题库总量') +
      statCard('已做 ' + f1(g.done) + ' 题', '完成进度') +
      statCard(g.complete.toFixed(1) + '%', '完成率', 'gray') +
      statCard('答对 ' + f1(g.right), '答对', 'green') +
      statCard('做错 ' + f1(g.wrong), '做错', 'red') +
      statCard(g.acc.toFixed(2) + '%', '正确率') +
      '</div>';
    h += '<div class="hint">正确率 = 答对 ÷ 已做　·　完成率 = 已做 ÷ 总题数</div>';

    if (!S.courses.length) { h += '<div class="empty"><div class="big">📊</div><p>还没有题库</p></div></div></div>'; return h; }

    h += '<div class="divider">按课程</div><div class="cards">';
    for (var i = 0; i < S.courses.length; i++) {
      var c = S.courses[i], cs = courseStats(c.key);
      h += '<div class="card" data-act="opencourse" data-key="' + esc(c.key) + '" data-tab="records">' +
        '<div class="cover c' + ((i % 6) + 1) + '">' + esc(courseName(c.key).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').charAt(0) || '课') + '</div>' +
        '<div class="info"><div class="title">' + esc(courseName(c.key)) + '</div>' +
        '<div class="statline"><span>总 <b>' + cs.total + '</b> 题</span><span>已做 <b>' + f1(cs.done) + '</b> 题</span>' +
        '<span>完成率 <b>' + cs.complete.toFixed(1) + '%</b></span>' +
        '<span class="ok">答对 <b>' + f1(cs.right) + '</b></span><span class="no">做错 <b>' + f1(cs.wrong) + '</b></span>' +
        '<span>正确率 <b>' + cs.acc.toFixed(2) + '%</b></span></div>' +
        '<div class="bar' + (cs.complete >= 100 ? ' done' : '') + '"><i style="width:' + Math.min(100, cs.complete).toFixed(1) + '%"></i></div>' +
        '</div><div class="go">明细 ›</div></div>';
    }
    h += '</div></div></div>';
    return h;
  }

  function viewRecordsCourse() {
    var c = findCourse(S.course);
    var cs = courseStats(S.course);
    var h = '<div class="body"><div class="wrap">';
    h += '<div class="pagehead"><h2>学习记录</h2><span class="sub">' + esc(courseName(S.course)) + '</span></div>';
    h += '<div class="statgrid">' +
      statCard('总 ' + cs.total + ' 题', '本课题量') +
      statCard('已做 ' + f1(cs.done) + ' 题', '完成进度') +
      statCard(cs.complete.toFixed(1) + '%', '完成率', 'gray') +
      statCard('答对 ' + f1(cs.right), '答对', 'green') +
      statCard('做错 ' + f1(cs.wrong), '做错', 'red') +
      statCard(cs.acc.toFixed(2) + '%', '正确率') +
      '</div>';
    h += '<div class="divider">按试卷 / 章节</div>';
    if (!c || !c.papers.length) { h += '<div class="empty"><p>这门课还没有试卷</p></div></div></div>'; return h; }

    h += '<div class="cards">';
    for (var i = 0; i < c.papers.length; i++) {
      var p = c.papers[i], key = S.course + '/' + p.name, st = paperStats(key);
      var dotCls = st.total && st.done >= st.total ? ' full' : (st.done > 0 ? ' part' : '');
      h += '<div class="paper"><div class="dot' + dotCls + '"></div><div class="pinfo">' +
        '<div class="pname">' + esc(p.name) + '</div>' +
        metaLine(st) +
        '<div class="bar' + (st.complete >= 100 ? ' done' : '') + '"><i style="width:' + Math.min(100, st.complete).toFixed(1) + '%"></i></div>' +
        '</div><div class="pacts">' +
        '<button class="btn sm" data-act="openpaper" data-c="' + esc(S.course) + '" data-f="' + esc(p.name) + '" data-m="order">开始</button>' +
        (st.wrong ? '<button class="btn sm" data-act="openpaper" data-c="' + esc(S.course) + '" data-f="' + esc(p.name) + '" data-m="wrong">错题 ' + st.wrong + '</button>' : '') +
        '</div></div>';
    }
    h += '</div></div></div>';
    return h;
  }

  /* ================= 视图：导入 / 导出 ================= */
  function viewImport() {
    var h = '<div class="body"><div class="wrap">';
    h += '<div class="pagehead"><h2>导入文件</h2><span class="sub">支持 .txt / .docx / .md</span></div>';
    h += '<div class="hint">选一门课程（或新建一门），把题目文件拖进来 / 选进来。文件会**复制**进题库文件夹，原文件不动。</div>';
    h += '<div class="field"><label>导入到哪门课程</label>' +
      '<select id="impcourse" class="sel">' +
      '<option value="__new__">＋ 新建课程…</option>';
    for (var i = 0; i < S.courses.length; i++)
      h += '<option value="' + esc(S.courses[i].key) + '">' + esc(courseName(S.courses[i].key)) + '</option>';
    h += '</select><div class="hint2">选「新建课程」会先建一个文件夹</div></div>';
    h += '<div class="field" id="newcoursewrap"><label>新课程名称</label>' +
      '<input type="text" id="newcoursename" placeholder="例如：人力资源管理（本科）" maxlength="40">' +
      '<div class="hint2">会成为题库文件夹下的一个子文件夹</div></div>';
    h += '<div class="dropzone" id="dz" data-act="pickfile"><span class="big">📥</span>' +
      '<b>把文件拖到这里</b>，或 <span style="color:#16a085;text-decoration:underline">点击选择文件</span><br>' +
      '<span style="font-size:12.5px">可一次选多个　·　.txt / .docx / .md　·　.doc 老格式不支持</span></div>';
    h += '<input type="file" id="pick" multiple accept=".txt,.docx,.md" style="display:none">';
    h += '<div class="tips"><b>题目文件怎么写？</b><br>' +
      '看「使用说明」里的格式说明，或直接参考题库里的<b>示例课程</b>。<br>' +
      '两种写法都行：① 试卷格式（题号 + ABCD + <code>答案：</code> + <code>解析：</code>）② 问答清单格式（<code>Q1 题干</code> + 答案段落）。</div>';
    h += '</div></div>';
    return h;
  }

  function viewExport() {
    var h = '<div class="body"><div class="wrap">';
    h += '<div class="pagehead"><h2>导出文件</h2><span class="sub">把题库文件下载出来</span></div>';
    h += '<div class="hint">导出的就是原始题目文件（不是答题记录）。可以用来备份、或发给别人。</div>';
    if (!S.courses.length) { h += '<div class="empty"><div class="big">📤</div><p>还没有题库</p></div></div></div>'; return h; }
    h += '<div class="btnrow" style="margin-bottom:18px">' +
      '<button class="btn" data-act="exportall">⬇ 全部导出（逐个下载）</button>' +
      '<button class="btn ghost" data-act="exportstate">⬇ 导出答题记录 (state.json)</button></div>';
    for (var i = 0; i < S.courses.length; i++) {
      var c = S.courses[i];
      h += '<div class="divider">' + esc(courseName(c.key)) + '（' + c.papers.length + ' 张）</div>';
      if (!c.papers.length) { h += '<div class="hint">（空课程）</div>'; continue; }
      h += '<div class="cards">';
      for (var j = 0; j < c.papers.length; j++) {
        var p = c.papers[j];
        h += '<div class="paper"><div class="dot"></div><div class="pinfo">' +
          '<div class="pname">' + esc(p.name) + '</div>' +
          '<div class="pmeta">' + (p.size / 1024).toFixed(1) + ' KB<em>|</em>' + esc(p.mtime) + '</div></div>' +
          '<div class="pacts"><button class="btn sm" data-act="dl" data-c="' + esc(c.key) + '" data-f="' + esc(p.name) + '">下载</button></div></div>';
      }
      h += '</div>';
    }
    h += '</div></div>';
    return h;
  }

  /* ================= 视图：设置 ================= */
  function viewSettingsGlobal() {
    var h = '<div class="body"><div class="wrap">';
    h += '<div class="pagehead"><h2>设置</h2></div>';
    h += '<div class="divider">题库根目录</div>';
    h += '<div class="hint">默认读程序目录下的 <code>题库</code> 文件夹。可以改成<b>任意文件夹</b> —— 比如让学习助手把题目写在自己的目录里，这里直接指过去，<b>不用来回拷文件</b>。<br>' +
      '约定：<b>里面每个子文件夹 = 一门课</b>；直接放在根目录下的文件归「未分类」。</div>';
    h += '<div class="field" style="margin-bottom:10px"><label>当前目录</label>' +
      '<input type="text" id="bankdir" value="' + esc(S.bankDir) + '" style="max-width:640px">' +
      '<div class="hint2">可以直接粘贴资源管理器地址栏里的路径</div></div>';
    h += '<div class="btnrow" style="margin-bottom:6px">' +
      '<button class="btn primary" data-act="setdir">保存并重新读取</button>' +
      '<button class="btn" data-act="pickdir">浏览文件夹…</button>' +
      '<button class="btn ghost" data-act="resetdir">恢复默认</button></div>';
    h += '<div class="divider">课程名称</div>';
    h += '<div class="hint">改的是**显示名称**，不会动文件夹名 —— 更安全，随时能改回来。<br>' +
      '要加课程，去「导入文件」里新建；要改文件夹本身，直接在资源管理器里改名即可。</div>';
    if (!S.courses.length) { h += '<div class="empty"><p>还没有课程</p></div>'; }
    else {
      h += '<div class="cards">';
      for (var i = 0; i < S.courses.length; i++) {
        var c = S.courses[i], name = courseName(c.key);
        h += '<div class="paper"><div class="dot"></div><div class="pinfo">' +
          '<div class="pname" style="margin-bottom:8px">' + esc(name) + '</div>' +
          '<div class="field" style="margin:0"><input type="text" class="cnameinput" data-key="' + esc(c.key) + '" value="' + esc(name) + '" maxlength="40"></div>' +
          '<div class="pmeta" style="margin-top:6px">文件夹：<code style="background:#eef1f5;padding:1px 5px;border-radius:3px">' + esc(c.key || '(根目录)') + '</code>' +
          '<em>|</em>' + c.papers.length + ' 张试卷</div></div>' +
          '<div class="pacts"><button class="btn sm primary" data-act="renamecourse" data-key="' + esc(c.key) + '">保存</button></div></div>';
      }
      h += '</div>';
      h += '<div class="btnrow" style="margin-top:16px"><button class="btn primary" data-act="saveallnames">保存全部名称</button></div>';
    }
    h += '<div class="divider">数据</div>';
    h += '<div class="btnrow"><button class="btn ghost" data-act="exportstate">导出答题记录</button>' +
      '<button class="btn danger" data-act="resetall">清空全部答题记录</button></div>';
    h += '<div class="hint" style="margin-top:10px">记录存在 <code>' + esc(S.bankDir.replace(/题库$/, '进度')) + '\\state.json</code>，删掉等于重置。</div>';
    h += '</div></div>';
    return h;
  }

  /* ================= 视图：使用说明 ================= */
  function viewHelp() {
    var h = '<div class="body"><div class="wrap">';
    h += '<div class="pagehead"><h2>使用说明</h2></div>';
    h += '<div class="tips"><b>三步用起来</b><br>' +
      '1. 「导入文件」→ 选课程 → 把 .txt / .docx / .md 拖进去<br>' +
      '2. 「题库列表」→ 点课程 → 点「练习模式」里的试卷开始做<br>' +
      '3. 做错的自动进错题本，「学习记录」里看进度</div>';
    h += '<div class="divider">答题操作</div>';
    h += '<div class="cards"><div class="paper"><div class="pinfo" style="line-height:2.1;font-size:14px">' +
      '选项：鼠标点，或按 <kbd>1</kbd>–<kbd>8</kbd> / <kbd>A</kbd>–<kbd>H</kbd><br>' +
      '翻页：底栏按钮，或 <kbd>←</kbd> <kbd>→</kbd><br>' +
      '看答案：<kbd>空格</kbd>　·　回首页：<kbd>Esc</kbd><br>' +
      '收藏本题：题干右上角的 ☆' +
      '</div></div></div>';
    h += '<div class="divider">题目文件怎么写</div>';
    h += '<div class="cards"><div class="paper"><div class="pinfo" style="line-height:2;font-size:14px">' +
      '<b>① 试卷格式（真题/模拟卷）</b><br>' +
      '<code>一、单项选择题</code> → <code>1.题干（ ）</code> → <code>A.甲</code> … → <code>答案：B</code> → <code>解析：…</code><br><br>' +
      '<b>② 问答清单格式（笔记/背诵清单）</b><br>' +
      '<code>### Q1 题干</code> → 下一段就是答案；<code>**题 1（…）**</code> → 正文并入题干<br><br>' +
      '<span style="color:#8695a4">大标题决定题型：<code>一、单项选择题</code> / <code>二、多选题</code> / <code>三、判断题</code> / <code>四、简答题</code> / <code>五、论述题</code> / <code>六、案例分析题</code></span>' +
      '</div></div></div>';
    h += '<div class="divider">出问题</div>';
    h += '<div class="cards"><div class="paper"><div class="pinfo" style="line-height:2;font-size:14px">' +
      '· <b>双击没反应</b> → 看 <code>进度\\启动日志.txt</code><br>' +
      '· <b>提示界面连不上本地服务</b> → 多半是安全软件拦了本地端口（程序只用 127.0.0.1）<br>' +
      '· <b>进度丢了</b> → <code>进度\\state.日期.bak.json</code> 是当天备份，改名覆盖回去<br>' +
      '· <b>.doc 打不开</b> → 在 Word 里另存为 .docx' +
      '</div></div></div>';
    h += '<div class="hint" style="margin-top:16px">题库位置：<code>' + esc(S.bankDir) + '</code>　·　不联网、不上传任何数据。</div>';
    h += '</div></div>';
    return h;
  }

  /* ================= 视图：答题 ================= */
  function viewPractice() {
    var q = curQ();
    if (!q) { S.screen = 'course'; return viewCourse(); }
    var n = S.order.length, pos = S.index + 1;
    var revealed = isRevealed(q), ua = userAns(q), opts = optionsOf(q);
    var modeTxt = S.mode === 'random' ? ' · 真题模拟' : S.mode === 'wrong' ? ' · 错题' : S.mode === 'star' ? ' · 收藏' : '';

    var h = '<div class="progress"><i style="width:' + (pos / n * 100).toFixed(1) + '%"></i></div>';
    h += '<div class="body"><div class="wrap">';
    h += '<div class="qhead"><span class="qtype ' + q.type + '">' + (P.TYPES[q.type] || '题目') + '</span>' +
      '<span class="qno">' + pos + ' / ' + n + modeTxt + '</span>' +
      (curWrong()[qkey(q)] ? '<span class="qno" style="color:#e74c3c">· 错题</span>' : '') +
      '<button class="starbtn' + (isStarred(q) ? ' on' : '') + '" data-act="star" title="收藏本题">' + (isStarred(q) ? '★' : '☆') + '</button></div>';
    h += '<div class="stem md">' + mdToHtml(q.stem) + '</div>';

    if (opts.length) {
      // 🔴 判断题的答案存的是「对 / 错」，不是选项字母 —— 必须换成 A/B，
      //    否则答完题「正确选项」不会标绿（踩过：判定是对的，但界面没高亮）
      var mine = letters(ua), right = answerLetters(q);
      h += '<div class="opts">';
      for (var i = 0; i < opts.length; i++) {
        var o = opts[i], cls = 'opt' + (q.type === 'multi' ? ' multi' : '');
        if (revealed) {
          cls += ' locked';
          if (right.indexOf(o.key) >= 0) cls += ' right';
          else if (mine.indexOf(o.key) >= 0) cls += ' wrong';
        } else if (mine.indexOf(o.key) >= 0) cls += ' picked';
        h += '<div class="' + cls + '" data-act="pick" data-key="' + o.key + '">' +
          '<div class="mark">' + o.key + '</div><div class="txt md">' + mdToHtml(o.text) + '</div></div>';
      }
      h += '</div>';
      if (q.type === 'multi' && !revealed)
        h += '<div class="btnrow" style="margin-top:16px"><button class="btn primary" data-act="submitmulti">提交本题</button>' +
          '<span class="qno">多选题：选完再提交</span></div>';
    } else {
      h += '<div class="selfbox"><textarea id="selfans" placeholder="在这里写你的答案（可选，写下来记得更牢）" ' +
        (revealed ? 'readonly' : '') + '>' + esc(ua) + '</textarea></div>';
      if (revealed) {
        var sg = curPaper().self[qkey(q)];
        h += '<div class="btnrow" style="margin-top:14px">' +
          '<button class="btn' + (sg === true ? ' primary' : '') + '" data-act="self" data-ok="1">✅ 我答对了</button>' +
          '<button class="btn' + (sg === false ? ' primary' : '') + '" data-act="self" data-ok="0">❌ 我答错了</button>' +
          '<span class="qno">主观题由你自己判分</span></div>';
      }
    }

    if (revealed) {
      var ok = isCorrect(q);
      if (opts.length) {
        if (ok === null) {
          // 🔴 只是按了「查看答案」、还没作答 —— 这时候说人家「答错了」是误导（踩过）
          h += '<div class="verdict" style="color:#8695a4"><span class="icon">👁</span>已查看答案（本题还没作答）</div>';
        } else {
          h += '<div class="verdict ' + (ok ? 'ok' : 'no') + '"><span class="icon">' + (ok ? '✅' : '❌') + '</span>' +
            (ok ? '答对了，正确答案为 ' + esc(q.answer) : '答错了，正确答案为 ' + esc(q.answer)) + '</div>';
        }
      } else if (ok !== null) {
        h += '<div class="verdict ' + (ok ? 'ok' : 'no') + '"><span class="icon">' + (ok ? '✅' : '❌') + '</span>' +
          (ok ? '已标记为答对' : '已标记为答错，已进错题本') + '</div>';
      }
      h += '<div class="answerbox">' +
        '<div class="lab">参考答案</div><div class="ans md">' +
        (q.answer ? mdToHtml(q.answer) : '<span style="color:#95a5a6">（原文件里没有答案）</span>') + '</div>' +
        (q.explain ? '<div class="lab exp">解析</div><div class="exp md">' + mdToHtml(q.explain) + '</div>' : '') +
        '</div>';
    }
    h += '</div></div>';
    h += '<div class="footbar">' +
      '<button class="btn" data-act="prev"' + (S.index === 0 ? ' disabled' : '') + '>上一题</button>' +
      '<button class="btn" data-act="next"' + (S.index >= n - 1 ? ' disabled' : '') + '>下一题</button>' +
      '<button class="btn" data-act="reveal"' + (revealed ? ' disabled' : '') + '>查看答案</button>' +
      '<button class="btn" data-act="toc">查看目录</button>' +
      '<button class="btn primary" data-act="submitall">交卷</button></div>';
    return h;
  }

  /* ================= 视图：目录 / 报告 ================= */
  function viewToc() {
    var total = S.questions.length, done = 0, right = 0, i, c;
    for (i = 0; i < total; i++) { c = isCorrect(S.questions[i]); if (c !== null) { done++; if (c) right++; } }
    var h = '<div class="progress"><i style="width:' + (total ? (done / total * 100).toFixed(1) : 0) + '%"></i></div>';
    h += '<div class="body"><div class="wrap">';
    h += '<div class="divider">题目目录</div>';
    h += '<div class="rate"><div class="lab">已答 ' + done + ' / ' + total + '　答对 ' + right + '</div></div>';
    h += '<div class="grid">';
    for (var j = 0; j < total; j++) {
      var q = S.questions[j], cc = isCorrect(q), cls = 'cell';
      if (cc === true) cls += isSubjective(q.type) ? ' self' : ' done';
      else if (cc === false) cls += ' bad';
      h += '<div class="' + cls + '" data-act="jump" data-qi="' + j + '">' + q.no + '</div>';
    }
    h += '</div><div class="tips">绿=答对　红=答错　紫=主观题自判答对　白=还没做</div>';
    h += '</div></div>';
    h += '<div class="footbar"><button class="btn primary" data-act="backpractice">回到答题</button>' +
      '<button class="btn" data-act="backcourse">返回课程</button></div>';
    return h;
  }

  function viewReport() {
    var total = S.questions.length, done = 0, right = 0, i;
    for (i = 0; i < total; i++) { var c = isCorrect(S.questions[i]); if (c !== null) { done++; if (c) right++; } }
    var st = paperStats(curKey());
    var h = '<div class="progress"><i style="width:' + (total ? (done / total * 100).toFixed(1) : 0) + '%"></i></div>';
    h += '<div class="body"><div class="wrap">';
    h += '<div class="divider">练题报告</div>';
    h += '<div class="rate"><div class="lab">正确率（' + right + ' / ' + total + '）</div>' +
      '<div class="num">' + (total ? (right / total * 100) : 0).toFixed(2) + '%</div>' +
      '<div class="sub">已答 ' + done + ' 题　答错 ' + st.wrong + ' 题　未答 ' + (total - done) + ' 题</div></div>';
    h += '<div class="grid">';
    for (var j = 0; j < total; j++) {
      var q = S.questions[j], cc = isCorrect(q), cls = 'cell';
      if (cc === true) cls += ' done'; else if (cc === false) cls += ' bad';
      h += '<div class="' + cls + '" data-act="jump" data-qi="' + j + '">' + q.no + '</div>';
    }
    h += '</div>';
    h += '<div class="btnrow center">' +
      (st.wrong ? '<button class="btn primary" data-act="start" data-m="wrong">只练这 ' + st.wrong + ' 道错题</button>' : '') +
      '<button class="btn" data-act="start" data-m="order">从头再练</button>' +
      '<button class="btn ghost" data-act="backhome">返回题库列表</button></div>';
    h += '</div></div>';
    return h;
  }

  /* ================= 事件 ================= */
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!t) return;
    var act = t.getAttribute('data-act');
    var q = (S.screen === 'practice' && S.order.length) ? curQ() : null;

    switch (act) {
      case 'nav':
        S.screen = t.getAttribute('data-v'); render(); break;
      case 'refresh': loadCourses(true); break;
      case 'pickfile': {
        // 🔴 v2 曾经漏掉这个分支 —— 按钮在、处理函数不在，点了没反应（用户报的 bug）
        var pk = $('#pick');
        if (pk) pk.click(); else toast('文件选择框没找到，请刷新页面');
        break;
      }
      case 'back':
        if (S.screen === 'practice' || S.screen === 'toc' || S.screen === 'report') { S.screen = 'course'; render(); }
        else if (S.screen === 'course') { S.screen = 'home'; render(); }
        else { S.screen = 'home'; render(); }
        break;
      case 'backhome': S.screen = 'home'; render(); break;
      case 'backcourse': S.screen = 'course'; render(); break;
      case 'backtocourses': S.screen = 'home'; render(); break;
      case 'tab': S.tab = t.getAttribute('data-v'); S.screen = 'course'; render(); break;
      case 'opencourse':
        S.course = t.getAttribute('data-key');
        S.tab = t.getAttribute('data-tab') || 'practice';
        S.screen = 'course'; S.paper = ''; render(); break;
      case 'openpaper':
        openPaper(t.getAttribute('data-c'), t.getAttribute('data-f'), t.getAttribute('data-m')); break;
      case 'start': startPractice(t.getAttribute('data-m')); break;
      case 'pick': if (q) recordChoice(q, t.getAttribute('data-key')); break;
      case 'submitmulti': if (q) submitMulti(q); break;
      case 'reveal': if (q) reveal(q); break;
      case 'self': if (q) selfGrade(q, t.getAttribute('data-ok') === '1'); break;
      case 'star': if (q) toggleStar(q); break;
      case 'prev': goto(S.index - 1); break;
      case 'next': goto(S.index + 1); break;
      case 'toc':
        if (!S.order.length) S.order = S.questions.map(function (_, i) { return i; });
        S.screen = 'toc'; render(); break;
      case 'submitall': submitAll(); break;
      case 'jump': jumpToQuestion(parseInt(t.getAttribute('data-qi'), 10)); break;

      case 'renamecourse':
        renameCourse(t.getAttribute('data-key') ||
          (t.closest('.paper') ? $('.cnameinput', t.closest('.paper')).getAttribute('data-key') : null)); break;
      case 'saveallnames': saveAllNames(); break;
      case 'resetcourse': {
        var k = t.getAttribute('data-key');
        delete S.data.settings.courses[k];
        save(true); render(); toast('已恢复成文件夹名'); break;
      }
      case 'resetcourseprogress':
        if (confirm('清空这门课全部答题记录和错题本？（题目文件不动）')) {
          var kk = t.getAttribute('data-key'), c2 = findCourse(kk);
          if (c2) for (var x = 0; x < c2.papers.length; x++) {
            delete S.data.papers[kk + '/' + c2.papers[x].name];
            delete S.data.wrong[kk + '/' + c2.papers[x].name];
          }
          save(true); render(); toast('已清空');
        }
        break;
      case 'resetall':
        if (confirm('清空全部课程的答题记录和错题本？（题目文件不动）')) {
          S.data.papers = {}; S.data.wrong = {};
          save(true); render(); toast('已清空全部记录');
        }
        break;
      case 'dl': download(t.getAttribute('data-c'), t.getAttribute('data-f')); break;
      case 'setdir': {
        var inp = $('#bankdir');
        var d = inp ? inp.value.trim() : '';
        if (!d) { toast('请先填目录路径'); break; }
        fetch('/api/setdir?d=' + encodeURIComponent(d), { method: 'POST' })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) {
            if (!res.ok || !res.j.ok) throw new Error((res.j && res.j.err) || '设置失败');
            toast('题库目录已切换');
            return loadCourses(false);
          })
          .catch(function (e) { toast('失败：' + e.message); });
        break;
      }
      case 'pickdir': {
        toast('正在打开文件夹选择框…');
        fetch('/api/pickdir', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (!j.ok || !j.dir) { toast('没有选择文件夹'); return null; }
            return fetch('/api/setdir?d=' + encodeURIComponent(j.dir), { method: 'POST' })
              .then(function () { toast('题库目录已切换'); return loadCourses(false); });
          })
          .catch(function (e) { toast('失败：' + e.message); });
        break;
      }
      case 'resetdir':
        fetch('/api/setdir?d=' + encodeURIComponent(S.defBankDir || ''), { method: 'POST' })
          .then(function () { toast('已恢复默认目录'); return loadCourses(false); })
          .catch(function (e) { toast('失败：' + e.message); });
        break;
      case 'exportall': exportAll(); break;
      case 'exportstate': exportState(); break;
    }
  });

  document.addEventListener('change', function (ev) {
    if (ev.target && ev.target.id === 'impcourse') {
      var w = $('#newcoursewrap');
      if (w) w.hidden = ev.target.value !== '__new__';
    }
    if (ev.target && ev.target.id === 'pick' && ev.target.files && ev.target.files.length) {
      doImport(ev.target.files);
      ev.target.value = '';
    }
  });

  /* 简答/论述的输入框：用事件委托保存内容。
     不能在下标里挂监听 —— render() 是整块 innerHTML 重建，一重绘就丢字。 */
  document.addEventListener('input', function (ev) {
    if (S.screen !== 'practice') return;
    if (!ev.target || ev.target.id !== 'selfans') return;
    var q = curQ(); if (!q) return;
    curPaper().answers[qkey(q)] = ev.target.value;
    save();
  });

  document.addEventListener('keydown', function (ev) {
    if (S.screen !== 'practice') return;
    if (ev.target && (ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'INPUT')) return;
    var q = curQ(); if (!q) return;
    var opts = optionsOf(q);
    if (ev.key === 'ArrowLeft') { goto(S.index - 1); ev.preventDefault(); return; }
    if (ev.key === 'ArrowRight') { goto(S.index + 1); ev.preventDefault(); return; }
    if (ev.key === ' ') { if (!isRevealed(q)) reveal(q); ev.preventDefault(); return; }
    if (ev.key === 'Escape') { S.screen = 'course'; render(); return; }
    if (opts.length && !isRevealed(q)) {
      var letter = null, m = /^([1-8])$/.exec(ev.key);
      if (m) { var n = parseInt(m[1], 10); if (n <= opts.length) letter = opts[n - 1].key; }
      else if (/^[a-hA-H]$/.test(ev.key)) {
        var up = ev.key.toUpperCase();
        for (var i = 0; i < opts.length; i++) if (opts[i].key === up) letter = up;
      }
      if (letter) { recordChoice(q, letter); ev.preventDefault(); }
    }
  });

  /* 拖拽导入 */
  document.addEventListener('dragover', function (ev) {
    var dz = $('#dz'); if (!dz) return;
    ev.preventDefault(); dz.classList.add('hot');
  });
  document.addEventListener('dragleave', function (ev) {
    var dz = $('#dz'); if (dz) dz.classList.remove('hot');
  });
  document.addEventListener('drop', function (ev) {
    var dz = $('#dz'); if (!dz) return;
    ev.preventDefault(); dz.classList.remove('hot');
    if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) doImport(ev.dataTransfer.files);
  });

  /* ================= 动作实现 ================= */
  function renameCourse(key) {
    if (key == null) return;
    var inp = $('.cnameinput[data-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]') || $('#cname');
    if (!inp) { toast('找不到输入框'); return; }
    var v = inp.value.trim();
    if (!v) { toast('名称不能为空'); return; }
    if (!S.data.settings.courses[key]) S.data.settings.courses[key] = {};
    S.data.settings.courses[key].name = v;
    save(true); render(); toast('已保存：' + v);
  }
  function saveAllNames() {
    var list = document.querySelectorAll('.cnameinput');
    for (var i = 0; i < list.length; i++) {
      var k = list[i].getAttribute('data-key'), v = list[i].value.trim();
      if (!v) continue;
      if (k === v) { if (S.data.settings.courses[k]) delete S.data.settings.courses[k].name; continue; }
      if (!S.data.settings.courses[k]) S.data.settings.courses[k] = {};
      S.data.settings.courses[k].name = v;
    }
    save(true); render(); toast('已保存全部名称');
  }
  function targetCourse() {
    var sel = $('#impcourse');
    if (!sel) return Promise.resolve(null);
    if (sel.value !== '__new__') return Promise.resolve(sel.value);
    var inp = $('#newcoursename');
    var name = (inp && inp.value.trim()) || '';
    if (!name) return Promise.reject(new Error('请填新课程名称'));
    return fetch('/api/mkdir?c=' + encodeURIComponent(name), { method: 'POST' })
      .then(function (r) { if (!r.ok) throw new Error('建课程失败'); return name; });
  }
  function doImport(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    targetCourse().then(function (course) {
      if (course == null) throw new Error('请选择导入到哪门课程');
      toast('正在导入 ' + files.length + ' 个文件…');
      var chain = Promise.resolve(), ok = 0, bad = [];
      files.forEach(function (f) {
        chain = chain.then(function () {
          return fetch('/api/upload?c=' + encodeURIComponent(course) + '&f=' + encodeURIComponent(f.name),
            { method: 'POST', body: f })
            .then(function (r) { if (!r.ok) throw new Error(f.name); ok++; })
            .catch(function () { bad.push(f.name); });
        });
      });
      return chain.then(function () {
        return loadCourses(false).then(function () {
          var c = findCourse(course);
          if (c) { S.course = course; S.tab = 'practice'; S.screen = 'course'; render(); }
          toast('导入完成：' + ok + ' 个成功' + (bad.length ? '，' + bad.length + ' 个失败' : ''));
        });
      });
    }).catch(function (e) { toast('导入失败：' + e.message); });
  }

  function download(course, name) {
    getBuf('/api/read?c=' + encodeURIComponent(course) + '&f=' + encodeURIComponent(name)).then(function (buf) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([buf]));
      a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    }).catch(function (e) { toast('下载失败：' + e.message); });
  }
  function exportAll() {
    var all = [];
    for (var i = 0; i < S.courses.length; i++)
      for (var j = 0; j < S.courses[i].papers.length; j++)
        all.push({ c: S.courses[i].key, f: S.courses[i].papers[j].name });
    if (!all.length) { toast('没有可导出的文件'); return; }
    toast('开始下载 ' + all.length + ' 个文件…');
    var i2 = 0;
    (function step() {
      if (i2 >= all.length) { toast('导出完成'); return; }
      var it = all[i2++];
      download(it.c, it.f);
      setTimeout(step, 600);
    })();
  }
  function exportState() {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(S.data, null, 2)], { type: 'application/json' }));
    a.download = 'state.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  /* ---------------- 心跳（决定 题库.exe 什么时候退出） ----------------
     页面活着 → 每 2 秒报到；关窗口 → 发告别信号，exe 立刻退出。
     这是唯一可靠的生命周期信号（Edge 的进程句柄会提前退出，不能靠它）。
     🔴 必须带本次启动的令牌：上一次会话残留的旧标签页被回收时也会发 pagehide，
        没有令牌的话会把新服务误杀（踩过这个坑）。 */
  function startHeartbeat() {
    var TOKEN = '';
    try { TOKEN = new URLSearchParams(location.search).get('t') || ''; } catch (e) { }
    if (!TOKEN) return;                       // 旧窗口 / 手动打开 → 不参与生命周期
    var q = '?t=' + encodeURIComponent(TOKEN);
    function beat() { fetch('/api/alive' + q, { cache: 'no-store' }).catch(function () { }); }
    beat();
    setInterval(beat, 2000);
    function bye() { try { navigator.sendBeacon('/api/bye' + q); } catch (e) { } }
    window.addEventListener('pagehide', bye);
    window.addEventListener('beforeunload', bye);
  }

  /* ================= 启动 ================= */
  function init() {
    startHeartbeat();
    getJSON('/api/state')
      .then(function (d) { S.data = migrate(d); })
      .catch(function () { S.data = blankData(); })
      .then(function () { return loadCourses(false); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
