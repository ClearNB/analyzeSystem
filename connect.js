/* AnalyzeSystem v 1.0.0
 * @author ClearNB
 * @description AnalayzeSystemでは、SNMPを用いて機器情報・ネットワーク情報を聞き込み、その情報をデータベースサーバに取り込みます<br>データベースサーバは別途インストールが必要です
 */

/* global process */

const mysql = require('mysql2/promise');
const crypto = require('crypto');
const snmp = require('net-snmp');
const net = require('net');
const inputData = require('./input');

const session_len = 25;
const run_delay = 60000;

const COLOR_YELLOW = '\x1b[33m';
const COLOR_RED = '\x1b[31m';
const COLOR_MAGENTA = '\x1b[35m';
const COLOR_GREEN = '\x1b[32m';
const COLOR_CYAN = '\x1b[36m';
const COLOR_DEFAULT = '\x1b[39m';

let receiver = [];

const ANALYZESYSTEM_VERSION = "1.3.1";

/**
 * [SET] メイン処理
 * アプリケーションの総括実行を行うための処理
 * 各処理の初期実行を担当します
 * 
 * @returns {void}
 */
(async function main() {
    await console.log(`${COLOR_CYAN}Analyze${COLOR_GREEN}System ${COLOR_DEFAULT}ver. ${ANALYZESYSTEM_VERSION}`);


    let yesno = await read_user_input('[INPUT] Reset Agent & Trap data? [y/n] ');

    // データベースチェック
    let con = await get_connection();
    if(!con) {
        // エラーが発生したら、この時点で終了
        data_log(`[${COLOR_RED}ERROR${COLOR_DEFAULT}] ${COLOR_YELLOW} unable to connect database`);
        return;
    } else {
        // 正常につながったので切断
        await con.end();
    }

    switch (yesno) {
        case 'y':
        case 'Y':
            // YESのときのみ、エージェントの初期化をする
            await reset_agent();



            // トラップ情報リセット
            await reset_trap();

            break;
        default:
            await data_log('[AGENT INIT / SKIP]');
            break;
    }

    // ユーザセッティング
    await setup_user();

    // エージェントセッティング
    await agent_setup();

    // トラップ情報セットアップ
    await trap_setup();

    // トラップ受付開始
    await trap_start();

    // 常時監視機能の受付
    setTimeout(async function () {
        yesno = await read_user_input('[INPUT] Enable for regular monitoring? [y/n] ');

        switch (yesno) {
            case 'y':
            case 'Y':
                // YESのときのみ、定期監視を開始する
                await get_start();
                break;
            default:
                await data_log(`[GET / ${COLOR_CYAN}SKIP${COLOR_DEFAULT}]`);
                break;
        }
        // ソケット受付開始（常時通信が開始された時点でソケット通信を開始する）
        await socket_start();
    }, 500);
})();

/**
 * [SET] トラップ情報のセットアップ
 * input.jsに記載されたトラップ情報をセットアップします
 * @returns {void}
 */
async function trap_setup() {
    await data_log(`[TRAP / ${COLOR_CYAN}SETUP${COLOR_DEFAULT}] Starting Trap setup...`);
    let trapData = inputData.trapInputData;
    const con = await get_connection();
    if(trapData && con) {
        for (let t of trapData) {
            // トラップデータの存在確認
            let [rows] = await con.execute("SELECT TRAPOID, TRAPNAME, DESCS, HOW FROM ap_trap WHERE TRAPID = ?", [t['trapid']]);
            if(rows && rows.length === 1) {
                let r = rows[0];
                // 更新必須か確認
                if(r['TRAPOID'] === t['trapoid'] && r['TRAPNAME'] === t['trapname'] && r['DESCS'] === t['desc'] && r['HOW'] === t['how']) {
                    // ログだけ残す
                    await data_log(`[TRAP / ${COLOR_YELLOW}EXISTS${COLOR_DEFAULT}] (${t['trapid']}) ${t['trapoid']} - ${t['trapname']}`);
                } else {
                    // データを更新
                    await con.execute("UPDATE ap_trap SET TRAPOID = ?, TRAPNAME = ?, DESCS = ?, HOW = ? WHERE TRAPID = ?", [t['trapoid'], t['trapname'], t['desc'], t['how'], t['trapid']]);
                    await data_log(`[TRAP / ${COLOR_CYAN}UPDATED${COLOR_DEFAULT}] (${t['trapid']}) ${t['trapoid']} - ${t['trapname']}`);
                }
            } else {
                await con.execute("INSERT INTO ap_trap (TRAPID, TRAPOID, TRAPNAME, DESCS, HOW) VALUES (?, ?, ?, ?, ?)", [t['trapid'], t['trapoid'], t['trapname'], t['desc'], t['how']]);
                await data_log(`[TRAP / ${COLOR_MAGENTA}ADDED${COLOR_DEFAULT}] (${t['trapid']}) ${t['trapoid']} - ${t['trapname']}`);
            }

        }
        await data_log(`[TRAP / ${COLOR_GREEN}SUCCESS${COLOR_DEFAULT}] Successfully Trap Setup`);
    }
}

/**
 * [SET] トラップ情報のリセット
 * トラップ情報をリセットします
 * @returns {void}
 */
async function reset_trap() {
    const con = await get_connection();
    if(con) {
        await data_log(`[TRAP / ${COLOR_CYAN}RESET${COLOR_DEFAULT}] Reset Trap...`);
        await con.execute('DELETE FROM ap_trap');
        await con.execute('ALTER TABLE ap_trap AUTO_INCREMENT = 1');
        await con.end();
        await data_log(`[TRAP / ${COLOR_GREEN}RESET${COLOR_DEFAULT}] Successfully Reset Trap`);
    }
}


/**
 * [SET] ユーザのセットアップ
 * input.jsに記載されたユーザをセットアップします
 * @returns {void}
 */
async function setup_user() {
    await data_log(`[USER / ${COLOR_CYAN}SETUP${COLOR_DEFAULT}] Starting User setup...`);
    let userData = inputData.userInputData;
    if(userData) {
        await reset_user();
        for (let u of userData) {
            await add_user(u['username'], u['password']);
            await data_log(`[USER / ${COLOR_MAGENTA}ADDED${COLOR_DEFAULT}] ${u['username']}`);
        }
        await data_log(`[USER / ${COLOR_GREEN}SUCCESS${COLOR_DEFAULT}] Successfully User Setup`);
    }
}

/**
 * [SET] ユーザのリセット
 * ユーザ情報・ユーザログ情報・ユーザセッション情報を削除します
 * @returns {void}
 */
async function reset_user() {
    const con = await get_connection();
    if(con) {
        await data_log(`[USER / ${COLOR_CYAN}RESET${COLOR_DEFAULT}] Reset User...`);
        await con.execute('DELETE FROM ap_session');
        await con.execute('DELETE FROM ap_userlog');
        await con.execute('DELETE FROM ap_user');

        await con.execute('ALTER TABLE ap_session AUTO_INCREMENT = 1');
        await con.execute('ALTER TABLE ap_userlog AUTO_INCREMENT = 1');
        await con.execute('ALTER TABLE ap_user AUTO_INCREMENT = 1');
        await con.end();
        await data_log(`[USER / ${COLOR_GREEN}RESET${COLOR_DEFAULT}] Successfully Reset User`);
    }
}

/**
 * エージェントのリセット
 * データベース内で保存されているすべてのエージェント情報を消去します
 * @returns {void}
 */
async function reset_agent() {
    data_log(`[AGENT / ${COLOR_CYAN}RESET${COLOR_DEFAULT}] Reset Agent...`);
    const con = await get_connection();
    if(con) {
        // ap_agent_interfaceの削除
        await con.execute('DELETE FROM ap_agent_interface');
        await con.execute('ALTER TABLE ap_agent_interface AUTO_INCREMENT = 1;');
        // ap_getdetailsの削除
        await con.execute('DELETE FROM ap_getdetails');
        await con.execute('ALTER TABLE ap_getdetails AUTO_INCREMENT = 1;');
        // ap_getlogの削除
        await con.execute('DELETE FROM ap_getlog');
        await con.execute('ALTER TABLE ap_getlog AUTO_INCREMENT = 1;');
        // ap_traplogの削除
        await con.execute('DELETE FROM ap_traplog');
        await con.execute('ALTER TABLE ap_getlog AUTO_INCREMENT = 1;');
        // ap_usmの削除
        await con.execute('DELETE FROM ap_usm');
        await con.execute('ALTER TABLE ap_usm AUTO_INCREMENT = 1;');
        // ap_agent_mibの削除
        await con.execute('DELETE FROM ap_agent_mib');
        await con.execute('ALTER TABLE ap_agent_mib AUTO_INCREMENT = 1;');
        // ap_agentの削除
        await con.execute('DELETE FROM ap_agent');
        await con.execute('ALTER TABLE ap_agent AUTO_INCREMENT = 1;');

        await con.end();
    }
    data_log(`[AGENT / ${COLOR_GREEN}RESET${COLOR_DEFAULT}] Successfully Reset Agent`);
}

/**
 * [SET] エージェントのセット
 * 本スクリプト内で設定している情報をもとにデータベースに保存します
 * @returns {void}
 */
async function agent_setup() {
    let agentData = inputData.agentInputData;
    const con = await get_connection();
    if(agentData && con) {
        let mibs = ['1.3.6.1.2.1.1', '1.3.6.1.2.1.2', '1.3.6.1.2.1.4'];
        let int_data = [];
        for (let a of agentData) {
            // トラップデータの存在確認
            let [rows] = await con.execute("SELECT HOSTADDRESS, GETPORT, TRAPPORT, POSX, POSY, HOSTNAME, ICONID, PACKETTHRESHOULD FROM ap_agent WHERE AGENTID = ?", [a['agentid']]);
            let [rows2] = await con.execute("SELECT SECURITYNAME, SECURITYTYPE, AUTHALGOID, AUTHPASS, PRIVALGOID, PRIVALGOPASS FROM ap_usm WHERE AGENTID = ?", [a['agentid']]);
            if(rows && rows2 && rows.length === 1 && rows2.length === 1) {
                let r = rows[0];
                let r2 = rows2[0];
                // 更新必須か確認
                if(r['TRAPOID'] === a['trapoid'] && r['TRAPNAME'] === a['trapname'] && r['DESCS'] === a['desc'] && r['HOW'] === a['how']
                        && r2['SECURITYNAME'] === a['sname'] && r2['STYPE'] === a['stype'] && r2['AUTHALGOID'] === a['aalgoid'] && r2['AUTHPASS'] === a['apass'] && r2['PRIVALGOID'] === a['palgoid'] && r2['PRIVALGOPASS'] === a['ppass']) {
                    // ログだけ残す
                    await data_log(`[AGENT / ${COLOR_YELLOW}EXISTS${COLOR_DEFAULT}] (${a['agentid']}) ${a['hname']} | ${a['host']}:${a['gport']}/udp | ${a['host']}:${a['tport']}/udp`);
                } else {
                    // データを更新
                    await con.execute("UPDATE ap_agent SET HOSTADDRESS = ?, GETPORT = ?, TRAPPORT = ?, POSX = ? , POSY = ?, HOSTNAME = ?, ICONID = ?, PACKETTHRESHOULD = ? WHERE AGENTID = ?", [a['host'], a['gport'], a['tport'], a['posx'], a['posy'], a['hname'], a['iconid'], a['packet_thre'], a['agentid']]);
                    await con.execute("UPDATE ap_usm SET SECURITYNAME = ?, SECURITYTYPE = ?, AUTHALGOID = ?, AUTHPASS = ? , PRIVALGOID = ?, PRIVALGOPASS = ? WHERE AGENTID = ?", [a['sname'], a['stype'], a['aalgoid'], a['apass'], a['palgoid'], a['ppass'], a['agentid']]);
                    await data_log(`[AGENT / ${COLOR_CYAN}UPDATED${COLOR_DEFAULT}] (${a['agentid']}) ${a['hname']} | ${a['host']}:${a['gport']}/udp | ${a['host']}:${a['tport']}/udp`);
                }
            } else {
                await con.execute('INSERT INTO ap_agent (AGENTID, HOSTADDRESS, GETPORT, TRAPPORT, POSX, POSY, HOSTNAME, ICONID, PACKETTHRESHOULD) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [a['agentid'], a['host'], a['gport'], a['tport'], a['posx'], a['posy'], a['hname'], a['iconid'], a['packet_thre']]);
                await con.execute('INSERT INTO ap_usm (AGENTID, SECURITYNAME, SECURITYTYPE, AUTHALGOID, AUTHPASS, PRIVALGOID, PRIVALGOPASS) VALUES (?, ?, ?, ?, ?, ?, ?)', [a['agentid'], a['sname'], a['stype'], a['aalgoid'], a['apass'], a['palgoid'], a['ppass']]);
                for (let m of mibs) {
                    // 1件ずつ追加
                    await con.execute('INSERT INTO ap_agent_mib (MIBGROUPID, AGENTID) VALUES (?, ?)', [m, a['agentid']]);
                }
                // インタフェース設定の追加
                for (let ink of a['conn']) {
                    int_data.push(ink);
                }
                await data_log(`[AGENT / ${COLOR_MAGENTA}ADDED${COLOR_DEFAULT}] (${a['agentid']}) ${a['hname']} | ${a['host']}:${a['gport']}/udp | ${a['host']}:${a['tport']}/udp`);
            }

        }
        // インタフェースの追加
        for (let i of int_data) {
            await con.execute('INSERT INTO ap_agent_interface (ORIGAGENTID, ORIGMACADDRESS, CONAGENTID, CONMACADDRESS) VALUES (?, ?, ?, ?)', [i[0], i[1], i[2], i[3]]);
            await data_log(`[AGENT / ${COLOR_MAGENTA}ADDED${COLOR_DEFAULT}] INTERFACE ([${i[0]}]${i[1]} <-> [${i[2]}]${i[3]})`);
        }
        // セッションの切断
        await con.end();
        await data_log(`[TRAP / ${COLOR_GREEN}SUCCESS${COLOR_DEFAULT}] Successfully Trap Setup`);
    }
}

/**
 * [SET] 定期監視のセットアップ
 * @returns {void}
 */
async function get_start() {
    await data_log(`[GET / ${COLOR_CYAN}SETUP${COLOR_DEFAULT}] Starting Get Setup...`);
    await data_log(`[GET / ${COLOR_GREEN}SET${COLOR_DEFAULT}] Regular monitoring has been started on and set duration ${run_delay / 1000} s`);
    // 1分間に一度起動
    await set_log_agents();
    setInterval(async function () {
        await set_log_agents();

    }, run_delay);
}

/**
 * [SET] トラップレシーバー作成
 * SNMPトラップを受け付けるレシーバーです
 * @returns {void}
 */
async function trap_start() {
    data_log(`[TRAP / ${COLOR_CYAN}SETUP${COLOR_DEFAULT}]`);
    // レシーバーリストをリセットする
    receiver = [];
    // エージェントごとのポートで開放するようにする
    let agents = await get_agents();
    let ports = [];
    let r = '';
    for (let agentid of agents) {
        let info = await get_agent_info(agentid);
        // ポートを探す
        let portindex = ports.findIndex(p => p === info['trapport']);
        if(portindex === -1) {

            // デフォルト設定
            let options = {
                port: info['trapport'],
                disableAuthorization: false,
                includeAuthentication: true,
                accessControlModelType: snmp.AccessControlModelType.None,
                engineID: "8000B98380XXXXXXXXXXXXXXXXXXXXXXXX",
                address: null,
                transport: "udp4"
            };
            data_log(`[TRAP / ${COLOR_CYAN}SET${COLOR_DEFAULT}] :${info['trapport']}/udp`);
            let callback = async function (error, notification) {
                if(error) {
                    // エラーを吐く
                    console.error(error);
                } else {
                    // それ以外（PDUおよびRINFOからエージェント情報を検索する）
                    let pdu = notification['pdu'];
                    let rinfo = notification['rinfo'];
                    let user = pdu.user;
                    let address = rinfo['address'];

                    const con = await get_connection();
                    if(!con) {
                        return;
                    }

                    // エージェント検索
                    let [rows] = await con.execute('SELECT a.AGENTID FROM ap_agent a INNER JOIN ap_usm b ON a.AGENTID = b.AGENTID WHERE a.HOSTADDRESS = ? AND b.SECURITYNAME = ?', [address, user]);
                    let agent = -1;
                    if(rows && rows[0]) {
                        agent = rows[0]['AGENTID'];
                        if(agent !== -1) {
                            let varbinds = pdu.varbinds;

                            let result = {
                                addlog: (agent !== -1),
                                traptype: 999,
                                oid: '',
                                other: [],
                                agent: agent
                            };
                            // ログ展開
                            for (let v of varbinds) {
                                if(snmp.isVarbindError(v)) {
                                    // ログデータにエラーがある場合
                                    console.error(snmp.varbindError(v));
                                } else {
                                    switch (v['oid']) {
                                        case '1.3.6.1.6.3.1.1.4.1.0': /* OID情報 */
                                            // トラップOID
                                            result['oid'] = v['value'];
                                            [rows] = await con.execute('SELECT TRAPID as id FROM ap_trap WHERE TRAPOID = ?', [result['oid']]);
                                            if(rows && rows[0]) {
                                                // 登録しているOIDであれば、その番号を入れる
                                                result['traptype'] = rows[0]['id'];
                                            }
                                            break;
                                        default: /* その他 */
                                            let search = await search_japname(v['oid'].toString());
                                            if(search) {
                                                result['other'].push(search + ' : ' + v['value']);
                                            } else if(v['oid'].toString() !== '1.3.6.1.2.1.1.3.0') {
                                                result['other'].push(v['oid'] + ' : ' + v['value']);
                                            }
                                    }
                                }
                            }
                            if(result['addlog']) {
                                // addlogがtrueのときのみデータベースに保管
                                if(result['traptype'] !== 6) {
                                    await con.execute('INSERT INTO ap_traplog (AGENTID, TRAPID, OTHER) VALUES (?, ?, ?)', [result['agent'], result['traptype'], result['other'].join("\n")]);
                                } else {
                                    // 6 : その他の場合は、OID情報をotherに載せた状態にする
                                    await con.execute('INSERT INTO ap_traplog (AGENTID, TRAPID, OTHER) VALUES (?, ?, ?)', [result['agent'], result['traptype'], "OID: " + result['oid'] + "\n" + result['other'].join("\n")]);
                                }
                            }
                            data_log(`[TRAP | ${COLOR_RED}RECEIVED${COLOR_DEFAULT}] ${JSON.stringify(result)}`);
                        } else {
                            data_log(`[TRAP | ${COLOR_RED}RECEIVED ANY?${COLOR_DEFAULT}] ${JSON.stringify(result)}`);
                        }
                    }
                }
            };
            r = snmp.createReceiver(options, callback);
            // 同じ位置にプッシュする
            receiver.push(r);
            ports.push(info['trapport']);
        } else {
            r = receiver[portindex];
        }
        if(r) {
            // ユーザの設定（V3のUSMの設定）
            let sec = await get_agent_security(agentid);
            r.getAuthorizer().addUser(sec);
            data_log(`[TRAP / ${COLOR_MAGENTA}USER ADDED${COLOR_DEFAULT}] ${COLOR_CYAN}${sec['name']}${COLOR_DEFAULT} [${info['hostaddress']}]`);
        }
    }
}

/**
 * [GET] OIDから日本語名を調べる
 * 前方一致のOIDより検索します
 * @param {type} oid 元のOIDを指定します
 * @returns {String} 前方一致で検索されたもののうち、最初の1件を返します
 */
async function search_japname(oid) {
    const con = await get_connection();
    let result = '';
    if(con) {
        let [rows] = await con.execute(`SELECT JAPNAME as name FROM ap_mib WHERE ? LIKE concat(OBJECTID, '.', '%') LIMIT 1`, [oid]);
        await con.end();
        if(rows && rows[0]) {
            result = rows[0]['name'];
        }
    }
    return result;
}

/**
 * [SET] ソケット通信開始
 * ソケット通信を開始します
 * @returns {void}
 */
async function socket_start() {
    data_log(`[SOCKET / ${COLOR_CYAN}SETUP${COLOR_DEFAULT}]`);
    let port = 3000;
    const server = net.createServer(async function (socket) {
        socket.setEncoding('utf8');
        // データ通信が行われたとき
        socket.on('data', async function (data) {
            // レスポンスのデフォルト
            let res = {func: '', result: ''};
            data_log(`[SOCKET / ${COLOR_CYAN}REQUEST<-${COLOR_DEFAULT}] ${data}`);

            // JSONチェック
            if(!is_json(data)) {
                res = {func: 'undefined', result: 'nojson'};
            } else {
                // JSON化する
                let json_de = JSON.parse(data);

                if(!json_de['func']) {
                    // funcがないデータはリクエスト拒否
                    res = {func: 'undefined', result: 'badrequest'};
                } else {
                    // レスポンスのフォーム
                    res = {func: json_de['func'], result: 'unknown'};
                    // funcがあるか確認する
                    if(json_de['func']) {
                        // funcごとにデータを取得する
                        switch (json_de['func']) {
                            case 'login': // ログイン処理
                                res = await ap_login(json_de['username'], json_de['password']);
                                break;
                            case 'getagents': // エージェント取得
                                res = await get_agents_request(json_de['username'], json_de['session']);
                                break;
                            case 'get_connections': // 接続情報取得
                                res = await get_connections_request(json_de['username'], json_de['session']);
                                break;
                            case 'getagent_latest': // エージェントの最新情報を取得
                                // 結果
                                res = await get_agent_latest_request(json_de['username'], json_de['session'], json_de['agentid']);
                                break;
                            case 'get_log': // ログの取得
                                // 結果
                                res = await get_log_request(json_de['username'], json_de['session'], json_de['logid']);
                                break;
                            case 'get_interface': // インタフェース情報の取得
                                res = await get_log_interface_request(json_de['username'], json_de['session'], json_de['logid'], json_de['interface_id']);
                                break;
                            case 'get_traplog': // トラップログの取得
                                res = await get_traplog_request(json_de['username'], json_de['session'], json_de['traplogid']);
                                break;
                            case 'logout': // ログアウト処理
                                res = await get_logout_request(json_de['username'], json_de['session']);
                                break;
                        }
                    }
                }
            }
            data_log(`[SOCKET / ${COLOR_GREEN}RESPONSE->${COLOR_DEFAULT}] ${JSON.stringify(res)}`);
            // 応答にJSONを文字化したものを書き込む
            socket.write(JSON.stringify(res) + '\0');
        });
        // 何らかの例外が発生したとき
        socket.on('error', function (error) {
            // 他の処理には影響がないので、サーバをクラッシュさせないように、警告化する
            socket.emit('warning', error);
            data_log(`[SOCKET / ${COLOR_RED}WARN${COLOR_DEFAULT}] ${socket.remoteAddress}:${socket.remotePort} ${error.code} (${error.syscall})`);
        });
    }).listen(port, async function () {
        data_log(`[SOCKET / ${COLOR_CYAN}SET${COLOR_DEFAULT}] ${server.address().address}:${server.address().port}/tcp`);
    });

    // 接続されたとき
    server.on('connection', async function (socket) {
        data_log(`[SOCKET / ${COLOR_YELLOW}CONNECT${COLOR_DEFAULT}] ${socket.remoteAddress}:${socket.remotePort}`);
        // 5000ミリ秒のタイムアウト
        socket.setTimeout(5000);
        socket.on('timeout', () => {
            data_log(`[SOCKET / ${COLOR_MAGENTA}TIMEOUT${COLOR_DEFAULT}] ${socket.remoteAddress}:${socket.remotePort}`);
            socket.end();
        });
        // 接続を閉じるとき
        socket.on('close', () => {
            data_log(`[SOCKET / ${COLOR_YELLOW}CLOSE${COLOR_DEFAULT}] ${socket.remoteAddress}:${socket.remotePort}`);
        });
    });

    // サーバが閉じるとき
    server.on('close', function () {
        // 3000ミリ秒後にソケット通信を再開
        setTimeout(function () {
            socket_start();
        }, 3000);
    });

    /**
     * [GET] JSON形式チェック
     * JSONをパースしてみて、エラーをキャッチした場合はJSON形式でないとして確認します
     * @param {String} data 文字列データを指定します
     * @returns {Boolean} JSON形式であればtrue、そうでなければfalseを返します
     */
    function is_json(data) {
        try {
            JSON.parse(data);
        } catch (error) {
            return false;
        }
        return true;
    }
}

/**
 * [GET] エージェント一覧取得リクエスト処理
 * @param {String} username ユーザ名を指定します
 * @param {String} session セッションを指定します
 * @returns {get_agents_request.res} レスポンス
 */
async function get_agents_request(username, session) {
    let res = {'func': 'getagents', 'result': '', 'session': '', 'agents': []};
    // セッションのチェック
    res['result'] = await ap_check_session(username, session);

    if(res['result'] === 'sa_success') {
        // セッションコードを更新
        res['session'] = await ap_update_session_from_username(username);
        if(res['session']) {
            // エージェント取得可能になる
            let agents = await get_agents();
            if(agents) {
                res['result'] = 'success';
                res['agents'] = agents;
            } else {
                res['result'] = 'noagents';
            }
        } else {
            res['result'] = 'dberror';
        }
    }
    return res;
}

/**
 * [GET] 接続情報取得リクエスト処理
 * @param {String} username ユーザ名を指定します
 * @param {String} session セッションを指定します
 * @returns {get_agents_request.res} レスポンス
 */
async function get_connections_request(username, session) {
    let res = {'func': 'get_connections', 'result': '', 'session': '', 'connections': []};
    // セッションのチェック
    res['result'] = await ap_check_session(username, session);
    if(res['result'] === 'sa_success') {
        res['session'] = await ap_update_session_from_username(username);
    }

    if(res['result'] === 'sa_success') {
        if(res['session']) {
            // エージェント取得可能になる
            let agents = await get_agents();
            if(agents) {
                res['result'] = 'success';
                for (let a of agents) {
                    let con = await get_agent_interface(a);
                    if(con) {
                        for (let c of con) {
                            // 反対方向のエージェントのつながりは冗長なので除外する
                            if(!res['connections'].find(
                                    r => r[0] === c[2] && r[1] === c[3] && r[2] === c[0] && r[3] === c[1])) {
                                res['connections'].push(c);
                            }
                        }
                    }
                }
            } else {
                res['result'] = 'noagents';
            }
        } else {
            res['result'] = 'dberror';
        }
    }
    return res;
}

/**
 * [GET] 最新のエージェント情報取得
 * @param {String} username ユーザ名を指定します
 * @param {String} session セッションを指定します
 * @param {Number} agentid エージェントIDを指定します
 * @returns {get_agent_latest_request.res}
 */
async function get_agent_latest_request(username, session, agentid) {
    const con = await get_connection();
    let res = {'func': 'getagent_latest', 'result': '', 'session': '', 'agent_info': [], 'latest_data': '', 'latest_trap': '', 'log_list': [], 'trap_list': []};

    // セッションのチェック
    let scheck = await ap_check_session(username, session);
    if(scheck === 'sa_success') {
        // セッションコードを更新
        res['session'] = await ap_update_session_from_username(username);
    }

    // エージェントIDがあるかチェック
    if(!agentid) {
        scheck = 'invalid';
    }

    if(scheck === 'sa_success') {
        // エージェント情報取得
        res['agent_info'] = await get_agent_info(agentid);
        if(res['session'] && con) {
            if(res['agent_info']) {
                res['result'] = 'success';
                // ログリストを取得
                let loglist = await get_loglist(agentid);
                if(loglist) {
                    // 最新のIDを取得
                    let latest_id = (loglist[0]) ? loglist[0] : '';
                    res['log_list'] = loglist;
                    res['latest_data'] = latest_id;
                }
                // トラップリストの取得
                let traploglist = await get_traplist(agentid);
                if(traploglist) {
                    // 最新のIDを取得
                    let latest_trapid = (traploglist[0]) ? traploglist[0] : '';
                    res['trap_list'] = traploglist;
                    res['latest_trap'] = latest_trapid;
                }
            } else {
                res['result'] = 'noagent';
            }
        } else {
            res['result'] = 'dberror';
        }
    } else {
        res['result'] = scheck;
    }
    await con.end();
    return res;
}

/**
 * [GET] ログリストの取得
 * @param {Number} agentid エージェントIDを指定します
 * @returns {Array|get_agent_latest_request.get_loglist.result}
 */
async function get_loglist(agentid) {
    try {
        const con = await get_connection();
        let [rows] = await con.execute('SELECT GETLOGID as id FROM ap_getlog WHERE AGENTID = ? ORDER BY GETDATE desc', [agentid]);
        await con.end();
        if(rows) {
            let result = [];
            for (let r of rows) {
                result.push(r['id']);
            }
            return result;
        } else {
            return [];
        }
    } catch (err) {
        console.log(err);
        return '';
    }

}

/**
 * [GET] トラップログリストの取得
 * @param {type} agentid
 * @returns {Array|get_agent_latest_request.get_traplist.result}
 */
async function get_traplist(agentid) {
    try {
        const con = await get_connection();
        let [rows] = await con.execute('SELECT TRAPLOGID as id FROM ap_traplog WHERE AGENTID = ? ORDER BY TRAPTIME desc', [agentid]);
        await con.end();
        if(rows) {
            let result = [];
            for (let r of rows) {
                result.push(r['id']);
            }
            return result;
        } else {
            return [];
        }
    } catch (err) {
        console.log(err);
        return '';
    }
}

/**
 * [GET] ログ取得リクエスト処理
 * @param {String} username ユーザ名を指定します
 * @param {String} session セッションを指定します
 * @param {Number} logid ログIDを指定します
 * @returns {get_log_request.res} レスポンスを返します
 */
async function get_log_request(username, session, logid) {
    const con = await get_connection();
    let res = {'func': 'get_log', 'result': '', 'session': '', 'agent_info': [], 'data': {}};

    // セッションのチェック
    let scheck = await ap_check_session(username, session);
    if(scheck === 'sa_success') {
        res['session'] = await ap_update_session_from_username(username);
    }
    // エージェントIDがあるかチェック
    if(!logid) {
        scheck = 'invalid';
    }

    if(scheck === 'sa_success') {
        // エージェント情報取得
        res['agent_info'] = await get_agent_info_from_logid(logid);

        if(res['session'] && con) {
            if(res['agent_info']) {
                res['result'] = 'success';
                // 各種パラメータの取得
                res['data'] = await get_logdata(logid);
                if(!res['data']['date']) {
                    res['data'] = {};
                    res['result'] = 'nodata';
                }
            } else {
                res['result'] = 'nodata';
            }
        } else {
            res['result'] = 'dberror';
        }
    } else {
        res['result'] = scheck;
    }
    await con.end();
    return res;
}

/**
 * [GET] リクエストを受け取り処理（インタフェース情報の取得）
 * ログIDとインタフェースIDからインタフェースの情報を取り出します
 * @param {String} username ユーザ名を指定します
 * @param {String} session セッション情報を指定します
 * @param {Number} logid ログIDを指定します
 * @param {Number} interfaceid インタフェースIDを指定します
 * @returns {get_log_interface_request.res}
 */
async function get_log_interface_request(username, session, logid,
        interfaceid) {
    let res = {'func': 'get_interface', 'result': '', 'session': '', 'data': {}};

    // セッションのチェック
    let scheck = await ap_check_session(username, session);
    if(scheck === 'sa_success') {
        res['session'] = await ap_update_session_from_username(username);
    }

    // エージェントIDがあるかチェック
    if(!logid || !interfaceid) {
        scheck = 'invalid';
    }

    if(scheck === 'sa_success') {
        if(res['session']) {
            res['result'] = 'success';
            // 各種パラメータの取得
            res['data'] = await get_data_select_interface(logid, Number(interfaceid));
            if(!res['data']) {
                res['data'] = {};
                res['result'] = 'dberror';
            } else if(!res['data']['id']) {
                res['data'] = {};
                res['result'] = 'nodata';
            }
        } else {
            res['result'] = 'dberror';
        }
    } else {
        res['result'] = scheck;
    }
    return res;
}

/**
 * [GET] トラップログリクエスト処理
 * @param {String} username ユーザ名を指定します
 * @param {String} session セッションを指定します
 * @param {Number} traplogid トラップログIDを指定します
 * @returns {get_traplog_request.res} レスポンスを返します
 */
async function get_traplog_request(username, session, traplogid) {
    let res = {'func': 'get_traplog', 'result': '', 'session': '', 'agent_info': '', 'data': {}};

    // セッションのチェック
    let scheck = await ap_check_session(username, session);

    if(scheck === 'sa_success') {
        res['session'] = await ap_update_session_from_username(username);
    }
    // エージェントIDがあるかチェック
    if(!traplogid) {
        scheck = 'invalid';
    }

    if(scheck === 'sa_success') {
        // エージェント情報取得
        res['agent_info'] = await get_agent_info_from_traplogid(traplogid);
        if(res['session']) {
            if(res['agent_info']) {
                res['result'] = 'success';
                // 各種パラメータの取得
                res['data'] = await get_traplog(traplogid);
                if(!res['data']) {
                    res['data'] = {};
                    res['result'] = 'dberror';
                } else if(!res['data']['id']) {
                    res['data'] = {};
                    res['result'] = 'nodata';
                }
            } else {
                res['result'] = 'notfound';
            }
        } else {
            res['result'] = 'dberror';
        }
    } else {
        res['result'] = scheck;
    }
    return res;
}

/**
 * [GET] ログアウトリクエスト処理
 * @param {String} username ユーザ名を指定します
 * @param {String} session セッションを指定します
 * @returns {get_logout_request.res} レスポンスを返します
 */
async function get_logout_request(username, session) {
    let res = {'func': 'logout', 'result': 'success'};
    const con = await get_connection();
    // セッションのチェック
    let scheck = await ap_check_session(username, session);
    if(scheck === 'sa_success') {
        // セッションとユーザの参照を行い、セッションにあるユーザでIDを検索する
        let [rows] = await con.execute('SELECT a.USERID FROM ap_session a INNER JOIN ap_user b ON a.USERID = b.USERID WHERE b.USERNAME = ?', [username]);
        if(rows && rows[0]['USERID']) {
            let userid = rows[0]['USERID'];
            // セッションを削除する
            await con.execute("UPDATE ap_session SET SESSIONCODE = NULL, EXPIRATION = NULL WHERE USERID = ?", [userid]);
            // ログに残す
            await con.execute("INSERT INTO ap_userlog (USERID, LOGDATE, LOGTYPEID) VALUES (?, NOW(), 3)", [userid]);
        } else {
            res['result'] = 'failed';
        }
    } else {
        res['result'] = scheck;
    }
    // 接続の終了
    await con.end();
    return res;
}

/**
 * [GET] ログデータ取得
 * ログIDによるデータを取得します
 * @param {Number} logid ログIDを指定します
 * @returns {Array} ログデータをリストで返します
 */
async function get_logdata(logid) {
    const con = await get_connection();
    let logdate = await get_logdate(logid);
    let data = {"id": Number(logid), "date": logdate, "os": "", "system_name": "", "system_location": "", "interfaces": []};
    if(logdate) {
        let [rows] = await con.execute('SELECT a.OBJECTID as id, a.INDEXVALUE as index_v, a.DATA as data_v FROM ap_getdetails a INNER JOIN ap_mib b ON a.OBJECTID = b.OBJECTID WHERE GETLOGID = ? ORDER BY b.NUM, a.INDEXVALUE', [logid]);
        if(rows) {
            for (let r of rows) {
                switch (r['id']) {
                    case '1.3.6.1.2.1.1.1': // os
                        data['os'] = r['data_v'];
                        break;
                    case '1.3.6.1.2.1.1.5': // system name
                        data['system_name'] = r['data_v'];
                        break;
                    case '1.3.6.1.2.1.1.6': // system location
                        data['system_location'] = r['data_v'];
                        break;
                    case '1.3.6.1.2.1.2.2.1.1': // interface id
                        data['interfaces'].push(Number(r['data_v']));
                        break;
                }
            }
        }
    }
    // 接続の終了
    await con.end();
    return data;

    async function get_logdate(logid) {
        let [rows] = await con.execute('SELECT GETDATE as getdate FROM ap_getlog WHERE GETLOGID = ?', [logid]);
        if(rows && rows[0]['getdate']) {
            return rows[0]['getdate'];
        } else {
            return [];
        }
    }
}

/**
 * [GET] エージェントインタフェース情報の取得
 * @param {Number} logid ログIDを指定します
 * @param {Number} interfaceid インタフェースIDを指定します
 * @returns {get_data_select_interface.data}
 */
async function get_data_select_interface(logid, interfaceid) {
    const con = await get_connection();
    let data = {"id": "", "name": "", "mtu": "", "bandwidth": "", "mac_address": "", "admin_status": "", "operate_status": "", "in_packets": "", "in_packets_destruct": "", "in_packets_error": "", "out_packets": "", "out_packets_destruct": "", "out_packets_error": "", "ip_address": "", "subnet_mask": "", "broadcast_address": "", "default_route": []};
    if(con) {
        let [rows] = await con.execute('SELECT a.OBJECTID as id, a.INDEXVALUE as index_v, a.DATA as data_v FROM ap_getdetails a INNER JOIN ap_mib b ON a.OBJECTID = b.OBJECTID WHERE GETLOGID = ? ORDER BY b.NUM, a.INDEXVALUE', [logid]);
        if(rows) {
            let ipaddr_list = {};
            let default_route_list = {};

            for (let r of rows) {
                let n_index = Number(r['index_v']);
                switch (r['id']) {
                    case '1.3.6.1.2.1.2.2.1.1': // interface id
                        if(n_index === interfaceid) {
                            data['id'] = Number(r['data_v']);
                        }
                        break;
                    case '1.3.6.1.2.1.2.2.1.2': // interface name
                        if(n_index === interfaceid) {
                            data['name'] = r['data_v'];
                        }
                        break;
                    case '1.3.6.1.2.1.2.2.1.4': // mtu
                        if(n_index === interfaceid) {
                            data['mtu'] = r['data_v'];
                        }
                        break;
                    case '1.3.6.1.2.1.2.2.1.5': // bandwidth
                        if(n_index === interfaceid) {
                            data['bandwidth'] = r['data_v'];
                        }
                        break;
                    case '1.3.6.1.2.1.2.2.1.6': // mac
                        if(n_index === interfaceid) {
                            data['mac_address'] = r['data_v'];
                        }
                        break;
                    case '1.3.6.1.2.1.2.2.1.7': // admin status
                        if(n_index === interfaceid) {
                            data['admin_status'] = Number(r['data_v']);
                        }
                        break;
                    case '1.3.6.1.2.1.2.2.1.8': // operate status
                        if(n_index === interfaceid) {
                            data['operate_status'] = Number(r['data_v']);
                        }
                        break;
                    case '1.3.6.1.2.1.2.2.1.10': // in packets
                        if(n_index === interfaceid) {
                            data['in_packets'] = r['data_v'];
                        }
                        break;
                    case '1.3.6.1.2.1.2.2.1.13': // in packets (destruct)
                        if(n_index === interfaceid) {
                            data['in_packets_destruct'] = r['data_v'];
                        }
                        break;
                    case '1.3.6.1.2.1.2.2.1.14': // in packets (error)
                        if(n_index === interfaceid) {
                            data['in_packets_error'] = r['data_v'];
                        }
                        break;
                    case '1.3.6.1.2.1.2.2.1.16': // out packets
                        if(n_index === interfaceid) {
                            data['out_packets'] = r['data_v'];
                        }
                        break;
                    case '1.3.6.1.2.1.2.2.1.19': // out packets (destruct)
                        if(n_index === interfaceid) {
                            data['out_packets_destruct'] = r['data_v'];
                        }
                        break;
                    case '1.3.6.1.2.1.2.2.1.20': // out packets (error)
                        if(n_index === interfaceid) {
                            data['out_packets_error'] = r['data_v'];
                        }
                        break;
                    case '1.3.6.1.2.1.4.20.1.1': // ip addr
                        // インデックスに紐づける形にしないといけない
                        ipaddr_list[r['index_v']] = {'ip_address': r['data_v'], 'subnet_mask': '', 'broadcast_address': ''};
                        break;
                    case '1.3.6.1.2.1.4.20.1.3': // subnet mask
                        ipaddr_list[r['index_v']]['subnet_mask'] = r['data_v'];
                        break;
                    case '1.3.6.1.2.1.4.20.1.4': // broadcast address
                        if(r['data_v'] === 1) {
                            ipaddr_list[r['index_v']]['broadcast_address'] = ''; // ブロードキャストを取得できるようにする
                        }
                        break;
                    case '1.3.6.1.2.1.4.21.1.1': // default route
                        if(!default_route_list[r['index_v']]) {
                            default_route_list[r['index_v']] = r['data_v'];
                        }
                        break;
                    case '1.3.6.1.2.1.4.20.1.2': // ip info (interface id)
                        if(ipaddr_list[r['index_v']]) {
                            if(Number(r['data_v']) === interfaceid) {
                                data['ip_address'] = ipaddr_list[r['index_v']]['ip_address'];
                                data['subnet_mask'] = ipaddr_list[r['index_v']]['subnet_mask'];
                                data['broadcast_address'] = ipaddr_list[r['index_v']]['broadcast_address'];
                            }
                        }
                        break;
                    case '1.3.6.1.2.1.4.21.1.2': // default route info (interface id)
                        if(default_route_list[r['index_v']]) {
                            if(Number(r['data_v']) === interfaceid) {
                                data['default_route'].push(default_route_list[r['index_v']]);
                            }
                        }
                        break;
                }
            }
        }
        // 接続の終了
        await con.end();
    } else {
        data = '';
    }

    return data;
}

/**
 * [GET] トラップログの取得
 * @param {Number} traplogid トラップログIDを指定します
 * @returns {get_traplog.rows} トラップログに紐づいたデータをリストで返します
 */
async function get_traplog(traplogid) {
    const con = await get_connection();
    let data = {};
    if(con) {
        let [rows] = await con.execute('SELECT a.TRAPLOGID as id, a.TRAPTIME as date, b.TRAPNAME as name, b.DESCS as descs, b.HOW as how, a.OTHER as other FROM ap_traplog a INNER JOIN ap_trap b ON a.TRAPID = b.TRAPID WHERE TRAPLOGID = ?', [traplogid]);
        if(rows && rows[0]) {
            data = rows[0];
        }
    }
    // 接続の終了
    await con.end();
    return data;
}

/**
 * [SET] すべてのエージェントからのSNMPログセット
 * すべてのエージェントからSNMP通信をリクエストし、それぞれで格納していきます
 * @returns {undefined} データ取得リクエストをエージェントごとに送信します
 */
async function set_log_agents() {
    let agents = await get_agents();
    if(!agents) {
        // エージェントデータがない場合
        data_log("[AGENT | ERROR] No agent!");
        return;
    }
    for (let agentid of agents) {
        await set_log(agentid);
    }
}

async function get_snmp_data(hostaddress, security, getport, trapport, oid) {
    // セッションサブツリーの取得（20件ずつリクエスト）
    return new Promise((resolve, reject) => {
        // オプション（ポート番号・トラップポートの設定）
        const options = {
            port: getport,
            retries: 1,
            timeout: 5000,
            transport: "udp4",
            trapPort: trapport,
            version: snmp.Version3,
            engineID: "8000B98380" + generateRandomHexString(24),
            backwardsGetNexts: true,
            reportOidMismatchErrors: false,
            idBitsSize: 32,
            context: ""
        };
        let result = {};
        const session = snmp.createV3Session(hostaddress, security, options);
        session.subtree(oid, 20, function (varbinds) {
            // 値をバーバインド（値に変換する）ができるか検証し、成功したらMIBと紐づけていく
            for (let v of varbinds) {
                if(snmp.isVarbindError(v)) {
                    // 値のバーバインドができない場合
                    data_log(`[GET / ${COLOR_RED}ERROR${COLOR_DEFAULT}] ${snmp.varbindError(v)}`);
                    return;
                } else {
                    // インデックスと値を分けて保存する
                    let index_s = v.oid.toString().replace(oid + '.', '');
                    let value_s = mib_export(oid, v.value);
                    if(index_s) {
                        result[index_s] = value_s;
                    } else {
                        result = value_s;
                    }
                }
            }
        }, function (error) {
            if(error) {
                reject(error);
            } else {
                resolve(result);
            }
        });
    });

}

/**
 * [SET] エージェントログセット
 * エージェントIDで指定されたログをセットします（SNMPデータを取得し保管します）
 * @param {Number} agentid エージェントIDを指定します
 * @returns {void} SNMP通信をし、取得された結果によって処理を行います
 */
async function set_log(agentid) {
    // エージェント情報の取得
    let agent = await get_agent_info(agentid);
    if(!agent) {
        // エージェントデータがない場合
        data_log(`[GET | ${COLOR_RED}ERROR${COLOR_DEFAULT}] No Agent Data`);
        return;
    }
    // オプション（ポート番号・トラップポートの設定）
    const options = {
        port: agent['getport'],
        retries: 1,
        timeout: 5000,
        transport: "udp4",
        trapPort: agent['trapport'],
        version: snmp.Version3,
        engineID: "8000B98380XXXXXXXXXXXXXXXXXXXXXXXX",
        backwardsGetNexts: true,
        reportOidMismatchErrors: false,
        idBitsSize: 32,
        context: ""
    };
    // セキュリティ情報の取得
    const security = await get_agent_security(agentid);

    // エージェントMIB情報の取得
    const agentmib = await get_agent_mib(agentid);

    // MIBの取得
    const mib = await get_mib(agentmib);

    // インタフェース接続情報の取得
    const conn = await get_all_interface_data();

    if(!mib) {
        data_log(`[GET / ${COLOR_RED}ERROR${COLOR_DEFAULT}] No MIB data`);
        return;
    }
    const con = await get_connection();
    if(con) {
        // データベースにログ取得情報を登録する
        await con.execute('INSERT INTO ap_getlog (AGENTID, GETDATE) VALUES (?, NOW())', [agentid]);
        // 先ほど登録したときのGETLOGIDを取得する
        let [rows] = await con.execute('SELECT GETLOGID FROM ap_getlog WHERE AGENTID = ? ORDER BY GETLOGID DESC LIMIT 1', [agentid]);
        await con.end();
        if(!rows) {
            data_log(`[GET / ${COLOR_RED}ERROR${COLOR_DEFAULT}] Data Log lost!`);
            return;
        }
        // ログIDを取得
        let getlogid = rows[0]['GETLOGID'];

        // MIBグループ順に取っていく
        for (let m of agentmib) {
            // セッションの取得
            const session = await snmp.createV3Session(agent['hostaddress'], security, options);
            // セッションサブツリーの取得（20件ずつリクエスト）
            await session.subtree(m, 20, async function (varbinds) {
                // 関数内でのコネクション確立
                const con = await get_connection();
                if(con) {
                    // 値をバーバインド（値に変換する）ができるか検証し、成功したらMIBと紐づけていく
                    for (let v of varbinds) {
                        if(snmp.isVarbindError(v)) {
                            // 値のバーバインドができない場合
                            data_log(`[GET / ${COLOR_RED}ERROR${COLOR_DEFAULT}] ${snmp.varbindError(v)}`);
                            // 念のため今まで記録していたものを削除する
                            await con.execute('DELETE FROM ap_getdetails WHERE GETLOGID = ?', [getlogid]);
                            await con.execute('DELETE FROM ap_getlog WHERE GETLOGID = ?', [getlogid]);
                            return;
                        } else {
                            let m_res = mib_search(v.oid, mib);
                            if(m_res) {
                                // インデックスをつくる
                                let index_s = v.oid.toString().replace(m_res + '.', '');
                                let value_s = mib_export(m_res, v.value);

                                // データベースに登録
                                await con.execute('INSERT INTO ap_getdetails (GETLOGID, OBJECTID, INDEXVALUE, DATA) VALUES (?, ?, ?, ?)', [getlogid, m_res, index_s, value_s]);
                                // 接続情報の確認（MACアドレスに一致する結果を反映する）
                                if(m_res === '1.3.6.1.2.1.2.2.1.6' && conn) {
                                    for (let c of conn) {
                                        if(c['orig_macaddress'] === value_s) {
                                            await con.execute('UPDATE ap_agent_interface SET ORIGINTERFACEID = ? WHERE INTERFACEID = ?', [index_s, c['id']]);
                                        } else if(c['con_macaddress'] === value_s) {
                                            await con.execute('UPDATE ap_agent_interface SET CONINTERFACEID = ? WHERE INTERFACEID = ?', [index_s, c['id']]);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    // 挿入操作でのコネクション終了
                    await con.end();
                }

            }, async function (error) {
                // 関数内でのコネクション確立
                const con = await get_connection();
                if(con) {
                    if(error) {
                        data_log(`[GET / ${COLOR_RED}ERROR${COLOR_DEFAULT}] -> ${getlogid} ${agent['hostaddress']}:${agent['getport']}/udp) : ${error.toString()}`);
                        await con.execute('DELETE FROM ap_getdetails WHERE GETLOGID = ?', [getlogid]);
                        await con.execute('DELETE FROM ap_getlog WHERE GETLOGID = ?', [getlogid]);
                    } else {
                        data_log(`[GET / ${COLOR_GREEN}SUCCESS${COLOR_DEFAULT}] -> ${getlogid} ${agent['hostaddress']}:${agent['getport']}/udp) : ${m}`);
                    }
                    // 削除操作でのコネクション終了
                    await con.end();
                }
            });
        }
    }
}

async function get_all_interface_data() {
    const con = await get_connection();
    let result = '';
    if(con) {
        let [rows] = await con.execute('SELECT INTERFACEID as id, ORIGAGENTID as orig_agentid, ORIGMACADDRESS as orig_macaddress, ORIGINTERFACEID as orig_interfaceid, CONAGENTID as con_agentid, CONMACADDRESS as con_macaddress, CONINTERFACEID as con_interfaceid FROM ap_agent_interface');
        if(rows) {
            result = rows;
        }
        await con.end();
    }
    return result;
}

/**
 * [GET] MIB変換
 * ObjectIDが対象のデータを表示できるデータに変換します
 * exp_dataに記載されている通り、対象のMIBの値を変換します
 * 
 * @param {String} objectid 検索結果のオブジェクトIDを指定します
 * @param {String} value 値を指定します
 * @returns {String} 変換されたデータを渡します
 */
function mib_export(objectid, value) {
    let result = value;
    if(objectid === "1.3.6.1.2.1.2.2.1.6" || objectid === "1.3.6.1.2.1.4.22.1.2") {
        // MACアドレスなので、適切なフォーマットに変換する
        if(value.toString('hex', 0, value.length)) {
            result = hyphenate(value.toString('hex', 0, value.length).toUpperCase(), 2, "-");
        } else {
            result = "00-00-00-00-00-00";
        }
    }
    return result.toString();
}



/**
 * [GET] MIB検索
 * MIBリストを渡し、そのリストが対象のObjectIDと合致するか検索します
 * 合致しない場合、前方一致による検索結果で抽出します
 * 
 * @param {String} objectid ObjectIDを指定します
 * @param {Array} mibs MIBリストを渡します（oidによって形成されているリストです）
 * @returns {String} 検索結果を文字列で返します
 */
function mib_search(objectid, mibs) {
    let result = '';
    for (let m of mibs) {
        let pattern = new RegExp("^(" + m + ")[.].*");
        if(pattern.exec(objectid)) {
            result = m;
            break;
        }
    }
    return result;
}

/**
 * [GET] MIB取得
 * データベースから指定したグループMIB以下のMIBをすべて取得し、そのOIDを1つの配列にまとめます
 * @param {Array} group_mibs グループMIBのOIDを配列に入れておきます
 * @returns {Array} グループMIBで指定したMIBが一括して配列に格納しています
 */
async function get_mib(group_mibs) {
    const con = await get_connection();
    let result = [];
    if(con) {
        for (let g of group_mibs) {
            let [rows] = await con.execute('SELECT OBJECTID FROM ap_mib WHERE MIBGROUPID = ? ORDER BY NUM', [g]);
            if(rows) {
                for (let r of rows) {
                    result.push(r['OBJECTID']);
                }
            }
        }
        await con.end();
    }
    return result;
}

/**
 * [GET] エージェント情報取得（ログID参照）
 * ユーザ向けのエージェント情報を取得します
 * @param {Number} logid ログIDを指定します
 * @returns {Array|null} エージェントID・ホストアドレス・取得ポート・トラップポート・ホスト名・構成X座標・構成Y座標のリストを返します
 */
async function get_agent_info_from_logid(logid) {
    const con = await get_connection();
    let result = '';
    if(con) {
        let [rows] = await con.execute('SELECT b.AGENTID as agentid, a.HOSTADDRESS as hostaddress, a.GETPORT as getport, a.TRAPPORT as trapport, a.HOSTNAME as hostname, a.POSX as posx, a.POSY as posy, a.PACKETTHRESHOULD as threshould, a.ICONID as iconid FROM ap_agent a INNER JOIN ap_getlog b ON a.AGENTID = b.AGENTID WHERE b.GETLOGID = ? ', [logid]);
        await con.end();
        if(rows && rows.length === 1 && rows[0]) {
            result = rows[0];
        }
    }
    return result;
}

/**
 * [GET] エージェント情報取得（トラップID参照）
 * ユーザ向けのエージェント情報を取得します
 * @param {Number} traplogid トラップログIDを指定します
 * @returns {Array|null} エージェントID・ホストアドレス・取得ポート・トラップポート・ホスト名・構成X座標・構成Y座標のリストを返します
 */
async function get_agent_info_from_traplogid(traplogid) {
    const con = await get_connection();
    let result = '';
    if(con) {
        let [rows] = await con.execute('SELECT b.AGENTID as agentid, a.HOSTADDRESS as hostaddress, a.GETPORT as getport, a.TRAPPORT as trapport, a.HOSTNAME as hostname, a.POSX as posx, a.POSY as posy, a.PACKETTHRESHOULD as threshould, a.ICONID as iconid FROM ap_agent a INNER JOIN ap_traplog b ON a.AGENTID = b.AGENTID WHERE b.TRAPLOGID = ? ', [traplogid]);
        await con.end();
        if(rows && rows.length === 1 && rows[0]) {
            result = rows[0];
        }
    }
    return result;
}

/**
 * [GET] エージェント情報取得
 * ユーザ向けのエージェント情報を取得します
 * @param {Number} agentid エージェントIDを指定します
 * @returns {Array|null} エージェントID・ホストアドレス・取得ポート・トラップポート・ホスト名・構成X座標・構成Y座標のリストを返します
 */
async function get_agent_info(agentid) {
    const con = await get_connection();
    let result = '';
    if(con) {
        let [rows] = await con.execute('SELECT AGENTID as agentid, HOSTADDRESS as hostaddress, GETPORT as getport, TRAPPORT as trapport, HOSTNAME as hostname, POSX as posx, POSY as posy, PACKETTHRESHOULD as threshould, ICONID as iconid FROM ap_agent WHERE AGENTID = ?', [agentid]);
        await con.end();
        if(rows && rows.length === 1 && rows[0]) {
            result = rows[0];
        }
    }
    return result;
}

/**
 * [GET] エージェントセキュリティ情報取得
 * エージェント情報のセキュリティ認証情報を取得します
 * @param {Number} agentid エージェントIDを指定します
 * @returns {Array|null} セキュリティネーム・認証アルゴリズム・認証パス・暗号化アルゴリズム・暗号化パスのリストを返します
 */
async function get_agent_security(agentid) {
    const con = await get_connection();
    let result = '';
    if(con) {
        let [rows] = await con.execute('SELECT SECURITYNAME as name, SECURITYTYPE as level, AUTHALGOID as authProtocol, AUTHPASS as authKey, PRIVALGOID as privProtocol, PRIVALGOPASS as privKey FROM ap_usm WHERE AGENTID = ?', [agentid]);
        await con.end();
        if(rows && rows.length === 1 && rows[0]) {
            result = rows[0];
        }
    }
    return result;
}

/**
 * [GET] エージェントMIB情報取得
 * エージェント情報のMIB情報を取得します
 * @param {Number} agentid エージェントIDを指定します
 * @returns {Array|null} セキュリティネーム・認証アルゴリズム・認証パス・暗号化アルゴリズム・暗号化パスのリストを返します
 */
async function get_agent_mib(agentid) {
    const con = await get_connection();
    let result = '';
    if(con) {
        let [rows] = await con.execute('SELECT MIBGROUPID as id FROM ap_agent_mib WHERE AGENTID = ?', [agentid]);
        await con.end();
        if(rows) {
            result = [];
            for (let r of rows) {
                result.push(r['id']);
            }
        }
    }
    return result;
}

/**
 * [GET] インタフェース情報取得
 * エージェントで監視する対象のインタフェースのMACアドレス一覧を取得します
 * @param {Number} agentid エージェントIDを指定します
 * @returns {Array|String|get_agent_interface.result}
 */
async function get_agent_interface(agentid) {
    const con = await get_connection();
    let result = '';
    if(con) {
        let [rows] = await con.execute('SELECT ORIGAGENTID as agentid, ORIGINTERFACEID as interfaceid, CONAGENTID as con_agentid, CONINTERFACEID as con_interfaceid FROM ap_agent_interface WHERE ORIGAGENTID = ?', [agentid]);
        await con.end();
        if(rows) {
            result = [];
            for (let r of rows) {
                result.push([r['agentid'], r['interfaceid'], r['con_agentid'], r['con_interfaceid']]);
            }
        }
    }
    return result;
}

/**
 * [GET] エージェント検索
 * 指定された情報のエージェントを検索します
 * @param {String} hostaddress ホストアドレスを指定します
 * @param {Number} getport 取得ポートを指定します
 * @param {Number} trapport トラップポートを指定します
 * @param {String} hostname ホスト名を指定します
 * @returns {Number} 取得件数を手に入れた場合はその数字を、データベースエラーや件数が正しく取得できなかった場合は-1を返します
 */
async function search_agent(hostaddress, getport, trapport, hostname) {
    const con = await get_connection();
    if(con) {
        let [rows] = await con.execute('SELECT COUNT(*) AS SCOUNTS FROM ap_agent WHERE HOSTADDRESS = ? AND GETPORT = ? AND TRAPPORT = ? AND HOSTNAME = ?', [hostaddress, getport, trapport, hostname]);
        await con.end();
        return (rows) ? rows[0]['SCOUNTS'] : -1;
    } else {
        return -1;
    }
}



/**
 * [GET] エージェント取得
 * @returns {String|Array} エージェント情報があれば、その情報を配列で返し、何もなければnullを返します
 */
async function get_agents() {
    const con = await get_connection();
    if(con) {
        let [rows] = await con.execute('SELECT AGENTID as id FROM ap_agent');
        await con.end();
        let res = [];
        if(rows) {
            for (let r of rows) {
                res.push(r['id']);
            }
        }
        return res;
    } else {
        return '';
    }
}

/**
 * [GET] コネクション作成
 * MySQLのコネクションを作成します
 * @returns {nm$_index.Connection}
 */
async function get_connection() {
    try {
        const bluebird = require('bluebird');
        let setting = inputData.databaseData;
        setting['Promise'] = bluebird;
        let connection = await mysql.createConnection(setting);
        return connection;
    } catch (err) {
        // エラー発生時
        switch (err.code) {
            case 'ECONNREFUSED':
                data_log(`[${COLOR_RED}DATABASE ERROR${COLOR_DEFAULT}] cannot access database: ECONNREFUSED`);
                break;
            default:
                data_log(`[${COLOR_RED}DATABASE ERROR${COLOR_DEFAULT}] database error: ${err.message}`);
                break;
        }
        return '';
    }
}

/**
 * [GET] セッション認証
 * @param {String} username ユーザ名を指定します
 * @param {String} session セッションコードを指定します
 * @returns {String} レスポンスの結果をsa_に続くステータスで返されます
 */
async function ap_check_session(username, session) {
    let result = 'sa_invalid';
    if(session && session.length === session_len) {
        const con = await get_connection();
        if(!con) {
            result = 'sa_dberror';
        }
        let [rows] = await con.execute('SELECT * FROM ap_user a INNER JOIN ap_session b ON a.USERID = b.USERID WHERE a.USERNAME = ? AND b.SESSIONCODE = ?', [username, session]);
        if((rows && rows.length === 1)) {
            [rows] = await con.execute('SELECT * FROM ap_session WHERE SESSIONCODE = ? AND NOW() < EXPIRATION', [session]);
            result = (rows && rows.length === 1) ? 'sa_success' : 'sa_timeout';
        } else {
            result = 'sa_failed';
        }
        await con.end();
    }
    return result;
}

/**
 * [GET] ログイン処理
 * ユーザ名とパスワードを指定してログインします
 * 
 * @param {string} username ユーザ名を指定します
 * @param {string} password  パスワードを指定します
 * @returns {Array} result と session の連想配列を返します（result はno username or password! / failed / success / database error のいずれかのメッセージが入ります・sessionはsuccessのときのみ返します）
 */
async function ap_login(username, password) {
    let res = {'func': 'login', 'result': 'invalid', 'session': ''};
    if(username && password) {
        const con = await get_connection();
        // conの準備ができているか
        res['result'] = 'failed';
        if(con) {
            // クエリの設定
            let [rows] = await con.execute('SELECT USERID, PASSHASH, PASSSALT FROM ap_user WHERE username = ?', [username]);
            if(rows && rows.length === 1) {
                let id = rows[0]['USERID'];
                let hash = rows[0]['PASSHASH'];
                let salt = rows[0]['PASSSALT'];
                let tryhash = hashPassword(password, salt);
                if(hash === tryhash) {
                    res['result'] = 'success';
                    res['session'] = await ap_update_session(id);
                    if(!res['session']) {
                        res['result'] = 'dberror';
                    } else {
                        // ログに情報を記録する
                        await con.execute('INSERT INTO ap_userlog (USERID, LOGDATE, LOGTYPEID) VALUES (?, NOW(), ?)', [id, 1]);
                    }
                } else {
                    // ログに情報を記録する
                    await con.execute('INSERT INTO ap_userlog (USERID, LOGDATE, LOGTYPEID) VALUES (?, NOW(), ?)', [id, 2]);
                    res['session'] = '';
                }
            }
            // セッションの切断
            await con.end();
        } else {
            res['result'] = 'dberror';
        }
    }
    return res;
}

/**
 * [GET] ユーザ名からセッションコード更新
 * 
 * @param {String} username ユーザ名を指定します
 * @returns {String} 成功したらあたらしいセッションコード、失敗したら空白を返します
 */
async function ap_update_session_from_username(username) {
    const con = await get_connection();
    let result = '';

    if(con) {
        let [rows] = await con.execute('SELECT USERID FROM ap_user WHERE USERNAME = ?', [username]);
        // セッションの切断
        await con.end();
        if(rows && rows.length === 1 && rows[0]['USERID']) {
            let userid = rows[0]['USERID'];
            result = ap_update_session(userid);
        }
    }
    return result;
}

/**
 * [GET] セッションの更新
 * セッション認証の後に更新を行います
 * @param {Number} userid ユーザIDを指定します
 * @returns {String} 更新されたセッションコードを渡します
 */
async function ap_update_session(userid) {
    let session = '';
    const con = await get_connection();
    if(con) {
        // セッションキーの発行（有効期限は現在時刻から30分後）
        session = generateRandomString(session_len);
        let [rows] = await con.execute('SELECT * FROM ap_session WHERE USERID = ?', [userid]);
        if(rows && rows.length === 1) {
            let isloop = true;
            // 重複チェック
            while (isloop) {
                isloop = false;
                [rows] = await con.execute('SELECT * FROM ap_session WHERE SESSIONCODE = ?', [session]);
                if(rows && rows.length > 0) {
                    // 重複したときは再発行
                    session = generateRandomString(15);
                    isloop = true;
                    data_log('session genrating... (duplicate)');
                }
            }
            // セッションと有効期限の更新
            await con.execute('UPDATE ap_session SET SESSIONCODE = ?, EXPIRATION = DATE_ADD(NOW(), INTERVAL 30 MINUTE) WHERE USERID = ?', [session, userid]);
        } else if(rows.length === 0) {
            // なければあたらしいのを作成する
            await con.execute('INSERT INTO ap_session (USERID, SESSIONCODE, EXPIRATION) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE))', [userid, session]);
        } else {
            // 2件以上の場合は、一度削除して、もう一度あたらしいのを作成する
            await con.execute('DELETE FROM ap_session FROM USERID = ?', [userid]);
            await con.execute('INSERT INTO ap_session (USERID, SESSIONCODE, EXPIRATION) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE))', [userid, session]);
        }
        // セッションの切断
        await con.end();
    }
    return session;
}

/**
 * [GET] ユーザ追加
 * 
 * @param {string} username ユーザ名を指定します
 * @param {string} password パスワードを指定します
 * @returns {Number} 0 の場合は追加完了、1の場合は追加失敗を返します
 */
async function add_user(username, password) {
    const con = await get_connection();

    // conの準備ができているか
    if(con) {
        // ソルトの作成
        let salt = generateRandomString(50);
        let hash = hashPassword(password, salt);
        // クエリの設定
        await con.execute('INSERT INTO ap_user (PASSHASH, USERNAME, PASSSALT) VALUES (?, ?, ?)', [hash, username, salt]);
        // セッションの切断
        await con.end();
        return 0;
    } else {
        return 1;
    }
}

/**
 * [GET] パスワードハッシュの作成
 * SHA256に従い、ソルトと組み合わせてパスワードハッシュを作成します
 * 
 * @param {string} password パスワードを指定します
 * @param {string} salt ソルトを指定します
 * @returns {string} 16進数に変換されたパスワードハッシュを返します
 */
function hashPassword(password, salt) {
    const hash = crypto.createHash('sha256');
    hash.update(password + salt);
    return hash.digest('hex');
}

/**
 * [GET] ランダム文字列の生成
 * cryptoモジュールを使って、ランダムバイトを作成します
 * @param {Number} length ランダム文字列の長さを指定します
 * @returns {string} ランダム文字列（半角英数字の大文字・小文字と数字の組み合わせ）を文字数分返します
 */
function generateRandomString(length) {
    return crypto.randomBytes(Math.ceil(length / 2))
            .toString('hex')
            .slice(0, length);
}

/**
 * [GET] ランダム16進数文字列の作成
 * cryptoモジュールを使って、ランダムバイトの16進数文字列を作成します
 * @param {Number} length ランダム16進数文字列の長さを指定します
 * @returns {string} ランダム16進数文字列を文字数分返します
 */
function generateRandomHexString(length) {
    return crypto.randomBytes(length / 2).toString('hex');
}

/**
 * [GET] 文字列を一定文字数で区切る
 * 文字列を一定文字数で区切り、その間に区切り文字を加えます
 * @param {string} str 対象の文字列を指定します
 * @param {string} splitLength 区切る文字の間隔を指定します
 * @param {string} delimiter 区切る文字を指定します
 * @returns {String} 区切って変換された後の文字列を返します
 */
function hyphenate(str, splitLength, delimiter) {
    if(typeof str !== 'string' || str.length === 0) {
        return '';
    }

    return str.split('').reduce((a, c,
            i) => i > 0 && i % splitLength === 0 ? `${a}${delimiter}${c}` : `${a}${c}`);
}

/**
 * [SET] ログ抽出
 * ログを統合的に抽出します
 * @param {string} log ログを指定します
 * @returns {void} ログを出力します
 */
function data_log(log) {
    console.log(`${COLOR_CYAN}<APServer LOG> ${COLOR_DEFAULT} ${log.substr(0, 255)} ${((log.length > 255) ? '...' : '')}`);
}

/**
 * [GET] 入力を待つ
 * 入力待ちを受け付けます
 * @param {String} question 質問内容を入れます
 * @returns {Promise} 入力データが返されます
 */
function read_user_input(question) {
    // readlineというモジュールで入出力インタフェースを作成
    const readline = require('readline').createInterface({
        input: process.stdin, // 手入力
        output: process.stdout // 手入力したものは出力される
    });

    // Promiseオブジェクトを返す
    return new Promise((resolve, reject) => {
        // Promise (非同期的な処理) ➡ とりあえず結果を返しておいて、時間差で結果が来るときは
        // resolve -> 引数の値が返ってくる　reject -> エラーが返ってきたときに、原因の値を引数に入れる
        readline.question(question, (answer) => {
            // readline.questionで入力値answerが返ってきたらresolveにいれる
            resolve(answer);
            // readlineを終了
            readline.close();
        });
    });
}