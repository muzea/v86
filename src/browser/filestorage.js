"use strict";

/** @interface */
function FileStorageInterface() {}

/**
 * Read a portion of a file.
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @return {!Promise<Uint8Array>} null if file does not exist.
 */
FileStorageInterface.prototype.read = function (sha256sum, offset, count) {};

/**
 * Add a read-only file to the filestorage.
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 * @return {!Promise}
 */
FileStorageInterface.prototype.cache = function (sha256sum, data) {};

/**
 * Call this when the file won't be used soon, e.g. when a file closes or when this immutable
 * version is already out of date. It is used to help prevent accumulation of unused files in
 * memory in the long run for some FileStorage mediums.
 */
FileStorageInterface.prototype.uncache = function (sha256sum) {};

/**
 * @constructor
 * @implements {FileStorageInterface}
 */
function MemoryFileStorage() {
    /**
     * From sha256sum to file data.
     * @type {Map<string,Uint8Array>}
     */
    this.filedata = new Map();
}

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @return {!Promise<Uint8Array>} null if file does not exist.
 */
MemoryFileStorage.prototype.read = async function (sha256sum, offset, count) {
    dbg_assert(sha256sum, "MemoryFileStorage read: sha256sum should be a non-empty string");
    const data = this.filedata.get(sha256sum);

    if (!data) {
        return null;
    }

    return data.subarray(offset, offset + count);
};

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 */
MemoryFileStorage.prototype.cache = async function (sha256sum, data) {
    dbg_assert(sha256sum, "MemoryFileStorage cache: sha256sum should be a non-empty string");
    this.filedata.set(sha256sum, data);
};

/**
 * @param {string} sha256sum
 */
MemoryFileStorage.prototype.uncache = function (sha256sum) {
    this.filedata.delete(sha256sum);
};

/**
 * @constructor
 * @implements {FileStorageInterface}
 * @param {FileStorageInterface} file_storage
 * @param {string} baseurl
 */
function ServerFileStorageWrapper(file_storage, baseurl) {
    dbg_assert(baseurl, "ServerMemoryFileStorage: baseurl should not be empty");

    this.storage = file_storage;
    this.baseurl = baseurl;
}

/**
 * @param {string} sha256sum
 * @return {!Promise<Uint8Array>}
 */
ServerFileStorageWrapper.prototype.load_from_server = function (sha256sum) {
    return new Promise((resolve, reject) => {
        v86util.load_file(this.baseurl + sha256sum, {
            done: async (buffer) => {
                const data = new Uint8Array(buffer);
                await this.cache(sha256sum, data);
                resolve(data);
            },
        });
    });
};

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @return {!Promise<Uint8Array>}
 */
ServerFileStorageWrapper.prototype.read = async function (sha256sum, offset, count) {
    const data = await this.storage.read(sha256sum, offset, count);
    if (!data) {
        const full_file = await this.load_from_server(sha256sum);
        return full_file.subarray(offset, offset + count);
    }
    return data;
};

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 */
ServerFileStorageWrapper.prototype.cache = async function (sha256sum, data) {
    return await this.storage.cache(sha256sum, data);
};

/**
 * @param {string} sha256sum
 */
ServerFileStorageWrapper.prototype.uncache = function (sha256sum) {
    this.storage.uncache(sha256sum);
};

const fsPackCache = window.caches.open("v86-fs-request");

if (DEBUG) {
    window.fsReadList = [];
}

/**
 *
 * @param {string} url
 * @returns {Promise<Response>}
 */
async function fetchWithCache(url) {
    const cacheIns = await fsPackCache;
    const maybeResult = await cacheIns.match(url);
    if (maybeResult) return maybeResult;

    const result = await fetch(url);

    await cacheIns.put(url, result.clone());
    return result;
}

/**
 *
 * @param {string} url
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchArrayBuffer(url) {
    return (await fetchWithCache(url)).arrayBuffer();
}

/**
 * @implements {FileStorageInterface}
 */
class ServerPackStorageWrapper {
    constructor(file_storage, baseurl, use_pack) {
        dbg_assert(baseurl, "ServerMemoryFileStorage: baseurl should not be empty");

        this.storage = file_storage;
        this.baseurl = baseurl;
        // store promise avoid parallel calls
        this.packMap = {};

        /**
         * Map<number, { p: number; s: number; l: number }>
         * p - pack
         * The file is in the p-th pack congregation
         * s - start
         * l - length
         */
        this.fileMap = use_pack.fileMap;
    }

    /**
     * @param {string} sha256sum
     * @return {!Promise<Uint8Array>}
     */
    async load_from_server(sha256sum) {
        // https://jsben.ch/qIzmj
        const hash = parseInt(sha256sum.substring(0, 8), 16);
        if (DEBUG) {
            window.fsReadList.push(hash);
        }
        const fileInfo = this.fileMap.get(hash);
        // check pack is load status
        if (!this.packMap[fileInfo.p]) {
            console.log("[v86][fs] load pack ", fileInfo.p);
            this.packMap[fileInfo.p] = new Promise((resolvePack) => {
                const resourceUrl = this.baseurl + `${fileInfo.p.toString(16)}.pack`;
                fetchArrayBuffer(resourceUrl).then(resolvePack);
            });
        }
        /**
         * @type {ArrayBuffer}
         */
        const pack = await this.packMap[fileInfo.p];

        return new Uint8Array(pack, fileInfo.s, fileInfo.l);
    }

    /**
     * @param {string} sha256sum
     * @param {number} offset
     * @param {number} count
     * @return {!Promise<Uint8Array>}
     */
    async read(sha256sum, offset, count) {
        const data = await this.storage.read(sha256sum, offset, count);
        if (!data) {
            const full_file = await this.load_from_server(sha256sum);
            return full_file.subarray(offset, offset + count);
        }
        return data;
    }

    /**
     * @param {string} sha256sum
     * @param {!Uint8Array} data
     */
    async cache(sha256sum, data) {
        return await this.storage.cache(sha256sum, data);
    }

    /**
     * @param {string} sha256sum
     */
    uncache(sha256sum) {
        this.storage.uncache(sha256sum);
    }
}

// Closure Compiler's way of exporting
if (typeof module !== "undefined" && typeof module.exports !== "undefined") {
    module.exports["MemoryFileStorage"] = MemoryFileStorage;
    module.exports["ServerFileStorageWrapper"] = ServerFileStorageWrapper;
    module.exports["ServerPackStorageWrapper"] = ServerPackStorageWrapper;
} else if (typeof window !== "undefined") {
    window["MemoryFileStorage"] = MemoryFileStorage;
    window["ServerFileStorageWrapper"] = ServerFileStorageWrapper;
    window["ServerPackStorageWrapper"] = ServerPackStorageWrapper;
} else if (typeof importScripts === "function") {
    // web worker
    self["MemoryFileStorage"] = MemoryFileStorage;
    self["ServerFileStorageWrapper"] = ServerFileStorageWrapper;
    self["ServerPackStorageWrapper"] = ServerPackStorageWrapper;
}
