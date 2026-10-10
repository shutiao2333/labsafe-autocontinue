#!/usr/bin/env node
/*
 * LabSafe userscript 回归测试（jsdom）
 *   node tests/test-labsafe.js labsafe.user.js [--keep]
 *
 * 设计要点：
 *  - fixture 里的弹窗结构与站点文案按平台真实形态写，空闲回调逐字取自站点线上 bundle
 *    （Vue 组件 data 的属性名压缩后仍保留，脚本正是靠它们做特征匹配）。
 *  - 注入脚本前先把 window.setTimeout/setInterval 包一层记录器：脚本 patch 时会快照
 *    当时的实现，所以"被拦截的定时器根本不会出现在记录里"是可断言的。
 *  - 另设对照组（不注入脚本）：同样的回调确实会被排程，避免把"其实没生效"测成通过。
 */
'use strict';

const fs = require('fs');
const { JSDOM } = require('jsdom');

const SCRIPT_PATH = process.argv[2] || 'labsafe.user.js';
const SCRIPT = fs.readFileSync(SCRIPT_PATH, 'utf8');

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (info !== undefined ? '   → ' + info : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 站点真实代码片段（逐字取自线上 bundle，压缩后属性名仍保留） ── */
const IDLE_STUDY = "function () { t.timer && clearInterval(t.timer), " +
  "t.outtimer = setInterval(function () { t.outTime--, t.outTime == 0 && (clearInterval(t.outtimer), t.$router.back()); }, 1000), " +
  "t.showNOoperated = !0 }";
const IDLE_OUTTIMER = "function () { t.outTime--, t.outTime == 0 && (clearInterval(t.outtimer), t.$router.back()) }";
const IDLE_EXAM = "function (t) { 5 <= (new Date().getTime() - t.lastAnswerTime) / 6e4 && (t.showextra = !0, t.outTimespace = 8) }";
const STUDY_TICK = "function () { window.__tick = (window.__tick || 0) + 1; /* study tick: t.timer2++ t.studyLength++ */ }";
const NOISE = "function () { window.__noise = (window.__noise || 0) + 1 }";  // 无关短延时
// 源码里带空闲特征、但调用时不做任何事：用来验证"延时不在 1min~60min 区间就不拦"
const MARKED_NOOP = "function () { /* showNOoperated outTime */ }";
// 同理：源码带考试页特征但调用时什么都不做（用来验证 blockIdleExam=false 时放行）
const EXAM_MARKED_NOOP = "function () { /* showextra isTimeOut */ }";

const PAGE_HTML = `
  <div id="app">
    <div id="chingo">
      <div class="positionRight">
        <div class="peopleName">同学</div>
        <div class="timeLayout">已用时<span class="alredyTime">00:12:34</span></div>
      </div>
    </div>
  </div>
  <div class="ivu-modal-wrap" id="idleWrap">
    <div class="ivu-modal" id="idleModal">
      <div class="ivu-modal-content">
        <div class="ivu-modal-body">你已经在此页面 5 分钟了，15秒后自动退出，是否继续!</div>
        <div class="ivu-modal-footer">
          <button class="ivu-btn ivu-btn-default"><span>取消</span></button>
          <button class="ivu-btn ivu-btn-primary" id="idleOk"><span>确定</span></button>
        </div>
      </div>
    </div>
  </div>
  <div class="ivu-modal-wrap" id="hiddenWrap" style="display:none">
    <div class="ivu-modal" id="hiddenModal">
      <div class="ivu-modal-content">
        <div class="ivu-modal-body">你已经在此页面 5 分钟了，15秒后自动退出，是否继续!</div>
        <div class="ivu-modal-footer"><button class="ivu-btn ivu-btn-primary" id="hiddenOk"><span>确定</span></button></div>
      </div>
    </div>
  </div>
  <div class="ivu-modal-wrap" id="decoyWrap">
    <div class="ivu-modal" id="decoyModal">
      <div class="ivu-modal-content">
        <div class="ivu-modal-body">系统繁忙，请稍后再试</div>
        <div class="ivu-modal-footer"><button class="ivu-btn ivu-btn-primary" id="decoyOk"><span>确定</span></button></div>
      </div>
    </div>
  </div>
  <button class="ivu-btn" id="resumeBtn">继续学习</button>
`;

/** 造一个页面；注入前包好定时器记录器 */
function makeDom(opts) {
  opts = opts || {};
  const dom = new JSDOM(`<!doctype html><html><head><meta charset="utf-8"><title>实验室安全教育平台</title></head>` +
    `<body>${opts.html || PAGE_HTML}</body></html>`, {
    url: opts.url || 'https://example.edu.cn/lab-study-front/security/safetyknowledgeDetial/167/4/0',
    runScripts: 'dangerously', pretendToBeVisual: true
  });
  const w = dom.window;
  const rec = { st: [], si: [] };
  const rawST = w.setTimeout.bind(w), rawSI = w.setInterval.bind(w);
  w.setTimeout = (fn, d, ...a) => { const id = rawST(fn, d, ...a); rec.st.push({ id: id, d: d, src: String(fn) }); return id; };
  w.setInterval = (fn, d, ...a) => { const id = rawSI(fn, d, ...a); rec.si.push({ id: id, d: d, src: String(fn) }); return id; };

  if (opts.firefoxSandbox) { w.unsafeWindow = w; }            // 模拟 Firefox 内容脚本沙箱
  const apiCalls = [];
  const vm = {                                                     // 站点 Vue 实例替身
    $el: w.document.querySelector('#chingo'),
    commonMethods: {
      emitAjax: function (o) {
        apiCalls.push(o);
        // 默认必须应答：不应答会让桥接一直 busy，后续测试全被跳过
        if (opts.onAjax) opts.onAjax(o, apiCalls.length);
        else o.error({ code: 500, message: '测试默认失败' });
      }
    }
  };
  if (vm.$el) vm.$el.__vue__ = vm;                                 // 夹具里没有 #chingo 时不挂（负例用）

  const clicks = [];                                        // 记录所有按钮点击（含脚本启动时自动点的）
  w.document.addEventListener('click', function (ev) {
    const t = ev.target && ev.target.closest ? ev.target.closest('button') : null;
    if (t) clicks.push((t.id || '?') + '|' + (t.textContent || '').trim());
  }, true);

  if (opts.inject !== false) {
    const s = w.document.createElement('script');
    s.textContent = opts.script || SCRIPT;
    w.document.body.appendChild(s);
    s.remove();
  }
  return { dom: dom, w: w, rec: rec, apiCalls: apiCalls, vm: vm, clicks: clicks,
           api: w.__labSafe, $: (sel) => w.document.querySelector(sel),
           rowText: () => { const el = w.document.querySelector('#labSafeRealRow .labSafeRealTime'); return el ? (el.textContent || '').trim() : null; } };
}

(async function main() {
  console.log('LabSafe 回归测试 · ' + SCRIPT_PATH + '\n');

  /* ═════ 1. 拦截空闲计时器 ═════ */
  console.log('【1】学习页：空闲退出计时器根本不排程');
  let X = makeDom();
  await sleep(80);
  const w = X.w;

  check('脚本已加载（window.__labSafe 存在）', !!X.api, typeof X.api);
  check('页面上下文 agent 已注入', w.__labSafeAgent === 'labsafe-agent-1', w.__labSafeAgent);

  const before = X.rec.st.length;
  const id1 = w.setTimeout(w.eval('(' + IDLE_STUDY + ')'), 60 * 5 * 1000);
  check('空闲 setTimeout(5分钟) 被拒（返回 0）', id1 === 0, 'id=' + id1);
  check('该回调没有进入真实排程队列', X.rec.st.length === before, '记录器条数 ' + X.rec.st.length);

  const idNoise = w.setTimeout(w.eval('(' + NOISE + ')'), 60 * 5 * 1000);
  check('无关的 5 分钟 setTimeout 正常排程', idNoise !== 0 && !!idNoise, 'id=' + idNoise);

  const idTick = w.setInterval(w.eval('(' + STUDY_TICK + ')'), 1000);
  check('站点自己的 1 秒学习秒表不受影响', idTick !== 0 && !!idTick, 'id=' + idTick);

  const idTickSrc = X.rec.si.findIndex((t) => /STUDY_TICK|t\.timer2/.test(t.src));
  check('秒表 interval 确实被真正排程了', idTickSrc >= 0);

  const idOut = w.setInterval(w.eval('(' + IDLE_OUTTIMER + ')'), 1000);
  check('空闲倒计时 interval（outtimer）也被拦', idOut === 0, 'id=' + idOut);

  const idShort = w.setTimeout(w.eval('(' + MARKED_NOOP + ')'), 3000);
  check('短延时不受影响（只拦 1min~60min 区间）', idShort !== 0 && !!idShort, 'id=' + idShort);

  /* ═════ 2. 考试页 ═════ */
  console.log('\n【2】考试/练习页：5 分钟未答题退出计时器（默认开启）');
  const idExamI = w.setInterval(w.eval('(' + IDLE_EXAM + ')'), 5000);
  check('考试页空闲探测 setInterval(5s) 被拦', idExamI === 0, 'id=' + idExamI);
  const idExamT = w.setTimeout(w.eval('(' + IDLE_EXAM + ')'), 60 * 5 * 1000);
  check('考试页空闲 setTimeout(5分钟) 被拦', idExamT === 0, 'id=' + idExamT);
  check('默认配置里考试页开关是开着的', X.api.CONFIG.blockIdleExam === true);

  const noExam = SCRIPT.replace(/blockIdleExam:\s*true/, 'blockIdleExam:  false');
  check('能造出"关闭考试页"的变体用于测试', noExam !== SCRIPT);
  const Y = makeDom({ script: noExam });
  await sleep(80);
  const idExamI2 = Y.w.setInterval(Y.w.eval('(' + EXAM_MARKED_NOOP + ')'), 5000);
  check('blockIdleExam=false 时考试页计时器放行', idExamI2 !== 0 && !!idExamI2, 'id=' + idExamI2);
  const idStudy2 = Y.w.setTimeout(Y.w.eval('(' + IDLE_STUDY + ')'), 300000);
  check('blockIdleExam=false 时学习页仍然被拦', idStudy2 === 0, 'id=' + idStudy2);

  /* ═════ 3. 对照组 ═════ */
  console.log('\n【3】对照组：不打补丁时该回调确实会排程');
  const Z = makeDom({ inject: false });
  await sleep(30);
  const idCtl = Z.w.setTimeout(Z.w.eval('(' + IDLE_STUDY + ')'), 300000);
  check('未打补丁：空闲 setTimeout 正常排程（弹窗会出现）', idCtl !== 0 && !!idCtl, 'id=' + idCtl);
  check('未打补丁：没有注入 agent', !Z.w.__labSafeAgent);

  /* ═════ 4. 弹窗兜底点击 ═════ */
  console.log('\n【4】兜底：弹窗出现时自动点「确定」');
  const clickedIds = () => X.clicks.map((c) => c.split('|')[0]);
  check('脚本启动时就点掉了可见的空闲弹窗', clickedIds().indexOf('idleOk') >= 0, JSON.stringify(X.clicks));
  check('隐藏的弹窗不被点（v-show display:none）', clickedIds().indexOf('hiddenOk') < 0);
  check('诱饵弹窗（系统繁忙）不被点', clickedIds().indexOf('decoyOk') < 0);
  const n4 = X.clicks.length;
  X.api.scanModals();
  check('同一弹窗 5 秒内不重复点', X.clicks.length === n4, 'clicks=' + X.clicks.length);

  // 动态插入的弹窗（MutationObserver 路径）
  const wrap = w.document.createElement('div');
  wrap.className = 'ivu-modal-wrap';
  wrap.innerHTML = '<div class="ivu-modal"><div class="ivu-modal-content">' +
    '<div class="ivu-modal-body">你已经在此页面 5 分钟了，8秒后自动退出，是否继续!</div>' +
    '<div class="ivu-modal-footer"><button class="ivu-btn ivu-btn-primary" id="dynOk"><span>继续学习</span></button></div></div></div>';
  w.document.body.appendChild(wrap);
  await sleep(60);                                   // 交给 MutationObserver + 1.2s 轮询
  X.api.scanModals();
  check('动态插入的弹窗也会被点（继续学习）', clickedIds().indexOf('dynOk') >= 0, JSON.stringify(X.clicks));

  /* ═════ 5. 秒表看门狗 ═════ */
  console.log('\n【5】兜底：学习秒表卡住 → 自动点「继续学习」');
  let resumeClicks = 0;
  w.document.getElementById('resumeBtn').addEventListener('click', () => resumeClicks++);
  let fakeNow = 1.7e12;
  const realNow = w.Date.now;
  w.Date.now = () => fakeNow;
  X.api.watchdog();
  fakeNow += 90 * 1000;                              // 秒表 90 秒没动（> watchdogSeconds=60）
  X.api.watchdog();
  check('秒表卡住后自动点了「继续学习」', resumeClicks === 1, 'clicks=' + resumeClicks);
  fakeNow += 90 * 1000;
  X.api.watchdog();
  check('5 分钟冷却期内不再重复点', resumeClicks === 1, 'clicks=' + resumeClicks);
  w.Date.now = realNow;

  /* ═════ 6. 右侧「实时已学」 ═════ */
  console.log('\n【6】右侧「实时已学」：行、取值、自愈');
  const P = makeDom();                                // 独立实例：只验证"自动建行 + 占位符"
  await sleep(60);
  P.api.ensureRow();
  const pRow = P.$('#labSafeRealRow');
  check('新行自动插到 .positionRight 里', !!pRow && P.$('.positionRight').contains(pRow));
  check('新行紧跟「已用时」那一行', pRow && pRow.previousElementSibling &&
    (pRow.previousElementSibling.className || '').indexOf('Dividing') >= 0,
    pRow && pRow.previousElementSibling && pRow.previousElementSibling.className);
  check('行标题是「实时已学」', pRow && /实时已学/.test(pRow.textContent));
  check('还没拿到值时是占位符 --:--:--', P.rowText() === '--:--:--', P.rowText());

  await sleep(1400);                                  // 主实例：让自身的 1s/1.2s 轮询跑一拍
  const row = X.$('#labSafeRealRow');
  check('主实例里也自动建好了行', !!row && X.$('.positionRight').contains(row));

  X.api.resetAttempts();                              // 从首选源重新开始
  X.vm.commonMethods.emitAjax = function (o) { X.apiCalls.push(o); o.success({ totalStudyLength: 3725 }); };
  X.api.fetchReal();
  await sleep(120);
  check('拿到服务器值 → 01:02:05', X.rowText() === '01:02:05', X.rowText());
  check('请求走的是当前数据源', X.apiCalls[X.apiCalls.length - 1].path === '/api/study_records/mine',
    X.apiCalls[X.apiCalls.length - 1].path);

  X.vm.commonMethods.emitAjax = function (o) { X.apiCalls.push(o); o.success({ data: { totalStudyLength: '120' } }); };
  X.api.fetchReal();
  await sleep(120);
  check('字符串数字 + 嵌套 data 也能解析（120 → 00:02:00）', X.rowText() === '00:02:00', X.rowText());

  X.$('#labSafeRealRow').remove();                   // 模拟被 Vue 重渲染抹掉
  X.api.ensureRow();
  check('行被抹掉后能自愈，且保留已取到的值', X.rowText() === '00:02:00', X.rowText());

  /* ═════ 7. 数据源链 ═════ */
  console.log('\n【7】数据源链与参数');
  X.api.resetAttempts();
  let seen = [];
  X.vm.commonMethods.emitAjax = function (o) { seen.push(o); o.error({ code: 500, message: '测试失败' }); };
  X.api.fetchReal();
  await sleep(60);
  const first = seen[0];
  check('首个数据源 = /api/study_records/mine', first && first.path === '/api/study_records/mine', first && first.path);
  check('参数 page=0 / size=10', first && first.data.page === 0 && first.data.size === 10, first && JSON.stringify(first.data));
  check('searchStart/searchEnd 是毫秒时间戳（不是 YYYY-MM-DD 字符串）',
    first && typeof first.data.searchStart === 'number' && typeof first.data.searchEnd === 'number',
    first && typeof first.data.searchStart + '/' + typeof first.data.searchEnd);
  check('区间方向正确：start < end', first && first.data.searchStart < first.data.searchEnd,
    first && (first.data.searchEnd - first.data.searchStart));
  check('起点是某天 00:00:00.000', first && new Date(first.data.searchStart).getHours() === 0 &&
    new Date(first.data.searchStart).getMinutes() === 0 && new Date(first.data.searchStart).getSeconds() === 0,
    first && new Date(first.data.searchStart).toString());
  check('终点是某天 23:59:59.999（含今天全天）', first && new Date(first.data.searchEnd).getHours() === 23 &&
    new Date(first.data.searchEnd).getMinutes() === 59 && new Date(first.data.searchEnd).getSeconds() === 59 &&
    new Date(first.data.searchEnd).getMilliseconds() === 999,
    first && new Date(first.data.searchEnd).toString());

  X.api.fetchReal();
  await sleep(60);
  check('该源失败后自动换到 /api/user_info', seen[1] && seen[1].path === '/api/user_info', seen[1] && seen[1].path);
  check('user_info 先按个人中心写法（不带 isNeedTotalStudyLength）',
    seen[1] && JSON.stringify(seen[1].data) === '{}', seen[1] && JSON.stringify(seen[1].data));

  // 字段为 null：先换源，别急着当 0
  X.api.resetAttempts();
  X.vm.commonMethods.emitAjax = function (o) { seen.push(o); o.success({ totalStudyLength: null, page: {} }); };
  X.api.fetchReal();
  await sleep(60);
  check('字段为 null 时不显示 00:00:00，先换源', X.rowText() !== '00:00:00', X.rowText());
  check('确实换到了下一个数据源', !/study_records/.test(X.api.currentSource()), X.api.currentSource());
  X.vm.commonMethods.emitAjax = function (o) { seen.push(o); o.error({ code: 500, message: 'x' }); };
  X.api.fetchReal(); await sleep(40);
  X.api.fetchReal(); await sleep(40);
  X.vm.commonMethods.emitAjax = function (o) { seen.push(o); o.success({ totalStudyLength: null, page: {} }); };
  X.api.fetchReal(); await sleep(40);
  X.api.fetchReal(); await sleep(40);
  X.api.fetchReal(); await sleep(60);
  check('所有数据源的字段都是 null 时才显示 00:00:00', X.rowText() === '00:00:00', X.rowText());

  // 备用源不能永久占位
  X.api.resetAttempts();
  const paths = [];
  X.vm.commonMethods.emitAjax = function (o) { paths.push(o.path); o.error({ code: 500, message: 'x' }); };
  X.api.fetchReal(); await sleep(30);
  X.api.fetchReal(); await sleep(30);
  for (let i = 0; i < 9; i++) { X.api.fetchReal(); await sleep(10); }
  check('退到备用源后会自动回头重试首选源',
    paths[0] === '/api/study_records/mine' && paths.slice(2).indexOf('/api/study_records/mine') > 0,
    JSON.stringify(paths.map((p) => p.replace('/api/', ''))));
  check('期间不会来回翻倍（首选源只试了 2 次）',
    paths.filter((p) => p === '/api/study_records/mine').length <= 3, 'study_records x' +
    paths.filter((p) => p === '/api/study_records/mine').length);

  /* ═════ 8. 日志面板 ═════ */
  console.log('\n【8】页面内日志面板（不用开控制台）');
  check('右下角按钮存在', !!X.$('#labSafeFab'));
  check('面板默认是收起的', X.$('#labSafePanel').style.display === 'none', X.$('#labSafePanel').style.display);
  X.api.togglePanel();
  check('点一下能展开', X.$('#labSafePanel').style.display !== 'none', X.$('#labSafePanel').style.display);
  X.api.selfCheck();
  const logTxt = X.$('#labSafeLog').textContent || '';
  check('自检输出 REALM / agent 状态', /自检/.test(logTxt) && /agent/.test(logTxt));
  check('自检输出 __vue__ 命中数与实例位置', /__vue__ 命中 \d+/.test(logTxt) && /可用实例在第/.test(logTxt));
  check('自检只列 localStorage 键名（不打印值）', /localStorage 键：/.test(logTxt));
  check('自检写明当前数据源与参数', /当前数据源：/.test(logTxt));
  check('自检会真发一次请求并打印原始返回', /服务器原始返回|发一次真实请求/.test(logTxt));
  X.api.copyLog();
  await sleep(30);
  check('没有剪贴板权限时退化为全选', /已全选|已复制/.test(X.api.LOGS.join('\n')));
  X.$('#labSafeClear').click();
  check('「清空」生效', /已清空/.test(X.$('#labSafeLog').textContent || ''));
  X.api.saveLog();
  check('「下载」成功或优雅失败（不抛异常）',
    /已下载到浏览器下载目录|下载失败/.test(X.api.LOGS.join('\n')));
  X.$('#labSafeFab').click();
  check('再点一次能收起面板', X.$('#labSafePanel').style.display === 'none', X.$('#labSafePanel').style.display);

  /* ═════ 9. Firefox 沙箱模拟 ═════ */
  console.log('\n【9】Firefox/Zen：unsafeWindow 存在的沙箱环境中同样有效');
  const F = makeDom({ firefoxSandbox: true, onAjax: (o) => o.success({ totalStudyLength: 4321 }) });
  await sleep(80);
  check('识别出沙箱世界并切到页面本体', /页面本体/.test(F.api.REALM), F.api.REALM);
  const fIdle = F.w.setTimeout(F.w.eval('(' + IDLE_STUDY + ')'), 300000);
  check('沙箱环境下空闲计时器仍被拦', fIdle === 0, 'id=' + fIdle);
  F.api.ensureRow();
  F.api.fetchReal();
  await sleep(120);
  check('沙箱环境下仍能经页面 agent 取到值（4321 → 01:12:01）', F.rowText() === '01:12:01', F.rowText());

  /* ═════ 10. 运行时门槛（@include 匹配放宽后的护栏） ═════ */
  console.log('\n【10】运行时门槛：不是本平台就什么都不做');
  const N = makeDom({ url: 'https://example.com/some/other/page', html: '<div id="nothing">nothing here</div>', inject: true });
  await sleep(150);
  check('非本平台页面：不注入 agent', !N.w.__labSafeAgent, String(N.w.__labSafeAgent));
  check('非本平台页面：不建日志面板', !N.$('#labSafeDock'));
  check('非本平台页面：不插右侧行', !N.$('#labSafeRealRow'));
  const noiseId = N.w.setTimeout(N.w.eval('(' + NOISE + ')'), 300000);
  check('非本平台页面：无关定时器照常', noiseId !== 0 && !!noiseId, 'id=' + noiseId);

  // 走学校 VPN 代理的地址（路径前面多一截）——正是 @include 放宽后要覆盖的场景
  const V = makeDom({ url: 'https://clientvpn.example.edu.cn/https/webvpn1a2b3c/lab-study-front/routine-exam/7?examRequestId=x',
                      onAjax: (o) => o.success({ totalStudyLength: 60 }) });
  await sleep(150);
  check('VPN 前缀地址：门槛通过并注入 agent', !!V.w.__labSafeAgent);
  check('VPN 前缀地址：面板建好了', !!V.$('#labSafeDock'), 'dock=' + !!V.$('#labSafeDock'));
  const vIdle = V.w.setTimeout(V.w.eval('(' + IDLE_STUDY + ')'), 300000);
  check('VPN 前缀地址：空闲计时器照样被拦', vIdle === 0, 'id=' + vIdle);
  check('启动日志写明识别依据', /识别依据=地址/.test(V.api.LOGS.join('\n')),
    V.api.LOGS.slice(0, 2).join(' | '));

  console.log('\n===== PASS ' + pass + ' / FAIL ' + fail + ' =====');
  process.exit(fail ? 1 : 0);
})();
