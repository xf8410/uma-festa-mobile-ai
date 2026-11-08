package com.ranko.matsuricapture

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** [ENGINE-ADAPTER] /summary → 上游引擎帧（Envelope{festa, baseGame}）
 *
 * 映射口径已用仓库 CI 的真引擎验证（`.github/scripts/summary_to_frame.js` 同源）：
 *  - cardId = 卡 ID × 10 + 突破等级（合并值）
 *  - persons 数量必须 == 卡组张数，且 persons[i].charaId == cardDb[cardId[i]].charaId
 *  - personDistribution 必须 5×5（persons 下标，-1 = 空）
 *  - 编成校验：6 张、必带 SSR 吾妻、无团队卡
 */
object FrameAdapter {
    private const val FRIEND_CARD = 30323
    private const val FRIEND_CARD_R = 10149
    @Volatile private var cardDb: JSONObject? = null

    fun loadCardDb(file: File) {
        if (cardDb != null) return
        cardDb = runCatching { JSONObject(file.readText()) }.getOrNull()
    }

    private fun cardCharaId(cardId: Int): Int {
        val db = cardDb ?: return 0
        val o = db.optJSONObject(cardId.toString()) ?: return 0
        return o.optInt("charaId", 0)
    }

    private fun arrInt(a: JSONArray?): IntArray {
        if (a == null) return IntArray(0)
        val out = IntArray(a.length())
        for (i in 0 until a.length()) out[i] = a.optInt(i, 0)
        return out
    }

    fun toFrame(src: JSONObject): JSONObject {
        val notes = JSONArray()
        val st = src.optJSONObject("stats") ?: JSONObject()
        val five = intArrayOf(st.optInt("speed", 0), st.optInt("stamina", 0), st.optInt("power", 0), st.optInt("guts", 0), st.optInt("wiz", 0))
        val mx = src.optJSONObject("max_stats") ?: JSONObject()
        val fiveLimit = intArrayOf(mx.optInt("speed", 0), mx.optInt("stamina", 0), mx.optInt("power", 0), mx.optInt("guts", 0), mx.optInt("wiz", 0))
        val mon = maxOf(1, src.optInt("month", 1))
        val half = maxOf(1, src.optInt("half", 1))
        val turn = minOf(77, maxOf(0, (mon - 1) * 2 + (half - 1)))
        val lv = arrInt(src.optJSONArray("training_levels"))
        val trainLevel = IntArray(5) { if (it < lv.size) lv[it] else 0 }

        val cardsJson = src.optJSONArray("support_cards") ?: JSONArray()
        val cardIds = ArrayList<Int>()
        val cardPlain = ArrayList<Int>()
        val persons = ArrayList<JSONObject>()
        val bondByCard = HashMap<Int, Int>()
        val trainings = src.optJSONArray("trainings") ?: JSONArray()
        for (i in 0 until trainings.length()) {
            val t = trainings.optJSONObject(i) ?: continue
            val ps = t.optJSONArray("partners") ?: continue
            for (j in 0 until ps.length()) {
                val p = ps.optJSONObject(j) ?: continue
                val cid = p.optInt("support_card_id", 0)
                if (cid > 0 && !bondByCard.containsKey(cid)) bondByCard[cid] = p.optInt("current_bond", 0)
            }
        }
        for (i in 0 until cardsJson.length()) {
            val c = cardsJson.optJSONObject(i) ?: continue
            val id = c.optInt("support_card_id", c.optInt("id", 0))
            if (id <= 0) continue
            val lb = c.optInt("limit_break_count", c.optInt("limit_break", 0))
            cardIds.add(id * 10 + lb)
            cardPlain.add(id)
            val o = JSONObject()
            o.put("personType", if (id == FRIEND_CARD || id == FRIEND_CARD_R) 1 else 2)
            o.put("charaId", cardCharaId(id))
            o.put("friendship", bondByCard[id] ?: 0)
            persons.add(o)
        }
        val cardIndexByCard = HashMap<Int, Int>()
        for (i in cardPlain.indices) cardIndexByCard[cardPlain[i]] = i
        val dist = JSONArray()
        for (k in 0 until 5) {
            val row = JSONArray()
            for (s in 0 until 5) row.put(-1)
            dist.put(row)
        }
        for (i in 0 until trainings.length()) {
            val t = trainings.optJSONObject(i) ?: continue
            val ci = t.optInt("command_id", 0) - 5101
            if (ci < 0 || ci > 4) continue
            val row = dist.getJSONArray(ci)
            var slot = 0
            val ps = t.optJSONArray("partners") ?: continue
            for (j in 0 until ps.length()) {
                val p = ps.optJSONObject(j) ?: continue
                val pi = cardIndexByCard[p.optInt("support_card_id", 0)] ?: continue
                if (slot < 5) {
                    row.put(slot, pi)
                    slot++
                }
            }
        }
        val mot = when (st.optString("motivation", "")) {
            "Worst" -> 1
            "Bad" -> 2
            "Normal" -> 3
            "Good" -> 4
            "Best" -> 5
            else -> 3
        }
        val effects = arrInt(src.optJSONArray("chara_effect_ids"))
        var aijiao = false
        for (e in effects) if (e == 8) aijiao = true

        val base = JSONObject()
        base.put("scenarioId", 15)
        base.put("umaId", src.optInt("chara_id", 0))
        base.put("umaStar", 0)
        base.put("turn", turn)
        base.put("vital", st.optInt("vital", 0))
        base.put("maxVital", st.optInt("max_vital", 0))
        base.put("motivation", mot)
        base.put("fiveStatus", JSONArray(five.toList()))
        base.put("fiveStatusLimit", JSONArray(fiveLimit.toList()))
        base.put("skillPt", st.optInt("skill_point", 0))
        val skills = src.optJSONObject("skills")
        base.put("skillScore", skills?.optInt("eval", 0) ?: 0)
        base.put("totalHints", src.optInt("total_hints", 0)) // [APP-FIX-090]
        base.put("trainLevelCount", JSONArray(trainLevel.toList()))
        base.put("ptScoreRate", 1.0)
        base.put("failureRateBias", 0)
        base.put("isIll", false)
        base.put("isQieZhe", false)
        base.put("isAiJiao", aijiao)
        base.put("zhongMaBlueCount", JSONArray(listOf(0, 0, 0, 0, 0)))
        base.put("isRacing", false)
        base.put("cardId", JSONArray(cardIds))
        base.put("persons", JSONArray(persons.toList()))
        base.put("personDistribution", dist)
        base.put("lockedTrainingId", -1)
        base.put("friendship_noncard_yayoi", 0)
        base.put("friendship_noncard_reporter", 0)
        base.put("friend_stage", 0)
        base.put("friend_outgoingUsed", src.optInt("friend_outgoing_used", 0)) // [APP-FIX-090]
        base.put("playing_state", if (src.has("playing_state")) src.optInt("playing_state", 1) else 1) // [APP-FIX-090]
        base.put("source", "command")
        base.put("isAfterTraining", false)
        base.put("single_mode_chara_id", src.optInt("chara_id", 0))

        val fs = src.optJSONObject("festa") ?: JSONObject()
        val acts = JSONArray()
        val fa = fs.optJSONArray("acts") ?: JSONArray()
        for (i in 0 until fa.length()) {
            val a = fa.optJSONObject(i) ?: continue
            acts.put(JSONObject().apply {
                put("actType", a.optInt("act_type", 0))
                put("gauge", a.optInt("gauge", 0))
                put("level", a.optInt("level", 0))
                put("needGauge", a.optInt("need_gauge", 0))
                put("adviceId", a.optInt("advice_id", 0))
                put("outingGainLevel", a.optInt("friend_outing_gain_act_level", 0))
            })
        }
        val cpsJ = JSONArray()
        val fc = fs.optJSONArray("checkpoints") ?: JSONArray()
        for (i in 0 until fc.length()) {
            val c = fc.optJSONObject(i) ?: continue
            cpsJ.put(JSONObject().apply {
                put("scheduleId", c.optInt("schedule_id", 0))
                put("resultType", c.optInt("result_type", 0))
            })
        }
        // [APP-FIX-097] festa.persons 只含卡位人头（persons 下标，不含友人卡），按分布反推
        val friendIdx = HashSet<Int>()
        for (i in cardPlain.indices) {
            if (cardPlain[i] == FRIEND_CARD || cardPlain[i] == FRIEND_CARD_R) friendIdx.add(i)
        }
        val fPersons = JSONArray()
        for (ai in 0 until 5) {
            val row = dist.getJSONArray(ai)
            for (k in 0 until row.length()) {
                val pi = row.optInt(k, -1)
                if (pi < 0 || friendIdx.contains(pi)) continue
                fPersons.put(JSONObject().apply {
                    put("targetId", pi)
                    put("actType", ai + 1)
                    put("origin", "card")
                })
            }
        }
        // [APP-FIX-091] 稽古掷中标记：acts[].state（SO 的 ActTrainingState）非 0 视为已掷中
        val kensanArr = JSONArray()
        for (i in 0 until fa.length()) {
            val a = fa.optJSONObject(i) ?: continue
            kensanArr.put(a.optInt("state", 0) != 0)
        }
        if (kensanArr.length() != 5) notes.put("kensan_missing_or_partial")
        val finfo = fs.optJSONObject("festa_info")
        val festa = JSONObject().apply {
            put("acts", acts)
            // [APP-FIX-097] 合宿剩余回合 / 演目最高等级用游戏真值
            put("maxActLevel", finfo?.optInt("max_act_level", 10) ?: 10)
            put("campRemain", if (finfo != null && finfo.has("summer_camp_remain_turn")) finfo.optInt("summer_camp_remain_turn", 0) else JSONObject.NULL)
            put("assistSupportLeft", JSONObject.NULL)
            put("fatigueRecovery", false)
            put("checkPoints", if (cpsJ.length() > 0) cpsJ else JSONObject.NULL)
            put("trainLevelTotal", JSONArray(trainLevel.toList()))
            put("kensan", if (kensanArr.length() == 5) kensanArr else JSONObject.NULL) // [APP-FIX-091]
            put("persons", fPersons)
        }
        val frame = JSONObject()
        frame.put("baseGame", base)
        frame.put("festa", festa)
        frame.put("_adapter_notes", notes)
        return frame
    }
}