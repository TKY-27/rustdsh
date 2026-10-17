# 回答の日本語訳を表示する

Issue #448 Step 1。規模: 中（既存のDSHコマンドとWeb UIスロットをつなぐプラグイン）。
DSHが管理する会話・モデル実行のホストアダプタとして実装し、独自のエージェントループは追加しません。

完了した英語・中国語の回答のアクション行で「日本語訳を表示」を押すと、
現在の会話で直近に使用したprovider/modelへ個別の翻訳リクエストを1回送信し、訳文ダイアログを開きます。
生成中の表示、二重クリック防止、失敗時の再試行に対応しています。
日本語のみの回答、コードのみの回答、中断された回答にはボタンを表示しません。
かな比率による判定を行うため、日本語の漢字のみで構成された文章などを誤判定する場合があります。

原文、会話のsurface、次のモデル入力は変更しません。翻訳の追加指示や新しいターンも追加しません。
DSHの通常の`command/run`・`command/done`ログには、操作と結果が記録されます。
訳文の表示はコンポーネントの一時的な状態であり、画面を再読み込みすると消えます。
履歴の置換（Step 2）、自動翻訳、モデルの切り替え、翻訳結果の専用保存は対象外です。

## 導入と操作

リポジトリの`plugins/install.sh`では、`PROFILE=web`または`PROFILE=desktop`を指定して導入します。
除外する場合は`TRANSLATION=0`を指定します。headless/TUIでは既定で導入されません。
個別に導入する場合は、Webプロファイルでは`dsh plugin --profile web add /絶対パス/plugins/rdsh-translation`を、
Desktopでは`rdsh desktop install --package /絶対パス/plugins/rdsh-translation`を使用します。
導入後に対象のWeb UIを開き直してください。

`$DSH_HOME/rdsh.json`の`translation.kana_threshold`で表示のしきい値を設定できます。
既定値は0.08、許容範囲は0.01〜0.5です。変更後は画面を再読み込みしてください。
翻訳の呼び出しには、現在のモデルの通常の利用料金や利用枠がかかります。

表示文言やコマンドの説明、エラー文は表示言語に追従します。Web UIはDSHのlocaleカタログ
（`rdsh-translation`名前空間のen/zh/ja辞書）を使用し、日本語の言語定義はrdsh-settingsが
管理しているため、本プラグインからは言語を追加しません。ホスト側の文言は`RDSH_LANG`、
`rdsh.json`の`general.language`、OSロケールの順に解決されます。プラグイン一覧の
タイトルや説明には、`locale/en.json`、`locale/ja.json`、`locale/zh.json`を使用します。

コードブロック、インラインコード、識別子やパスなどは保護トークンで保持します。
トークンの欠落や重複、空の応答、途中終了、64KiBを超える入力・出力はエラーとして表示します。
60秒の制限時間とDSHの保守処理による排他制御を利用し、生成中の会話は変更しません。

## 検証

`node --test tests/translation-preview.test.mjs`を実行し、ボタンからコマンドの結果表示まで、
原文とsessionの不変性、二重起動、失敗・取り消し・上限、導入リストを確認します。
同様のテストはCIの既存プラグイン検証エントリポイントからも読み込まれます。
実providerを使った翻訳の品質や実DSH全体での受け入れは、合成境界におけるテストの成功とは区別します。

隔離したDSH環境を用意した場合は、次のコマンドで実際のAgentLoop・LLM・CommandRuntimeと
実sessionの境界を確認できます。providerのみが固定応答を返し、モデルAPIは呼び出しません。

```sh
RDSH_NATIVE_MODULES=/path/to/dsh/node_modules npm run test:translation --prefix tests/e2e
```

画面確認とは別の試験です。実行方法は[受入試験](../../tests/e2e/README.md)を参照してください。

実Webプロファイルでの操作前後のPNG画像や操作GIF、および検証範囲については、
[画面の受入記録](../../docs/evidence/issue448-translation-preview/README.md)を参照してください。
