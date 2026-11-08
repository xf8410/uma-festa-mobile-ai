#!/usr/bin/env node
// [SKILLTIPS-3292] 修技能提示读取：List<T> 的元素在 _items(0x10) 指向的数组里；
// 元素字段是内联 ObscuredInt（16/36/56）。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [SKILLTIPS-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }

const rep = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`anchor count=${n}: ${JSON.stringify(a.slice(0, 60))}`);
  s = s.split(a).join(b);
};

rep(`        let gid = std::ptr::read_unaligned::<i32>(base.add(0x10) as *const i32);
        let rar = std::ptr::read_unaligned::<i32>(base.add(0x14) as *const i32);
        let lvl = std::ptr::read_unaligned::<i32>(base.add(0x18) as *const i32);`,
`        // ${MARK} SkillTips 三个字段都是内联 ObscuredInt
        let gid = read_obscured_int_at(base as *const c_void, 16);
        let rar = read_obscured_int_at(base as *const c_void, 36);
        let lvl = read_obscured_int_at(base as *const c_void, 56);`);

rep(`        let lb = list as *const u8;
        let count =
            std::ptr::read_unaligned::<usize>(lb.add(IL2CPP_LIST_COUNT_OFF) as *const usize);
        if count > 0 && count < 500 {
            for i in 0..count {
                let ep = std::ptr::read_unaligned::<*mut c_void>(
                    lb.add(IL2CPP_LIST_ITEMS_OFF + i * IL2CPP_LIST_ITEM_SIZE) as *const *mut c_void,
                );
                if let Some(t) = read_tip(ep) {
                    tips.push(t);
                }
            }
        }`,
`        // ${MARK} List<T>: _size@0x18, _items@0x10 → 元素在数组 +0x20
        let lb = list as *const u8;
        let count = std::ptr::read_unaligned::<usize>(lb.add(0x18) as *const usize);
        let items = std::ptr::read_unaligned::<*mut c_void>(lb.add(0x10) as *const *mut c_void);
        if count > 0 && count < 500 && !items.is_null() {
            for i in 0..count {
                let ep = std::ptr::read_unaligned::<*mut c_void>(
                    (items as *const u8).add(0x20 + i * 8) as *const *mut c_void,
                );
                if let Some(t) = read_tip(ep) {
                    tips.push(t);
                }
            }
        }`);

rep(`        let ab = field_arr as *const u8;
        let count =
            std::ptr::read_unaligned::<usize>(ab.add(IL2CPP_LIST_COUNT_OFF) as *const usize);
        if count > 0 && count < 500 {
            for i in 0..count {
                let ep = std::ptr::read_unaligned::<*mut c_void>(
                    ab.add(IL2CPP_LIST_ITEMS_OFF + i * IL2CPP_LIST_ITEM_SIZE) as *const *mut c_void,
                );
                if let Some(t) = read_tip(ep) {
                    tips.push(t);
                }
            }
        }`,
`        // ${MARK} 同上：字段可能是 List，也可能是数组
        let ab = field_arr as *const u8;
        let count = std::ptr::read_unaligned::<usize>(ab.add(0x18) as *const usize);
        let items = std::ptr::read_unaligned::<*mut c_void>(ab.add(0x10) as *const *mut c_void);
        if count > 0 && count < 500 && !items.is_null() {
            for i in 0..count {
                let ep = std::ptr::read_unaligned::<*mut c_void>(
                    (items as *const u8).add(0x20 + i * 8) as *const *mut c_void,
                );
                if let Some(t) = read_tip(ep) {
                    tips.push(t);
                }
            }
        }`);

fs.writeFileSync(P, s);
console.log('skilltips applied, bytes=' + Buffer.byteLength(s));