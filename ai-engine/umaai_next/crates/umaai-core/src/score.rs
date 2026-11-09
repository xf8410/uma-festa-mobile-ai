//! # 五维属性评分公式
//!
//! 以原始属性（未经显示压缩）为输入，计算单项属性的终局评价分，公式没有属性上限。
//! 分段按原始属性坐标标定：0–1200 每 50 点一档、1201–2801 每 20 点一档、
//! 2802 以上每 50 点一档且每点增量逐档递增。
//!
//! 1200 以上每 2 点原始属性折算 1 个计分档位，属公式自身的分档口径；
//! 调用方直接传原始值，不需要先做显示压缩。
//!
//! 与上游 URA 的 `StatusToPoint` 同源：0–2803 与旧评分表逐位一致，
//! 高段按公式外推，替代「越界饱和到表末」。

/// 0–1200 段各 50 点档的斜率（十分之一分/点），末档 51 点。
const LOW_RATES: [i64; 24] = [
    5, 8, 10, 13, 16, 18, 21, 24, 26, 28, 29, 30, 31, 33, 34, 35, 39, 41, 42, 43, 52, 55, 66, 68,
];

/// 1200 档位处的累计分（十分之一分）。
const MID_BASE: i64 = 38418;

/// 2000 档位处的累计分（分）。
const HIGH_BASE: i64 = 14280;

/// 原始属性 → 计分档位：1200 以上每 2 点折算 1 档。
fn step_of(status: i32) -> i64 {
    if status <= 1200 {
        i64::from(status)
    } else {
        1200 + (i64::from(status) - 1200) / 2
    }
}

/// 低段：0 点参与首档累计，1200 点归入末档。
fn low(step: i64) -> i64 {
    let mut rem = step + 1;
    let mut score = 0i64;
    for (band, &rate) in LOW_RATES.iter().enumerate() {
        if rem <= 0 {
            break;
        }
        let count = rem.min(if band + 1 == LOW_RATES.len() { 51 } else { 50 });
        score += count * rate;
        rem -= count;
    }
    score / 10
}

/// 中段：每 10 档位换一次斜率，首尾档覆盖 9 / 11 点。
fn mid(step: i64) -> i64 {
    let mut rem = step - 1200;
    let mut score = MID_BASE;
    let mut band = 0i64;
    while rem > 0 {
        let width = match band {
            0 => 9,
            79 => 11,
            _ => 10,
        };
        let count = rem.min(width);
        score += count * ((7910 + 131 * band) / 100);
        rem -= count;
        band += 1;
    }
    score / 10
}

/// 高段：每 25 档位一档，每点增量从 18.3 起逐档 +0.1（十分之一分口径）。
fn high(step: i64) -> i64 {
    let delta = step - 2000;
    let bands = delta / 25;
    let rem = delta % 25;
    HIGH_BASE + (183 * delta + 25 * bands * (bands - 1) / 2 + bands * rem + 1) / 10
}

/// 计算单项原始属性对应的终局评价分。
///
/// 负数按 0 处理；结果超出 `i32` 时饱和到 `i32::MAX`。中间量用 `i64`，
/// 不依赖任何数据表，也没有属性上限。
#[must_use]
pub fn status_point(status: i32) -> i32 {
    if status <= 0 {
        return 0;
    }
    let step = step_of(status);
    let point = if step <= 1200 {
        low(step)
    } else if step <= 2000 {
        mid(step)
    } else {
        high(step)
    };
    i32::try_from(point).unwrap_or(i32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 分段边界与高段外推的锚点（与上游公式逐点对齐）
    #[test]
    fn test_status_point_anchors() {
        let cases = [
            (0, 0),
            (1, 1),
            (2, 1),
            (50, 25),
            (51, 26),
            (1199, 3835),
            (1200, 3841),
            (1201, 3841),
            (1202, 3849),
            (1203, 3849),
            (1204, 3857),
            (2000, 8013),
            (2800, 14280),
            (2801, 14280),
            (2802, 14298),
            (2803, 14298),
            (2804, 14316),
            (3000, 16125),
            (3100, 17062),
            (3800, 23905),
            (3801, 23905),
            (3802, 23925),
            (4000, 25950),
            (5000, 36775),
        ];
        for (status, want) in cases {
            assert_eq!(status_point(status), want, "status={status}");
        }
    }

    /// 负数按 0、单调不减、表末之后不饱和、溢出不 panic
    #[test]
    fn test_status_point_bounds() {
        assert_eq!(status_point(-5), 0);
        assert_eq!(status_point(i32::MIN), 0);
        let mut prev = 0;
        for status in 0..6000 {
            let now = status_point(status);
            assert!(now >= prev, "status={status} 分数倒退");
            prev = now;
        }
        assert!(status_point(5000) > status_point(3801), "表末之后不再饱和");
        assert_eq!(status_point(i32::MAX), i32::MAX, "溢出饱和而不 panic");
    }
}
