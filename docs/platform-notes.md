# 平台机制与踩坑记录

这份笔记记录脚本是怎么写出来的、平台内部到底怎么工作、以及一路上修掉的坑。
目的是让别人（或未来的自己）在平台改版后能快速重新定位问题。

## 1. 平台识别

- 厂商：浙江创高智联科技有限公司（曾用名：浙江创高软件有限公司，"创高软件 / 创高智联"）。
  该厂商做高校实验室安全系列（安全教育与考试、安全检查、危险源管理等），官网 <https://www.chingo.cn/>。
  早期资料署名"杭州创高软件科技有限公司"（如软著登字第 026609 号《高校实验室安全考试系统》）。
- URL 特征：`<域名>/lab-study-front/…`（新版学习/考试前端）、`<域名>/lab-platform/…`、`<域名>/cg-exam/…`。
  旧版平台则是 `redir.php?catalog_id=6&cmd=dati`。
- 前端：Vue 2.6.11，`commonMethods` 挂在 `Vue.prototype` 上，组件根元素带 `el.__vue__`。
- 后端接口前缀形如 `https://<域名>/cg-exam-server`，统一信封 `{"message","data","code"}`。

## 2. 怎么读它的实现

1. 拉入口 HTML，正则抠出 webpack 的 chunk→hash 映射，然后把几十个 chunk 全下下来。
2. 中文提示语不会被压缩：先搜提示语（例如"你已经在此页面"）拿到 i18n 的 `code`，再搜 `code`
   定位到渲染它的组件。
3. Vue `data` 里的属性名也不会被压缩（`showNOoperated` / `outTime` / `outtimer` / `showextra` /
   `outTimespace`），这些就是最稳的特征串。
4. 关键不是找弹窗的 DOM，而是找谁排程了这个计时器、以及它的回调里 `clearInterval` 掉了什么。

## 3. 空闲退出的真实实现

学习/阅读页：

```js
init() {
  this.staticTimer = setTimeout(function () {
    t.timer && clearInterval(t.timer),                  // ← 先把学习秒表清掉
    t.outtimer = setInterval(function () {
      t.outTime--, t.outTime == 0 && (clearInterval(t.outtimer), t.$router.back());
    }, 1000),
    t.showNOoperated = !0;                              // ← 再弹"是否继续"
  }, 60 * this.config.NoOperationTime * 1000);
}
```

考试/练习页：`setInterval(this.isTimeOut, 5000)`，空闲超过 5 分钟置 `showextra = true`，
弹「您已 5 分钟未进行答题，8 秒后将退出考试页面!」。

为什么拦计时器而不是点弹窗：弹窗一出现，站点已经先 `clearInterval(this.timer)` 了；
而且部分页面的 `onOk()` 只重新计时，并不重启秒表 —— 弹窗出现本身就等于扣学习时长。

## 4. 鉴权：不要复刻，直接借

每个请求都带签名头：`app-key` + `timestamp`，`sign = MD5(salt + 路径 + 排序后的参数 + 时间戳)`，
外加一个 AES 加密的 `cgAuthorization`。复刻它必然随平台改版失效，所以脚本改为调用
站点自己的 `commonMethods.emitAjax`，签名由站点生成：

```js
const vm = document.querySelector('#app').__vue__;      // 或扫描首个带 __vue__ 的元素
vm.commonMethods.emitAjax({ path: '/api/…', data: {…}, errorTipExecuteCallback: true, success, error });
```

`errorTipExecuteCallback: true` 很关键：它让你的 `error` 回调被调用，而不是去弹站点自己的错误框。
另外注意平台自己的错误分支 —— 某些 `code`（如登录失效 `101`）既不回调 success 也不回调 error，
而是清 `localStorage` 后跳登录页；所以"请求发出去了但一直没回调"未必是你的 bug。

## 5. 学习时长接口的两个坑

坑一：字段存在但值是 `null`。
`GET /api/user_info` 返回 `{"…","totalStudyLength":null}` —— 该部署没启用这个统计
（`config.isNeedTotalStudyLength` 关闭时服务端压根不计算，所以站点自己那句"平台学习时长"也不显示）。
不要把 `null` 当 0 就完事，更不要用它挡住换源逻辑：先去 bundle 里 grep 这个字段名的所有调用点，
找到真正显示这个数字的那个页面用的接口 —— 这里是 `GET /api/study_records/mine`
（「学习时长」页那句"总学习时长约为 X"），响应里的 `data.totalStudyLength`（秒）。

坑二：参数是毫秒时间戳，不是日期字符串。
该页 `mounted()` 里写的是 `moment().subtract(1,'year').format('YYYY-MM-DD')`，
但 `SelectDate` 组件挂载时传了 `isTimeStamp`，实际发出去的是：

```js
start = new Date(t + ' 00:00:00').getTime()          // 一年前 00:00:00.000
end   = new Date(t + ' 23:59:59').getTime() + 999    // 今天 23:59:59.999
```

传 `"2026-10-07"` 字符串会直接被后端拒：

```
Failed to convert property value of type 'java.lang.String' to required type
'java.lang.Long' for property 'searchEnd'; NumberFormatException: For input string: "2026-10-07"
```

照抄参数时，要抄"组件 emit 出去的值"，不是"页面显示/传进去的字符串"。

## 6. Firefox / Zen 的 realm 问题

在 Firefox 系（Zen、Waterfox）里，油猴脚本可能跑在 content-script 沙箱而不是页面上下文，
两者行为不同且都会静默失败（Xray 视野下读 `el.__vue__` 恒为 `undefined`；在沙箱里打的
`window.setTimeout` 补丁打不到页面的定时器）。

不要假设，检测并上报：脚本启动时就把所在世界打印到日志面板。
彻底的做法是：往页面注入一小段页面上下文 agent，两个世界只通过
DOM 属性传 JSON 字符串（属性名 + 自定义事件），对象不跨世界传递 ——
这样无论管理器/设置怎么变都能工作。agent 还要自己带看门狗，保证沙箱那边一定有应答。

## 7. 为什么必须带一个日志面板

脚本的失败是静默的：请求发出去了、返回了、但解析不到值，用户只看到一个 `读取失败`。
让用户开 DevTools 再粘贴日志，每轮要浪费一次往返。所以脚本自带右下角面板：
自检会把 realm、`__vue__` 命中数、`localStorage` 键名（只列键名）、以及
一次真实请求的原始返回全部打出来 —— 出问题时用户点两下就能把定位信息发出来。

## 8. 测试方法

- 用 jsdom：fixture 里的弹窗 DOM 和站点回调函数逐字复制线上压缩代码，
  这样验证的是"脚本能否识别真实站点的代码"，而不是"能否点自己造的按钮"。
- 注入前后包一层 `setTimeout/setInterval` 记录器（脚本在 patch 时会快照当时的 `window.setTimeout`，
  所以能捕到包装）。
- 对照组装一份不打补丁的 DOM，断言"该弹窗确实会弹出"，防止把"其实没生效"测成通过。
- 对生成出来的请求参数断言不变量（`start < end`、类型是数字、毫秒必须是 999）——
  日期方向写反这种错在服务器上是致命的，却很容易在测试里静默通过。
- 节流逻辑用假时钟（`w.Date.now = () => fakeNow`），断言累计请求数，
  免得页面自身的轮询和手动调用互相干扰导致 flaky。
