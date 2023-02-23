const snmp = require('net-snmp'); // 使用モジュール（ここは消さない！）

/**
 * [アイコンIDについて]
 * PC … 1
 * タブレット … 2
 * サーバ(種別なし) … 3
 * ルータ … 4
 * ブリッジ … 5
 * L3スイッチ … 6
 * L2スイッチ … 7
 * Wi-Fi … 8
 * ファイアウォール … 9
 * プリンター … 10
 * 監視カメラ … 11
 */

/**
 * エージェント登録情報
 * @type Array
 */
const agent_input_data = [
    {
        agentid: "1",                           // エージェントID
        host: "localhost",                      // ホストアドレス
        gport: "161",                           // 取得ポート
        tport: "162",                           // トラップポート
        hname: "APサーバ",                      // ホスト名
        iconid: "3",                            // アイコンID
        posx: "200",                            // 機器表示のX座標
        posy: "50",                             // 機器表示のY座標
        stype: snmp.SecurityLevel.authPriv,     // セキュリティレベル（noAuthNoPriv, authNoPriv, noAuthNoPriv）
        sname: "test_user03",                   // ユーザ名
        aalgoid: snmp.AuthProtocols.sha,        // 認証アルゴリズム（none…なし, md5…MD5, sha…SHA）
        apass: "user_pass03",                   // 認証パスワード
        palgoid: snmp.PrivProtocols.aes,        // 暗号化プロトコル（none…なし, des…DES, aes…AES）
        ppass: "user_pass03",                   // 暗号化パスワード
        conn: [
            [
                "1",                            // 接続元エージェントID
                "00-0C-29-D9-A3-00",            // 接続元インタフェースMACアドレス
                "2",                            // 接続先エージェントID
                "28-80-88-E4-1C-C4"             // 接続先インタフェースMACアドレス
            ]
        ],
        packet_thre: 10000000                   // しきい値の最大（パケット許容量の限界）
    }
];

/**
 * ユーザ情報（増やすときは54～57の4行を下にコピーする）
 */
const user_input_data = [
    {
        username: 'test_user01',    // ユーザ名
        password: 'user_pass01'     // パスワード
    }
];

/**
 * データベース情報
 */
const database_input_data = {
    host: '192.168.254.2',      // DBサーバのホストアドレス
    user: 'apdbuser',           // DBサーバのユーザ名
    password: 'apdbuser',       // DBユーザのパスワード
    database: 'apdb',           // 使用するデータベース名
    Promise: ''                 // NodeJS用の非同期処理プロセス（ここは空欄でOK）
};

exports.agentInputData = agent_input_data;
exports.userInputData = user_input_data;
exports.databaseData = database_input_data;