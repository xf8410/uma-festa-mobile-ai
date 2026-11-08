#!/usr/bin/env node
// [APP-FIX-094] 悬浮窗「随时可拉伸」：
//   底部加一条 ⇳ 拖拽条 → 直接改 WindowManager 窗口 width/height（自由缩放，不再是三档）
//   WebView 改成 MATCH_PARENT + weight，窗口多大面板就多大
const fs = require('fs');
const P = process.argv[2];
if (!P) throw new Error('usage: apply_appfix_094.js <FloatingWindowService.kt>');
let s = fs.readFileSync(P, 'utf8');
if (s.includes('[APP-FIX-094]')) { console.log('already applied'); process.exit(0); }
const once = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.log('skip(count=' + n + '): ' + JSON.stringify(a.slice(0, 48))); return; }
  s = s.split(a).join(b);
};

// 1) WebView 布局改成撑满容器
once(
  "            val w = (0.94 * resources.displayMetrics.widthPixels).toInt()\n            layoutParams = LinearLayout.LayoutParams(w, dp(320))",
  "            // [APP-FIX-094] 撑满窗口，窗口尺寸由外面的拖拽条决定\n" +
  "            layoutParams = LinearLayout.LayoutParams(\n" +
  "                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f\n" +
  "            )"
);

// 2) 容器里加拖拽条
once(
  "            addView(header, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))\n            addView(web)\n        }\n        root = container",
  "            addView(header, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))\n" +
  "            addView(web)\n" +
  "        }\n" +
  "        // [APP-FIX-094] 底部自由缩放拖拽条\n" +
  "        val resizer = TextView(this).apply {\n" +
  "            text = \"⇳ 拖拽缩放\"\n" +
  "            textSize = 11f\n" +
  "            gravity = Gravity.CENTER\n" +
  "            setTextColor(0xFF4A5C50.toInt())\n" +
  "            setBackgroundColor(0xAAFFFFFF.toInt())\n" +
  "            setPadding(0, dp(4), 0, dp(4))\n" +
  "        }\n" +
  "        container.addView(resizer, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(26)))\n" +
  "        resizer.setOnTouchListener { _, ev ->\n" +
  "            val params = lp ?: return@setOnTouchListener false\n" +
  "            when (ev.actionMasked) {\n" +
  "                MotionEvent.ACTION_DOWN -> {\n" +
  "                    resStartW = params.width\n" +
  "                    resStartH = params.height\n" +
  "                    resStartX = ev.rawX\n" +
  "                    resStartY = ev.rawY\n" +
  "                    true\n" +
  "                }\n" +
  "                MotionEvent.ACTION_MOVE -> {\n" +
  "                    val mw = resources.displayMetrics.widthPixels\n" +
  "                    val mh = (0.95 * resources.displayMetrics.heightPixels).toInt()\n" +
  "                    params.width = (resStartW + (ev.rawX - resStartX)).toInt().coerceIn(dp(140).coerceAtMost(mw), mw)\n" +
  "                    params.height = (resStartH + (ev.rawY - resStartY)).toInt().coerceIn(dp(90).coerceAtMost(mh), mh)\n" +
  "                    try { wm?.updateViewLayout(container, params) } catch (e: Throwable) { }\n" +
  "                    true\n" +
  "                }\n" +
  "                else -> false\n" +
  "            }\n" +
  "        }\n" +
  "        root = container"
);

// 3) 窗口初始尺寸：固定像素（不再 WRAP_CONTENT）
once(
  "        lp = WindowManager.LayoutParams(\n            WindowManager.LayoutParams.WRAP_CONTENT,\n            WindowManager.LayoutParams.WRAP_CONTENT,",
  "        val initW = (0.94 * resources.displayMetrics.widthPixels).toInt()\n" +
  "        val initH = (0.42 * resources.displayMetrics.heightPixels).toInt()\n" +
  "        lp = WindowManager.LayoutParams(\n            initW,\n            initH,"
);

// 4) 折叠/展开改成改窗口高度
once(
  "                    wlp.height = dp(30)\n                    w.layoutParams = wlp\n                    header.visibility = View.GONE",
  "                    lp?.height = dp(34) // [APP-FIX-094] 折叠 = 迷你条窗口高度\n" +
  "                    wm?.updateViewLayout(container, lp)\n                    header.visibility = View.GONE"
);
once(
  "                    wlp.height = dp(320)\n                    w.layoutParams = wlp\n                    header.visibility = View.VISIBLE",
  "                    lp?.height = (0.42 * resources.displayMetrics.heightPixels).toInt() // [APP-FIX-094]\n" +
  "                    wm?.updateViewLayout(container, lp)\n                    header.visibility = View.VISIBLE"
);

// 5) 字段
once(
  "    private var scaleIdx = 0",
  "    private var scaleIdx = 0\n" +
  "    // [APP-FIX-094] 拖拽缩放的起点\n" +
  "    private var resStartW = 0\n" +
  "    private var resStartH = 0\n" +
  "    private var resStartX = 0f\n" +
  "    private var resStartY = 0f"
);

fs.writeFileSync(P, s);
console.log('app-fix-094 applied');