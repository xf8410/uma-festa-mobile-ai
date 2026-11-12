#!/usr/bin/env node
// [/summary → 引擎帧] 把 SO 的 /summary 转成上游引擎要的 thisTurn.json（Envelope{festa, baseGame}）
// 依据：matsuri-ai/src/frame.rs（Envelope）+ umaai/src/protocol/base.rs（BaseStatus）
//      + 上游 docs/issues.md：cardId = 卡 ID × 10 + 突破等级；persons[i].charaId 必须对得上
// 原则：源数据没有的字段不编造，填保守值并写进 _adapter_notes（引擎忽略未知键）
const fs = require('fs');
const src = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const notes = [];
const MOT = { Worst: 1, Bad: 2, Normal: 3, Good: 4, Best: 5 };
const st = src.stats || {};
const five = [st.speed || 0, st.stamina || 0, st.power || 0, st.guts || 0, st.wiz || 0];
const lim = src.max_stats || {};
const fiveLimit = [lim.speed || 0, lim.stamina || 0, lim.power || 0, lim.guts || 0, lim.wiz || 0];
const turn = Math.max(0, Math.min(77, (Math.max(1, src.month || 1) - 1) * 2 + (Math.max(1, src.half || 1) - 1)));
// training_levels 是 [{command_id, level}]（不是 5 个数字）：稽古位 5101-5105 优先，退化到设施 101-105
const lvList = Array.isArray(src.training_levels) ? src.training_levels : [];
const levelOf = id => {
  const e = lvList.find(x => Number(x && x.command_id) === id);
  return e ? Number(e.level || 0) : 0;
};
let trainLevelCount = [5101, 5102, 5103, 5104, 5105].map(levelOf);
if (trainLevelCount.every(v => v === 0)) trainLevelCount = [101, 102, 103, 104, 105].map(levelOf);
// 协议 cardId 是「卡 ID × 10 + 突破等级」的合并值
const cards = (src.support_cards || []).map(c => {
  const id = Number(c.support_card_id || c.id || 0);
  const lb = Number(c.limit_break_count || c.limit_break || 0);
  return id > 0 ? id * 10 + lb : 0;
}).filter(x => x > 0);
const effects = (src.chara_effect_ids || []).map(Number);
const isAijiao = effects.includes(8);
if (!effects.length) notes.push('chara_effect_ids empty');
// [APP-FIX-113] 待选多选项事件判定（与 FrameAdapter.kt 同口径）
function isEventPending(s) {
  return Number(s.story_id || 0) > 0 && Number(s.story_choices || 0) > 1 && Number(s.story_selected ?? -1) < 0;
}
// 人头：引擎要求 persons 数量 == 卡组张数；friend 卡（30323/10149）personType=1，其余 2
const FRIEND_CARDS = [30323, 10149];
const partnerByCard = {};
(src.trainings || []).forEach(t => (t.partners || []).forEach(p => {
  const cid = Number(p.support_card_id || 0);
  if (cid && !partnerByCard[cid]) partnerByCard[cid] = p;
}));
// cardDB（App 里已随包）：id → charaId / cardType；给人头填对 chara_id
const CARD_DB = (() => {
  const p = process.env.CARD_DB;
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { notes.push('cardDB unreadable'); return null; }
})();
// [APP-FIX-105] 羁绊双源：Festa 布局 partners 恒空 → 主源 evaluation 段（target_id→bond），
// target_id 由 festa.persons 的 chara_id 匹配卡位反查；partners 路径兜底。
const bondByTarget = {};
(src.evaluation || []).forEach(e => {
  const tid = Number(e.target_id || e.partner_id || 0);
  if (tid > 0) bondByTarget[tid] = Number(e.current_bond || e.evaluation || 0);
});
const festaSrcEarly = src.festa || {};
const festaPersons = (festaSrcEarly.persons || []).map(p => ({
  targetId: Number(p.target_id || p.targetId || 0),
  charaId: Number(p.chara_id || p.charaId || 0),
  actType: Number(p.act_type || p.actType || 0)
})).filter(p => p.targetId > 0);
const cardChara = cid => Number((CARD_DB && CARD_DB[cid] && CARD_DB[cid].charaId) || 0);
const slotByChara = {};
(src.support_cards || []).forEach((c, i) => {
  const cid = Number(c.support_card_id || c.id || 0);
  const ch = cardChara(cid);
  if (ch > 0) slotByChara[ch] = i;
});
const targetBySlot = {};
festaPersons.forEach(fp => {
  // targetId>=1000 = 神驹段（restore.rs PROTOCOL_GUEST_ID_MIN）；卡角色 charaId 本身可 ≥1000
  if (fp.targetId >= 1 && fp.targetId <= 999) {
    const slot = slotByChara[fp.charaId];
    if (slot !== undefined && targetBySlot[slot] === undefined) targetBySlot[slot] = fp.targetId;
  }
});
const persons = (src.support_cards || []).map((c, i) => {
  const cid = Number(c.support_card_id || c.id || 0);
  const p = partnerByCard[cid] || {};
  const bondViaFesta = targetBySlot[i] !== undefined ? bondByTarget[targetBySlot[i]] : undefined;
  return {
    personType: FRIEND_CARDS.includes(cid) ? 1 : 2,
    charaId: cardChara(cid) || Number(p.partner_id || 0),
    friendship: Number(bondViaFesta !== undefined ? bondViaFesta : (p.current_bond || 0))
  };
});
// personDistribution：5 训练位 × 5 槽，元素是 persons 的下标（卡位）/ chara_id（神驹≥1000），-1 = 空
// [APP-FIX-105] 主源 = festa.persons（按 target_id 升序，restore.rs 落位口径）；partners 反推兜底
const cardIndexByCard = {};
(src.support_cards || []).forEach((c, i) => { cardIndexByCard[Number(c.support_card_id || c.id || 0)] = i; });
const personDistribution = [0, 1, 2, 3, 4].map(() => [-1, -1, -1, -1, -1]);
let distFromFesta = false;
{
  const counts = [0, 0, 0, 0, 0];
  [...festaPersons].sort((a, b) => a.targetId - b.targetId).forEach(fp => {
    if (fp.actType < 1 || fp.actType > 5) return;
    if (fp.targetId >= 101 && fp.targetId <= 115) return; // NPC 占位
    const row = fp.actType - 1;
    if (counts[row] >= 5) return;
    let v;
    if (fp.targetId >= 1000) v = fp.charaId;
    else { const s = slotByChara[fp.charaId]; if (s === undefined) return; v = s; }
    personDistribution[row][counts[row]++] = v;
    distFromFesta = true;
  });
}
if (!distFromFesta) (src.trainings || []).forEach(t => {
  const ci = Number(t.command_id || 0) - 5101;
  if (ci < 0 || ci > 4) return;
  let slot = 0;
  (t.partners || []).forEach(p => {
    const cid = Number(p.support_card_id || 0);
    const pi = cardIndexByCard[cid];
    if (pi === undefined || pi === null) return;
    if (slot < 5) personDistribution[ci][slot++] = pi;
  });
});
const festaSrc = src.festa || {};
// [APP-FIX-109] 転成教诲：festa.advice[] 是 advice_id→fusion 对，按 act.advice_id 反查
const fadvPairs = festaSrc.advice || [];
const fusionOf = aid => {
  if (!aid) return 0;
  const hit = fadvPairs.find(e => Number(e.advice_id || 0) === aid);
  return hit ? Number(hit.fusion_advice_id || 0) : 0;
};
const acts = (festaSrc.acts || []).map(a => ({
  actType: Number(a.act_type || 0),
  gauge: Number(a.gauge || 0),
  level: Number(a.level || 0),
  needGauge: Number(a.need_gauge || 0),
  adviceId: Number(a.advice_id || 0),
  fusionId: fusionOf(Number(a.advice_id || 0)) || Number(a.fusion_advice_id || 0) || undefined,
  outingGainLevel: Number(a.friend_outing_gain_act_level || 0)
}));
const cps = (festaSrc.checkpoints || []).map(c => ({ scheduleId: Number(c.schedule_id || 0), resultType: Number(c.result_type || 0) }));
// [APP-FIX-105] 帧 festa.persons 直传 SO 剧本段（上游 FestaPerson：targetId/actType/origin）：
// 卡位 chara_id 命中卡组 → card（吾妻 → friend）；chara_id>=1000 → guest；101..115 占位丢弃
const fPersons = [];
[...festaPersons].sort((a, b) => a.targetId - b.targetId).forEach(fp => {
  if (fp.targetId >= 101 && fp.targetId <= 115) return;
  let origin;
  if (fp.targetId >= 1000) origin = 'guest';
  else {
    const slot = slotByChara[fp.charaId];
    if (slot === undefined) return;
    const cid = Number((src.support_cards || [])[slot] && ((src.support_cards || [])[slot].support_card_id || (src.support_cards || [])[slot].id) || 0);
    origin = FRIEND_CARDS.includes(cid) ? 'friend' : 'card';
  }
  fPersons.push({ targetId: fp.targetId, actType: fp.actType, origin });
});
const baseGame = {
  scenarioId: 15,
  umaId: Number(src.chara_id || 0),
  umaStar: 0,
  turn,
  vital: Number(st.vital || 0),
  maxVital: Number(st.max_vital || 0),
  motivation: MOT[st.motivation] || 3,
  fiveStatus: five,
  fiveStatusLimit: fiveLimit,
  skillPt: Number(st.skill_point || 0),
  skillScore: Number((src.skills && src.skills.eval) || 0),
  totalHints: 0,
  trainLevelCount,
  ptScoreRate: 1.0,
  failureRateBias: 0,
  isIll: false,
  isQieZhe: false,
  isAiJiao: isAijiao,
  // [APP-FIX-112] 全量状态 ID 透传（与 FrameAdapter.kt 同口径）：引擎按 142 表判病种（变胖只认这条路）
  charaEffects: effects,
  zhongMaBlueCount: [0, 0, 0, 0, 0],
  isRacing: false,
  cardId: cards,
  persons,
  personDistribution,
  lockedTrainingId: -1,
  friendship_noncard_yayoi: bondByTarget[102] || 0,   // [APP-FIX-105] 102=理事长
  friendship_noncard_reporter: bondByTarget[103] || 0, // [APP-FIX-105] 103=记者
  friend_stage: 0,
  friend_outgoingUsed: 0,
  // [APP-FIX-109] 教诲窗口路由：playing_state=51 → special 帧（上游 route() 口径），引擎才走 Advice 分配决策
  playing_state: Number(src.playing_state || 1),
  // [APP-FIX-113] 事件帧（上游 G16）：待选多选项事件（id>0 && choices>1 && 未选择）→ source=event + storyId，
  // 引擎查本地事件表给选项建议；未收录引擎自己 Skip，不回落成训练建议
  source: Number(src.playing_state || 1) === 51 ? 'special'
    : (isEventPending(src) ? 'event' : 'command'),
  ...(isEventPending(src) ? { storyId: Number(src.story_id) } : {}),
  isAfterTraining: false,
  single_mode_chara_id: Number(src.chara_id || 0)
};
const frame = {
  baseGame,
  festa: {
    acts,
    maxActLevel: 10,
    campRemain: null,
    assistSupportLeft: null,
    fatigueRecovery: false,
    checkPoints: cps.length ? cps : null,
    trainLevelTotal: trainLevelCount,
    kensan: null,
    persons: fPersons
  },
  _adapter_notes: notes
};
process.stdout.write(JSON.stringify(frame));