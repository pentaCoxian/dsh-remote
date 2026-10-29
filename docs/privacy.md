# DSH Remote Privacy Policy

Last updated: 2026-10-29
Operator: pentaCoxian (contact: dshremote@pentacoxian.dev)

[日本語は下にあります](#dsh-remote-プライバシーポリシー)

## 1. About the app

DSH Remote connects your phone, over an end-to-end encrypted connection, to the DeepSeek Harness (DSH) you run on your own computer. There are no accounts. We do not collect names, email addresses, contacts or location.

## 2. What the operator handles

- **Notification routing.** For each host you turn notifications on for, the notification gateway stores a random identifier, the public key IDs of your phone and the host, the platform (APNs or FCM), your device's push token, and when the entry was created and last used. Notification content is encrypted with a key only your phone and your host hold. We cannot read it and do not store it.
- **Relay logs.** The relay's operational logs (for example connection errors) include the client's IP address and port. The relays forward encrypted traffic and cannot read it.

## 3. Purpose

Only to deliver notifications, run and troubleshoot the service, and prevent abuse. Never for advertising, tracking or analytics.

## 4. Retention

- Notification routing entries are deleted when you remove them (see 6), when the push token becomes invalid, or 90 days after they were last used.
- Notifications that cannot be delivered are kept by Apple or Google for at most one hour.
- Relay logs are deleted after 14 days.

## 5. Sharing and service providers

We share nothing with third parties unless the law requires it. We use these providers, which handle encrypted traffic and what delivery needs (push tokens, IP addresses) under their own policies:

- Apple Push Notification service (Apple), to deliver notifications on iPhone
- Firebase Cloud Messaging (Google), to deliver notifications on Android. No other Firebase service (such as Analytics or Crashlytics) is used
- Vultr, which hosts our relay and notification gateway in Tokyo
- Public relays run by n0, inc. (the makers of iroh), used as a fallback

## 6. Deletion

- Turn notifications off in a host's settings in the app: that host's routing entry is deleted at once.
- Remove a host from the app: its routing entry, keys and connection details are deleted.
- Revoke your phone on the host: the host deletes its entry and stops notifying.
- Delete the app: its data on your phone is gone, and the routing entry is deleted at the next failed delivery or after 90 days.

For anything else, write to dshremote@pentacoxian.dev.

## 7. Data on your own host

DSH Web content, the record of paired phones and the request log stay on your own computer and never reach us.

## 8. Changes

We will announce changes on this page.

---

# DSH Remote プライバシーポリシー

最終更新日: 2026-10-29
運営者: pentaCoxian（連絡先: dshremote@pentacoxian.dev）

## 1. このアプリについて

DSH Remote は、利用者が自分のパソコンで動かしている DeepSeek Harness（DSH）に、スマートフォンからエンドツーエンド暗号化された接続でつなぐアプリです。アカウント登録はなく、氏名・メールアドレス・連絡先・位置情報は取得しません。

## 2. 運営者が扱う情報

- **通知の宛先情報**: 通知をオンにしたホストごとに、通知ゲートウェイが次の情報を保存します。ランダムな識別子、端末とホストの公開鍵 ID、プラットフォーム（APNs / FCM）、端末のプッシュトークン、作成日時と最終利用日時。通知の本文は端末とホストだけが持つ鍵で暗号化されており、運営者は読めず、保存もしません。
- **中継サーバーのログ**: 中継サーバーは、接続エラーなどの運用ログに接続元の IP アドレスとポートを記録します。中継サーバーは暗号化された通信を転送するだけで、内容は読めません。

## 3. 利用目的

通知の配信、サービスの運用・障害対応、不正利用の防止のためだけに使います。広告・トラッキング・分析には使いません。

## 4. 保存期間

- 通知の宛先情報は、利用者が削除したとき（6 を参照）、プッシュトークンが無効になったとき、または最後に使われてから 90 日で削除します。
- 届けられなかった通知は、Apple または Google が最長 1 時間保持したあと破棄されます。
- 中継サーバーのログは 14 日で削除します。

## 5. 第三者への提供と外部サービス

法令に基づく場合を除き、第三者に提供しません。次の事業者を利用しており、各社は暗号化された通信と配信に必要な情報（プッシュトークンや IP アドレス）を各社の方針に従って扱います。

- Apple Push Notification service（Apple）: iPhone への通知の配信
- Firebase Cloud Messaging（Google）: Android への通知の配信。Analytics・Crashlytics など他の Firebase のサービスは使いません
- Vultr: 東京の中継サーバーと通知ゲートウェイのホスティング
- n0, inc.（iroh の開発元）の公開リレー: 予備の中継サーバー

## 6. 削除の方法

- アプリのホスト設定で通知をオフにする: そのホストの宛先情報をすぐに削除します。
- アプリからホストを削除する: 宛先情報、鍵、接続情報を削除します。
- ホストで端末の許可を取り消す: ホストが登録を削除し、通知を止めます。
- アプリを削除する: 端末内のデータが消え、宛先情報は次の配信の失敗時か 90 日後に削除されます。

その他のご依頼は dshremote@pentacoxian.dev までお送りください。

## 7. 利用者自身のホストのデータ

DSH Web の内容、ペアリングした端末の記録、要求の記録は利用者自身のパソコンに保存され、運営者には届きません。

## 8. 改定

内容を変更するときは、このページで告知します。
