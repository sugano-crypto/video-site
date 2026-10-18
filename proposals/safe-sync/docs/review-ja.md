# 安全な同期候補と導入前レビュー

2026年10月18日。これは修正候補です。本番へデプロイ、SQL実行、Cron変更、既存同期実行はしていません。
表示修正PRとは独立し、既存の関数・mainのHTMLを変更しません。

## 確認済みの現状

提供されたコードは、記事マスター `3db36098fd3680e596dcfaa1715d566f` をページネーションして全件取得し、タイトル・記事IDがありselect型ステータスが「公開」の行を同期します。
本文はNotion記事URLのリンク先ページを優先し、URLがなければマスター自身を取得します。
Supabaseの全 articles 行から「今回同期したIDにない」「article_idが空でない」行を物理削除します。
空の正常応答・プロパティ型変更・一時的なID/タイトル欠落・別ソースの記事に対する削除保護がありません。
HTTP/本文/メディア/upsertのエラーなら削除まで到達しませんが、先に成功した書き込みは残ります。
画像と音声は毎回同じStorageパスへ上書きします。公開区分欠落時は「無料」、対象読者欠落時は「全員」になります。

画面で確認した設定：
- 本番プロジェクト：bicqctaxvponqbzjsjbw / VIDEOS
- Cron：sync-notion-articles-daily、`0 18 * * *`＝03:00 JST、POST、body `{}`、タイムアウト5000ms、画面上の追加HTTPヘッダーなし
- 既存関数：Verify JWT with legacy secret OFF。提供コード内にも呼び出し元の認証処理なし
- CronのSucceededはpg_netへの投入成功であり、同期処理完了を証明しない

提供された25行のCSVで、記事のRLSがauthenticated向けUSING(true)、article-mediaがpublicであることを確認した。[追加の権限確認結果](security-findings-ja.md)を参照。同期の本番移行前にサーバー側の有料アクセス保護も設計する。

## 今回実装した候補

新規関数名：`sync-notion-articles-safe`。Notionトークン、Supabase service roleはサーバーだけで使用。
専用の `x-sync-secret` を検証し、認証前にはNotion/DB/Storageへアクセスしません。会員ログインのJWTやpublishable keyを同期権限として扱いません。
書き込みは `SYNC_APPLY_ENABLED=true` とリクエスト `{ "dry_run": false }` の両方が必要です。初期値は両方とも書き込みなし。dry-runはロック・同期状態・記事・Storageを書き込みません（HTTP通信とダウンロードは行います）。

- 空一覧・スキーマ不一致・重複ID・権限値の欠落は書き込み前に停止。
- ステータスはselect型とstatus型に対応。タイトルや記事IDが欠けた下書きも全体を止める厳格な仕様。マスターの必須値を整理してから導入する。
- 記事ID衝突・同期所有者の変更・既存の非公開statusは自動上書きしない。
- Notion本文とマスタープロパティを両方保存。長いrich_textはプロパティ取得APIの全ページを読む。
- 音声の優先順（本文ページのプロパティ→マスター→audioブロック）、カバーの優先順（本文ページcover→アイキャッチ画像）は従来を維持。
- mediaの取得失敗時は記事を更新しない。プロパティからメディアが消えても既存のURLを自動で空にしない。
- メディアをハッシュ付きの新規パスに保存。同じバイト列は再アップロードせず、既存画像/再生中MP3を上書きしない。失敗時に新しい未参照ファイルが残る場合はあるが、自動削除しない。
- masterとリンク先pageの編集時刻が両方同じなら本文・画像・MP3を取得し直さない。通常の文章編集時にはメディアもダウンロードしてハッシュを確認するため「転送ゼロ」ではない。毎日force=trueでは全件再検証し、同一URLの外部ファイル差し替えも補完する。
- 2回目の更新日時/公開状態確認により、取得途中の原稿編集を検出して再試行対象にする。NotionとDBをまたぐトランザクションではないため、最終確認直後の変更は次回同期で追従する。
- 5分の共有リースと、記事＋同期状態の単一DBトランザクションで重複適用を防止。期限切れの実行はcommit不可。異常終了のロックは最大5分で失効。
- Notionの429/一部5xxは上限付き再試行。全件失敗ではなく記事ごとにエラーを報告し、成功した記事だけ適用する。

## 初期導入は3分間隔の差分同期

本文が別Notionページに置かれるため、まずマスターと本文ページの両方を照合する方式にする。
3分間隔で30日14,400回＋毎日1回のバックアップ。変更なしでもNotionの一覧取得と公開記事ごとのページメタデータ取得は必要であり、記事数とともに負荷が増える。
1実行は約100秒を目安に制限し、Notionへの呼び出し間隔を確保する。大量記事や大きなMP3は分割ワーカーが必要になる。
Supabase無料プランでの可否は、現行の料金・休止条件・Edge Function回数/実行時間・Storage/転送量・DB使用量を導入時に確認する。現行料金枠の照合や本番使用量の測定はまだ実施していない。

Webhookは後続段階。Notionの署名検証、イベントIDの永続化、再送/重複排除、本文ページ→マスターの対応づけを追加し、同じ同期処理を起動する。3分ポーリングの負荷を減らす選択肢として残す。今回Webhook受信口は実装していない。

## 公開取り消しと閲覧権限の追加候補（本番未適用）

同期状態に登録済みの記事をNotionで明示的に「公開」以外へ変更した場合は、元ページのID/所属DB/現ステータスを再確認し、所有する記事だけstatus='unpublished'へ更新する候補を追加した。本文・画像・MP3は削除しない。再公開時には本文を再取得してstatusをpublishedへ戻す。
ソース一覧から消えた記事、所有確認できない記事、404/403/通信失敗は非公開化せずattention/エラーにする。Notionページの単なるアーカイブや全件空の応答を根拠に、一括非公開化しない。

`sql/004-member-access-candidate.sql` と `member-access/index.candidate.html`、`functions/article-media-links/` を追加し、サーバー側の契約・会員区分・公開状態による拒否と、メディアの5分署名URLを実装した。会員による契約情報の自己昇格を防ぐトリガーも候補に含めた。既存の広いRLSは本番ではまだ置き換えていない。
詳細は [閲覧側移行の候補](../member-access/README.md) を参照。

新同期のapplyは専用認証・環境変数・リクエストに加え、サーバーの準備確認にも通る必要がある。article-mediaがpublicの間はapplyを拒否する。バケットのprivate化SQLは含めず、HTML/署名API/RLS/既存同期入口の切替を揃えた承認済みの移行でのみ実施する。
user_profilesの実スキーマ・既存トリガー、idのIDENTITY、実メディアの確認は残る。ユーザーへ追加の操作は求めず、これらは本番移行の保留条件として記録する。

## ファイルと検証

- `functions/_shared/sync-core.mjs`：認証・対象検証・差分・保存方針
- `functions/_shared/supabase-io.mjs`：Notion/Supabase/Storageアダプター
- `functions/sync-notion-articles-safe/index.ts`：Supabase Edge Function入口
- `sql/000-inspect-readonly.sql`：記事スキーマ/RLS/Storage方針だけを読む調査SQL。本文・ユーザー・秘密は取得しない
- `sql/001-state.sql`：非公開の同期状態とロック、service_role限定RPC。既存articlesの型を利用するため、実スキーマのレビューが必要
- `sql/002-cron-review.sql`：Vault参照、3分ジョブ、既存03:00ジョブ保持。冒頭のガードにより誤実行を停止するレビュー用SQL
- `functions/config-review.toml`：専用関数だけの設定例。既存関数設定は変更しない
- `tests/`：外部通信なしのテスト。本番接続用の環境変数は使用しない

## 本番導入の順序（すべて未実施）

1. articlesのDDL/制約/default/トリガーとRLS、Storage方針を読み取り確認。非公開化方針を決定する。
2. articlesと参照メディアの復元可能なバックアップを取得し、既存件数・TOPIC-20261018等の本文/画像/音声を記録する。
3. 検証プロジェクトでSQLと関数を検証する。本番ID固定ガードは検証用設定に明示変更する。設定済みの別プロジェクトの認証情報を流用しない。
4. 専用秘密を安全な環境で生成し、Supabase SecretsのSYNC_CRON_SECRETとVaultのsc_sync_cron_secretへ同じ値を登録する。GitHub/チャット/SQLファイルに値を書かない。
5. 実際のNotion CDNホストだけをSYNC_MEDIA_HOSTSへ設定。HTTPS以外・許可外ホスト・リダイレクト・不正MIME・サイズ超過は拒否する。画像8MiB/音声40MiBを超える既存ファイルは事前確認する。
6. SYNC_APPLY_ENABLEDを未設定/falseのまま新関数をデプロイし、認証なし401、正しい認証のdry-run差分を確認。旧関数は別名なので、この時点では旧Cronを変更しない。
7. 会員/記事RLS・署名メディア・候補HTMLを揃えて検証し、差分とテスト結果をユーザーが承認してから切り替える。サーバー準備確認に通らない限りapplyは拒否する。
8. 切替の短いメンテナンス時間で既存ジョブのコマンドを安全な関数に変更。名前と03:00 JSTを維持し、新しい3分ジョブを追加する。旧関数が実行中でないことを確認する。cronテンプレートも初期dry_run=trueなので、別途承認した時点でfalseにする。
9. 旧・認証なしの入口を残さない。旧関数は専用認証で保護して呼び出し元を揃えるか、安全な新関数への移行完了後に停止する。削除付きの旧コードを復旧先として再有効化しない。
10. 新規公開、本文ページだけの更新、画像/MP3変更、公開取り消し、未契約/他会員区分の拒否、管理者・動画機能を実会員環境で確認する。

障害時：3分ジョブを停止し、新関数の書き込みを無効化する。最後に成功した本文・メディアは保持される。必要なら承認したバックアップから復元する。メディアの自動清掃は含めない。

## 実施した検証と限界

同期19件、同期SQL8件、会員/メディア9件の計36テストを実施。ローカルWASM PostgreSQL上で権限と保存を検証。認証・dry-run・差分・メディア・失敗時保持・RPCの権限制限・重複ロック・記事と状態の原子的保存を検証した。
CSVの列型・既定値・UNIQUE制約に合わせた検証用DDLでテストした。idのIDENTITY採番方式は仮置きで追加確認中。本番の全DDL・RLS・トリガー互換性、Supabase Edge Runtime上でのデプロイ、Notion/Supabase実API、Cron/pg_net/Vaultの動作は未検証。CronテンプレートのSQLは本番で実行していない。

## 成功判定と監視

CronのSucceededだけを成功判定にしない。Edge FunctionのHTTP応答・logsと、`updated / unchanged / errors / attention` を見る。`deleted` は常に0。
200は正常、401は認証失敗、403はapply未許可、409はロック競合または要確認、502は取得/保存失敗、503はサーバー設定不備。
個別記事失敗でも他の記事は成功する場合がある。未成功記事のfingerprintは進めず次回再試行する。100秒制限に繰り返し達する場合はポーリング間隔短縮では解決せず、分割処理へ移行する。

公式資料：
- https://supabase.com/docs/guides/cron
- https://supabase.com/docs/guides/functions/limits
- https://supabase.com/pricing
- https://developers.notion.com/reference/request-limits
- https://developers.notion.com/reference/webhooks
