// ==UserScript==
// @name         实验室安全教育平台 · 自动继续学习 + 实时已学时长
// @namespace    https://github.com/shutiao2333/labsafe-autocontinue
// @version      1.0.0
// @description  ① 屏蔽本平台的"空闲 N 分钟自动退出"机制（学习页与考试/练习页，考试页可用 CONFIG.blockIdleExam=false 单独关闭）——让空闲计时器压根不排程，而不是等弹窗出现再点；② 在学习页右侧"已用时"旁显示服务器端累计学习时长（含自动换数据源）；③ 右下角「LabSafe 日志」诊断面板（自检/复制/下载）。
// @author       shutiao2333
// @match        *://*/lab-study-front/*
// @match        *://*/lab-platform/*
// @match        *://*/cg-exam/*
// @run-at       document-start
// @license      MIT
// @grant        none
// ==/UserScript==

/*
  ── 原理（依据该平台前端 bundle 的真实实现）──────────────────────────────
  学习页 (TaskDetail / taskDetail / SDS / safetyManualCard / safetySigns)：
      init(){ this.staticTimer = setTimeout(fn, 60 * config.NoOperationTime * 1000) }  // 5 分钟
      fn 里做两件事：① clearInterval(this.timer)  ← 清掉"学习计时"秒表
                     ② this.showNOoperated = true ← 弹出"是否继续"确认框
      倒计时 15 秒 → 归零时 $router.back()（退出页面）
      点"确定" → onOk()：重新计时，但注意部分页面（如 safetyManualCard）
                 并不会重新启动学习秒表，所以"弹窗出现"本身就在扣你的学习时长。

  考试/练习页 (studentExaming)：
      setInterval(this.isTimeOut, 5000)；空闲 > 5 分钟 → showextra = true
      → 弹出"您已5分钟未进行答题，8秒后将退出考试页面!"，点"继续考试"才继续。

  ── 因此本脚本的主策略不是"帮你点弹窗"，而是让空闲计时器压根不生效，
     这样 clearInterval(this.timer) 永远不会执行，学习秒表连续累计。
     自动点弹窗只是兜底（万一站点改版、我的特征失配）。

  ── 右侧"实时已学"数值来自站点自己的接口（按顺序尝试，前一个拿不到数值就换下一个）：
     ① GET /api/study_records/mine {page:0,size:10,searchStart:近一年,searchEnd:今天}
          → data.totalStudyLength（秒）。「学习时长」页那句"总学习时长约为 X"用的就是它。
     ② GET /api/user_info（个人中心的接口）→ data.totalStudyLength。
        注意：部分院校部署对 user_info 的这个字段返回的是 null ——
        站点配置 isNeedTotalStudyLength 未启用时，服务端压根不计算它，
        （所以站点自己那句"平台学习时长"也不显示）。因此它只作兜底。
     所有源都拿不到数值时才退化成读页面组件里的值；全部为 null 时显示 00:00:00 并写明原因。
     请求通过站点自己的 commonMethods.emitAjax 发出，因此 app-key / timestamp / sign /
     cgAuthorization 这些鉴权头由站点自己生成，无需复刻签名算法。
  ─────────────────────────────────────────────────────────────────────
*/

(function () {
  'use strict';

  /* ================= 开关（按需修改） ================= */
  const CONFIG = {
    blockIdleStudy: true,    // 学习/阅读页：屏蔽"空闲5分钟自动退出"计时器（推荐 true）
    blockIdleExam:  true,    // 考试/练习页：屏蔽"5分钟未答题退出考试页面"计时器（正式考试也生效；不需要就改 false）
    autoClickFallback: true, // 兜底：弹窗出现时立刻自动点"确定/继续学习/继续考试"
    watchdogSeconds: 60,     // 兜底：学习秒表卡住超过 N 秒时自动点"继续学习/开始学习"按钮；0 = 关闭
    debug: false             // 控制台打印调试日志
  };

  /* 右侧"实时已学"显示（学习页 .positionRight 里，紧跟"已用时"那一行） */
  // 数据源链（按顺序尝试，前一个拿不到数值就自动换下一个）：
  //   ① /api/study_records/mine —— 「学习时长」页「总学习时长约为」用的就是这个接口，
  //      响应 data.totalStudyLength（秒）。参数逐字照抄该页：
  //        page=0, size=10, searchStart/searchEnd 是【毫秒时间戳】——
  //        该页 SelectDate 传了 isTimeStamp，组件内部把日期转成
  //        start = new Date('YYYY-MM-DD 00:00:00').getTime()      （一年前 00:00:00.000）
  //        end   = new Date('YYYY-MM-DD 23:59:59').getTime() + 999（今天 23:59:59.999）
  //      传 "YYYY-MM-DD" 字符串服务器会报 Long 转换失败（实测）。
  //   ② /api/user_info —— 个人中心用的接口。注意本校部署对 totalStudyLength 返回的是 null
  //      （isNeedTotalStudyLength 未启用的系统就不计算），所以它只作兜底。
  const REAL = {
    enabled:   true,
    label:     '实时已学',                     // 行标题
    field:     'totalStudyLength',             // 各数据源都用这个字段名（单位：秒）
    sources: [
      {
        name: '学习记录 /api/study_records/mine',
        endpoint: '/api/study_records/mine',
        visibleMs: 10000,                      // 这个查询比 user_info 重，10 秒一次就够了
        payloads: [function () {
          return { page: 0, size: 10, searchStart: tsStart(-365), searchEnd: tsEnd(0) };
        }]
      },
      {
        name: '用户信息 /api/user_info',
        endpoint: '/api/user_info',
        visibleMs: 5000,
        payloads: [function () { return {}; }, function () { return { isNeedTotalStudyLength: 1 }; }]
      }
    ],
    hiddenMs:  30000,                          // 页面切到后台：统一降到 30 秒（减少轮询）
    syncStore: true,                           // 顺便写回站点 Vuex，顶栏"平台学习时长"一起刷新
    color:     '#2d8cf0'
  };

  // 近 N 天 → 'YYYY-MM-DD'（与站点 moment().subtract(1,'year').format("YYYY-MM-DD") 一致）
  function ymd(daysFromNow) {
    const d = new Date(Date.now() + daysFromNow * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  // 该日 00:00:00.000 的毫秒时间戳（daysFromNow 为负=过去；站点 SelectDate 传 isTimeStamp 时的 start 值）
  function tsStart(daysFromNow) { return new Date(ymd(daysFromNow) + ' 00:00:00').getTime(); }
  // 该日 23:59:59.999 的毫秒时间戳（站点 SelectDate 传 isTimeStamp 时的 end 值）
  function tsEnd(daysFromNow) { return new Date(ymd(daysFromNow) + ' 23:59:59').getTime() + 999; }

  const TAG = '[LabSafe]';
  const log = (...a) => { if (CONFIG.debug) console.log(TAG, ...a); };
  const LOGS = [];                     // 页面内日志面板的缓冲（最多 400 行）
  let lastWhy = '';                    // 最近一次失败原因（供自检显示）

  /* ================= 〇、进入"页面本体世界"（Firefox / Zen 的关键） =================
     Firefox 把油猴脚本放在**沙箱**（content script）里执行，沙箱看 DOM 有 Xray 视野：
       · 页面脚本挂在元素上的 expando 属性（Vue 的 el.__vue__ 就是）在沙箱里读出来永远是
         undefined —— 所以脚本能"看到"页面，却永远找不到 Vue 实例；
       · 在沙箱里覆盖 window.setTimeout 只改到沙箱自己的 window，页面调用的 setTimeout
         根本没被拦到（拦截静默失效，只剩自动点弹窗在起作用）。
     Chromium 没有这层（@grant none 直接跑在页面上下文），所以 Chrome/Edge 里一切正常 ——
     这也正是"离线测试全绿、真实页面取不到值"的原因。
     解法：经 unsafeWindow / wrappedJSObject 拿到页面本体的 window 和节点对象。 */
  const PAGE = (function () {
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow) {   // Tampermonkey/Violentmonkey 都提供
        return unsafeWindow.wrappedJSObject || unsafeWindow;
      }
    } catch (e) { /* ignore */ }
    return null;                                                   // Chromium：无需转换
  })();
  const TIMER_HOST = PAGE || window;                                // 页面真正使用的 window
  const REALM = PAGE ? 'Firefox 沙箱 → 已切到页面本体对象' : 'Chromium 同域直读';

  // 把 Xray 包装换回页面本体对象；普通对象原样返回
  function raw(o) {
    try { return (o && o.wrappedJSObject) ? o.wrappedJSObject : o; } catch (e) { return o; }
  }
  // 元素上的 Vue 实例（跨过 Xray 视野读取 expando）
  function vueOf(el) {
    const t = raw(el);
    try { if (t && t.__vue__) return t.__vue__; } catch (e) { /* ignore */ }
    try { if (el && el.__vue__) return el.__vue__; } catch (e) { /* ignore */ }
    return null;
  }

  /* ================= 一、空闲计时器拦截 ================= */
  // 站点源码特征：
  //   学习页回调含 showNOoperated / outtimer / outTime / NoOperationTime
  //   考试页回调含 showextra / outTimespace / isTimeOut
  // 这些是 Vue 组件 data 的属性名，压缩混淆后依然保留，因此可以据此精确识别。
  const STUDY_MARK = /showNOoperated|outtimer|NoOperationTime|自动退出|是否继续/;
  const EXAM_MARK  = /showextra|outTimespace|isTimeOut|未进行答题|退出考试页面/;

  // 注意：自己用的定时器仍取沙箱 window 的原生实现（不受下面补丁影响）
  const nativeSetTimeout  = window.setTimeout;
  const nativeSetInterval = window.setInterval;
  const nativeClearTimeout = window.clearTimeout;

  function fnSource(fn) {
    try { return typeof fn === 'function' ? Function.prototype.toString.call(fn) : String(fn); }
    catch (e) { return ''; }
  }

  function idleKind(src) {                      // → 'study' | 'exam' | null
    if (STUDY_MARK.test(src)) return 'study';
    if (EXAM_MARK.test(src))  return 'exam';
    return null;
  }

  function shouldBlock(kind, delay, isInterval) {
    if (!kind) return false;
    if (kind === 'study' && !CONFIG.blockIdleStudy) return false;
    if (kind === 'exam'  && !CONFIG.blockIdleExam)  return false;
    if (isInterval) return true;                                    // 考试页的空闲探测 interval
    // setTimeout：只拦 1 分钟 ~ 60 分钟区间，避免误伤站点的短延时逻辑
    return typeof delay === 'number' && delay >= 60000 && delay <= 3600000;
  }

  if (CONFIG.blockIdleStudy || CONFIG.blockIdleExam) {
    // 必须打在"页面自己的 window"上，否则沙箱里改的只是沙箱的定时器，页面照旧弹窗
    TIMER_HOST.setTimeout = function (fn, delay, ...args) {
      const kind = idleKind(fnSource(fn));
      if (shouldBlock(kind, delay, false)) {
        console.info(TAG, `已拦截空闲退出定时器 [${kind}] ${delay}ms —— 弹窗不会出现，学习计时不中断`);
        return 0;
      }
      return nativeSetTimeout.apply(window, [fn, delay].concat(args));
    };

    TIMER_HOST.setInterval = function (fn, delay, ...args) {
      const kind = idleKind(fnSource(fn));
      if (shouldBlock(kind, delay, true)) {
        console.info(TAG, `已拦截空闲探测定时器 [${kind}] ${delay}ms`);
        return 0;
      }
      return nativeSetInterval.apply(window, [fn, delay].concat(args));
    };
  }

  /* ================= 二、弹窗出现时的自动点击（兜底） ================= */
  const MODAL_TEXT = /秒后就?自动退出|是否继续|未进行答题|继续学习|继续考试/;
  const MODAL_SKIP = /是否跳转到微课堂|系统繁忙|温馨提示/;
  const OK_TEXT    = /^(确定|是|继续|继续学习|继续考试|继续练习|继续答题)$/;
  const clickedAt  = new WeakMap();            // 防止同一弹窗被反复点击

  function isVisible(el) {                      // 逐级查 display/visibility（v-show 用的是行内 display:none）
    let n = el;
    while (n && n.nodeType === 1) {
      if (n.style && n.style.display === 'none') return false;
      const cs = window.getComputedStyle && window.getComputedStyle(n);
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
      n = n.parentElement;
    }
    return !!el;
  }

  function pickButton(modal) {
    const btns = Array.prototype.slice.call(modal.querySelectorAll('button.ivu-btn, button, .ivu-btn'));
    let soft = null;
    for (const b of btns) {
      if (!isVisible(b)) continue;
      const txt = (b.textContent || '').trim();
      if (!OK_TEXT.test(txt)) continue;
      if (b.classList.contains('ivu-btn-primary')) return b;   // 主按钮优先
      if (!soft) soft = b;
    }
    if (soft) return soft;
    const p = modal.querySelector('.ivu-modal-confirm-footer .ivu-btn-primary, .ivu-modal-footer .ivu-btn-primary');
    return (p && isVisible(p)) ? p : null;
  }

  function scanModals() {
    if (!CONFIG.autoClickFallback || !document.body) return;
    const modals = document.querySelectorAll('.ivu-modal');
    for (const m of modals) {
      if (!isVisible(m)) continue;
      const text = m.textContent || '';
      if (!MODAL_TEXT.test(text) || MODAL_SKIP.test(text)) continue;
      const btn = pickButton(m);
      if (!btn) continue;
      if (Date.now() - (clickedAt.get(m) || 0) < 5000) continue;    // 同一弹窗 5 秒内不重复点
      clickedAt.set(m, Date.now());
      console.info(TAG, '检测到空闲提示弹窗，自动点击：', btn.textContent.trim());
      btn.click();
    }
  }

  /* ================= 三、学习秒表卡住的兜底（站点改版时仍能自愈） ================= */
  let lastVal = null, lastChangeAt = 0, lastKickAt = 0;

  function clickLearnButton() {
    const now = Date.now();
    if (now - lastKickAt < 5 * 60 * 1000) return;              // 5 分钟冷却，避免反复点
    const btns = document.querySelectorAll('button.ivu-btn, button');
    for (const b of btns) {
      if (!isVisible(b)) continue;
      const txt = (b.textContent || '').trim();
      if (/^(继续学习|开始学习|再次学习)$/.test(txt)) {
        console.info(TAG, '学习计时卡住，自动点击：', txt);
        lastKickAt = now;
        b.click();
        return;
      }
    }
  }

  function watchdog() {
    if (!CONFIG.watchdogSeconds) return;
    const el = document.querySelector('.alredyTime');
    if (!el) return;                                            // 非学习页 / 结构不同则跳过
    const val = (el.textContent || '').replace(/\s+/g, '');
    if (!/^\d{2}:\d{2}:\d{2}$/.test(val)) return;
    const now = Date.now();
    if (val !== lastVal) { lastVal = val; lastChangeAt = now; return; }
    if (now - lastChangeAt > CONFIG.watchdogSeconds * 1000) {    // 正常时秒表每秒都在走
      lastChangeAt = now;
      clickLearnButton();
    }
  }

  /* ================= 四、右侧「实时已学」时长 ================= */
  const ROW_ID = 'labSafeRealRow';
  let vmCache = null, lastFetchAt = 0, lastExhaustiveAt = 0;
  let fromApi = false;                 // 是否已经拿到过服务器值
  let failCount = 0, lastWarnAt = 0, lastShown = null;

  function fmtHMS(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const p = (n) => String(n).padStart(2, '0');
    return p(Math.floor(sec / 3600)) + ':' + p(Math.floor(sec % 3600 / 60)) + ':' + p(sec % 60);
  }

  // 后端可能把 Long 序列化成字符串（"3725"），必须接受
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return isFinite(n) ? n : null;
    }
    return null;
  }

  // 响应可能被包一层 / 字段可能嵌在 data 里；递归找第一个数值型字段
  // （Firefox 沙箱里拿到的响应对象是 Xray 包装，必须先 raw() 拆开才能读属性）
  function deepFind(obj, key, depth) {
    depth = depth || 0;
    if (typeof obj === 'number' || typeof obj === 'string') return num(obj);
    if (!obj || typeof obj !== 'object' || depth > 3) return null;
    obj = raw(obj);
    try {
      if (key in obj) { const v = num(obj[key]); if (v !== null) return v; }
    } catch (e) { return null; }
    let keys;
    try { keys = Object.keys(obj); } catch (e) { return null; }
    for (const k of keys) {
      const v = obj[k];
      if (v && typeof v === 'object') { const r = deepFind(v, key, depth + 1); if (r !== null) return r; }
    }
    return null;
  }

  // 字段是否存在于响应里（哪怕值是 null —— 那种情况应显示 00:00:00，而不是报失败）
  function keyPresent(obj, key, depth) {
    depth = depth || 0;
    if (!obj || typeof obj !== 'object' || depth > 3) return false;
    obj = raw(obj);
    try { if (key in obj) return true; } catch (e) { return false; }
    let keys;
    try { keys = Object.keys(obj); } catch (e) { return false; }
    for (const k of keys) {
      const v = obj[k];
      if (v && typeof v === 'object' && keyPresent(v, key, depth + 1)) return true;
    }
    return false;
  }

  // 站点的 commonMethods 挂在 Vue.prototype 上，所以任意组件实例都能拿到它的 emitAjax
  function anyVue() {
    if (vmCache && vmCache.$el && vmCache.commonMethods && vmCache.commonMethods.emitAjax) {
      try { if (document.contains(raw(vmCache.$el))) return vmCache; } catch (e) { /* ignore */ }
    }
    const fast = ['#chingo', '.positionRight', '.person-wrap', '.container', 'body > *'];
    for (const sel of fast) {
      for (const el of document.querySelectorAll(sel)) {
        const vm = vueOf(el);
        if (vm && vm.commonMethods && vm.commonMethods.emitAjax) { vmCache = vm; return vm; }
      }
    }
    if (Date.now() - lastExhaustiveAt > 5000) {                  // 兜底：整页找第一个 Vue 实例（最多 5 秒一次）
      lastExhaustiveAt = Date.now();
      for (const el of document.querySelectorAll('*')) {
        const vm = vueOf(el);
        if (vm && vm.commonMethods && vm.commonMethods.emitAjax) { vmCache = vm; return vm; }
      }
    }
    return null;
  }

  // 接口还没通时，读页面组件自己保存的时长顶一下（站点字段名见过几种，全试一遍）
  function fromComponent() {
    const vm = anyVue();
    if (!vm) return null;
    const stack = [raw(vm)];
    let n = 0;
    while (stack.length && n++ < 600) {
      const c = raw(stack.pop());
      if (!c || typeof c !== 'object') continue;
      const dv = num(c[REAL.field]);                             // 学习时长页组件：this.totalStudyLength
      if (dv !== null) return dv;
      for (const prop of ['studyObj', 'pageStuty']) {
        const o = raw(c[prop]);
        if (o && typeof o === 'object') {
          const v = num(o[REAL.field]);
          if (v !== null) return v;
        }
      }
      const kids = raw(c.$children);
      if (kids) for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
    }
    return null;
  }

  // 在学习页右侧面板里，把新行插到「已用时」那一行的正下方
  function ensureRow() {
    if (!REAL.enabled) return null;
    const holder = document.querySelector('.positionRight');
    const old = document.getElementById(ROW_ID);
    if (!holder) { if (old) old.remove(); return null; }
    if (old && holder.contains(old)) return old.querySelector('.labSafeRealTime');

    const anchor = Array.prototype.slice.call(holder.querySelectorAll('.timeLayout'))
      .find((r) => /已用时|已学习|用时/.test(r.textContent || ''));

    const divider = document.createElement('div');
    divider.className = 'Dividing';
    const row = document.createElement('div');
    row.id = ROW_ID;
    row.className = ' timeLayout ';
    const lab = document.createElement('span');
    lab.textContent = REAL.label;
    const val = document.createElement('span');
    val.className = 'labSafeRealTime';
    val.style.color = REAL.color;
    row.appendChild(lab);
    row.appendChild(val);

    if (anchor && anchor.parentNode === holder) {
      anchor.insertAdjacentElement('afterend', divider);
      divider.insertAdjacentElement('afterend', row);
    } else {                                                     // 找不到就在用户名下面插
      const name = holder.querySelector('.peopleName');
      if (name && name.parentNode === holder) {
        name.insertAdjacentElement('afterend', divider);
        divider.insertAdjacentElement('afterend', row);
      } else {
        holder.appendChild(divider);
        holder.appendChild(row);
      }
    }
    // 行被 Vue 重建时，别让已经拿到的数掉回占位符
    if (lastShown) paint(lastShown.txt, lastShown.title);
    else paint('--:--:--', '正在读取 ' + currentSource().endpoint + ' …');
    return val;
  }

  function paint(txt, title) {
    const span = document.querySelector('#' + ROW_ID + ' .labSafeRealTime');
    if (!span) return;
    if (span.firstChild && span.firstChild.nodeType === 3) span.firstChild.nodeValue = txt;
    else span.textContent = txt;                                 // 用 nodeValue 更新，避免触发观察器
    if (title) span.title = title;
  }

  function setReal(sec, title) {
    const txt = fmtHMS(sec);
    lastShown = { txt: txt, title: title };
    paint(txt, title);
    log('实时已学 =', txt, title);
  }

  // 失败时先顶上页面组件里的值；连组件值都没有，就明确显示"读取失败"而不是一直占位符
  function reportFail(why, raw) {
    failCount++;
    lastWhy = why;
    const now = Date.now();
    if (failCount <= 3 || now - lastWarnAt > 60000) {              // 前 3 次 + 之后每分钟一次
      lastWarnAt = now;
      console.warn(TAG, '[实时已学] ' + why + '（第 ' + failCount + ' 次）；原始响应：', raw);
      note('✗ ' + why);
    }
    if (fromApi) return;
    const cv = fromComponent();
    if (cv !== null) setReal(cv, '页面 studyObj 本地值（接口尚未取到：' + why + '）');
    else if (failCount >= 2) {
      lastShown = { txt: '读取失败', title: why + ' —— 点右下角「LabSafe 日志」看详情' };
      paint('读取失败', lastShown.title);
      if (!autoOpened && failCount >= 3) { autoOpened = true; ensureUI(); togglePanel(); }
    }
  }

  /* ================= 五、页面本体通道（页面上下文 agent，根治沙箱问题） =================
     Firefox 沙箱读不到 el.__vue__（Xray 视野），而且不同管理器/设置差异很大。
     最稳的办法：往页面里注入一段 **页面上下文** 的脚本，由它在页面世界里找 Vue 实例、
     发请求；两个世界之间只用 DOM 属性的**字符串**通信（不传任何对象），彻底绕开 Xray。 */
  const BRIDGE_ID = 'labSafeBridge', EV_REQ = 'labsafe-bridge-req', EV_RES = 'labsafe-bridge-res';
  const BRIDGE_TIMEOUT = 8000;         // 要比 agent 内部 6 秒看门狗长，正常都由 agent 先应答

  const AGENT_SRC = '(' + function (cfg) {
    if (window.__labSafeAgent) return;
    cfg = cfg || {};
    window.__labSafeAgent = '1.0.0';
    var ID = 'labSafeBridge', REQ = 'labsafe-bridge-req', RES = 'labsafe-bridge-res';

    // ① 顺手在页面世界打上空闲定时器补丁（沙箱里的补丁打不到这里，这里才是真正生效的）
    var STUDY = /showNOoperated|outtimer|NoOperationTime|自动退出|是否继续/;
    var EXAM  = /showextra|outTimespace|isTimeOut|未进行答题|退出考试页面/;
    var nST = window.setTimeout, nSI = window.setInterval, tlog = [];
    function fsrc(f) { try { return typeof f === 'function' ? Function.prototype.toString.call(f) : String(f); } catch (e) { return ''; } }
    function knd(s) { return STUDY.test(s) ? 'study' : (EXAM.test(s) ? 'exam' : null); }
    // 这层补丁才是"真正生效"的那一层（沙箱里打的补丁打不到页面），所以必须同样尊重开关
    function on(k) { return k === 'study' ? cfg.study !== false : (k === 'exam' ? cfg.exam !== false : false); }
    function push(s) { if (tlog.length < 40) tlog.push(s); }
    if (cfg.study !== false || cfg.exam !== false) {
      window.setTimeout = function (f, d) {
        var k = knd(fsrc(f));
        if (k && on(k) && typeof d === 'number' && d >= 60000 && d <= 3600000) { push('拦截空闲 setTimeout [' + k + '] ' + d + 'ms'); return 0; }
        return nST.apply(window, arguments);
      };
      window.setInterval = function (f, d) {
        var k = knd(fsrc(f));
        if (k && on(k)) { push('拦截空闲 setInterval [' + k + '] ' + d + 'ms'); return 0; }
        return nSI.apply(window, arguments);
      };
    }

    // ② 找站点的 Vue 实例（这里是页面世界，el.__vue__ 直接可见）
    var cached = null;
    function ok(vm) { return !!(vm && vm.commonMethods && vm.commonMethods.emitAjax); }
    function findVue() {
      var out = { vueSeen: 0, scanned: 0, via: '' };
      try { if (ok(cached) && cached.$el && document.contains(cached.$el)) { out.via = 'cache'; out.vm = cached; return out; } } catch (e) { cached = null; }
      var sels = ['#chingo', '.positionRight', '.person-wrap', '.container'], i, j, el, vm;
      for (i = 0; i < sels.length; i++) {
        var list = document.querySelectorAll(sels[i]);
        for (j = 0; j < list.length; j++) {
          el = list[j];
          if (el.__vue__) { out.vueSeen++; vm = el.__vue__; if (ok(vm)) { cached = vm; out.via = 'fast:' + sels[i]; out.vm = vm; return out; } }
        }
      }
      var all = document.querySelectorAll('*');
      out.scanned = all.length;
      for (i = 0; i < all.length; i++) {
        el = all[i];
        if (el.__vue__) { out.vueSeen++; vm = el.__vue__; if (!out.first) out.first = vm; if (ok(vm)) { cached = vm; out.via = 'scan'; out.vm = vm; return out; } }
      }
      out.vm = out.first || null;
      return out;
    }

    // ③ 沙箱发来请求 → 在页面世界发 API → 把结果写成字符串塞回 DOM 属性
    document.addEventListener(REQ, function () {
      var b = document.getElementById(ID);
      if (!b) return;
      var req;
      try { req = JSON.parse(b.getAttribute('data-req') || 'null'); } catch (e) { req = null; }
      if (!req || !req.id) return;
      var out = { id: req.id, ok: false, timersPatched: true, timerLog: tlog.slice(-40),
                  elCount: document.querySelectorAll('*').length };
      var sent = false, wd = null;
      function done() {
        if (sent) return;
        sent = true;
        try { window.clearTimeout(wd); } catch (e) { /* ignore */ }
        try { b.setAttribute('data-res', JSON.stringify(out)); } catch (e) { /* ignore */ }
        document.dispatchEvent(new Event(RES));
      }
      var f = findVue();
      out.found = !!f.vm; out.via = f.via; out.vueSeen = f.vueSeen; out.scanned = f.scanned;
      out.hasCommonMethods = !!(f.vm && f.vm.commonMethods);
      out.hasEmitAjax = ok(f.vm);
      if (!out.hasEmitAjax) { out.error = '页面世界里没找到带 commonMethods.emitAjax 的实例'; done(); return; }
      // 看门狗：万一站点的 emitAjax 既不回 success 也不回 error，也必须给出应答，否则沙箱会一直卡住
      wd = nST.call(window, function () { out.error = out.error || '站点 emitAjax 6 秒无回调'; done(); }, 6000);
      try {
        f.vm.commonMethods.emitAjax({
          path: req.path, data: req.data || {}, errorTipExecuteCallback: true,
          success: function (d) {
            out.ok = true;
            try { out.raw = JSON.stringify(d); }
            catch (e) { out.raw = String(d); }
            if (out.raw && out.raw.length > 20000) out.raw = out.raw.slice(0, 20000);
            done();
          },
          error: function (e) {
            var m = (e && (e.message || e.code)) || '';
            out.error = '站点 error 回调：' + m;
            try { out.errRaw = JSON.stringify(e); } catch (x) { out.errRaw = String(e); }
            done();
          }
        });
      } catch (e) { out.error = '调用 emitAjax 抛异常：' + e; done(); }
    });
  }.toString() + ')(' + JSON.stringify({ study: CONFIG.blockIdleStudy, exam: CONFIG.blockIdleExam }) + ');';

  function injectAgent() {
    try {
      const s = document.createElement('script');
      s.textContent = AGENT_SRC;
      (document.head || document.documentElement).appendChild(s);
      if (s.parentNode) s.parentNode.removeChild(s);
      return true;
    } catch (e) { return false; }
  }
  function agentAlive() {
    try { if (window.__labSafeAgent) return true; } catch (e) { /* ignore */ }
    try { if (PAGE && PAGE.__labSafeAgent) return true; } catch (e) { /* ignore */ }
    return false;
  }
  injectAgent();                       // 尽早注入（agent 自身幂等，boot() 里会再确认一次）

  let bridgeBusy = false, bridgeSeq = 0, bridgeDead = false, bridgeFail = 0, pendingBridge = null;
  let srcIdx = 0, payloadIdx = 0, fallbackPolls = 0;           // 当前试到第几个数据源 / 第几种参数 / 备用源已轮询次数

  function currentSource() { return REAL.sources[Math.min(srcIdx, REAL.sources.length - 1)]; }

  function currentPayload() {
    const ps = currentSource().payloads || [function () { return {}; }];
    const f = ps[Math.min(payloadIdx, ps.length - 1)];
    try { return Object.assign({}, typeof f === 'function' ? f() : f); } catch (e) { return {}; }
  }

  // 还没试完所有组合
  function hasMoreAttempts() {
    return payloadIdx < currentSource().payloads.length - 1 || srcIdx < REAL.sources.length - 1;
  }

  // 先换参数，参数用完了再换数据源；换成功返回 true
  function nextAttempt(reason) {
    const ps = currentSource().payloads || [{}];
    if (payloadIdx < ps.length - 1) {
      payloadIdx++;
      note('换第 ' + (payloadIdx + 1) + ' 种参数重试（' + reason + '）');
      return true;
    }
    if (srcIdx < REAL.sources.length - 1) {
      srcIdx++; payloadIdx = 0;
      note('换下一个数据源：' + currentSource().name + '（' + reason + '）');
      return true;
    }
    return false;
  }

  function bridgeNode() {
    let b = document.getElementById(BRIDGE_ID);
    if (b) return b;
    const host = document.body || document.documentElement;
    if (!host) return null;
    b = document.createElement('div');
    b.id = BRIDGE_ID;
    b.setAttribute('style', 'display:none');
    host.appendChild(b);
    return b;
  }

  function bridgeCall(path, data, cb) {
    if (bridgeBusy) { cb(null, 'busy'); return; }
    if (bridgeDead) { cb(null, 'bridge-dead'); return; }
    const b = bridgeNode();
    if (!b) { cb(null, 'no-bridge-node'); return; }
    const id = ++bridgeSeq;
    let done = false;
    bridgeBusy = true;
    const finish = function (res, err) {
      if (done) return;
      done = true; bridgeBusy = false; pendingBridge = null;
      nativeClearTimeout.call(window, timer);
      cb(res, err);
    };
    const timer = nativeSetTimeout.call(window, function () {
      bridgeFail++;
      if (bridgeFail >= 2) bridgeDead = true;
      finish(null, '桥接超时 ' + BRIDGE_TIMEOUT + 'ms（agent 没回应，可能被 CSP 或管理器挡了）');
    }, BRIDGE_TIMEOUT);
    pendingBridge = { id: id, finish: finish };
    try {
      b.setAttribute('data-req', JSON.stringify({ id: id, path: path, data: data }));
      document.dispatchEvent(new Event(EV_REQ));
    } catch (e) { finish(null, '派发事件失败：' + e); }
  }

  document.addEventListener(EV_RES, function () {
    if (!pendingBridge) return;
    const b = document.getElementById(BRIDGE_ID);
    if (!b) return;
    let res = null;
    try { res = JSON.parse(b.getAttribute('data-res') || 'null'); } catch (e) { return; }
    if (!res || res.id !== pendingBridge.id) return;
    pendingBridge.finish(res, null);
  });

  // 万一桥接卡住/被判死，手动重置（面板右上角「重连」也调它）
  function resetBridge() {
    bridgeBusy = false; bridgeDead = false; bridgeFail = 0; pendingBridge = null;
    const b = document.getElementById(BRIDGE_ID);
    if (b) { b.removeAttribute('data-req'); b.removeAttribute('data-res'); }
    injectAgent();
    note('桥接已重置 · agent ' + (agentAlive() ? '运行中' : '未运行'));
  }

  /* 兜底：沙箱直接读（Chromium 或 unsafeWindow 可用时有效） */
  function directFetch(verbose) {
    const src = currentSource();
    const vm = anyVue();
    if (!vm) { reportFail('沙箱里也拿不到 Vue 实例', null); return; }
    if (verbose) note('沙箱直读：发 ' + src.endpoint + ' ' + JSON.stringify(currentPayload()));
    try {
      vm.commonMethods.emitAjax({
        path: src.endpoint,
        data: currentPayload(),
        errorTipExecuteCallback: true,
        success: function (data) {
          if (verbose) note('服务器原始返回：' + safeStr(data));
          applyValue(data, vm, verbose);
        },
        error: function (e) {
          reportFail('接口未返回成功：' + ((e && (e.message || e.code)) || '未知'), e);
          if (!nextAttempt('直读接口未成功')) note('所有数据源都试过了，仍未拿到值');
        }
      });
    } catch (e) { reportFail('调用 emitAjax 抛异常：' + e, null); }
  }

  function safeStr(o) {
    try { return JSON.stringify(o).slice(0, 1200); } catch (e) { return String(o).slice(0, 1200); }
  }

  function topKeys(o) {
    try {
      o = raw(o);
      if (!o || typeof o !== 'object') return String(o).slice(0, 120);
      let s = Object.keys(o).slice(0, 25).join(',');
      const d = raw(o.data);
      if (d && typeof d === 'object') s += ' || data: ' + Object.keys(d).slice(0, 25).join(',');
      return s;
    } catch (e) { return '(读不到键名)'; }
  }

  function syncStore(v, vm) {
    if (!REAL.syncStore) return;
    try {
      const t = vm || anyVue();
      if (t && t.$store && t.$store.commit) t.$store.commit('setTotalStudyLength', v);
    } catch (e) { /* ignore */ }
  }

  function applyValue(data, vm, verbose) {
    let v = deepFind(data, REAL.field, 0);
    let coerced = false;
    // 字段在、但值是 null：先换数据源（本站 user_info 就是不计算的），别急着当 0
    if (v === null && keyPresent(data, REAL.field, 0) && hasMoreAttempts()) {
      nextAttempt('响应里 ' + REAL.field + ' 为 null');
      return;
    }
    if (v === null && keyPresent(data, REAL.field, 0)) {
      v = 0; coerced = true;                                      // 全部组合都试过了：服务端就是不计算
      note('⚠ 所有数据源的 ' + REAL.field + ' 都是 null（本站部署未启用该统计），按 0 显示');
    }
    if (v === null) {
      const why = '响应里没有数值字段 ' + REAL.field + '；实际字段：' + topKeys(data);
      reportFail(why, data);
      if (!nextAttempt('响应里没有 ' + REAL.field)) note('所有数据源都试过了，仍没有该字段');
      return;
    }
    const first = !fromApi;
    const src = currentSource();
    failCount = 0; fromApi = true;
    setReal(v, src.name + ' · ' + REAL.field + '（服务器值，每 ' +
                ((src.visibleMs || REAL.visibleMs) / 1000) + ' 秒刷新）' + (coerced ? ' ⚠ 服务器返回 null' : ''));
    if (coerced) {                                                // 不要拿这个 0 去覆盖站点自己的值
      console.warn(TAG, '所有数据源的 ' + REAL.field + ' 都是 null，界面按 0 显示');
      return;
    }
    if (first) {
      note('✓ 接入成功：' + src.name + ' 返回 ' + REAL.field + ' = ' + v + ' 秒');
      console.info(TAG, '实时已学 已接入 ' + src.name + '，服务器值 = ' + v + ' 秒');
    } else if (verbose) note('值 = ' + v + ' 秒');
    syncStore(v, vm);
  }

  function applyBridge(res, verbose) {
    if (verbose) {
      note('桥接：found=' + res.found + ' ok=' + res.ok + ' via=' + (res.via || '-') +
           ' 命中__vue__=' + (res.vueSeen || 0) + ' 扫描=' + (res.scanned || 0) + ' 元素=' + (res.elCount || 0));
      if (res.error) note('桥接 error：' + res.error);
      if (res.errRaw) note('桥接 error 原文：' + String(res.errRaw).slice(0, 600));
      if (res.raw) note('服务器原始返回：' + String(res.raw).slice(0, 1200));
      if (res.timerLog && res.timerLog.length) note('页面世界定时器：' + res.timerLog.join(' / '));
    }
    if (!res.found) { reportFail('页面世界也没找到 Vue 实例（扫描 ' + (res.scanned || 0) + ' 元素，命中 __vue__ ' + (res.vueSeen || 0) + ' 个）', res); return; }
    if (!res.ok) {
      reportFail('接口未成功：' + (res.error || '未知'), res);
      if (!nextAttempt('接口未成功')) note('所有数据源都试过了，仍未成功');
      return;
    }
    let data = null;
    if (res.raw) { try { data = JSON.parse(res.raw); } catch (e) { note('返回非 JSON：' + String(res.raw).slice(0, 200)); } }
    applyValue(data, null, verbose);
  }

  function fetchReal(verbose) {
    if (!REAL.enabled) return;
    lastFetchAt = Date.now();
    // 已经退到备用源时，每 8 次轮询回头重试一次首选源
    // （首次加载可能因登录态还没就绪 / 参数试错而失败，不能让备用源永久占位）
    if (srcIdx > 0) {
      if (fallbackPolls >= 8) { fallbackPolls = 0; srcIdx = 0; payloadIdx = 0; note('回头重试首选数据源：' + currentSource().name); }
      else fallbackPolls++;
    } else fallbackPolls = 0;
    const src = currentSource();
    const body = currentPayload();
    if (verbose) note('→ GET ' + src.endpoint + ' ' + JSON.stringify(body) + '（' + src.name + '）');
    bridgeCall(src.endpoint, body, function (res, err) {
      if (err) {
        if (err === 'busy') {                                     // 上一轮还没回来：本轮跳过，不要退化成直读（否则请求翻倍）
          if (verbose) note('上一轮桥接请求尚未返回，本轮跳过');
          return;
        }
        if (verbose) note('桥接不可用：' + err + ' → 退回沙箱直读');
        else if (failCount < 3) note('桥接不可用：' + err);
        directFetch(verbose);
        return;
      }
      applyBridge(res, verbose);
    });
  }

  function realDriver() {
    if (!REAL.enabled) return;
    ensureRow();                                                  // 被 Vue 重渲染抹掉时补回来
    if (!fromApi) {                                               // 接口还没通：用页面组件里的数顶上（零网络开销）
      const cv = fromComponent();
      if (cv !== null) setReal(cv, '页面 studyObj 本地值（接口尚未取到）');
    }
    const gap = document.hidden ? REAL.hiddenMs : (currentSource().visibleMs || REAL.visibleMs);
    if (Date.now() - lastFetchAt < gap) return;
    fetchReal(failCount > 0 && failCount < 4);                    // 早期失败时把细节写进日志面板
  }

  /* ================= 六、页面内日志面板（不用开控制台） ================= */
  const DOCK_ID = 'labSafeDock';
  let panelOpen = false, autoOpened = false;

  function note(line) {
    const t = new Date(), p = (n) => String(n).padStart(2, '0');
    LOGS.push('[' + p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds()) + '] ' + line);
    if (LOGS.length > 400) LOGS.splice(0, LOGS.length - 400);
    if (panelOpen) renderLog();
  }

  function ensureUI() {
    if (document.getElementById(DOCK_ID)) return;
    const host = document.body || document.documentElement;
    if (!host) return;
    const dock = document.createElement('div');
    dock.id = DOCK_ID;
    dock.setAttribute('style', 'position:fixed;right:14px;bottom:14px;z-index:2147483000;' +
      'font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;text-align:right;');
    dock.innerHTML =
      '<div id="labSafePanel" style="display:none;width:430px;max-width:88vw;background:#fff;color:#333;' +
        'border:1px solid #dcdee2;border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.22);margin-bottom:8px;overflow:hidden;text-align:left;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#f8f8f9;border-bottom:1px solid #e8eaec;">' +
          '<b>LabSafe 诊断日志</b><span><span id="labSafeReconnect" style="cursor:pointer;color:#2d8cf0;padding:0 6px;">重连</span>' +
          '<span id="labSafeClose" style="cursor:pointer;padding:0 5px;">✕</span></span></div>' +
        '<pre id="labSafeLog" style="margin:0;padding:8px 10px;max-height:46vh;overflow:auto;white-space:pre-wrap;' +
          'word-break:break-all;font:11px/1.55 ui-monospace,Consolas,"Courier New",monospace;background:#fff;"></pre>' +
        '<div style="display:flex;gap:6px;padding:6px 10px;border-top:1px solid #e8eaec;background:#f8f8f9;">' +
          '<button id="labSafeCheck" style="flex:1;cursor:pointer;padding:4px 0;border:1px solid #2d8cf0;background:#2d8cf0;color:#fff;border-radius:4px;">自检</button>' +
          '<button id="labSafeCopy" style="flex:1;cursor:pointer;padding:4px 0;border:1px solid #dcdee2;background:#fff;border-radius:4px;">复制</button>' +
          '<button id="labSafeSave" style="flex:1;cursor:pointer;padding:4px 0;border:1px solid #dcdee2;background:#fff;border-radius:4px;">下载</button>' +
          '<button id="labSafeClear" style="flex:1;cursor:pointer;padding:4px 0;border:1px solid #dcdee2;background:#fff;border-radius:4px;">清空</button>' +
        '</div></div>' +
      '<span id="labSafeFab" style="cursor:pointer;display:inline-block;padding:5px 11px;border-radius:14px;' +
        'background:#2d8cf0;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.25);opacity:.85;user-select:none;">LabSafe 日志</span>';
    host.appendChild(dock);

    const $ = (id) => document.getElementById(id);
    $('labSafeFab').addEventListener('click', togglePanel);
    $('labSafeClose').addEventListener('click', togglePanel);
    $('labSafeReconnect').addEventListener('click', resetBridge);
    $('labSafeCheck').addEventListener('click', selfCheck);
    $('labSafeCopy').addEventListener('click', copyLog);
    $('labSafeSave').addEventListener('click', saveLog);
    $('labSafeClear').addEventListener('click', function () { LOGS.length = 0; note('日志已清空'); renderLog(); });
  }

  function togglePanel() {
    const p = document.getElementById('labSafePanel');
    if (!p) return;
    panelOpen = p.style.display === 'none';
    p.style.display = panelOpen ? 'block' : 'none';
    if (panelOpen) renderLog();
  }

  function renderLog() {
    const pre = document.getElementById('labSafeLog');
    if (!pre) return;
    pre.textContent = LOGS.join('\n') || '(暂无日志)';
    pre.scrollTop = pre.scrollHeight;
  }

  function logText() {
    return 'LabSafe 诊断日志  ' + new Date().toString() + '\n' +
      'URL: ' + location.href + '\nUA: ' + navigator.userAgent + '\n' +
      'REALM: ' + REALM + '  agent: ' + (agentAlive() ? '运行中' : '未运行') + '\n' +
      '-'.repeat(48) + '\n' + LOGS.join('\n') + '\n';
  }

  function copyLog() {
    const txt = logText();
    const okMsg = () => note('✓ 日志已复制到剪贴板，直接粘给我即可');
    const fallback = () => {
      const pre = document.getElementById('labSafeLog');
      if (!pre) return;
      const r = document.createRange();
      r.selectNodeContents(pre);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
      note('已全选日志，按 Ctrl+C 复制');
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(okMsg, fallback);
        return;
      }
    } catch (e) { /* ignore */ }
    fallback();
  }

  function saveLog() {
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([logText()], { type: 'text/plain;charset=utf-8' }));
      a.download = 'labsafe-log.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      note('日志已下载到浏览器下载目录：labsafe-log.txt');
    } catch (e) { note('下载失败：' + e); }
  }

  function selfCheck() {
    note('———— 自检 ————');
    note('REALM=' + REALM + '；PAGE ' + (PAGE ? '有' : '无') +
         '；unsafeWindow ' + (typeof unsafeWindow !== 'undefined' ? '有' : '无') +
         '；页面 agent ' + (agentAlive() ? '运行中' : '未运行'));
    let direct = 0, wrapped = 0, hitAt = 0;
    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      try { if (all[i].__vue__) direct++; } catch (e) { /* ignore */ }
      try { const t = raw(all[i]); if (t && t !== all[i] && t.__vue__) wrapped++; } catch (e) { /* ignore */ }
    }
    for (let i = 0; i < all.length; i++) {
      const vm = vueOf(all[i]);
      if (vm && vm.commonMethods && vm.commonMethods.emitAjax) { hitAt = i + 1; break; }
    }
    note('元素 ' + all.length + ' 个；沙箱直读 __vue__ 命中 ' + direct + '；经 wrappedJSObject 命中 ' + wrapped +
         '；可用实例在第 ' + (hitAt || '无') + ' 个元素');
    note('.positionRight ' + document.querySelectorAll('.positionRight').length + ' 个；本行存在 ' +
         !!document.getElementById(ROW_ID) + '；当前显示值 ' +
         ((document.querySelector('#' + ROW_ID + ' .labSafeRealTime') || {}).textContent || '无'));
    note('localStorage：dataSix ' + (localStorage.getItem('dataSix') ? '有' : '无') +
         '，labLearnSysConfig ' + (localStorage.getItem('labLearnSysConfig') ? '有' : '无'));
    note('localStorage 键：' + (function () { const a = []; for (let i = 0; i < localStorage.length; i++) a.push(localStorage.key(i)); return a.join(',').slice(0, 300); })());
    note('当前失败计数 ' + failCount + '，最近原因：' + lastWhy);
    note('当前数据源：' + currentSource().name + ' · 参数 ' + JSON.stringify(currentPayload()));
    note('发一次真实请求，看服务器到底返回什么…');
    fetchReal(true);
  }

  /* ================= 启动 ================= */
  function boot() {
    scanModals();

    // ⓿ 页面内日志面板（右下角按钮）+ 注入页面上下文 agent
    try { ensureUI(); } catch (e) { /* ignore */ }
    const injected = injectAgent();
    note('脚本启动 · ' + REALM + ' · agent 注入' + (injected ? '成功' : '失败'));
    note('日志面板已就绪：点右下角「LabSafe 日志」→「自检」可看完整诊断');

    // ① 监听 DOM 变化：弹窗插入时立刻处理（比轮询快）
    try {
      new MutationObserver(() => scanModals()).observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class']
      });
    } catch (e) { /* ignore */ }

    // ② 轮询兜底（兜住 v-show 以外的打开方式）+ 右侧行自愈
    nativeSetInterval.call(window, function () { scanModals(); ensureRow(); }, 1200);
    nativeSetInterval.call(window, watchdog, 5000);

    // ③ 右侧「实时已学」：每秒看一眼要不要拉取，实际频率由 visibleMs / hiddenMs 决定
    nativeSetInterval.call(window, realDriver, 1000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) realDriver();                         // 切回前台立刻刷新一次
    });

    console.info(TAG, '已启用：拦截空闲退出计时器' +
      (CONFIG.blockIdleExam ? '（含考试页）' : '（考试页已关闭）') +
      ' + 弹窗自动点击兜底' + (REAL.enabled ? ' + 右侧实时已学时长' : '') + ' · ' + REALM);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // 调试用（沙箱里一份；Firefox 下再尽力导出一份到页面本体，方便在 DevTools 控制台直接用）
  const api = { CONFIG, REAL, LOGS, scanModals, watchdog, clickLearnButton,
                       ensureRow, fetchReal, directFetch, realDriver, setReal, paint, reportFail,
                       fmtHMS, num, deepFind, anyVue, fromComponent, raw, REALM,
                       selfCheck, togglePanel, renderLog, copyLog, saveLog, injectAgent, agentAlive, resetBridge,
                       resetAttempts: function () { srcIdx = 0; payloadIdx = 0; fallbackPolls = 0; },
                       resetPayload: function () { srcIdx = 0; payloadIdx = 0; fallbackPolls = 0; },
                       currentSource: function () { return currentSource().name; },
                       currentPayload: function () { return currentPayload(); },
                       clearCache: function () { vmCache = null; lastExhaustiveAt = 0; },
                       // 一行诊断：在控制台执行可直接看到接口原始返回
                       debug: function () { selfCheck(); return '已写入日志面板（右下角）'; } };
  window.__labSafe = api;
  try {
    if (PAGE && PAGE !== window && typeof cloneInto === 'function') PAGE.__labSafe = cloneInto(api, PAGE);
  } catch (e) { /* ignore */ }
})();
