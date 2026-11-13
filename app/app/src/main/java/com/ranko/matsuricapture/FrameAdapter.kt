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

    // [APP-FIX-115] keyEvents 持久跟踪（上游：事件历史只能由 keyEvents 换算，否则 rollout
    // 后续事件抽取与真机不一致——支援卡连续事件按段归 8001/8002/8003、friend_first_event
    // 命中纠正友人 UnClicked→BeforeUnlock）。SO 只透传「当前事件」三元组，历史由本跟踪器
    // 按局种子（fixed_turn_chara_seed）分桶持久化：事件挂起（story_id>0 未选择）→ 消失
    // 或已选择 = 已发生，入账。
    @Volatile private var stateDir: File? = null
    private var trackEpoch: Long = -1
    private var trackPending: Int = 0
    private var trackFirstTurn: Int = -1
    private val trackEvents = sortedSetOf<Int>()

    fun initState(dir: File) {
        stateDir = dir
    }

    private fun trackFile(): File? = stateDir?.let { File(it, "key_events.json") }

    private fun trackLoad(epoch: Long) {
        trackEpoch = epoch
        trackPending = 0
        trackFirstTurn = -1
        trackEvents.clear()
        val f = trackFile() ?: return
        runCatching {
            val o = JSONObject(f.readText())
            if (o.optLong("epoch", -1) == epoch) {
                trackFirstTurn = o.optInt("firstTurn", -1)
                val a = o.optJSONArray("events") ?: JSONArray()
                for (i in 0 until a.length()) trackEvents.add(a.optInt(i, 0))
            }
        }
    }

    private fun trackSave() {
        val f = trackFile() ?: return
        runCatching {
            f.parentFile?.mkdirs()
            val a = JSONArray()
            for (e in trackEvents) a.put(e)
            f.writeText(JSONObject().apply {
                put("epoch", trackEpoch)
                put("firstTurn", trackFirstTurn)
                put("events", a)
            }.toString())
        }
    }

    /** 事件跟踪 + 局号。返回 Pair(局号, keyEvents 快照)。 */
    @Synchronized
    private fun trackEventFrame(src: JSONObject, turn: Int, storyId: Int, storySelected: Int): Pair<Long, List<Int>> {
        val seed = src.optLong("fixed_turn_chara_seed", 0)
        val epoch: Long = if (seed > 0) seed else src.optInt("chara_id", 0).toLong()
        if (epoch != trackEpoch) trackLoad(epoch)
        if (trackFirstTurn < 0 || turn < trackFirstTurn) trackFirstTurn = turn
        // 挂起事件消失（已结算/被跳过）或已选择 → 入账
        if (trackPending > 0 && (storyId != trackPending || storySelected >= 0)) {
            trackEvents.add(trackPending)
            trackPending = 0
            trackSave()
        }
        if (storyId > 0) {
            if (storySelected >= 0) {
                if (trackEvents.add(storyId)) trackSave()
            } else {
                trackPending = storyId
            }
        }
        return Pair(epoch, trackEvents.toList())
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

    /** [APP-FIX-105] SO festa.persons 条目（snake_case 原样）：target_id / chara_id / act_type */
    private data class FestaPersonLite(val targetId: Int, val charaId: Int, val actType: Int)

    private fun festaPersonList(arr: JSONArray?): List<FestaPersonLite> {
        val out = ArrayList<FestaPersonLite>()
        if (arr == null) return out
        for (i in 0 until arr.length()) {
            val p = arr.optJSONObject(i) ?: continue
            val tid = p.optInt("target_id", p.optInt("targetId", 0))
            if (tid <= 0) continue
            out.add(FestaPersonLite(tid, p.optInt("chara_id", p.optInt("charaId", 0)), p.optInt("act_type", p.optInt("actType", 0))))
        }
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
        // [APP-FIX-105] training_levels 是 [{command_id, level}]（对齐 JS 版 summary_to_frame）：
        // 稽古位 5101-5105 优先，全 0 退化到设施 101-105
        val lvList = src.optJSONArray("training_levels")
        fun levelOf(cmdId: Int): Int {
            if (lvList == null) return 0
            for (i in 0 until lvList.length()) {
                val e = lvList.optJSONObject(i) ?: continue
                if (e.optInt("command_id", 0) == cmdId) return e.optInt("level", 0)
            }
            return 0
        }
        var trainLevel = IntArray(5) { levelOf(5101 + it) }
        if (trainLevel.all { it == 0 }) trainLevel = IntArray(5) { levelOf(101 + it) }

        val cardsJson = src.optJSONArray("support_cards") ?: JSONArray()
        val cardIds = ArrayList<Int>()
        val cardPlain = ArrayList<Int>()
        val persons = ArrayList<JSONObject>()
        // [APP-FIX-105] 羁绊双源：Festa 布局下 trainings[].partners 恒空（SO 不直读非 legacy
        // CommandInfoArray），主源改用 /summary 的 evaluation 段（target_id → current_bond，
        // target_id 空间与 festa.persons 一致）；旧 partners 路径保留为兜底。
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
        val bondByTarget = HashMap<Int, Int>()
        val evalArr = src.optJSONArray("evaluation")
        if (evalArr != null) {
            for (i in 0 until evalArr.length()) {
                val e = evalArr.optJSONObject(i) ?: continue
                val tid = e.optInt("target_id", e.optInt("partner_id", 0))
                if (tid > 0) bondByTarget[tid] = e.optInt("current_bond", e.optInt("evaluation", 0))
            }
        }
        // [APP-FIX-105] festa.persons（SO 直读剧本段，Festa 布局下唯一可靠的人头源）：
        // [{target_id, chara_id, act_type}]；act_type 1..5 = 担当训练位（速耐力根智），
        // 0 = 不占担当（友人 / NPC / 未落位）；chara_id >= 1000 = 编成外神驹；101..115 = NPC 占位。
        val fsEarly = src.optJSONObject("festa") ?: JSONObject()
        val festaPersons = festaPersonList(fsEarly.optJSONArray("persons"))
        // 第一遍：收卡（cardIds 合并值 + cardPlain 纯 ID，保持卡组序）
        for (i in 0 until cardsJson.length()) {
            val c = cardsJson.optJSONObject(i) ?: continue
            val id = c.optInt("support_card_id", c.optInt("id", 0))
            if (id <= 0) continue
            val lb = c.optInt("limit_break_count", c.optInt("limit_break", 0))
            cardIds.add(id * 10 + lb)
            cardPlain.add(id)
            if (cardCharaId(id) <= 0) notes.put("cardDB_missing:" + id)
        }
        // charaId → 卡位下标（cardDB 缺卡 charaId=0 不入表，防 0 撞车误配）
        val slotByChara = HashMap<Int, Int>()
        for (i in cardPlain.indices) {
            val ch = cardCharaId(cardPlain[i])
            if (ch > 0) slotByChara[ch] = i
        }
        // 卡位 → 协议人头 target_id：chara_id 匹配 festa.persons 反查
        // （restore.rs：开新局友人占 1 卡从 2 起 / 载入局卡从 1 起——不做 targetId 算术，按身份反查）
        val targetBySlot = HashMap<Int, Int>()
        for (fp in festaPersons) {
            // targetId>=1000 = 神驹段（restore.rs PROTOCOL_GUEST_ID_MIN）；卡角色 charaId 本身可 ≥1000
            if (fp.targetId in 1..999) {
                val slot = slotByChara[fp.charaId] ?: continue
                if (!targetBySlot.containsKey(slot)) targetBySlot[slot] = fp.targetId
            }
        }
        for (i in cardPlain.indices) {
            val id = cardPlain[i]
            val o = JSONObject()
            o.put("personType", if (id == FRIEND_CARD || id == FRIEND_CARD_R) 1 else 2)
            o.put("charaId", cardCharaId(id))
            val bond = targetBySlot[i]?.let { bondByTarget[it] } ?: bondByCard[id] ?: 0
            o.put("friendship", bond)
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
        // [APP-FIX-105] 分布主源 = festa.persons（按 target_id 升序，与 restore.rs 落位口径一致）：
        // 卡位人头填 persons 下标（0..5），神驹填 chara_id（>=1000）；act_type 0 = 不占担当不进分布。
        // 注意：festa.persons 只覆盖「担当」人头；站着但不担当的友人 / NPC 站位无数据源（Festa 布局
        // CommandInfoArray 不直读），分布可能比真机少人——引擎容忍（人数加成偏低），不拒帧。
        run {
            val counts = IntArray(5)
            for (fp in festaPersons.sortedBy { it.targetId }) {
                if (fp.actType !in 1..5) continue
                if (fp.targetId in 101..115) continue // NPC 占位
                val row = fp.actType - 1
                if (counts[row] >= 5) continue
                val value: Int = if (fp.targetId >= 1000) {
                    fp.charaId // 神驹：分布协议原值 = chara_id
                } else {
                    slotByChara[fp.charaId] ?: continue
                }
                dist.getJSONArray(row).put(counts[row], value)
                counts[row]++
            }
        }
        // [APP-FIX-114] 分布补漏：festa.persons 的 act_type 只标担当/神驹，友人卡(target 6)与
        // 理事长(102)/记者(103)站位恒 act_type=0 被丢弃（真机 fixture 实证：友人卡站力量位丢失）。
        // trainings[].partners 是训练界面人头数组，身份齐全 → 用它补全（上游协议值：
        // 卡位 0..5 / 理事长 6 / 记者 7 / 神驹 chara_id>=1000；NPC 101..115 丢弃）。
        // 友人与理事长站位直接抬高该训练收益，漏算 = 期望分系统性偏低 + 建议歪。
        run {
            for (i in 0 until trainings.length()) {
                val t = trainings.optJSONObject(i) ?: continue
                val ci = t.optInt("command_id", 0) - 5101
                if (ci < 0 || ci > 4) continue
                val row = dist.getJSONArray(ci)
                val have = HashSet<Int>()
                for (k in 0 until row.length()) { val v = row.optInt(k, -1); if (v >= 0) have.add(v) }
                val ps = t.optJSONArray("partners") ?: continue
                for (j in 0 until ps.length()) {
                    val p = ps.optJSONObject(j) ?: continue
                    val pid = p.optInt("partner_id", 0)
                    val v: Int = when {
                        p.optInt("support_card_id", 0) > 0 ->
                            cardIndexByCard[p.optInt("support_card_id", 0)] ?: continue
                        pid >= 1000 -> pid                     // 神驹 chara_id
                        pid == 102 -> 6                        // 理事长
                        pid == 103 -> 7                        // 记者
                        else -> continue                       // NPC 占位/未知
                    }
                    if (v in have) continue
                    if (have.size >= 5) break
                    // 紧凑化：festa 路可能留了 -1 空位，找第一个空位写
                    var w = -1
                    for (k in 0 until 5) { if (row.optInt(k, -1) < 0) { w = k; break } }
                    if (w < 0) break
                    row.put(w, v)
                    have.add(v)
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
        // [APP-FIX-115] 状态 ID → 协议字段（上游 online_wiring 状态表：7=切者 25=正向思考 45=消除疲劳 47=助力支撑）：
        // 引擎 restore 只从 charaEffects 挑 1-6 病种，切者/心情盾不进 charaEffects 消费路径，
        // 必须显式翻译，否则切者局的 PT 加权期望分与真机口径错位。
        val isQieZhe = effects.contains(7)
        val positiveThinking = if (effects.contains(25)) 1 else 0
        val hasAssistSupport = effects.contains(47)
        val hasFatigueRecovery = effects.contains(45)
        // [APP-FIX-115] 种马蓝因子星数（SO-FIX-114 的 succession_factors=[[id,lv],...]，蓝因子 id 1..5=速耐力根智）。
        // 恒 0 时引擎把 T30/T54 两次继承模拟成 0 收益（属性=蓝×6+剧本因子、上限=蓝×5.33），满配局期望分系统性偏低。
        val blueCount = IntArray(5)
        val sfArr = src.optJSONArray("succession_factors")
        if (sfArr != null) {
            for (i in 0 until sfArr.length()) {
                val f = sfArr.optJSONArray(i) ?: continue
                val fid = f.optInt(0, 0)
                val flv = f.optInt(1, 0)
                if (fid in 1..5 && flv in 1..3) blueCount[fid - 1] += flv
            }
        } else if (turn > 0) {
            notes.put("succession_factors_missing")
        }

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
        // [APP-FIX-115] trainLevelCount 语义 = 成功普通训练次数（上游 umasim：等级 = count/4+1），
        // SO 给的是等级 → 换算「该等级最小次数」(lv-1)*4；引擎 restore 以帧 trainLevelTotal 为真值
        // 反解 bonus，次数给对后 bonus 归零，rollout 的后续升级节奏与真机一致。
        base.put("trainLevelCount", JSONArray(trainLevel.map { (it - 1).coerceAtLeast(0) * 4 }))
        base.put("ptScoreRate", 1.0)
        base.put("failureRateBias", 0)
        base.put("isIll", false)
        base.put("isQieZhe", isQieZhe) // [APP-FIX-115]
        base.put("isAiJiao", aijiao)
        base.put("PositiveThinkingCount", positiveThinking) // [APP-FIX-115]
        // [APP-FIX-112] 全量状态 ID 透传（上游 2026-11-08 handoff：baseGame.charaEffects）。
        // 引擎 restore 按 142 表从 effects 判病种覆盖 isIll 粗标记——变胖(FAT)只有这条路
        // 认得出来；纯 buff/空数组时引擎不覆盖，isIll=false 兜底不变。
        base.put("charaEffects", JSONArray(effects.toList()))
        base.put("zhongMaBlueCount", JSONArray(blueCount.toList())) // [APP-FIX-115]
        base.put("isRacing", false)
        base.put("cardId", JSONArray(cardIds))
        base.put("persons", JSONArray(persons.toList()))
        base.put("personDistribution", dist)
        base.put("lockedTrainingId", -1)
        base.put("friendship_noncard_yayoi", bondByTarget[102] ?: 0) // [APP-FIX-105] 102=理事长
        base.put("friendship_noncard_reporter", bondByTarget[103] ?: 0) // [APP-FIX-105] 103=记者
        // [APP-FIX-115] friend_stage 推断（上游 to_friend：0 未点击/1 已点击未出行/2 已出行/其它=离开）：
        // 协议无法区分 0/1（上游 apply_key_events 注释），已出行段数>0 → 2；0/1 的区分交给
        // keyEvents（friend_first_event=809052001 命中时引擎自己纠正为 1）。
        base.put("friend_stage", if (src.optInt("friend_outgoing_used", 0) > 0) 2 else 0)
        base.put("friend_outgoingUsed", src.optInt("friend_outgoing_used", 0)) // [APP-FIX-090]
        val psVal = if (src.has("playing_state")) src.optInt("playing_state", 1) else 1
        base.put("playing_state", psVal) // [APP-FIX-090]
        // [APP-FIX-113] 事件帧（上游 G16）：SO 透传 story_id/story_choices/story_selected。
        // 口径 = 「待选多选项事件」：id>0 且 choices>1 且未选择 → source=event + storyId，
        // 引擎按本地事件表注入后走 Event 路由给选项建议；未收录/无数据引擎自己 Skip。
        // 不发时事件弹窗帧会被当 command 帧用残值给训练建议（上游明确禁止的回落）。
        val storyId = src.optInt("story_id", 0)
        val storyChoices = src.optInt("story_choices", 0)
        val storySelected = src.optInt("story_selected", -1)
        val isEventPending = storyId > 0 && storyChoices > 1 && storySelected < 0
        // [APP-FIX-109] 教诲选择建议：playing_state=51 = 教诲分配窗口，按上游 route() 口径发 special 帧，
        // 引擎才会走 Advice 分配决策（否则永远只有训练决策，教诲选择不出建议）
        base.put("source", if (psVal == 51) "special" else if (isEventPending) "event" else "command")
        if (isEventPending) base.put("storyId", storyId)
        base.put("isAfterTraining", false)
        // [APP-FIX-115] 局号 + keyEvents（见 trackEventFrame 注释）：
        // 局号必须随局变化（fixed_turn_chara_seed），引擎 sync_epoch 靠它清跨帧基准/幂等集；
        // 原来发 chara_id，同角色连开两局 epoch 不变，prev_levels/seen 跨局残留。
        val (epoch, keyEvents) = trackEventFrame(src, turn, storyId, storySelected)
        base.put("single_mode_chara_id", epoch)
        base.put("keyEvents", JSONArray(keyEvents))
        base.put("isFullGame", trackFirstTurn in 0..1)

        val fs = fsEarly
        // [APP-FIX-109] 転成教诲：summary festa.advice[] 是 advice_id→fusion 对，按 act.advice_id 反查补 fusionId
        val fadv = fs.optJSONArray("advice") ?: JSONArray()
        fun fusionOf(aid: Int): Int {
            if (aid <= 0) return 0
            for (k in 0 until fadv.length()) {
                val e = fadv.optJSONObject(k) ?: continue
                if (e.optInt("advice_id", 0) == aid) return e.optInt("fusion_advice_id", 0)
            }
            return 0
        }
        val acts = JSONArray()
        val fa = fs.optJSONArray("acts") ?: JSONArray()
        for (i in 0 until fa.length()) {
            val a = fa.optJSONObject(i) ?: continue
            val aid = a.optInt("advice_id", 0)
            acts.put(JSONObject().apply {
                put("actType", a.optInt("act_type", 0))
                put("gauge", a.optInt("gauge", 0))
                put("level", a.optInt("level", 0))
                put("needGauge", a.optInt("need_gauge", 0))
                put("adviceId", aid)
                put("fusionId", fusionOf(aid))
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
        // [APP-FIX-105] 帧 festa.persons 直传 SO 剧本段（上游 FestaPerson：targetId/actType/origin）：
        // 卡位 chara_id 命中卡组 → card（吾妻 → friend）；chara_id>=1000 → guest；101..115 占位丢弃。
        // 不再从分布反推（反推丢友人 / 神驹身份，且分布本来就源自这里）。
        val fPersons = JSONArray()
        for (fp in festaPersons.sortedBy { it.targetId }) {
            if (fp.targetId in 101..115) continue
            val origin: String
            if (fp.targetId >= 1000) {
                origin = "guest"
            } else {
                val slot = slotByChara[fp.charaId] ?: continue // 非编成人头（NPC）不进帧
                origin = if (cardPlain[slot] == FRIEND_CARD || cardPlain[slot] == FRIEND_CARD_R) "friend" else "card"
            }
            fPersons.put(JSONObject().apply {
                put("targetId", fp.targetId)
                put("actType", fp.actType)
                put("origin", origin)
            })
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
            // [APP-FIX-115] 助力支撑(47)/消除疲劳(45) 从 charaEffects 翻译（上游 G4：有则 1 回合）
            put("assistSupportLeft", if (hasAssistSupport) 1 else 0)
            put("fatigueRecovery", hasFatigueRecovery)
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