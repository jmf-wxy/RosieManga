/*
Venera JavaScript Library

This library provides a set of APIs for interacting with the Venera app.
*/

/**
 * @function sendMessage
 * @global
 * @param {Object} message
 * @returns {any}
 */

/**
 * Set a timeout to execute a callback function after a specified delay.
 * @param callback {Function}
 * @param delay {number} - delay in milliseconds
 */
function setTimeout(callback, delay) {
    sendMessage({
        method: 'delay',
        time: delay,
    }).then(callback);
}

/// encode, decode, hash, decrypt
let Convert = {
    /**
     * @param str {string}
     * @returns {ArrayBuffer}
     */
    encodeUtf8: (str) => {
        return sendMessage({
            method: "convert",
            type: "utf8",
            value: str,
            isEncode: true
        });
    },

    /**
     * @param value {ArrayBuffer}
     * @returns {string}
     */
    decodeUtf8: (value) => {
        return sendMessage({
            method: "convert",
            type: "utf8",
            value: value,
            isEncode: false
        });
    },

    /**
     * @param str {string}
     * @returns {ArrayBuffer}
     */
    encodeGbk: (str) => {
        return sendMessage({
            method: "convert",
            type: "gbk",
            value: str,
            isEncode: true
        });
    },

    /**
     * @param value {ArrayBuffer}
     * @returns {string}
     */
    decodeGbk: (value) => {
        return sendMessage({
            method: "convert",
            type: "gbk",
            value: value,
            isEncode: false
        });
    },

    /**
     * @param {ArrayBuffer} value
     * @returns {string}
     */
    encodeBase64: (value) => {
        return sendMessage({
            method: "convert",
            type: "base64",
            value: value,
            isEncode: true
        });
    },

    /**
     * @param {string} value
     * @returns {ArrayBuffer}
     */
    decodeBase64: (value) => {
        return sendMessage({
            method: "convert",
            type: "base64",
            value: value,
            isEncode: false
        });
    },

    /**
     * @param {ArrayBuffer} value
     * @returns {ArrayBuffer}
     */
    md5: (value) => {
        return sendMessage({
            method: "convert",
            type: "md5",
            value: value,
            isEncode: true
        });
    },

    /**
     * @param {ArrayBuffer} value
     * @returns {ArrayBuffer}
     */
    sha1: (value) => {
        return sendMessage({
            method: "convert",
            type: "sha1",
            value: value,
            isEncode: true
        });
    },

    /**
     * @param {ArrayBuffer} value
     * @returns {ArrayBuffer}
     */
    sha256: (value) => {
        return sendMessage({
            method: "convert",
            type: "sha256",
            value: value,
            isEncode: true
        });
    },

    /**
     * @param {ArrayBuffer} value
     * @returns {ArrayBuffer}
     */
    sha512: (value) => {
        return sendMessage({
            method: "convert",
            type: "sha512",
            value: value,
            isEncode: true
        });
    },

    /**
     * @param key {ArrayBuffer}
     * @param value {ArrayBuffer}
     * @param hash {string} - md5, sha1, sha256, sha512
     * @returns {ArrayBuffer}
     */
    hmac: (key, value, hash) => {
        return sendMessage({
            method: "convert",
            type: "hmac",
            value: value,
            key: key,
            hash: hash,
            isEncode: true
        });
    },

    /**
     * @param key {ArrayBuffer}
     * @param value {ArrayBuffer}
     * @param hash {string} - md5, sha1, sha256, sha512
     * @returns {string} - hex string
     */
    hmacString: (key, value, hash) => {
        return sendMessage({
            method: "convert",
            type: "hmac",
            value: value,
            key: key,
            hash: hash,
            isEncode: true,
            isString: true
        });
    },

    /**
     * @param {ArrayBuffer} value
     * @param {ArrayBuffer} key
     * @returns {ArrayBuffer}
     */
    encryptAesEcb: (value, key) => {
        return sendMessage({
            method: "convert",
            type: "aes-ecb",
            value: value,
            key: key,
            isEncode: true
        });
    },

    /**
     * @param {ArrayBuffer} value
     * @param {ArrayBuffer} key
     * @returns {ArrayBuffer}
     */
    decryptAesEcb: (value, key) => {
        return sendMessage({
            method: "convert",
            type: "aes-ecb",
            value: value,
            key: key,
            isEncode: false
        });
    },

    /**
     * @param {ArrayBuffer} value
     * @param {ArrayBuffer} key
     * @param {ArrayBuffer} iv
     * @returns {ArrayBuffer}
     */
    encryptAesCbc: (value, key, iv) => {
        return sendMessage({
            method: "convert",
            type: "aes-cbc",
            value: value,
            key: key,
            iv: iv,
            isEncode: true
        });
    },

    /**
     * @param {ArrayBuffer} value
     * @param {ArrayBuffer} key
     * @param {ArrayBuffer} iv
     * @returns {ArrayBuffer}
     */
    decryptAesCbc: (value, key, iv) => {
        return sendMessage({
            method: "convert",
            type: "aes-cbc",
            value: value,
            key: key,
            iv: iv,
            isEncode: false
        });
    },

    /**
     * @param {ArrayBuffer} value
     * @param {ArrayBuffer} key
     * @param {ArrayBuffer} iv
     * @param {number} blockSize
     * @returns {ArrayBuffer}
     */
    encryptAesCfb: (value, key, iv, blockSize) => {
        return sendMessage({
            method: "convert",
            type: "aes-cfb",
            value: value,
            key: key,
            iv: iv,
            blockSize: blockSize,
            isEncode: true
        });
    },

    /**
     * @param {ArrayBuffer} value
     * @param {ArrayBuffer} key
     * @param {ArrayBuffer} iv
     * @param {number} blockSize
     * @returns {ArrayBuffer}
     */
    decryptAesCfb: (value, key, iv, blockSize) => {
        return sendMessage({
            method: "convert",
            type: "aes-cfb",
            value: value,
            key: key,
            iv: iv,
            blockSize: blockSize,
            isEncode: false
        });
    },

    /**
     * @param {ArrayBuffer} value
     * @param {ArrayBuffer} key
     * @param {number} blockSize
     * @returns {ArrayBuffer}
     */
    encryptAesOfb: (value, key, blockSize) => {
        return sendMessage({
            method: "convert",
            type: "aes-ofb",
            value: value,
            key: key,
            blockSize: blockSize,
            isEncode: true
        });
    },

    /**
     * @param {ArrayBuffer} value
     * @param {ArrayBuffer} key
     * @param {number} blockSize
     * @returns {ArrayBuffer}
     */
    decryptAesOfb: (value, key, blockSize) => {
        return sendMessage({
            method: "convert",
            type: "aes-ofb",
            value: value,
            key: key,
            blockSize: blockSize,
            isEncode: false
        });
    },

    /**
     * @param {ArrayBuffer} value
     * @param {ArrayBuffer} key
     * @returns {ArrayBuffer}
     */
    decryptRsa: (value, key) => {
        return sendMessage({
            method: "convert",
            type: "rsa",
            value: value,
            key: key,
            isEncode: false
        });
    },
    /** Encode bytes to hex string
     * @param bytes {ArrayBuffer}
     * @return {string}
     */
    hexEncode: (bytes) => {
        const hexDigits = '0123456789abcdef';
        const view = new Uint8Array(bytes);
        let charCodes = new Uint8Array(view.length * 2);
        let j = 0;

        for (let i = 0; i < view.length; i++) {
            let byte = view[i];
            charCodes[j++] = hexDigits.charCodeAt((byte >> 4) & 0xF);
            charCodes[j++] = hexDigits.charCodeAt(byte & 0xF);
        }

        return String.fromCharCode(...charCodes);
    },
}

/**
 * create a time-based uuid
 *
 * Note: the engine will generate a new uuid every time it is called
 *
 * To get the same uuid, please save it to the local storage
 *
 * @returns {string}
 */
function createUuid() {
    return sendMessage({
        method: "uuid"
    });
}

/**
 * Generate a random integer between min and max
 * @param min {number}
 * @param max {number}
 * @returns {number}
 */
function randomInt(min, max) {
    return sendMessage({
        method: 'random',
        type: 'int',
        min: min,
        max: max
    });
}

/**
 * Generate a random double between min and max
 * @param min {number}
 * @param max {number}
 * @returns {number}
 */
function randomDouble(min, max) {
    return sendMessage({
        method: 'random',
        type: 'double',
        min: min,
        max: max
    });
}

class _Timer {
    delay = 0;

    callback = () => { };

    status = false;

    constructor(delay, callback) {
        this.delay = delay;
        this.callback = callback;
    }

    run() {
        this.status = true;
        this._interval();
    }

    _interval() {
        if (!this.status) {
            return;
        }
        this.callback();
        setTimeout(this._interval.bind(this), this.delay);
    }

    cancel() {
        this.status = false;
    }
}

function setInterval(callback, delay) {
    let timer = new _Timer(delay, callback);
    timer.run();
    return timer;
}

/**
 * Create a cookie object.
 * @param name {string}
 * @param value {string}
 * @param domain {string}
 * @constructor
 */
function Cookie({name, value, domain}) {
    this.name = name;
    this.value = value;
    this.domain = domain;
}

/**
 * Network object for sending HTTP requests and managing cookies.
 * @namespace Network
 */
let Network = {
    /**
     * Sends an HTTP request.
     * @param {string} method - The HTTP method (e.g., GET, POST, PUT, PATCH, DELETE).
     * @param {string} url - The URL to send the request to.
     * @param {Object} headers - The headers to include in the request.
     * @param data - The data to send with the request.
     * @param {Object} extra - Extra options to pass to the interceptor.
     * @returns {Promise<{status: number, headers: {}, body: ArrayBuffer}>} The response from the request.
     */
    async fetchBytes(method, url, headers, data, extra) {
        let result = await sendMessage({
            method: 'http',
            http_method: method,
            bytes: true,
            url: url,
            headers: headers,
            data: data,
            extra: extra,
        });

        // The bridge returns a JSON *string*, not an object: the QuickJS wrapper's native
        // return-value marshalling rejects `java.util.Map` ("Unsupported Java type
        // java.util.LinkedHashMap"), so the Kotlin side serialises instead. Decode here, once.
        if (typeof result === 'string') {
            result = JSON.parse(result);
        }

        if (result.error) {
            throw result.error;
        }

        // `body` arrives base64-encoded so arbitrary bytes survive the string round-trip.
        // `Convert.decodeBase64` is a synchronous API (see docs/venera-js-api.md), so there is
        // nothing to await here — the value is already an ArrayBuffer.
        if (typeof result.body === 'string') {
            result.body = Convert.decodeBase64(result.body);
        }

        return result;
    },

    /**
     * Sends an HTTP request.
     * @param {string} method - The HTTP method (e.g., GET, POST, PUT, PATCH, DELETE).
     * @param {string} url - The URL to send the request to.
     * @param {Object} headers - The headers to include in the request.
     * @param data - The data to send with the request.
     * @param {Object} extra - Extra options to pass to the interceptor.
     * @returns {Promise<{status: number, headers: {}, body: string}>} The response from the request.
     */
    async sendRequest(method, url, headers, data, extra) {
        let result = await sendMessage({
            method: 'http',
            http_method: method,
            url: url,
            headers: headers,
            data: data,
            extra: extra,
        });

        // Same JSON-string envelope as `fetchBytes`; here `body` is wanted as decoded text.
        if (typeof result === 'string') {
            result = JSON.parse(result);
        }

        if (result.error) {
            throw result.error;
        }

        if (typeof result.body === 'string') {
            result.body = Convert.decodeUtf8(Convert.decodeBase64(result.body));
        }

        return result;
    },

    /**
     * Sends an HTTP GET request.
     * @param {string} url - The URL to send the request to.
     * @param {Object} headers - The headers to include in the request.
     * @param {Object} extra - Extra options to pass to the interceptor.
     * @returns {Promise<{status: number, headers: {}, body: string}>} The response from the request.
     */
    async get(url, headers, extra) {
        return this.sendRequest('GET', url, headers, extra);
    },

    /**
     * Sends an HTTP POST request.
     * @param {string} url - The URL to send the request to.
     * @param {Object} headers - The headers to include in the request.
     * @param data - The data to send with the request.
     * @param {Object} extra - Extra options to pass to the interceptor.
     * @returns {Promise<{status: number, headers: {}, body: string}>} The response from the request.
     */
    async post(url, headers, data, extra) {
        return this.sendRequest('POST', url, headers, data, extra);
    },

    /**
     * Sends an HTTP PUT request.
     * @param {string} url - The URL to send the request to.
     * @param {Object} headers - The headers to include in the request.
     * @param data - The data to send with the request.
     * @param {Object} extra - Extra options to pass to the interceptor.
     * @returns {Promise<{status: number, headers: {}, body: string}>} The response from the request.
     */
    async put(url, headers, data, extra) {
        return this.sendRequest('PUT', url, headers, data, extra);
    },

    /**
     * Sends an HTTP PATCH request.
     * @param {string} url - The URL to send the request to.
     * @param {Object} headers - The headers to include in the request.
     * @param data - The data to send with the request.
     * @param {Object} extra - Extra options to pass to the interceptor.
     * @returns {Promise<{status: number, headers: {}, body: string}>} The response from the request.
     */
    async patch(url, headers, data, extra) {
        return this.sendRequest('PATCH', url, headers, data, extra);
    },

    /**
     * Sends an HTTP DELETE request.
     * @param {string} url - The URL to send the request to.
     * @param {Object} headers - The headers to include in the request.
     * @param {Object} extra - Extra options to pass to the interceptor.
     * @returns {Promise<{status: number, headers: {}, body: string}>} The response from the request.
     */
    async delete(url, headers, extra) {
        return this.sendRequest('DELETE', url, headers, extra);
    },

    /**
     * Sets cookies for a specific URL.
     * @param {string} url - The URL to set the cookies for.
     * @param {Cookie[]} cookies - The cookies to set.
     */
    setCookies(url, cookies) {
        sendMessage({
            method: 'cookie',
            function: 'set',
            url: url,
            cookies: cookies,
        });
    },

    /**
     * Retrieves cookies for a specific URL.
     * @param {string} url - The URL to get the cookies from.
     * @returns {Promise<Cookie[]>} The cookies for the given URL.
     */
    getCookies(url) {
        return sendMessage({
            method: 'cookie',
            function: 'get',
            url: url,
        });
    },

    /**
     * Deletes cookies for a specific URL.
     * @param {string} url - The URL to delete the cookies from.
     */
    deleteCookies(url) {
        sendMessage({
            method: 'cookie',
            function: 'delete',
            url: url,
        });
    },
};

/**
 * [fetch] function for sending HTTP requests. Same api as the browser fetch.
 * @param url {string}
 * @param [options] {{method?: string, headers?: Object, body?: any}}
 * @returns {Promise<{ok: boolean, status: number, statusText: string, headers: {}, arrayBuffer: (function(): Promise<ArrayBuffer>), text: (function(): Promise<string>), json: (function(): Promise<any>)}>}
 * @since 1.2.0
 */
async function fetch(url, options) {
    let method = 'GET';
    let headers = {};
    let data = null;

    if (options) {
        method = options.method || method;
        headers = options.headers || headers;
        data = options.body || data;
    }

    let result = await Network.fetchBytes(method, url, headers, data);

    return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        statusText: '',
        headers: result.headers,
        arrayBuffer: async () => result.body,
        text: async () => Convert.decodeUtf8(result.body),
        json: async () => JSON.parse(Convert.decodeUtf8(result.body)),
    }
}

/**
 * HtmlDocument class for parsing HTML and querying elements.
 */
/**
 * Host divergence (Aniyomi port): every method here calls `__sendMessageSync`, NOT the
 * Promise-returning `sendMessage` shim — same precedent as the `Image` class below. The whole
 * Html API is synchronous by contract (Venera's flutter_qjs `sendMessage` was synchronous);
 * through the Promise shim `querySelectorAll` would receive a Promise and `ks.map(...)` would
 * die as QuickJS's bare `not a function` (GoDa漫画 explore page, 2026-10-03).
 */
class HtmlDocument {
    static _key = 0;

    key = 0;

    /**
     * Constructor for HtmlDocument.
     * @param {string} html - The HTML string to parse.
     */
    constructor(html) {
        this.key = HtmlDocument._key;
        HtmlDocument._key++;
        __sendMessageSync({
            method: "html",
            function: "parse",
            key: this.key,
            data: html
        })
    }

    /**
     * Query a single element from the HTML document.
     * @param {string} query - The query string.
     * @returns {HtmlElement | null} The first matching element.
     */
    querySelector(query) {
        let k = __sendMessageSync({
            method: "html",
            function: "querySelector",
            key: this.key,
            query: query
        })
        if(k == null) return null;
        return new HtmlElement(k, this.key);
    }

    /**
     * Query all matching elements from the HTML document.
     * @param {string} query - The query string.
     * @returns {HtmlElement[]} An array of matching elements.
     */
    querySelectorAll(query) {
        let ks = __sendMessageSync({
            method: "html",
            function: "querySelectorAll",
            key: this.key,
            query: query
        })
        return ks.map(k => new HtmlElement(k, this.key));
    }

    /**
     * Dispose the HTML document.
     * This should be called when the document is no longer needed.
     */
    dispose() {
        __sendMessageSync({
            method: "html",
            function: "dispose",
            key: this.key
        })
    }

    /**
     * Get the element by its id.
     * @param id {string}
     * @returns {HtmlElement|null}
     */
    getElementById(id) {
        let k = __sendMessageSync({
            method: "html",
            function: "getElementById",
            key: this.key,
            id: id
        })
        if(k == null) return null;
        return new HtmlElement(k, this.key);
    }
}

/**
 * HtmlDom class for interacting with HTML elements.
 */
class HtmlElement {
    key = 0;

    doc = 0;

    /**
     * Constructor for HtmlDom.
     * @param {number} k - The key of the element.
     * @param {number} doc - The key of the document.
     */
    constructor(k, doc) {
        this.key = k;
        this.doc = doc;
    }

    /**
     * Get the text content of the element.
     * @returns {string} The text content.
     */
    get text() {
        return __sendMessageSync({
            method: "html",
            function: "getText",
            key: this.key,
            doc: this.doc,
        })
    }

    /**
     * Get the attributes of the element.
     * @returns {Object} The attributes.
     */
    get attributes() {
        return __sendMessageSync({
            method: "html",
            function: "getAttributes",
            key: this.key,
            doc: this.doc,
        })
    }

    /**
     * Query a single element from the current element.
     * @param {string} query - The query string.
     * @returns {HtmlElement} The first matching element.
     */
    querySelector(query) {
        let k = __sendMessageSync({
            method: "html",
            function: "dom_querySelector",
            key: this.key,
            query: query,
            doc: this.doc,
        })
        if(k == null) return null;
        return new HtmlElement(k, this.doc);
    }

    /**
     * Query all matching elements from the current element.
     * @param {string} query - The query string.
     * @returns {HtmlElement[]} An array of matching elements.
     */
    querySelectorAll(query) {
        let ks = __sendMessageSync({
            method: "html",
            function: "dom_querySelectorAll",
            key: this.key,
            query: query,
            doc: this.doc,
        })
        return ks.map(k => new HtmlElement(k, this.doc));
    }

    /**
     * Get the children of the current element.
     * @returns {HtmlElement[]} An array of child elements.
     */
    get children() {
        let ks = __sendMessageSync({
            method: "html",
            function: "getChildren",
            key: this.key,
            doc: this.doc,
        })
        return ks.map(k => new HtmlElement(k, this.doc));
    }

    /**
     * Get the nodes of the current element.
     * @returns {HtmlNode[]} An array of nodes.
     */
    get nodes() {
        let ks = __sendMessageSync({
            method: "html",
            function: "getNodes",
            key: this.key,
            doc: this.doc,
        })
        return ks.map(k => new HtmlNode(k, this.doc));
    }

    /**
     * Get inner HTML of the element.
     * @returns {string} The inner HTML.
     */
    get innerHTML() {
        return __sendMessageSync({
            method: "html",
            function: "getInnerHTML",
            key: this.key,
            doc: this.doc,
        })
    }

    /**
     * Get parent element of the element. If the element has no parent, return null.
     * @returns {HtmlElement|null}
     */
    get parent() {
        let k = __sendMessageSync({
            method: "html",
            function: "getParent",
            key: this.key,
            doc: this.doc,
        })
        if(k == null) return null;
        return new HtmlElement(k, this.doc);
    }

    /**
     * Get class names of the element.
     * @returns {string[]} An array of class names.
     */
    get classNames() {
        return __sendMessageSync({
            method: "html",
            function: "getClassNames",
            key: this.key,
            doc: this.doc,
        })
    }

    /**
     * Get id of the element.
     * @returns {string | null} The id of the element.
     */
    get id() {
        return __sendMessageSync({
            method: "html",
            function: "getId",
            key: this.key,
            doc: this.doc,
        })
    }

    /**
     * Get local name of the element.
     * @returns {string} The tag name of the element.
     */
    get localName() {
        return __sendMessageSync({
            method: "html",
            function: "getLocalName",
            key: this.key,
            doc: this.doc,
        })
    }

    /**
     * Get the previous sibling element of the element. If the element has no previous sibling, return null.
     * @returns {HtmlElement|null}
     */
    get previousElementSibling() {
        let k = __sendMessageSync({
            method: "html",
            function: "getPreviousSibling",
            key: this.key,
            doc: this.doc,
        })
        if(k == null) return null;
        return new HtmlElement(k, this.doc);
    }

    /**
     * Get the next sibling element of the element. If the element has no next sibling, return null.
     * @returns {HtmlElement|null}
     */
    get nextElementSibling() {
        let k = __sendMessageSync({
            method: "html",
            function: "getNextSibling",
            key: this.key,
            doc: this.doc,
        })
        if (k == null) return null;
        return new HtmlElement(k, this.doc);
    }
}

class HtmlNode {
    key = 0;

    doc = 0;

    constructor(k, doc) {
        this.key = k;
        this.doc = doc;
    }

    /**
     * Get the text content of the node.
     * @returns {string} The text content.
     */
    get text() {
        return __sendMessageSync({
            method: "html",
            function: "node_text",
            key: this.key,
            doc: this.doc,
        })
    }

    /**
     * Get the type of the node.
     * @returns {string} The type of the node. ("text", "element", "comment", "document", "unknown")
     */
    get type() {
        return __sendMessageSync({
            method: "html",
            function: "node_type",
            key: this.key,
            doc: this.doc,
        })
    }

    /**
     * Convert the node to an HtmlElement. If the node is not an element, return null.
     * @returns {HtmlElement|null}
     */
    toElement() {
        let k = __sendMessageSync({
            method: "html",
            function: "node_toElement",
            key: this.key,
            doc: this.doc,
        })
        if(k == null) return null;
        return new HtmlElement(k, this.doc);
    }
}

function log(level, title, content) {
    sendMessage({
        method: 'log',
        level: level,
        title: title,
        content: content,
    })
}

let console = {
    log: (content) => {
        log('info', 'JS Console', content)
    },
    warn: (content) => {
        log('warning', 'JS Console', content)
    },
    error: (content) => {
        log('error', 'JS Console', content)
    },
};

/**
 * Create a comic object
 * @param id {string}
 * @param title {string}
 * @param subtitle {string}
 * @param subTitle {string} - equal to subtitle
 * @param cover {string}
 * @param tags {string[]}
 * @param description {string}
 * @param maxPage {number?}
 * @param language {string?}
 * @param favoriteId {string?} - Only set this field if the comic is from favorites page
 * @param stars {number?} - 0-5, double
 * @constructor
 */
function Comic({id, title, subtitle, subTitle, cover, tags, description, maxPage, language, favoriteId, stars}) {
    this.id = id;
    this.title = title;
    this.subtitle = subtitle;
    this.subTitle = subTitle;
    this.cover = cover;
    this.tags = tags;
    this.description = description;
    this.maxPage = maxPage;
    this.language = language;
    this.favoriteId = favoriteId;
    this.stars = stars;
}

/**
 * Create a comic details object
 * @param title {string}
 * @param subtitle {string}
 * @param subTitle {string} - equal to subtitle
 * @param cover {string}
 * @param description {string?}
 * @param tags {Map<string, string[]> | {} | null | undefined}
 * @param chapters {Map<string, string> | {} | null | undefined} - key: chapter id, value: chapter title
 * @param isFavorite {boolean | null | undefined} - favorite status.
 * @param subId {string?} - a param which is passed to comments api
 * @param thumbnails {string[]?} - for multiple page thumbnails, set this to null, and use `loadThumbnails` api to load thumbnails
 * @param recommend {Comic[]?} - related comics
 * @param commentCount {number?}
 * @param likesCount {number?}
 * @param isLiked {boolean?}
 * @param uploader {string?}
 * @param updateTime {string?}
 * @param uploadTime {string?}
 * @param url {string?}
 * @param stars {number?} - 0-5, double
 * @param maxPage {number?}
 * @param comments {Comment[]?}- `since 1.0.7` App will display comments in the details page.
 * @constructor
 */
function ComicDetails({title, subtitle, subTitle, cover, description, tags, chapters, isFavorite, subId, thumbnails, recommend, commentCount, likesCount, isLiked, uploader, updateTime, uploadTime, url, stars, maxPage, comments}) {
    this.title = title;
    this.subtitle = subtitle ?? subTitle;
    this.cover = cover;
    this.description = description;
    this.tags = tags;
    this.chapters = chapters;
    this.isFavorite = isFavorite;
    this.subId = subId;
    this.thumbnails = thumbnails;
    this.recommend = recommend;
    this.commentCount = commentCount;
    this.likesCount = likesCount;
    this.isLiked = isLiked;
    this.uploader = uploader;
    this.updateTime = updateTime;
    this.uploadTime = uploadTime;
    this.url = url;
    this.stars = stars;
    this.maxPage = maxPage;
    this.comments = comments;
}

/**
 * Create a comment object
 * @param userName {string}
 * @param avatar {string?}
 * @param content {string}
 * @param time {string?}
 * @param replyCount {number?}
 * @param id {string?}
 * @param isLiked {boolean?}
 * @param score {number?}
 * @param voteStatus {number?} - 1: upvote, -1: downvote, 0: none
 * @constructor
 */
function Comment({userName, avatar, content, time, replyCount, id, isLiked, score, voteStatus}) {
    this.userName = userName;
    this.avatar = avatar;
    this.content = content;
    this.time = time;
    this.replyCount = replyCount;
    this.id = id;
    this.isLiked = isLiked;
    this.score = score;
    this.voteStatus = voteStatus;
}

/**
 * Create image loading config
 * @param url {string?}
 * @param method {string?} - http method, uppercase
 * @param data {any} - request data, may be null
 * @param headers {Object?} - request headers
 * @param onResponse {((ArrayBuffer) => ArrayBuffer)?} - modify response data
 * @param modifyImage {string?}
 *  A js script string.
 *  The script will be executed in a new Isolate.
 *  A function named `modifyImage` should be defined in the script, which receives an [Image] as the only argument, and returns an [Image]..
 * @param onLoadFailed {(() => ImageLoadingConfig)?} - called when the image loading failed
 * @constructor
 * @since 1.0.5
 *
 * To keep the compatibility with the old version, do not use the constructor. Consider creating a new object with the properties directly.
 */
function ImageLoadingConfig({url, method, data, headers, onResponse, modifyImage, onLoadFailed}) {
    this.url = url;
    this.method = method;
    this.data = data;
    this.headers = headers;
    this.onResponse = onResponse;
    this.modifyImage = modifyImage;
    this.onLoadFailed = onLoadFailed;
}

class ComicSource {
    name = ""

    key = ""

    version = ""

    minAppVersion = ""

    url = ""

    /**
     * load data with its key
     * @param {string} dataKey
     * @returns {any}
     */
    loadData(dataKey) {
        return sendMessage({
            method: 'load_data',
            key: this.key,
            data_key: dataKey
        })
    }

    /**
     * load a setting with its key
     * @param key {string}
     * @returns {any}
     */
    loadSetting(key) {
        return sendMessage({
            method: 'load_setting',
            key: this.key,
            setting_key: key
        })
    }

    /**
     * save data
     * @param {string} dataKey
     * @param data
     */
    saveData(dataKey, data) {
        return sendMessage({
            method: 'save_data',
            key: this.key,
            data_key: dataKey,
            data: data
        })
    }

    /**
     * delete data
     * @param {string} dataKey
     */
    deleteData(dataKey) {
        return sendMessage({
            method: 'delete_data',
            key: this.key,
            data_key: dataKey,
        })
    }

    /**
     *
     * @returns {boolean}
     */
    get isLogged() {
        return sendMessage({
            method: 'isLogged',
            key: this.key,
        });
    }

    translation = {}

    /**
     * Translate given string with the current locale using the translation object.
     * @param key {string}
     * @returns {string}
     * @since 1.2.5
     */
    translate(key) {
        let locale = APP.locale;
        return this.translation[locale]?.[key] ?? key;
    }

    init() { }

    static sources = {}
}

/// A reference to dart object.
/// The api can only be used in the comic.onImageLoad.modifyImage function
///
/// Host divergence (Aniyomi port): methods call `__sendMessageSync`, NOT the Promise-returning
/// `sendMessage` shim. The whole Image API is synchronous by contract (Venera's flutter_qjs
/// `sendMessage` was synchronous); through the Promise shim every returned key would be a
/// Promise and `new Image(key)` would wrap an unresolved value.
class Image {
    key = 0;

    constructor(key) {
        this.key = key;
    }

    /**
     * Copy the specified range of the image
     * @param x
     * @param y
     * @param width
     * @param height
     * @returns {Image|null}
     */
    copyRange(x, y, width, height) {
        let key = __sendMessageSync({
            method: "image",
            function: "copyRange",
            key: this.key,
            x: x,
            y: y,
            width: width,
            height: height
        })
        if(key == null) return null;
        return new Image(key);
    }

    /**
     * Copy the image and rotate 90 degrees
     * @returns {Image|null}
     */
    copyAndRotate90() {
        let key = __sendMessageSync({
            method: "image",
            function: "copyAndRotate90",
            key: this.key
        })
        if(key == null) return null;
        return new Image(key);
    }

    /**
     * fill [image] to this image at (x, y)
     * @param x
     * @param y
     * @param image
     */
    fillImageAt(x, y, image) {
        __sendMessageSync({
            method: "image",
            function: "fillImageAt",
            key: this.key,
            x: x,
            y: y,
            image: image.key
        })
    }

    /**
     * fill [image] with range(srcX, srcY, width, height) to this image at (x, y)
     * @param x
     * @param y
     * @param image
     * @param srcX
     * @param srcY
     * @param width
     * @param height
     */
    fillImageRangeAt(x, y, image, srcX, srcY, width, height) {
        __sendMessageSync({
            method: "image",
            function: "fillImageRangeAt",
            key: this.key,
            x: x,
            y: y,
            image: image.key,
            srcX: srcX,
            srcY: srcY,
            width: width,
            height: height
        })
    }

    get width() {
        return __sendMessageSync({
            method: "image",
            function: "getWidth",
            key: this.key
        })
    }

    get height() {
        return __sendMessageSync({
            method: "image",
            function: "getHeight",
            key: this.key
        })
    }

    static empty(width, height) {
        let key = __sendMessageSync({
            method: "image",
            function: "emptyImage",
            width: width,
            height: height
        })
        return new Image(key);
    }
}

/**
 * UI related apis
 * @since 1.2.0
 */
let UI = {
    /**
     * Show a message
     * @param message {string}
     */
    showMessage: (message) => {
        sendMessage({
            method: 'UI',
            function: 'showMessage',
            message: message,
        })
    },

    /**
     * Show a dialog. Any action will close the dialog.
     * @param title {string}
     * @param content {string}
     * @param actions {{text:string, callback: () => void | Promise<void>, style: "text"|"filled"|"danger"}[]} - If callback returns a promise, the button will show a loading indicator until the promise is resolved.
     * @returns {Promise<void>} - Resolved when the dialog is closed.
     * @since 1.2.1
     */
    showDialog: (title, content, actions) => {
        sendMessage({
            method: 'UI',
            function: 'showDialog',
            title: title,
            content: content,
            actions: actions,
        })
    },

    /**
     * Open [url] in external browser
     * @param url {string}
     */
    launchUrl: (url) => {
        sendMessage({
            method: 'UI',
            function: 'launchUrl',
            url: url,
        })
    },

    /**
     * Show a loading dialog.
     * @param onCancel {() => void | null | undefined} - Called when the loading dialog is canceled. If [onCancel] is null, the dialog cannot be canceled by the user.
     * @returns {number} - A number that can be used to cancel the loading dialog.
     * @since 1.2.1
     */
    showLoading: (onCancel) => {
        return sendMessage({
            method: 'UI',
            function: 'showLoading',
            onCancel: onCancel
        })
    },

    /**
     * Cancel a loading dialog.
     * @param id {number} - returned by [showLoading]
     * @since 1.2.1
     */
    cancelLoading: (id) => {
        sendMessage({
            method: 'UI',
            function: 'cancelLoading',
            id: id
        })
    },

    /**
     * Show an input dialog
     * @param title {string}
     * @param validator {(string) => string | null | undefined} - A function that validates the input. If the function returns a string, the dialog will show the error message.
     * @param image {string | ArrayBuffer | null | undefined} - Since 1.4.6, you can pass an image url to show an image in the dialog. Since 1.5.3, you can also pass an ArrayBuffer to show a custom image.
     * @returns {Promise<string | null>} - The input value. If the dialog is canceled, return null.
     */
    showInputDialog: (title, validator, image) => {
        return sendMessage({
            method: 'UI',
            function: 'showInputDialog',
            title: title,
            image: image,
            validator: validator
        })
    },

    /**
     * Show a select dialog
     * @param title {string}
     * @param options {string[]}
     * @param initialIndex {number?}
     * @returns {Promise<number | null>} - The selected index. If the dialog is canceled, return null.
     */
    showSelectDialog: (title, options, initialIndex) => {
        return sendMessage({
            method: 'UI',
            function: 'showSelectDialog',
            title: title,
            options: options,
            initialIndex: initialIndex
        })
    }
}

/**
 * App related apis
 * @since 1.2.1
 */
let APP = {
    /**
     * Get the app version
     * @returns {string} - The app version
     */
    get version() {
        return appVersion // defined in the engine
    },

    /**
     * Get current app locale
     * @returns {string} - The app locale, in the format of [languageCode]_[countryCode]
     */
    get locale() {
        return sendMessage({
            method: 'getLocale'
        })
    },

    /**
     * Get current running platform
     * @returns {string} - The platform name, "android", "ios", "windows", "macos", "linux"
     */
    get platform() {
        return sendMessage({
            method: 'getPlatform'
        })
    }
}

/**
 * Set clipboard text
 * @param text {string}
 * @returns {Promise<void>}
 * 
 * @since 1.3.4
 */
function setClipboard(text) {
    return sendMessage({
        method: 'setClipboard',
        text: text
    })
}

/**
 * Get clipboard text
 * @returns {Promise<string>}
 * 
 * @since 1.3.4
 */
function getClipboard() {
    return sendMessage({
        method: 'getClipboard'
    })
}

/**
 * Compute a function with arguments. The function will be executed in the engine pool which is not in the main thread.
 * @param func {string} - A js code string which can be evaluated to a function. The function will receive the args as its only argument.
 * @param args {any[]} - The arguments to pass to the function.
 * @returns {Promise<any>} - The result of the function.
 * @since 1.5.0
 */
function compute(func, ...args) {
    return sendMessage({
        method: 'compute',
        function: func,
        args: args
    })
}
/**
 * Deep-convert JS `Map` / `Set` instances (and class instances in general) into plain objects /
 * arrays, recursively.
 *
 * ### Why the host needs this at the *result-unwrapping* boundary
 *
 * Venera's `ComicDetails` contract lets sources return `chapters` as a `Map<string, string>`
 * (jm.js builds exactly that: `chapters.set(id, title)`), and `tags` as a
 * `Map<string, string[]>`. But the QuickJS wrapper's object→Kotlin conversion
 * (`QuickJSObject.convertToMap`) enumerates a value with `JS_GetOwnPropertyNames` — and a `Map`
 * instance keeps its entries in an *internal slot*, not in own properties. So `new Map([['a','b']])`
 * arrives in Kotlin as an **empty** `{}`: the chapter list silently collapsed to `[]`, which made
 * `SyncChaptersWithSource` throw `NoChaptersException` — the「没有章节」snackbar — on every manga
 * whose source uses Maps, while the import-time chapter fetch wrote nothing at all.
 *
 * The host therefore normalises the settled value *before* converting it (see `JsEngine`):
 * `Map` → **ordered list of `[key, value]` pairs** (see the Map branch below for why a keyed
 * object cannot survive the native conversion), `Set` → array, class instances → own-property
 * objects. Binary values (`ArrayBuffer` / views) pass through untouched — the bridge marshals
 * them as `byte[]` and flattening them would corrupt payloads. Depth is capped so a
 * self-referencing structure degrades to `null` instead of hanging the JS thread.
 *
 * @param v {any}
 * @param depth {number?}
 * @returns {any}
 */
globalThis.__plainValue = function (v, depth) {
    depth = depth || 0
    if (v === null || v === undefined) return v
    var t = typeof v
    if (t !== 'object' && t !== 'function') return v
    if (t === 'function') return undefined
    if (depth > 8) return null
    if (typeof ArrayBuffer !== 'undefined' && (v instanceof ArrayBuffer || ArrayBuffer.isView(v))) return v
    if (typeof Date !== 'undefined' && v instanceof Date) return v.toISOString ? v.toISOString() : String(v)
    if (typeof Set !== 'undefined' && v instanceof Set) {
        var arr = []
        v.forEach(function (item) { arr.push(globalThis.__plainValue(item, depth + 1)) })
        return arr
    }
    if (typeof Map !== 'undefined' && v instanceof Map) {
        // S18: a Map must become an ORDERED LIST OF [key, value] PAIRS — never a keyed object.
        // Two independent reasons, both fatal on device and BOTH invisible to the Node bench
        // (vm has no JNI boundary and no native HashMap):
        //
        //  1. Count — the wrapper's `convertToMap` reads each key out of the
        //     `JS_GetOwnPropertyNames` JSArray and marshals it through JNI's modified UTF-8
        //     (`NewStringUTF`), where a raw 0x00 byte is the C-string terminator. A "\u0000"
        //     insertion-order guard therefore truncated EVERY guarded key to "" on arrival and
        //     the chapters map collapsed into a single `"" -> null` entry — every detail page
        //     showed「共 1 章」with a blank title. (An interim "\u200b" guard survived the JNI
        //     boundary but see 2.)
        //
        //  2. Order — `QuickJSObject.toMap` collects keys into a **java.util.HashMap**
        //     (mapCreator = `HashMap::new`), which iterates in HASH order. No object-key scheme
        //     can preserve a Map's insertion order across that boundary; the device fingerprint
        //     第5話,42,37,20,34,27,… was exactly that hash order.
        //
        // An array of pairs travels as JSArray → `ArrayList` (`convertToMap` walks nested arrays
        // by index), which preserves BOTH count and insertion order. Consumer:
        // JsMangaSource.getChapterList — pairs are the primary shape there; a plain-object
        // `chapters` from a source still falls back to Map entries.
        var pairs = []
        v.forEach(function (value, key) {
            pairs.push([globalThis.__plainValue(key, depth + 1), globalThis.__plainValue(value, depth + 1)])
        })
        return pairs
    }
    if (Array.isArray(v)) {
        return v.map(function (item) { return globalThis.__plainValue(item, depth + 1) })
    }
    var out = {}
    var keys = Object.keys(v)
    for (var i = 0; i < keys.length; i++) {
        out[keys[i]] = globalThis.__plainValue(v[keys[i]], depth + 1)
    }
    return out
}
