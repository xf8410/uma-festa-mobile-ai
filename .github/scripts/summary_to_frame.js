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
const persons = (src.support_cards || []).map(c => {
  const cid = Number(c.support_card_id || c.id || 0);
  const p = partnerByCard[cid] || {};
  return {
    personType: FRIEND_CARDS.includes(cid) ? 1 : 2,
    charaId: Number((CARD_DB && CARD_DB[cid] && CARD_DB[cid].charaId) || p.partner_id || 0),
    friendship: Number(p.current_bond || 0)
  };
});
// personDistribution：5 训练位 × 5 槽，元素是 persons 的下标，-1 = 空
const cardIndexByCard = {};
(src.support_cards || []).forEach((c, i) => { cardIndexByCard[Number(c.support_card_id || c.id || 0)] = i; });
const personDistribution = [0, 1, 2, 3, 4].map(() => [-1, -1, -1, -1, -1]);
(src.trainings || []).forEach(t => {
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
const acts = (festaSrc.acts || []).map(a => ({
  actType: Number(a.act_type || 0),
  gauge: Number(a.gauge || 0),
  level: Number(a.level || 0),
  needGauge: Number(a.need_gauge || 0),
  adviceId: Number(a.advice_id || 0),
  fusionId: Number(a.fusion_advice_id || 0) || undefined,
  outingGainLevel: Number(a.friend_outing_gain_act_level || 0)
}));
const cps = (festaSrc.checkpoints || []).map(c => ({ scheduleId: Number(c.schedule_id || 0), resultType: Number(c.result_type || 0) }));
// festa.persons 只能含「卡位人头」（不含友人卡），按 personDistribution 反推；targetId = persons 下标
const friendIndex = new Set();
(src.support_cards || []).forEach((c, i) => {
  const cid = Number(c.support_card_id || c.id || 0);
  if (FRIEND_CARDS.includes(cid)) friendIndex.add(i);
});
const fPersons = [];
personDistribution.forEach((row, actIdx) => {
  row.forEach(pi => {
    if (pi < 0 || friendIndex.has(pi)) return;
    fPersons.push({ targetId: pi, actType: actIdx + 1, origin: 'card' });
  });
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
  zhongMaBlueCount: [0, 0, 0, 0, 0],
  isRacing: false,
  cardId: cards,
  persons,
  personDistribution,
  lockedTrainingId: -1,
  friendship_noncard_yayoi: 0,
  friendship_noncard_reporter: 0,
  friend_stage: 0,
  friend_outgoingUsed: 0,
  playing_state: 1,
  source: 'command',
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