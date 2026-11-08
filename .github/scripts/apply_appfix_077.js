#!/usr/bin/env node
// [APP-FIX-077] 游戏内悬浮窗改成「大面板」：加载 index.html，固定占用约 60% 屏高，可原生滚动。
const fs = require('fs');
const K = process.argv[2] || 'app/app/src/main/java/com/ranko/matsuricapture/FloatingWindowService.kt';
const G = process.argv[3] || 'app/app/build.gradle.kts';
let s = fs.readFileSync(K, 'utf8');
if (s.includes('// [APP-FIX-077]')) { console.log('already applied'); process.exit(0); }

const rep = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`anchor count=${n}: ${JSON.stringify(a.slice(0, 60))}`);
  s = s.split(a).join(b);
};

// 1) 悬浮窗加载主面板（大框）而不是紧凑 float 页
rep('private const val FLOAT_URL = "http://127.0.0.1:18766/float"',
    '// [APP-FIX-077] 大面板：加载主面板页\n        private const val FLOAT_URL = "http://127.0.0.1:18766/"');

// 2) 初始高度给大框
rep('            val w = (0.94 * resources.displayMetrics.widthPixels).toInt()\n            layoutParams = LinearLayout.LayoutParams(w, dp(320))',
`            val w = (0.94 * resources.displayMetrics.widthPixels).toInt()
            // [APP-FIX-077] 初始就给大框高度（约 60% 屏高），不再靠页面回执收成小条
            val bigH = (0.60 * resources.displayMetrics.heightPixels).toInt()
            layoutParams = LinearLayout.LayoutParams(w, bigH)`);

// 3) 展开时也回到大框
rep('                    wlp.height = dp(320)\n                    w.layoutParams = wlp\n                    header.visibility = View.VISIBLE',
`                    // [APP-FIX-077] 展开=大框
                    wlp.height = (0.60 * resources.displayMetrics.heightPixels).toInt()
                    w.layoutParams = wlp
                    header.visibility = View.VISIBLE`);

fs.writeFileSync(K, s);

// 4) 版本 0.7.7 / 19
let g = fs.readFileSync(G, 'utf8');
g = g.replace(/versionCode = \d+/, 'versionCode = 19')
     .replace(/versionName = "[^"]*"/, 'versionName = "0.7.7-dsh2"');
fs.writeFileSync(G, g);
console.log('app-fix-077 applied');