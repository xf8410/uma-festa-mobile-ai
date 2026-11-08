#!/usr/bin/env node
// [APP-FIX-090] FrameAdapter 接上 SO 新补的三字段（3.29.2-fields 起 /summary 会带）：
//   total_hints          → baseGame.totalHints
//   playing_state        → baseGame.playing_state
//   friend_outgoing_used → baseGame.friend_outgoingUsed
const fs = require('fs');
const P = process.argv[2];
if (!P) throw new Error('usage: apply_appfix_090.js <FrameAdapter.kt>');
let s = fs.readFileSync(P, 'utf8');
if (s.includes('[APP-FIX-090]')) { console.log('already applied'); process.exit(0); }
const once = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.log('skip (count=' + n + '): ' + JSON.stringify(a.slice(0, 50))); return; }
  s = s.split(a).join(b);
};

once(
  '        base.put("totalHints", 0)',
  '        base.put("totalHints", src.optInt("total_hints", 0)) // [APP-FIX-090]'
);
once(
  '        base.put("playing_state", 1)',
  '        base.put("playing_state", if (src.has("playing_state")) src.optInt("playing_state", 1) else 1) // [APP-FIX-090]'
);
once(
  '        base.put("friend_outgoingUsed", 0)',
  '        base.put("friend_outgoingUsed", src.optInt("friend_outgoing_used", 0)) // [APP-FIX-090]'
);
fs.writeFileSync(P, s);
console.log('app-fix-090 applied');