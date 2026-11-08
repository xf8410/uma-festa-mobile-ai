package com.ranko.matsuricapture

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * [ENGINE-ADAPTER-TEST] FrameAdapter 与 CI 里已验证的 Node 适配器（summary_to_frame.js）对齐：
 * 用同一份真机 /summary（CI 把 .github/fixtures/summary_real.b64 解到 test resources），
 * 断言引擎强制要求的几条硬约束都成立（这些都是被引擎报错逼出来的规则）。
 */
class FrameAdapterTest {
    private fun fixture(): JSONObject {
        val f = File("src/test/resources/summary_real.json")
        assertTrue("缺少测试夹具 ${f.absolutePath}", f.exists())
        return JSONObject(f.readText())
    }

    private fun tinyCardDb(): JSONObject {
        val db = JSONObject()
        fun put(id: Int, chara: Int, type: Int) {
            db.put(id.toString(), JSONObject().put("cardId", id).put("charaId", chara).put("cardType", type))
        }
        put(30323, 9052, 5)
        put(10002, 1002, 0)
        put(10006, 1007, 1)
        put(10005, 1006, 2)
        put(10001, 1001, 3)
        put(10013, 1017, 4)
        return db
    }

    @Test
    fun frameMatchesEngineContract() {
        val tmp = File.createTempFile("carddb", ".json")
        tmp.writeText(tinyCardDb().toString())
        FrameAdapter.loadCardDb(tmp)

        val frame = FrameAdapter.toFrame(fixture())
        val base = frame.getJSONObject("baseGame")
        val cards = base.getJSONArray("cardId")
        val persons = base.getJSONArray("persons")
        val dist = base.getJSONArray("personDistribution")

        assertEquals(15, base.getInt("scenarioId"))
        assertTrue(base.getInt("turn") in 0..77)

        for (i in 0 until cards.length()) {
            val merged = cards.getInt(i)
            assertTrue("cardId 应为合并值: $merged", merged % 10 in 0..4)
            assertTrue("cardId 量级不对: $merged", merged / 10 >= 10001)
        }

        assertEquals(cards.length(), persons.length())

        assertEquals(5, dist.length())
        for (r in 0 until 5) assertEquals(5, dist.getJSONArray(r).length())

        val lv = base.getJSONArray("trainLevelCount")
        assertEquals(5, lv.length())
        for (i in 0 until 5) assertTrue(lv.get(i) is Number)

        val festa = frame.getJSONObject("festa")
        assertEquals(5, festa.getJSONArray("acts").length())
        assertTrue(festa.getJSONArray("persons").length() <= cards.length())
    }
}