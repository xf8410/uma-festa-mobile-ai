#!/usr/bin/env node
// [FIELDS-3292] 给 /summary 补上引擎帧还缺的 3 个字段：
//   playing_state        → Gallop.WorkSingleModeData._playingState（ObscuredInt）
//   friend_outgoing_used → WorkSingleModeCharaData.GuestOutingInfoList 里友人卡(30323/10149) 的 story_step
//   total_hints          → Σ skill_tips[].level
// 插入点必须在 [SCORE-3292] 之后（那里 __out 才存在），且不能早于 LUCK 块
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [FIELDS-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }
const once = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error('anchor count=' + n + ' for: ' + JSON.stringify(a.slice(0, 60)));
  s = s.split(a).join(b);
};

const BLOCK = [
'    ' + MARK + ' 补帧字段：playing_state / friend_outgoing_used / total_hints',
'    {',
'        let mut playing_state = 0i32;',
'        if !sm_class.is_null() && !sm_obj.is_null() {',
'            playing_state = read_obscured_field(sm_obj as *const c_void, sm_class, "_playingState");',
'        }',
'        let mut friend_used = -1i32;',
'        if !chara_class.is_null() && !chara_obj.is_null() {',
'            let g_list = read_field_value(chara_class, chara_obj, "GuestOutingInfoList");',
'            for e in walk_obj_list(g_list) {',
'                let ei = e as *const c_void;',
'                let eclass = get_class_from_object(ei);',
'                if eclass.is_null() { continue; }',
'                let cid = call_getter_int(eclass, ei, "get_SupportCardId");',
'                if cid == 30323 || cid == 10149 {',
'                    let step = call_getter_int(eclass, ei, "get_StoryStep");',
'                    if step >= 0 { friend_used = step; break; }',
'                }',
'            }',
'        }',
'        let total_hints: i32 = read_skill_tips(chara_class, chara_obj, image).iter().map(|t| t.2).sum();',
'        if let Some(pos) = __out.rfind(\'}\') {',
'            __out.insert_str(pos, &format!(",\\"playing_state\\":{},\\"friend_outgoing_used\\":{},\\"total_hints\\":{}", playing_state, friend_used, total_hints));',
'        }',
'    }',
].join('\n');

const anchor = '                    total_s, five_s, pt_s\n                ),\n            );\n        }\n    }';
once(anchor, anchor + '\n' + BLOCK);
fs.writeFileSync(P, s);
console.log('fields patch applied');