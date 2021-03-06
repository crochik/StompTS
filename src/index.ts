/*
    Stomp Over WebSocket https://github.com/crochik/stompts | Apache License V2.0

    This is a typescript version of stompjs with modifications. 
    It is not intended as replacement of it or to be backwards compatible with it.

    Original Header:
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
    supportedVersions: () => '1.1,1.0'
};

interface IUnmarshall {
    frames: Frame[],
    partial: string
};

export interface IHeaders { [key: string]: string }

interface IHeartbeat {
    outgoing: number;
    incoming: number;
}

export interface ISubscription {
    id: string;
    unsubscribe: () => any;
}

export interface ITransaction {
    id: string;
    commit: () => any;
    abort: () => any;
}

export class Frame {
    command: string;
    headers: IHeaders;
    body: string;

    ack?: (header: IHeaders) => any;
    nack?: (header: IHeaders) => any;

    constructor(command: string, headers?: IHeaders, body?: string) {
        this.command = command;
        this.headers = headers != null ? headers : {};
        this.body = body != null ? body : '';
    }

    /*
    Provides a textual representation of the frame
    suitable to be sent to the server
    */
    toString() {
        var lines = [this.command];

        var skipContentLength = !this.headers['content-length'] ? true : false;
        if (skipContentLength) {
            delete this.headers['content-length'];
        }

        for (var name in this.headers) {
            if (!this.headers.hasOwnProperty(name)) {
                continue;
            }
            var value = this.headers[name];
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
        }

        return 0;
    }

    /*
    Unmarshall a single STOMP frame from a `data` string
    */
    static unmarshallSingle(data: string) {
        // search for 2 consecutives LF byte to split the command
        // and headers from the body
        var body, chr, i, idx, len, line, start, _i, _j, _len, _ref1;
        var divider = data.search(RegExp("" + Byte.LF + Byte.LF));
        var headerLines = data.substring(0, divider).split(Byte.LF);
        var command = headerLines.shift();
        var headers: IHeaders = {};
        var trim = (str: string) => str.replace(/^\s+|\s+$/g, '');

        var _ref = headerLines.reverse();
        for (_i = 0, _len = _ref.length; _i < _len; _i++) {
            line = _ref[_i];
            idx = line.indexOf(':');
            headers[trim(line.substring(0, idx))] = trim(line.substring(idx + 1));
        }
        body = '';
        start = divider + 2;
        if (headers['content-length']) {
            len = parseInt(headers['content-length'], 10);
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

        if (!command) {
            throw new Error(`Comamnd should not be null??`);
        }

        return new Frame(command, headers, body);
    }

    /*
    Split the data before unmarshalling every single STOMP frame.
    Web socket servers can send multiple frames in a single websocket message.
    If the message size exceeds the websocket message size, then a single
    frame can be fragmented across multiple messages.
    */
    static unmarshall(datas: string): IUnmarshall {
        let frames = datas.split(RegExp("" + Byte.NULL + Byte.LF + "*"));
        let r: IUnmarshall = {
            frames: [],
            partial: ''
        };

        r.frames = (function () {
            var _i, _len, _ref, _results;
            _ref = frames.slice(0, -1);
            _results = [];
            for (_i = 0, _len = _ref.length; _i < _len; _i++) {
                var frame = _ref[_i];
                _results.push(Frame.unmarshallSingle(frame));
            }
            return _results;
        })();

        var last_frame = frames.slice(-1)[0];
        if (last_frame === Byte.LF || (last_frame.search(RegExp("" + Byte.NULL + Byte.LF + "*$"))) !== -1) {
            r.frames.push(Frame.unmarshallSingle(last_frame));
        } else {
            r.partial = last_frame;
        }

        return r;
    }

    /*
    Marshall a Stomp frame
    */
    static marshall(command: string, headers?: IHeaders, body?: string): string {
        let frame = new Frame(command, headers, body);
        return frame.toString() + Byte.NULL;
    }
}

function setInterval(interval: number, f: () => any): number {
    if (typeof window !== "undefined" && window !== null) {
        return window.setInterval(f, interval);
    }

    throw new Error("setInterval is undefined");
}

function clearInterval(id: number) {
    if (typeof window !== "undefined" && window !== null) {
        return window.clearInterval(id);
    }

    throw new Error("clearInterval is undefined");
}

/*
STOMP Client Class
All STOMP protocol is exposed as methods of this class (`connect()`, `send()`, etc.)
*/
export class Client {
    ws: WebSocket;
    counter: number;
    connected: boolean;
    heartbeat: IHeartbeat;
    maxWebSocketFrameSize: number;
    partialData: string;
    logOutput?: string;
    onMessage?: (subscription: string, message: Frame) => void;

    pinger?: number;
    ponger?: number;

    serverActivity: number;

    connectCallback?: (frame: Frame) => any;
    errorCallback?: (frame: Frame | string) => any;
    onreceipt?: (frame: Frame) => any;
    onreceive?: (frame: Frame) => any;

    constructor(url: string, protocols?: string[], logOutput?: 'log' | 'debug') {
        this.logOutput = logOutput;

        if (protocols == null) {
            protocols = ['v10.stomp', 'v11.stomp'];
        }
        this.ws = new WebSocket(url, protocols);
        this.ws.binaryType = "arraybuffer";
        this.counter = 0;
        this.connected = false;
        this.heartbeat = {
            incoming: 10000,
            outgoing: 10000,
        };
        this.maxWebSocketFrameSize = 16 * 1024;
        this.partialData = '';
        this.serverActivity = Client.now();
    }

    debug(message: string) {
        switch (this.logOutput) {
            case 'debug':
                console.debug(message);
                break;
            case 'log':
                console.log(message);
                break;
        }
    }

    static now(): number {
        return Date.now();
    }

    private _transmit(command: string, headers?: IHeaders, body?: string) {
        var out = Frame.marshall(command, headers, body);
        this.debug(">>> " + out);

        while (true) {
            if (out.length > this.maxWebSocketFrameSize) {
                this.ws.send(out.substring(0, this.maxWebSocketFrameSize));
                out = out.substring(this.maxWebSocketFrameSize);
                this.debug("remaining = " + out.length);

            } else {
                return this.ws.send(out);
            }
        }
    }

    private _setupHeartbeat(headers: IHeaders): void {
        let { version } = headers;
        if (version !== VERSIONS.V1_1 && version !== VERSIONS.V1_2) {
            return;
        }

        let parts = headers['heart-beat'].split(",");
        let serverOutgoing = parseInt(parts[0], 10);
        let serverIncoming = parseInt(parts[1], 10);

        var ttl: number;
        if (!(this.heartbeat.outgoing === 0 || serverIncoming === 0)) {
            ttl = Math.max(this.heartbeat.outgoing, serverIncoming);
            this.debug("send PING every " + ttl + "ms");

            this.pinger = setInterval(ttl, () => {
                this.ws.send(Byte.LF);
                this.debug(">>> PING");
            });
        }

        if (!(this.heartbeat.incoming === 0 || serverOutgoing === 0)) {
            ttl = Math.max(this.heartbeat.incoming, serverOutgoing);
            this.debug("check PONG every " + ttl + "ms");

            this.ponger = setInterval(ttl, () => {
                var delta;
                delta = Client.now() - this.serverActivity;
                if (delta > ttl * 2) {
                    this.debug("did not receive server activity for the last " + delta + "ms");
                    return this.ws.close();
                }
            });
        }
    }

    _onMessage = (evt: MessageEvent) => {
        var data;
        if (evt.data instanceof ArrayBuffer) {
            let arr = new Uint8Array(evt.data);
            this.debug("--- got data length: " + arr.length);
            data = '';
            // tslint:disable-next-line:prefer-for-of
            for (var c = 0; c < arr.length; c++) {
                data += String.fromCharCode(arr[c]);
            }
        } else {
            data = evt.data;
        }

        this.serverActivity = Client.now();

        if (data === Byte.LF) {
            this.debug("<<< PONG");
            return;
        }

        this.debug("<<< " + data);

        let unmarshalledData = Frame.unmarshall(this.partialData + data);
        this.partialData = unmarshalledData.partial;

        for (var frame of unmarshalledData.frames) {
            switch (frame.command) {
                case "CONNECTED":
                    this.debug("connected to server " + frame.headers.server);
                    this.connected = true;
                    this._setupHeartbeat(frame.headers);
                    if (this.connectCallback) {
                        this.connectCallback(frame);
                    }
                    break;

                case "MESSAGE":
                    let subscription = frame.headers.subscription as string;

                    if (this.onMessage) {
                        let messageID = frame.headers["message-id"] as string;

                        frame.ack = (headers: IHeaders) => {
                            if (headers == null) {
                                headers = {};
                            }
                            return this.ack(messageID, subscription, headers);
                        };

                        frame.nack = (headers: IHeaders) => {
                            if (headers == null) {
                                headers = {};
                            }
                            return this.nack(messageID, subscription, headers);
                        };

                        this.onMessage(subscription, frame);

                    } else {
                        this.debug("Unhandled received MESSAGE: " + frame);

                    }
                    break;

                case "RECEIPT":
                    if (this.onreceipt) {
                        this.onreceipt(frame);
                    }
                    break;

                case "ERROR":
                    if (this.errorCallback) {
                        this.errorCallback(frame);
                    }
                    break;

                default:
                    this.debug("Unhandled frame: " + frame);
            }
        }
    }

    /*
    [CONNECT Frame](http://stomp.github.com/stomp-specification-1.1.html#CONNECT_or_STOMP_Frame)
    */
    connect(headers: IHeaders, connectCallback: (frame: Frame) => any, errorCallback?: (frame: Frame | string) => any) {
        this.connectCallback = connectCallback;
        this.errorCallback = errorCallback;

        this.debug("Opening Web Socket...");

        this.ws.onmessage = this._onMessage;

        this.ws.onclose = () => {
            var msg;
            msg = "Whoops! Lost connection to " + this.ws.url;
            this.debug(msg);
            this._cleanUp();

            if (errorCallback) {
                errorCallback(msg);
            }
        }

        this.ws.onopen = () => {
            this.debug('Web Socket Opened...');
            headers["accept-version"] = VERSIONS.supportedVersions();
            headers["heart-beat"] = [this.heartbeat.outgoing, this.heartbeat.incoming].join(',');
            this._transmit("CONNECT", headers);
        }
    }

    disconnect(disconnectCallback: () => any, headers: IHeaders) {
        if (headers == null) {
            headers = {};
        }
        this._transmit("DISCONNECT", headers);
        this.ws.onclose = null;
        this.ws.close();
        this._cleanUp();

        if (disconnectCallback) {
            disconnectCallback();
        }
    }

    private _cleanUp() {
        this.connected = false;
        if (this.pinger) {
            clearInterval(this.pinger);
        }
        if (this.ponger) {
            return clearInterval(this.ponger);
        }
    }

    send(destination: string, headers?: IHeaders, body?: string) {
        if (headers == null) {
            headers = {};
        }
        if (body == null) {
            body = '';
        }
        headers.destination = destination;
        return this._transmit("SEND", headers, body);
    }

    subscribe(destination: string, headers?: IHeaders): ISubscription {
        if (headers == null) {
            headers = {};
        }

        if (!headers.id) {
            headers.id = "sub-" + this.counter++;
        }

        headers.destination = destination;

        var id: string = headers.id;
        this._transmit("SUBSCRIBE", headers);

        var subscription: ISubscription = {
            id: headers.id,
            unsubscribe: () => this.unsubscribe(id)
        };

        return subscription;
    }

    unsubscribe(id: string) {
        return this._transmit("UNSUBSCRIBE", { id });
    }

    begin(transaction: string): ITransaction {
        var txid: string;
        txid = transaction || "tx-" + this.counter++;
        this._transmit("BEGIN", {
            transaction: txid
        });

        return {
            abort: () => this.abort(txid),
            commit: () => this.commit(txid),
            id: txid,
        };
    }

    commit(transaction: string) {
        return this._transmit("COMMIT", { transaction });
    }

    abort(transaction: string) {
        return this._transmit("ABORT", { transaction });
    }

    ack(messageID: string, subscription: string, headers?: IHeaders) {
        if (headers == null) {
            headers = {};
        }
        headers["message-id"] = messageID;
        headers.subscription = subscription;
        return this._transmit("ACK", headers);
    }

    nack(messageID: string, subscription: string, headers?: IHeaders) {
        if (headers == null) {
            headers = {};
        }
        headers["message-id"] = messageID;
        headers.subscription = subscription;
        return this._transmit("NACK", headers);
    }
}