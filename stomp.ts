/*
   Stomp Over WebSocket http://www.jmesnil.net/stomp-websocket/doc/ | Apache License V2.0

   Copyright (C) 2010-2013 [Jeff Mesnil](http://jmesnil.net/)
   Copyright (C) 2012 [FuseSource, Inc.](http://fusesource.com)
 */

const Byte = {
    LF: '\x0A',
    NULL: '\x00'
};

const VERSIONS = {
    V1_0: '1.0',
    V1_1: '1.1',
    V1_2: '1.2',
    supportedVersions: function () {
        return '1.1,1.0';
    }
};

interface Unmarshall {
    frames: Frame[],
    partial: string
};

interface Headers {
    host?: string;
    login?: string;
    passcode?: string;

    id?: string;
    version?: string;
    destination?: string;
    server?: string;
    subscription?: string;
    transaction?: string;
    "message-id"?: string;
}

interface Heartbeat {
    outgoing: number;
    incoming: number;
}

interface Subscription {
    id: string;
    unsubscribe: () => any;
}

interface Transaction {
    id: string;
    commit: () => any;
    abort: () => any;
}

class Frame {
    command: string;
    headers: Headers;
    body: string;

    ack?: (header: Headers) => any;
    nack?: (header: Headers) => any;

    constructor(command: string, headers?: Headers, body?: string) {
        this.command = command;
        this.headers = headers != null ? headers : {};
        this.body = body != null ? body : '';
    }

    /*
    Provides a textual representation of the frame
    suitable to be sent to the server
    */
    toString() {
        var lines, name, skipContentLength, value, _ref;
        lines = [this.command];
        skipContentLength = this.headers['content-length'] === false ? true : false;
        if (skipContentLength) {
            delete this.headers['content-length'];
        }
        _ref = this.headers;
        for (name in _ref) {
            if (!_ref.hasOwnProperty(name)) continue;
            value = _ref[name];
            lines.push("" + name + ":" + value);
        }
        if (this.body && !skipContentLength) {
            lines.push("content-length:" + (Frame.sizeOfUTF8(this.body)));
        }
        lines.push(Byte.LF + this.body);
        return lines.join(Byte.LF);
    }

    /*
    Compute the size of a UTF-8 string by counting its number of bytes
    (and not the number of characters composing the string)
    */
    static sizeOfUTF8(s: string) {
        if (s) {
            let str = encodeURI(s).match(/%..|./g);
            return str != null ? str.length : 0;
        } else {
            return 0;
        }
    }

    /*
    Unmarshall a single STOMP frame from a `data` string
    */
    static unmarshallSingle(data: string) {
        // search for 2 consecutives LF byte to split the command
        // and headers from the body
        var body, chr, command, divider, headerLines, headers: Headers, i, idx, len, line, start, trim, _i, _j, _len, _ref, _ref1;
        divider = data.search(RegExp("" + Byte.LF + Byte.LF));
        headerLines = data.substring(0, divider).split(Byte.LF);
        command = headerLines.shift();
        headers = {};
        trim = function (str: string) {
            return str.replace(/^\s+|\s+$/g, '');
        };
        _ref = headerLines.reverse();
        for (_i = 0, _len = _ref.length; _i < _len; _i++) {
            line = _ref[_i];
            idx = line.indexOf(':');
            headers[trim(line.substring(0, idx))] = trim(line.substring(idx + 1));
        }
        body = '';
        start = divider + 2;
        if (headers['content-length']) {
            len = parseInt(headers['content-length']);
            body = ('' + data).substring(start, start + len);
        } else {
            chr = null;
            for (i = _j = start, _ref1 = data.length; start <= _ref1 ? _j < _ref1 : _j > _ref1; i = start <= _ref1 ? ++_j : --_j) {
                chr = data.charAt(i);
                if (chr === Byte.NULL) {
                    break;
                }
                body += chr;
            }
        }

        if (!command) throw `Comamnd should not be null??`;
        return new Frame(command, headers, body);
    }

    /*
    # Split the data before unmarshalling every single STOMP frame.
    # Web socket servers can send multiple frames in a single websocket message.
    # If the message size exceeds the websocket message size, then a single
    # frame can be fragmented across multiple messages.
    #
    # `datas` is a string.
    #
    # returns an *array* of Frame objects
    */
    static unmarshall(datas: string): Unmarshall {
        var frame, frames, last_frame: string, r: Unmarshall;
        frames = datas.split(RegExp("" + Byte.NULL + Byte.LF + "*"));

        r = {
            frames: [],
            partial: ''
        };

        r.frames = (function () {
            var _i, _len, _ref, _results;
            _ref = frames.slice(0, -1);
            _results = [];
            for (_i = 0, _len = _ref.length; _i < _len; _i++) {
                frame = _ref[_i];
                _results.push(Frame.unmarshallSingle(frame));
            }
            return _results;
        })();

        last_frame = frames.slice(-1)[0];
        if (last_frame === Byte.LF || (last_frame.search(RegExp("" + Byte.NULL + Byte.LF + "*$"))) !== -1) {
            r.frames.push(Frame.unmarshallSingle(last_frame));
        } else {
            r.partial = last_frame;
        }
        return r;
    }

    /*
    # Marshall a Stomp frame
    */
    static marshall(command: string, headers?: Headers, body?: string): string {
        var frame;
        frame = new Frame(command, headers, body);
        return frame.toString() + Byte.NULL;
    }
}

/*
# ##STOMP Client Class
#
# All STOMP protocol is exposed as methods of this class (`connect()`,
# `send()`, etc.)
*/
export class Client {
    ws: WebSocket;
    counter: number;
    connected: boolean;
    heartbeat: Heartbeat;
    maxWebSocketFrameSize: number;
    subscriptions: { [subscriptionId: string]: (frame: Frame) => any };
    partialData: string;

    pinger?: number;
    ponger?: number;

    serverActivity: number;

    connectCallback?: (frame: Frame) => any;
    errorCallback?: (frame: Frame | string) => any;
    onreceipt?: (frame: Frame) => any;
    onreceive?: (frame: Frame) => any;

    constructor(ws: WebSocket) {
        this.ws = ws;
        this.ws.binaryType = "arraybuffer";
        this.counter = 0;
        this.connected = false;
        this.heartbeat = {
            outgoing: 10000,
            incoming: 10000
        };
        this.maxWebSocketFrameSize = 16 * 1024;
        this.subscriptions = {};
        this.partialData = '';
    }

    debug(message: string) {
        var _ref;
        return typeof window !== "undefined" && window !== null ? (_ref = window.console) != null ? _ref.log(message) : void 0 : void 0;
    }

    static now(): number {
        return Date.now();
    }

    _transmit(command: string, headers?: Headers, body?: string) {
        var out;
        out = Frame.marshall(command, headers, body);
        if (typeof this.debug === "function") {
            this.debug(">>> " + out);
        }
        while (true) {
            if (out.length > this.maxWebSocketFrameSize) {
                this.ws.send(out.substring(0, this.maxWebSocketFrameSize));
                out = out.substring(this.maxWebSocketFrameSize);
                if (typeof this.debug === "function") {
                    this.debug("remaining = " + out.length);
                }
            } else {
                return this.ws.send(out);
            }
        }
    }

    _setupHeartbeat(headers: Headers): void {
        var serverIncoming: number, serverOutgoing: number, _ref;
        if ((_ref = headers.version) !== VERSIONS.V1_1 && _ref !== VERSIONS.V1_2) {
            return;
        }

        var parts = headers['heart-beat'].split(",");
        serverOutgoing = parseInt(parts[0]);
        serverIncoming = parseInt(parts[1]);

        if (!(this.heartbeat.outgoing === 0 || serverIncoming === 0)) {
            var ttl = Math.max(this.heartbeat.outgoing, serverIncoming);
            this.debug("send PING every " + ttl + "ms");

            this.pinger = Stomp.setInterval(ttl, () => {
                this.ws.send(Byte.LF);
                this.debug(">>> PING");
            });
        }

        if (!(this.heartbeat.incoming === 0 || serverOutgoing === 0)) {
            var ttl = Math.max(this.heartbeat.incoming, serverOutgoing);
            this.debug("check PONG every " + ttl + "ms");

            this.ponger = Stomp.setInterval(ttl, () => {
                var delta;
                delta = Client.now() - this.serverActivity;
                if (delta > ttl * 2) {
                    this.debug("did not receive server activity for the last " + delta + "ms");
                    return this.ws.close();
                }
            });
        }
    }

    onMessage(evt: MessageEvent): any {
        var arr, c, frame, messageID: string, onreceive, subscription: string, unmarshalledData, _i, _len, _ref;

        var data = typeof ArrayBuffer !== 'undefined' && evt.data instanceof ArrayBuffer ? (arr = new Uint8Array(evt.data), typeof this.debug === "function" ? this.debug("--- got data length: " + arr.length) : void 0, ((function () {
            var _i, _len, _results;
            _results = [];
            for (_i = 0, _len = arr.length; _i < _len; _i++) {
                c = arr[_i];
                _results.push(String.fromCharCode(c));
            }
            return _results;
        })()).join('')) : evt.data;

        this.serverActivity = Client.now();

        if (data === Byte.LF) {
            this.debug("<<< PONG");
            return;
        }

        this.debug("<<< " + data);

        unmarshalledData = Frame.unmarshall(this.partialData + data);
        this.partialData = unmarshalledData.partial;
        _ref = unmarshalledData.frames;

        for (_i = 0, _len = _ref.length; _i < _len; _i++) {
            frame = _ref[_i];
            switch (frame.command) {
                case "CONNECTED":
                    this.debug("connected to server " + frame.headers.server);
                    this.connected = true;
                    this._setupHeartbeat(frame.headers);
                    if (this.connectCallback) this.connectCallback(frame);
                    break;

                case "MESSAGE":
                    subscription = frame.headers.subscription as string;
                    onreceive = this.subscriptions[subscription] || this.onreceive;

                    if (onreceive) {
                        messageID = frame.headers["message-id"] as string;

                        frame.ack = (headers: Headers) => {
                            if (headers == null) {
                                headers = {};
                            }
                            return this.ack(messageID, subscription, headers);
                        };

                        frame.nack = (headers: Headers) => {
                            if (headers == null) {
                                headers = {};
                            }
                            return this.nack(messageID, subscription, headers);
                        };

                        onreceive(frame);

                    } else {
                        this.debug("Unhandled received MESSAGE: " + frame);

                    }
                    break;

                case "RECEIPT":
                    if (this.onreceipt) this.onreceipt(frame);
                    break;

                case "ERROR":
                    if (this.errorCallback) this.errorCallback(frame);
                    break;

                default:
                    this.debug("Unhandled frame: " + frame);
            }
        }
    }

    /*
    # [CONNECT Frame](http://stomp.github.com/stomp-specification-1.1.html#CONNECT_or_STOMP_Frame)
    #
    # The `connect` method accepts different number of arguments and types:
    #
    # * `connect(headers, connectCallback)`
    # * `connect(headers, connectCallback, errorCallback)`
    # * `connect(login, passcode, connectCallback)`
    # * `connect(login, passcode, connectCallback, errorCallback)`
    # * `connect(login, passcode, connectCallback, errorCallback, host)`
    #
    # The errorCallback is optional and the 2 first forms allow to pass other
    # headers in addition to `client`, `passcode` and `host`.
    */
    connect(headers: Headers, connectCallback: (frame: Frame) => any, errorCallback?: (frame: Frame | string) => any) {
        this.connectCallback = connectCallback;
        this.errorCallback = errorCallback;

        if (typeof this.debug === "function") {
            this.debug("Opening Web Socket...");
        }

        this.ws.onmessage = this.onMessage.bind(this);

        this.ws.onclose = (function (_this) {
            return function () {
                var msg;
                msg = "Whoops! Lost connection to " + _this.ws.url;
                if (typeof _this.debug === "function") {
                    _this.debug(msg);
                }
                _this._cleanUp();
                return typeof errorCallback === "function" ? errorCallback(msg) : void 0;
            };
        })(this);

        return this.ws.onopen = (function (_this) {
            return function () {
                if (typeof _this.debug === "function") {
                    _this.debug('Web Socket Opened...');
                }
                headers["accept-version"] = VERSIONS.supportedVersions();
                headers["heart-beat"] = [_this.heartbeat.outgoing, _this.heartbeat.incoming].join(',');
                return _this._transmit("CONNECT", headers);
            };
        })(this);
    };

    disconnect(disconnectCallback: () => any, headers: Headers) {
        if (headers == null) {
            headers = {};
        }
        this._transmit("DISCONNECT", headers);
        this.ws.onclose = null;
        this.ws.close();
        this._cleanUp();

        if (disconnectCallback) disconnectCallback();
    }

    _cleanUp() {
        this.connected = false;
        if (this.pinger) {
            Stomp.clearInterval(this.pinger);
        }
        if (this.ponger) {
            return Stomp.clearInterval(this.ponger);
        }
    }

    send(destination: string, headers?: Headers, body?: string) {
        if (headers == null) {
            headers = {};
        }
        if (body == null) {
            body = '';
        }
        headers.destination = destination;
        return this._transmit("SEND", headers, body);
    }

    subscribe(destination: string, callback: (frame: Frame) => any, headers: Headers): Subscription {
        if (headers == null) {
            headers = {};
        }

        if (!headers.id) {
            headers.id = "sub-" + this.counter++;
        }

        headers.destination = destination;

        var id: string = headers.id;
        this.subscriptions[id] = callback;
        this._transmit("SUBSCRIBE", headers);

        var subscription: Subscription = {
            id: headers.id,
            unsubscribe: () => this.unsubscribe(id)
        };

        return subscription;
    }

    unsubscribe(id: string) {
        delete this.subscriptions[id];
        return this._transmit("UNSUBSCRIBE", {
            id: id
        });
    }

    begin(transaction: string): Transaction {
        var txid: string;
        txid = transaction || "tx-" + this.counter++;
        this._transmit("BEGIN", {
            transaction: txid
        });

        return {
            id: txid,
            commit: () => this.commit(txid),
            abort: () => this.abort(txid)
        };
    }

    commit(transaction: string) {
        return this._transmit("COMMIT", {
            transaction: transaction
        });
    }

    abort(transaction: string) {
        return this._transmit("ABORT", {
            transaction: transaction
        });
    }

    ack(messageID: string, subscription: string, headers?: Headers) {
        if (headers == null) {
            headers = {};
        }
        headers["message-id"] = messageID;
        headers.subscription = subscription;
        return this._transmit("ACK", headers);
    }

    nack(messageID: string, subscription: string, headers?: Headers) {
        if (headers == null) {
            headers = {};
        }
        headers["message-id"] = messageID;
        headers.subscription = subscription;
        return this._transmit("NACK", headers);
    }
}

export class Stomp {
    static WebSocketClass: any; // ???

    client(url: string, protocols: string[]) {
        var klass, ws;
        if (protocols == null) {
            protocols = ['v10.stomp', 'v11.stomp'];
        }
        klass = Stomp.WebSocketClass || WebSocket;
        ws = new klass(url, protocols);
        return new Client(ws);
    }

    over(ws: WebSocket) {
        return new Client(ws);
    }

    static setInterval(interval: number, f: () => any): number {
        if (typeof window !== "undefined" && window !== null) {
            return window.setInterval(f, interval);
        }

        throw "setInterval is undefined";
    }

    static clearInterval(id: number) {
        if (typeof window !== "undefined" && window !== null) {
            window.clearInterval(id);
        }

        throw "clearInterval is undefined";
    }
}

const stomp = new Stomp();

if (typeof exports !== "undefined" && exports !== null) {
    exports.Stomp = stomp;
}

if (typeof window !== "undefined" && window !== null) {
    window["Stomp"] = stomp;

} else if (!exports) {
    self["Stomp"] = stomp;
}