#!/usr/bin/env node
// [HOOKTRACE-3292] 给游戏主线程上的 hook 加轻量打点，定位 MT 段错误出自哪个 hook。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [HOOKTRACE-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }

const pairs = [
  ['extern "C" fn training_hook_handler(', 'H:train'],
  ['extern "C" fn exec_training_hook(', 'H:exec_train'],
  ['extern "C" fn failure_rate_hook(', 'H:fail_rate'],
  ['extern "C" fn event_choice_hook_handler(', 'H:event_choice'],
  ['extern "C" fn event_add_choice_hook_handler(', 'H:add_choice'],
  ['extern "C" fn story_set_hook_handler(', 'H:story'],
];
for (const [sig, tag] of pairs) {
  const i = s.indexOf(sig);
  if (i < 0) throw new Error('missing handler: ' + sig);
  const brace = s.indexOf('{', i);
  if (brace < 0) throw new Error('no brace: ' + sig);
  const ins = `\n    ${MARK} ${tag}\n    log_predict_step("${tag}");`;
  s = s.slice(0, brace + 1) + ins + s.slice(brace + 1);
}
fs.writeFileSync(P, s);
console.log('hooktrace applied');