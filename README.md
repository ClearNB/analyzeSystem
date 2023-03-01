# AnalyzeSystem
v 1.3.1
SNMPを用いた、ログ監視システム

## このシステムについて
このシステムは、SNMPを用いてログ監視を行います

ログ監視された情報はMySQLのデータベースに蓄積され、情報を入手するには監視ソフト「Viewer」を用います

## 機能
- SNMPv3を用いて対応機器のデータ（システム情報・インタフェース情報・IPアドレス情報・パケット情報）を監視します
- データ監視は60秒定期で行われます
- トラップ受信も行い、内容によって日本語に変換します
- 監視ソフト「Viewer」との通信を行います

## Analyzerとの通信について
- Viewerとの通信は「TCPソケット通信」を行います
- データ形式はJSONで、JSONを文字列化した状態で通信します
- ポートは3000/tcp（デフォルト）を開放します

## データベースについて
- AnalyzeSystemのデータの蓄積には、MySQL（InnoDB）を用いたデータベースが必要です
- MySQLデータベースサーバは別途用意してください
- ユーザはパスワードを設定して作成します
- セットアップスクリプト（apdb.sql）がありますので、必ずセットアップしてください
https://gist.github.com/ClearNB/386c66250163d5b895726c2cd83ffa8c

## 導入方法
1. 必要なアプリをインストールします
```sh
sudo apt-get update
sudo apt-get install -y nodejs npm snmpd
```

2. gitを使い、AnalyzeSystemをクローンします
```sh
git clone https://github.com/ClearNB/analyzeSystem.git
```

3. /etc/snmp/snmpd.conf を編集します（テスト用SNMPエージェントの作成）
以下は作成フォーマットです
```sh
## /etc/snmp/snmpd.conf の設定
# sysLocation / sysContact の設定
sysLocation [システムの場所]
sysContact [連絡先の名前] [<メールアドレス>]

# サービス値の設定
sysServices 79

# 運用システムの設定
master agentx

# エージェントのアクセスIPアドレスの設定
agentaddress udp:161

# ユーザー（USM）の作成
createUser [セキュリティネーム] SHA [認証パスワード] AES [暗号化パスワード]

# リードオンリーユーザーとしての登録
rouser [セキュリティネーム] authPriv

# トラップの設定（送信先・ユーザの名前を指定）
trapsess -v 3 -l authPriv -u [セキュリティネーム] [送信先IPアドレス]
# 認証情報付きのトラップを有効化（0で無効化）
authtrapenable 1
```

その後、snmpdを再起動し、OSの起動時にsnmpdの起動を有効にします
```sh
sudo systemctl restart snmpd
sudo systemctl enable snmpd
```

4. クローンしたAnalyzeSystem内のinput_example.jsを編集します
「エージェント情報」「ユーザ情報」「DBサーバ情報」「トラップ情報」を設定します
input_example.jsには、書き方例が記載されているので、従って記載してください
なお、「エージェント情報」「ユーザ情報」「トラップ情報」は、オブジェクトをコンマ区切りで複数記載することができます

5. 編集したinput_example.jsをinput.jsに変換します
```sh
mv input_example.js input.js
```

6. npmを実行し、package.jsonに記載されたパッケージをインストールします
```sh
npm install
```

7. ufwでファイアウォールを設定し、通信可能な状態にします
```sh
sudo ufw enable
sudo ufw allow 3000/tcp
sudo ufw allow 161/udp
sudo ufw allow 3306/tcp
sudo ufw allow 162/udp
sudo ufw allow out 161/udp
sudo ufw allow out 3000/tcp
sudo ufw allow out 3306/tcp
sudo ufw allow out 162/udp
sudo systemctl enable ufw
sudo ufw reload
```

8. NodeJSスクリプトを起動します（管理者権限必須）
```sh
sudo node connect.js
```

## 更新情報
2023/03/01 - v 1.3.1
 - トラップ情報が正しく更新されないバグの修正

2023/03/01 - v 1.3.0
 - トラップ情報をinput.jsで記載可能になりました
 - トラップ情報は「trap_input_data」という変数で書き換えが可能です
 - ログのフォーマット基準を定めました
> - 追加：マゼンタ
> - 更新：シアン
> - 成功：グリーン
> - トラップ・失敗：レッド
> - すでに存在：イエロー

2023/01/15 - v 1.2
 - サーバログ機能搭載
 - データベースを含む全ての機能が完成

2023/01/01 - v.1.1-β
 - TCPソケット通信テストバージョン
 - SNMPv3トラップ通信対応

2023/12/01 - v 1.0-β
 - 初期リリースバージョン
 - SNMPv3の通信デバッグ