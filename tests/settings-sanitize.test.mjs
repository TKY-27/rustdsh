import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSettings } from '../plugins/rdsh-settings/index.js';

// 孤立サロゲート（サロゲートペアの片割れ）を含むかどうか。
function hasLoneSurrogate(value) {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// Rust 側 (src/rdsh_config.rs の truncate) は Unicode スカラー単位で切る。
// JS の String#slice は UTF-16 コード単位なので、境界に絵文字があるとサロゲート
// ペアを割り、rdsh.json が serde_json から読めず CLI が exit 1 になる。
test('truncation never leaves a lone surrogate at the boundary', () => {
  const emoji = '\u{1F44D}';
  const out = sanitizeSettings({
    search: { dir: 'a'.repeat(299) + emoji },
    general: { default_profile: 'p'.repeat(499) + emoji },
    context: { goal: 'g'.repeat(1999) + emoji },
    guard: { deny: ['d'.repeat(299) + emoji] },
  });
  const values = [
    out.search.dir,
    out.general.default_profile,
    out.context.goal,
    out.guard.deny[0],
  ];
  for (const value of values) {
    assert.equal(hasLoneSurrogate(value), false, 'lone surrogate written to rdsh.json');
  }
  // 保存される JSON がそのまま読み戻せること。
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(out)));
});

// Rust は guard.deny を TEXT_CHARS(500) で切る。GUI だけ 300 だったため、
// 同じ入力を保存しても GUI と CLI で結果が違っていた。
test('guard.deny keeps the Rust text limit', () => {
  const kept = 'a'.repeat(400);
  assert.equal(sanitizeSettings({ guard: { deny: [kept] } }).guard.deny[0], kept);
  assert.equal(sanitizeSettings({ guard: { deny: ['a'.repeat(600)] } }).guard.deny[0].length, 500);
});

test('truncation counts code points, like the Rust side', () => {
  const emoji = '\u{1F44D}';
  const dir = 'a'.repeat(299) + emoji; // 300 code points, 301 UTF-16 units
  assert.equal(sanitizeSettings({ search: { dir } }).search.dir, dir);
  const long = emoji.repeat(301);
  assert.equal(Array.from(sanitizeSettings({ search: { dir: long } }).search.dir).length, 300);
});
