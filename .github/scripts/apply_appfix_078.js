#!/usr/bin/env node
// [APP-FIX-078] 三档窗口：大屏(index.html,60%屏高) ⇄ 紧凑(float.html) ⇄ 迷你条；任何一档都能回大屏。
const fs = require('fs');
const K = process.argv[2] || 'app/app/src/main/java/com/ranko/matsuricapture/FloatingWindowService.kt';
const G = process.argv[3] || 'app/app/build.gradle.kts';
let s = fs.readFileSync(K, 'utf8');
if (s.includes('[APP-FIX-078]')) { console.log('already applied'); process.exit(0); }
const rep = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`anchor count=${n}: ${JSON.stringify(a.slice(0, 60))}`);
  s = s.split(a).join(b);
};

// 1) 状态位
rep('    private var collapsed = false',
    '    private var collapsed = false\n    // [APP-FIX-078] 紧凑模式（大屏 / 紧凑 二选一）\n    private var compactMode = false');

// 2) URL 常量
rep('        private const val FLOAT_URL = "http://127.0.0.1:18766/"',
`        private const val FLOAT_URL = "http://127.0.0.1:18766/"
        // [APP-FIX-078] 紧凑页
        private const val SMALL_URL = "http://127.0.0.1:18766/float"`);

// 3) 折叠/展开：展开时强制回大屏并重新载入主面板
rep(`                    // 展开：高度先给一屏内的默认值，页面下一次 render 的 reportHeight 会收紧
                    // [APP-FIX-077] 展开=大框
                    wlp.height = (0.60 * resources.displayMetrics.heightPixels).toInt()
                    w.layoutParams = wlp
                    header.visibility = View.VISIBLE
                    w.evaluateJavascript("window.setMini&&setMini(false)", null)`,
`                    // [APP-FIX-078] 展开：一定回到大屏 + 主面板，杜绝回不去
                    compactMode = false
                    wlp.height = (0.60 * resources.displayMetrics.heightPixels).toInt()
                    w.layoutParams = wlp
                    header.visibility = View.VISIBLE
                    w.loadUrl(FLOAT_URL)`);

// 4) ⤢ 改成 大屏 ⇄ 紧凑 切换（不再只缩放，且始终可逆）
rep(`        // 缩放：100% → 70% → 45% 循环，页面整体 zoom，窗口宽度同步缩（露出游戏画面）
        scaleBtn.setOnClickListener {
            scaleIdx = (scaleIdx + 1) % SCALES.size
            val sc = SCALES[scaleIdx]
            web?.let { w ->
                val wlp = w.layoutParams as LinearLayout.LayoutParams
                wlp.width = ((0.94 * resources.displayMetrics.widthPixels) * sc).toInt()
                w.layoutParams = wlp
                w.evaluateJavascript("window.setZoom&&setZoom($sc)", null)
            }
            scaleBtn.text = if (sc >= 1f) "⤢" else "\${(sc * 100).toInt()}"
            wm?.updateViewLayout(container, lp)
        }`,
`        // [APP-FIX-078] ⤢ = 大屏 ⇄ 紧凑，两档互相可逆
        scaleBtn.setOnClickListener {
            compactMode = !compactMode
            web?.let { w ->
                val wlp = w.layoutParams as LinearLayout.LayoutParams
                wlp.width = (0.94 * resources.displayMetrics.widthPixels).toInt()
                if (compactMode) {
                    wlp.height = dp(360)
                    w.layoutParams = wlp
                    w.loadUrl(SMALL_URL)
                } else {
                    wlp.height = (0.60 * resources.displayMetrics.heightPixels).toInt()
                    w.layoutParams = wlp
                    w.loadUrl(FLOAT_URL)
                }
            }
            scaleBtn.text = if (compactMode) "▣" else "⤢"
            wm?.updateViewLayout(container, lp)
        }`);

// 5) 迷你条点一下 = 回大屏（原来只能拖）
rep(`        web?.setOnTouchListener { _, ev ->
            if (!collapsed) return@setOnTouchListener false`,
`        web?.setOnTouchListener { _, ev ->
            if (!collapsed) return@setOnTouchListener false
            // [APP-FIX-078] 迷你条轻点=回到大屏
            if (ev.action == MotionEvent.ACTION_UP) {
                val dx = Math.abs(ev.rawX - tx)
                val dy = Math.abs(ev.rawY - ty)
                if (dx < dp(8) && dy < dp(8)) {
                    collapsed = false
                    compactMode = false
                    minBtn.text = "—"
                    web?.let { w ->
                        val wlp = w.layoutParams as LinearLayout.LayoutParams
                        wlp.height = (0.60 * resources.displayMetrics.heightPixels).toInt()
                        w.layoutParams = wlp
                        w.loadUrl(FLOAT_URL)
                    }
                    header.visibility = View.VISIBLE
                    wm?.updateViewLayout(container, lp)
                    return@setOnTouchListener true
                }
            }`);

fs.writeFileSync(K, s);

let g = fs.readFileSync(G, 'utf8');
g = g.replace(/versionCode = \d+/, 'versionCode = 20')
     .replace(/versionName = "[^"]*"/, 'versionName = "0.7.8-dsh3"');
fs.writeFileSync(G, g);
console.log('app-fix-078 applied');