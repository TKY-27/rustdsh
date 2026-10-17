# Cargo workspace 分割（段階的移行）の計画

Issue #703（[P2] Cargo workspace 分割）の受け入れ条件と、安全に進めるための段階を
ここに固定します。roadmap は `docs/ROADMAP.md` を正とします。

## なぜ分割するか

- 単一クレートに CLI・ガード・コア・Web が同居しており、`cargo test` が全部を巻き込む。
- guard の deny 判定や設定の読み取りを、CLI 以外（Web や将来のデスクトップ）からも
  独立にビルド・テストできるようにしたい。
- リリース（`--locked` ビルド、MSRV 1.85、5 プラットフォーム）を壊さないことが最優先。

## 目標レイアウト

| クレート | 役割 | 主なソース |
| --- | --- | --- |
| `rdsh-guard` | フック判定・シェル解析・パス正規化 | `src/guard.rs` |
| `rdsh-core` | 設定・機能スイッチ・locale・モデルカタログ | `src/rdsh_config.rs`, `src/locale.rs`, `src/models.rs` |
| `rdsh-web` | `serve` の UI/API | `src/serve.rs`, `src/ui.html` |
| `rdsh-cli`（現 `rdsh`） | サブコマンド、委譲、インストーラ | `src/main.rs` ほか |

## 進め方（1 スライス = 1 PR）

1. `rdsh-guard`: 依存が最も少なく、テスト（21 件）が自己完結しているため最初に切り出す。
2. `rdsh-core`: 設定と locale。`include_str!` の配置と公開 API を確定してから移す。
3. `rdsh-web`: `serve` を分離。UI テスト（`dashboard/test/serve-ui.test.mjs`）は現状のパスを維持。
4. `rdsh-cli`: 残りを束ねる。`Cargo.toml` の `[[bin]]` 名は `rdsh` のまま維持する。

各スライスで必ず:

- `cargo fmt --check` / `cargo clippy --locked --all-targets -- -D warnings`。
- `cargo check --locked --all-targets` と `cargo +1.85.0 check`（MSRV）。
- 既存テストの件数が減っていないこと（移動ならパス変更のみ）。
- `release-digests`・CD の資産名・`install.sh` が参照する成果物名を変えない。

## 受け入れ条件

- ワークスペース化しても `cargo build --locked --release` が従来どおり 1 バイナリ `rdsh` を出す。
- `cargo publish`（publish-crate ジョブ）が現行と同じ成果物を出す。
- すべての必須チェックが緑のままであること。

## 現状

未着手。分割はリリース直後の静穏なタイミングで、1 スライスずつ行います。
