//! L3 集成：评分公式与数据根旧评分表的逐位对照
//!
//! 0–2803 逐位一致（保证 L4 基线零位移）；2804–3801 只容许 1 分的取整差；
//! 表末之后公式继续增长，不再饱和到 23905。

use anyhow::{Context, Result};
use umaai_core::score::status_point;
use umaai_core::testing::data_root;
use umaai_tests::Checker;

/// 公式逐项对照旧表，并守高段外推
#[test]
fn status_score_formula_matches_legacy_table() -> Result<()> {
    let path = data_root()?.join("constants.json");
    let text = std::fs::read_to_string(&path)?;
    let value: serde_json::Value = serde_json::from_str(&text)?;
    let table = value["five_status_final_score"]
        .as_array()
        .context("constants.json 缺 five_status_final_score 数组")?;

    let mut exact = 0;
    let mut off_by_one = 0;
    let mut bad = 0;
    let mut first_diff = None;
    for (status, want) in table.iter().enumerate() {
        let want = want.as_i64().context("旧表项不是整数")? as i32;
        let diff = (status_point(status as i32) - want).abs();
        match diff {
            0 => exact += 1,
            1 => {
                off_by_one += 1;
                if first_diff.is_none() {
                    first_diff = Some(status);
                }
            }
            _ => bad += 1,
        }
    }
    println!(
        "逐位统计: 表长 {} / 一致 {} / 差 1 分 {} / 其它 {} / 首个差异 raw {:?}",
        table.len(),
        exact,
        off_by_one,
        bad,
        first_diff
    );

    let mut c = Checker::new("评分公式与旧表逐位对照");
    c.check(table.len() == 3802, "旧表长度 3802");
    c.check(bad == 0, "0..3801 无大于 1 分的偏差");
    c.check(exact >= 2804, "0..2803 逐位一致（基线零位移）");
    c.check(first_diff == Some(2804), "首个取整差落在 raw 2804");
    c.check(off_by_one == 124, "外推段取整差恰为 124 点");
    c.check(
        status_point(4000) == 25950 && status_point(5000) == 36775,
        "表末之后按公式外推",
    );
    c.check(status_point(4000) > status_point(3801), "不再饱和到表末");
    c.finish()
}
