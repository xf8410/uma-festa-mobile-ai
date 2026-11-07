package com.ranko.matsuricapture

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 验证「SO /summary 深 JSON → 面板扁平帧」的归一化，以及 SO 重编译判定。
 * 样本字段严格照 matsuri-adapter/docs/FIELDMAP.md（hachimi_ura_plugin /summary）。
 */
class NormalizeTest {

    private val engine: Any = NativeEngine::class.java.getDeclaredField("INSTANCE").get(null)!!

    private fun ingest(body: String, source: String = "push") {
        val m = NativeEngine::class.java
            .getDeclaredMethod("ingest", String::class.java, String::class.java)
        m.isAccessible = true
        m.invoke(engine, body, source)
    }

    private fun snapshot(): JSONObject {
        val m = NativeEngine::class.java.getDeclaredMethod("snapshot")
        m.isAccessible = true
        return m.invoke(engine) as JSONObject
    }

    /** 合并线 SO：/summary 内嵌 festa（sid==15） */
    private fun summaryWithFesta() = JSONObject(
        """
        {
          "turn":47,"raw_total_turn_num":47,"year":2,"month":3,"half":2,
          "ui_turn_semantics":"countdown","scenario":"Festa","chara_id":100101,
          "stats":{"speed":412,"stamina":388,"power":501,"guts":300,"wiz":255,
                   "vital":64,"max_vital":100,"motivation":"GREAT","skill_point":780,"fan":92378},
          "max_stats":{"speed":3179,"stamina":2415,"power":2200,"guts":2200,"wiz":2400},
          "festa":{
            "festa_info":{"summer_camp_remain_turn":2,"max_act_level":10,"act_training_step":3},
            "acts":{"len":2,"list":[
              {"act_type":1,"command_id":5101,"name":"流镝","name_src":"mdb","gauge":3,
               "need_gauge":12,"level":2,"state":1,"advice_id":101,"friend_outing":0},
              {"act_type":4,"command_id":5104,"name":"大曳","name_src":"mdb","gauge":7,
               "need_gauge":12,"level":1,"state":1,"advice_id":401,"friend_outing":0}
            ]},
            "advice":{"len":0,"list":[]},
            "checkpoints":{"len":3,"list":[
              {"schedule_id":23,"result_type":2},
              {"schedule_id":47,"result_type":1},
              {"schedule_id":67,"result_type":0}
            ]},
            "command_info":{"len":2,"list":[
              {"command_type":1,"command_id":5101,"params_len":3,"predict_len":4,
               "is_upper_training_event_occurred":0,"predict":[]},
              {"command_type":4,"command_id":5104,"params_len":2,"predict_len":6,
               "is_upper_training_event_occurred":1,"predict":[]}
            ]},
            "gain_gauges":{"len":2,"list":[
              {"command_type":1,"predict_len":4},
              {"command_type":4,"predict_len":6}
            ]},
            "evaluation_info":{"len":2,"list":[
              {"class":"FestaEvaluationInfo","fields_hex":"0a0b0c"},
              {"class":"FestaEvaluationInfo","fields_hex":"0d0e0f"}
            ]}
          },
          "last_action":{"action":"Training","normalized_command_id":5101,"result_type":0}
        }
        """.trimIndent()
    )

    /** 现役 hlpatch / uma-scenario15-plugin 线：/summary 无 festa */
    private fun summaryWithoutFesta() = JSONObject(
        """
        {
          "turn":47,"raw_total_turn_num":47,"year":2,"month":3,"half":2,
          "ui_turn_semantics":"countdown","scenario":"Ramen","chara_id":100101,
          "stats":{"speed":412,"stamina":388,"power":501,"guts":300,"wiz":255,
                   "vital":64,"max_vital":100,"motivation":"GREAT","skill_point":780,"fan":92378},
          "max_stats":{"speed":3179,"stamina":2415,"power":2200,"guts":2200,"wiz":2400}
        }
        """.trimIndent()
    )

    @Test
    fun `嵌套 summary 被映射成面板扁平帧`() {
        ingest(summaryWithFesta().toString())
        val snap = snapshot()
        val f = snap.getJSONObject("latest")

        assertTrue("内嵌 festa 应被识别", snap.getBoolean("has_festa"))
        assertFalse("不应报需重编译", snap.getBoolean("need_so_rebuild"))
        assertEquals(47L, f.getLong("turn"))
        assertEquals(listOf(412L, 388L, 501L, 300L, 255L),
            (0 until f.getJSONArray("five").length()).map { f.getJSONArray("five").getLong(it) })
        assertEquals(listOf(3179L, 2415L, 2200L, 2200L, 2400L),
            (0 until f.getJSONArray("max_five").length()).map { f.getJSONArray("max_five").getLong(it) })
        assertEquals(64L, f.getLong("vital"))
        assertEquals(100L, f.getLong("max_vital"))
        assertEquals(780L, f.getLong("skill_point"))
        assertEquals(92378L, f.getLong("fan"))
        assertEquals("GREAT", f.getString("motivation"))
        assertEquals(2, f.getJSONArray("acts").length())
        assertEquals("流镝", f.getJSONArray("acts").getJSONObject(0).getString("name"))
        assertEquals(5104L, f.getJSONArray("acts").getJSONObject(1).getLong("command_id"))
        assertEquals(23L, f.getJSONArray("checkpoints").getJSONObject(0).getLong("schedule_id"))
        assertEquals(3, f.getJSONArray("checkpoints").length())
        assertEquals(2L, f.getLong("camp_remain_turn"))
        assertEquals(10L, f.getLong("max_act_level"))
        assertEquals(3L, f.getLong("act_training_step"))
        assertEquals(0, f.getJSONArray("missing").length())

        // ── v0.4.0：SO 已推但旧版丢弃的三类 festa 字段 ──────────────────
        // 上游 online_wiring.md §2 #21：任一训练位 is_upper_training_event_occurred>0 即掷中。
        val ci = f.getJSONArray("command_info")
        assertEquals(2, ci.length())
        assertEquals(1L, ci.getJSONObject(0).getLong("command_type"))
        assertEquals(5101L, ci.getJSONObject(0).getLong("command_id"))
        assertEquals(4L, ci.getJSONObject(0).getLong("predict_len"))
        assertEquals(0L, ci.getJSONObject(0).getLong("is_upper_training_event_occurred"))
        assertEquals(1L, ci.getJSONObject(1).getLong("is_upper_training_event_occurred"))
        assertTrue("第 2 训练位掷中应置 kensan_pending", f.getBoolean("kensan_pending"))

        val gg = f.getJSONArray("gain_gauges")
        assertEquals(2, gg.length())
        assertEquals(4L, gg.getJSONObject(0).getLong("predict_len"))
        assertEquals(6L, gg.getJSONObject(1).getLong("predict_len"))

        // evaluation_info 只推原始 hex，不得解析成人名：以计数 + 解析状态表达。
        assertEquals(2, f.getInt("evaluation_count"))
        assertFalse("姓名字段布局未实测（❓G5），解析状态必须为 false",
            f.getBoolean("evaluation_parsed"))
    }

    @Test
    fun `裸数组形态的 festa 字段同样被接住`() {
        val s = JSONObject(
            """
            {
              "turn":12,"scenario":"Festa",
              "stats":{"speed":100,"stamina":100,"power":100,"guts":100,"wiz":100,
                       "vital":50,"max_vital":100,"motivation":"GOOD","skill_point":10,"fan":1},
              "max_stats":{"speed":1200,"stamina":1200,"power":1200,"guts":1200,"wiz":1200},
              "festa":{
                "festa_info":{"summer_camp_remain_turn":0,"max_act_level":10,"act_training_step":1},
                "acts":[],"advice":[],"checkpoints":[],
                "command_info":[
                  {"command_type":2,"command_id":5102,"predict_len":0,
                   "is_upper_training_event_occurred":0}
                ],
                "gain_gauges":[],
                "evaluation_info":[{"class":"X","fields_hex":"00"}]
              },
              "last_action":{"action":"Rest","normalized_command_id":0,"result_type":0}
            }
            """.trimIndent()
        )
        ingest(s.toString())
        val f = snapshot().getJSONObject("latest")
        assertEquals(1, f.getJSONArray("command_info").length())
        assertEquals(0, f.getJSONArray("gain_gauges").length())
        assertFalse("全部训练位均未掷中时 kensan_pending 应为 false",
            f.getBoolean("kensan_pending"))
        assertEquals(1, f.getInt("evaluation_count"))
        assertFalse(f.getBoolean("evaluation_parsed"))
    }

    @Test
    fun `缺 festa 时判定为需要重编译 SO`() {
        ingest(summaryWithoutFesta().toString())
        val snap = snapshot()
        val f = snap.getJSONObject("latest")

        assertFalse("无 festa 应被识别", snap.getBoolean("has_festa"))
        assertTrue("应报需重编译 SO", snap.getBoolean("need_so_rebuild"))
        assertTrue("missing 应含 festa",
            (0 until f.getJSONArray("missing").length()).any {
                f.getJSONArray("missing").getString(it) == "festa"
            })
        assertTrue("缺值应为 -1 而不是 0", f.getJSONArray("advice").length() == 0)
        // v0.4.0：无 festa 时新增字段必须给出安全的空值，而不是抛异常。
        assertFalse(f.getBoolean("kensan_pending"))
        assertEquals(0, f.getInt("evaluation_count"))
        assertFalse(f.getBoolean("evaluation_parsed"))
        assertEquals(0, f.getJSONArray("command_info").length())
        assertEquals(0, f.getJSONArray("gain_gauges").length())
    }

    @Test
    fun `已是归一化帧时不重复映射`() {
        val flat = JSONObject(
            """{"turn":46,"five":[412,388,501,300,255],"max_five":[3179,2415,2200,2200,2400],
                 "vital":64,"max_vital":100,"skill_point":780,"has_festa":true,
                 "missing":[],"acts":[],"advice":[],"checkpoints":[]}""".trimIndent()
        )
        ingest(flat.toString())
        val f = snapshot().getJSONObject("latest")
        assertEquals(46L, f.getLong("turn"))
        assertEquals(412L, f.getJSONArray("five").getLong(0))
        assertTrue(snapshot().getBoolean("has_festa"))
    }

    // ───────── 接线修复（v0.6.0）：验证「持续主动拉 + 属性落库 + 诊断」 ─────────

    /** 直接调私有 normalize（pullLoop 走的正是这条路径），验证 /summary 被解析成育成属性帧 */
    private fun normalize(body: String, source: String): JSONObject {
        val m = NativeEngine::class.java.getDeclaredMethod(
            "normalize", JSONObject::class.java, JSONObject::class.java, String::class.java
        )
        m.isAccessible = true
        return m.invoke(engine, JSONObject(body), null, source) as JSONObject
    }

    @Test
    fun `接线-主动拉取来源的 summary 也能归一化出五维与 PT`() {
        val f = normalize(summaryWithFesta().toString(), "pull")
        assertEquals("pull", f.getString("source"))
        assertEquals(listOf(412L, 388L, 501L, 300L, 255L),
            (0 until f.getJSONArray("five").length()).map { f.getJSONArray("five").getLong(it) })
        assertEquals(64L, f.getLong("vital"))
        assertEquals(780L, f.getLong("skill_point"))
        assertEquals(92378L, f.getLong("fan"))
        assertTrue("有 stats 段应标记 fields_ok", f.getBoolean("fields_ok"))
    }

    @Test
    fun `接线-缺 stats 段时 fields_ok 为 false 且五维全为 -1 不编造`() {
        val body = JSONObject("""{"turn":1,"scenario":"Festa","festa":{"acts":[]}}""".trimIndent())
        val f = normalize(body.toString(), "pull")
        assertFalse("stats 缺失不应标记 fields_ok", f.getBoolean("fields_ok"))
        assertEquals(listOf(-1L, -1L, -1L, -1L, -1L),
            (0 until f.getJSONArray("five").length()).map { f.getJSONArray("five").getLong(it) })
        assertTrue((0 until f.getJSONArray("missing").length()).any {
            f.getJSONArray("missing").getString(it) == "stats"
        })
    }

    @Test
    fun `接线-snapshot 暴露链路诊断字段`() {
        ingest(summaryWithFesta().toString(), "push")
        val snap = snapshot()
        assertTrue("应有 push_recv", snap.has("push_recv"))
        assertTrue("应有 pull_recv", snap.has("pull_recv"))
        assertTrue("应有 stats_ok", snap.has("stats_ok"))
        assertTrue("应有 last_pull_ok_ms", snap.has("last_pull_ok_ms"))
        assertTrue("应有 last_summary_error", snap.has("last_summary_error"))
        assertTrue("推送帧应使 push_recv 递增", snap.getInt("push_recv") >= 1)
        assertTrue("有 stats 的帧 stats_ok 应为 true", snap.getBoolean("stats_ok"))
    }
}
