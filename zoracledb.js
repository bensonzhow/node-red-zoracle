module.exports = function (RED) {
    "use strict";
    const oracledb = require("oracledb");
    const resolvePath = require("object-resolve-path");
    const events = require("events");
    oracledb.fetchAsBuffer = [oracledb.BLOB];
    oracledb.fetchAsString = [oracledb.CLOB];

    function transformBindVars(bindVars) {
        const transformed = {};
        for (const key in bindVars) {
            if (Object.prototype.hasOwnProperty.call(bindVars, key)) {
                const bindVar = bindVars[key];
                transformed[key] = {
                    dir: oracledb[bindVar.dir],
                    type: oracledb[bindVar.type]
                };
                if (bindVar.hasOwnProperty("val")) {
                    transformed[key].val = bindVar.val;
                }
            }
        }
        return transformed;
    }

    // 新增：允许无server节点，直接用msg.oracleConfig连接
    async function directQuery(msg, node, query, bindVars, resultAction, resultSetLimit) {
        const oracleConfig = msg.oracleConfig || {};
        const user = oracleConfig.user;
        const password = oracleConfig.password;
        const host = oracleConfig.host || "localhost";
        const port = oracleConfig.port || "1521";
        const db = oracleConfig.db || "orcl";
        const tnsname = oracleConfig.tnsname;
        const instantclientpath = oracleConfig.instantclientpath;
        let connection;
        try {
            let connectString = tnsname ? tnsname : `${host}:${port}/${db}`;
            if (instantclientpath) {
                oracledb.initOracleClient({ libDir: instantclientpath });
            }
            connection = await oracledb.getConnection({
                user,
                password,
                connectString
            });
            const options = { autoCommit: true, outFormat: oracledb.OBJECT, maxRows: resultSetLimit, resultSet: resultAction === "multi" };
            const result = await connection.execute(query.trim().replace(/;$/, ""), bindVars || [], options);
            node.status({ fill: "green", shape: "dot", text: "connected" });
            switch (resultAction) {
                case "single":
                    msg.payload = result.rows;
                    node.send(msg);
                    break;
                case "single-meta":
                    msg.payload = {
                        rowsAffected: result.rowsAffected,
                        metaData: result.metaData,
                        outBinds: result.outBinds
                    };
                    node.send(msg);
                    break;
                case "multi":
                    if (result.resultSet) {
                        const resultSet = result.resultSet;
                        let rows;
                        do {
                            rows = await resultSet.getRows(resultSetLimit);
                            if (rows.length > 0) {
                                const newMsg = RED.util.cloneMessage(msg);
                                newMsg.payload = rows;
                                node.send(newMsg);
                            }
                        } while (rows.length > 0);
                        await resultSet.close();
                    }
                    break;
                case "none":
                default:
                    break;
            }
        } catch (err) {
            const shortError = err.message.split("\n")[0];
            node.error(`Oracle query error: ${shortError}`, msg);
            node.status({ fill: "red", shape: "dot", text: shortError });
        } finally {
            if (connection) {
                try {
                    await connection.close();
                } catch (err) {
                    node.error("Error releasing connection: " + err.message);
                }
            }
        }
    }

    function initialize(node) {
        if (node.server) {
            if (node.server.pool) {
                node.status({ fill: "green", shape: "dot", text: "connected" });
            }
            else {
                node.status({ fill: "grey", shape: "dot", text: "unconnected" });
            }
            node.serverStatus = node.server.status;
            node.serverStatus.on("connecting", () => {
                node.status({ fill: "green", shape: "ring", text: "connecting..." });
            });
            node.serverStatus.on("connected", () => {
                node.status({ fill: "green", shape: "dot", text: "connected" });
            });
            node.serverStatus.on("closed", () => {
                node.status({ fill: "red", shape: "ring", text: "disconnected" });
            });
            node.serverStatus.on("error", (err) => {
                const shortError = err.message.split("\n")[0];
                node.status({ fill: "red", shape: "dot", text: shortError });
            });
        } else {
            // 移除强制报错，允许无server节点
            node.status({ fill: "grey", shape: "dot", text: "dynamic config mode" });
        }
    }

    function zoracledb(n) {
        const node = this;
        RED.nodes.createNode(node, n);
        node.server = RED.nodes.getNode(n.server);
        node.on("input", (msg) => {
            node.status({ fill: "blue", shape: "dot", text: "running..." });
            const useQuery = n.usequery;
            const query = (useQuery || !msg.query) ? n.query : msg.query;
            const useMappings = n.usemappings;
            let mappings = [];
            try {
                mappings = n.mappings ? JSON.parse(n.mappings) : [];
            }
            catch (e) {
                node.error("Error parsing Field Mappings JSON: " + e.message, msg);
                node.status({ fill: "red", shape: "dot", text: "Invalid Mappings" });
                return;
            }
            const resultAction = msg.resultAction || n.resultaction;
            const resultSetLimit = parseInt(msg.resultSetLimit || n.resultlimit, 10) || 100;
            let bindVars = null;
            if (msg.bindVars) {
                try {
                    bindVars = transformBindVars(msg.bindVars);
                }
                catch (err) {
                    node.error("Error transforming bind variables: " + err.message, msg);
                    node.status({ fill: "red", shape: "dot", text: "Invalid BindVars" });
                    return;
                }
            }
            else if (msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload) && !useMappings) {
                const queryBinds = new Set();
                const regex = /:(\w+)/g;
                let match;
                while ((match = regex.exec(query)) !== null) {
                    queryBinds.add(match[1]);
                }
                if (queryBinds.size > 0) {
                    const cleanBinds = {};
                    const payloadAsAny = msg.payload;
                    queryBinds.forEach(bindName => {
                        if (payloadAsAny.hasOwnProperty(bindName)) {
                            cleanBinds[bindName] = payloadAsAny[bindName];
                        }
                    });
                    bindVars = cleanBinds;
                }
                else {
                    bindVars = {};
                }
            }
            else {
                const params = [];
                if (useMappings && msg.payload && !Array.isArray(msg.payload)) {
                    for (let i = 0; i < mappings.length; i++) {
                        let value;
                        try {
                            value = resolvePath(msg.payload, mappings[i]);
                        }
                        catch (err) {
                            value = null;
                        }
                        params.push(value);
                    }
                }
                else if (Array.isArray(msg.payload)) {
                    params.push(...msg.payload);
                }
                bindVars = params;
            }
            // 支持 msg.oracleConfig 动态连接，无server时自动单次连接
            if (node.server) {
                node.server.query(msg, node, query, bindVars, resultAction, resultSetLimit);
            } else if (msg.oracleConfig) {
                directQuery(msg, node, query, bindVars, resultAction, resultSetLimit);
            } else {
                node.status({ fill: "red", shape: "dot", text: "missing config" });
                node.error("Oracle node missing server config and msg.oracleConfig!", msg);
            }
        });
        initialize(node);
    }

    function zoracleserver(n) {
        const node = this;
        RED.nodes.createNode(node, n);
        node.connectionname = n.connectionname || "";
        node.tnsname = n.tnsname || "";
        node.instantclientpath = n.instantclientpath || "";
        node.host = n.host || "";
        node.port = n.port || "";
        node.db = n.db || "";
        node.user = (node.credentials && node.credentials.user) ? node.credentials.user : "";
        node.password = (node.credentials && node.credentials.password) ? node.credentials.password : "";
        node.poolmin = parseInt(n.poolmin, 10) || 0;
        node.poolmax = parseInt(n.poolmax, 10) || 4;
        node.pooltimeout = parseInt(n.pooltimeout, 10) || 60;
        node.pool = null;
        node.status = new events.EventEmitter();
        node.status.setMaxListeners(0);

        async function connect() {
            if (node.pool)
                return;
            node.status.emit("connecting");
            try {
                if (node.instantclientpath) {
                    oracledb.initOracleClient({ libDir: node.instantclientpath });
                }
            }
            catch (err) {
                if (err.message.indexOf("NJS-019") === -1) {
                    node.error("Oracle-server error initializing client: " + err.message);
                    node.status.emit("error", err);
                    return;
                }
            }
            // 只有节点配置存在时才创建连接池
            if (node.user && node.password && (node.tnsname || (node.host && node.port && node.db))) {
                const connectString = node.tnsname ? node.tnsname : `${node.host}:${node.port}/${node.db}`;
                const poolConfig = {
                    user: node.user,
                    password: node.password,
                    connectString: connectString,
                    poolMin: node.poolmin,
                    poolMax: node.poolmax,
                    poolIncrement: 1,
                    poolTimeout: node.pooltimeout
                };
                try {
                    node.pool = await oracledb.createPool(poolConfig);
                    node.status.emit("connected");
                    node.log(`Oracle connection pool created for ${connectString}`);
                }
                catch (err) {
                    node.status.emit("error", err);
                }
            }
        }
        connect();
        node.on("close", async (done) => {
            if (node.pool) {
                try {
                    await node.pool.close(10);
                    node.pool = null;
                    node.status.emit("closed");
                    node.log("Oracle connection pool closed.");
                }
                catch (err) {
                    node.error("Error closing Oracle connection pool: " + err.message);
                }
            }
            done();
        });

        node.query = async function (msg, requestingNode, query, bindVars, resultAction, resultSetLimit) {
            // 优先取 msg.oracleConfig 参数
            const oracleConfig = msg.oracleConfig || {};
            const user = oracleConfig.user || node.user;
            const password = oracleConfig.password || node.password;
            const host = oracleConfig.host || node.host || "localhost";
            const port = oracleConfig.port || node.port || "1521";
            const db = oracleConfig.db || node.db || "orcl";
            const tnsname = oracleConfig.tnsname || node.tnsname;
            const instantclientpath = oracleConfig.instantclientpath || node.instantclientpath;

            const dynamicConnect = !!(oracleConfig.user || oracleConfig.password || oracleConfig.host || oracleConfig.port || oracleConfig.db || oracleConfig.tnsname);

            const finalQuery = query.trim().replace(/;$/, "");
            let connection;
            try {
                if (dynamicConnect) {
                    // 动态参数连接（单次直连）
                    let connectString;
                    if (tnsname) {
                        connectString = tnsname;
                    } else {
                        connectString = `${host}:${port}/${db}`;
                    }
                    if (instantclientpath) {
                        oracledb.initOracleClient({ libDir: instantclientpath });
                    }
                    connection = await oracledb.getConnection({
                        user,
                        password,
                        connectString
                    });
                } else {
                    // 走池子
                    if (!node.pool) {
                        const errText = "Connection pool is not available.";
                        requestingNode.error(errText, msg);
                        requestingNode.status({ fill: "red", shape: "dot", text: errText });
                        return;
                    }
                    connection = await node.pool.getConnection();
                }
                const options = { autoCommit: true, outFormat: oracledb.OBJECT, maxRows: resultSetLimit, resultSet: resultAction === "multi" };
                const result = await connection.execute(finalQuery, bindVars || [], options);
                requestingNode.status({ fill: "green", shape: "dot", text: "connected" });
                switch (resultAction) {
                    case "single": {
                        msg.payload = result.rows;
                        requestingNode.send(msg);
                        break;
                    }
                    case "single-meta": {
                        msg.payload = {
                            rowsAffected: result.rowsAffected,
                            metaData: result.metaData,
                            outBinds: result.outBinds
                        };
                        requestingNode.send(msg);
                        break;
                    }
                    case "multi": {
                        if (result.resultSet) {
                            const resultSet = result.resultSet;
                            let rows;
                            do {
                                rows = await resultSet.getRows(resultSetLimit);
                                if (rows.length > 0) {
                                    const newMsg = RED.util.cloneMessage(msg);
                                    newMsg.payload = rows;
                                    requestingNode.send(newMsg);
                                }
                            } while (rows.length > 0);
                            await resultSet.close();
                        }
                        break;
                    }
                    case "none":
                    default:
                        break;
                }
            }
            catch (err) {
                const shortError = err.message.split("\n")[0];
                requestingNode.error(`Oracle query error: ${shortError}`, msg);
                requestingNode.status({ fill: "red", shape: "dot", text: shortError });
            }
            finally {
                if (connection) {
                    try {
                        await connection.close();
                    }
                    catch (err) {
                        requestingNode.error("Error releasing connection: " + err.message);
                    }
                }
            }
        };
    }

    RED.nodes.registerType("zoracledb", zoracledb);
    RED.nodes.registerType("zoracleserver", zoracleserver, {
        credentials: { user: { type: "text" }, password: { type: "password" } }
    });
};