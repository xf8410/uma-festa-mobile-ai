#!/usr/bin/env node
// [APP-FIX-097] 帧被引擎拒收（「帧内卡位人头多于卡组非友人卡（targetId=6，卡组 6 张）」）：
//   festa.persons 必须只含「卡位人头」（persons 下标，不含友人卡），按 personDistribution 反推；
//   原来用游戏给的 target_id（人物 id，6 这种）→ 引擎判定超出卡组。
// 另外：合宿信息补上（festa_info.summer_camp_remain_turn / max_act_level），引擎靠 campRemain 判断合宿。
const fs = require('fs');
const P = process.argv[2];
if (!P) throw new Error('usage: apply_appfix_097.js <FrameAdapter.kt>');
let s = fs.readFileSync(P, 'utf8');
if (s.includes('[APP-FIX-097]')) { console.log('already applied'); process.exit(0); }
const once = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error('anchor count=' + n + ' for: ' + JSON.stringify(a.slice(0, 60)));
  s = s.split(a).join(b);
};

// 1) festa.persons 改按分布反推
once(
  '        val fPersons = JSONArray()\n        val fp = fs.optJSONArray("persons") ?: JSONArray()\n        for (i in 0 until fp.length()) {\n            val p = fp.optJSONObject(i) ?: continue\n            fPersons.put(JSONObject().apply {\n                put("targetId", p.optInt("target_id", p.optInt("chara_id", 0)))\n                put("actType", p.optInt("act_type", 0))\n                put("origin", p.optString("origin", "card"))\n            })\n        }',
  '        // [APP-FIX-097] festa.persons 只含卡位人头（persons 下标，不含友人卡），按分布反推\n' +
  '        val friendIdx = HashSet<Int>()\n' +
  '        for (i in cardPlain.indices) {\n' +
  '            if (cardPlain[i] == FRIEND_CARD || cardPlain[i] == FRIEND_CARD_R) friendIdx.add(i)\n' +
  '        }\n' +
  '        val fPersons = JSONArray()\n' +
  '        for (ai in 0 until 5) {\n' +
  '            val row = dist.getJSONArray(ai)\n' +
  '            for (k in 0 until row.length()) {\n' +
  '                val pi = row.optInt(k, -1)\n' +
  '                if (pi < 0 || friendIdx.contains(pi)) continue\n' +
  '                fPersons.put(JSONObject().apply {\n' +
  '                    put("targetId", pi)\n' +
  '                    put("actType", ai + 1)\n' +
  '                    put("origin", "card")\n' +
  '                })\n' +
  '            }\n' +
  '        }'
);

// 2) 合宿信息
once(
  '        val festa = JSONObject().apply {\n            put("acts", acts)\n            put("maxActLevel", 10)\n            put("campRemain", JSONObject.NULL)',
  '        val finfo = fs.optJSONObject("festa_info")\n' +
  '        val festa = JSONObject().apply {\n' +
  '            put("acts", acts)\n' +
  '            // [APP-FIX-097] 合宿剩余回合 / 演目最高等级用游戏真值\n' +
  '            put("maxActLevel", finfo?.optInt("max_act_level", 10) ?: 10)\n' +
  '            put("campRemain", if (finfo != null && finfo.has("summer_camp_remain_turn")) finfo.optInt("summer_camp_remain_turn", 0) else JSONObject.NULL)'
);

fs.writeFileSync(P, s);
console.log('app-fix-097 applied');