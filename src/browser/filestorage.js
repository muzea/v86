"use strict";

/** @interface */
function FileStorageInterface() { }

/**
 * Read a portion of a file.
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @return {!Promise<Uint8Array>} null if file does not exist.
 */
FileStorageInterface.prototype.read = function (sha256sum, offset, count) { };

/**
 * Add a read-only file to the filestorage.
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 * @return {!Promise}
 */
FileStorageInterface.prototype.cache = function (sha256sum, data) { };

/**
 * Call this when the file won't be used soon, e.g. when a file closes or when this immutable
 * version is already out of date. It is used to help prevent accumulation of unused files in
 * memory in the long run for some FileStorage mediums.
 */
FileStorageInterface.prototype.uncache = function (sha256sum) { };

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
            done: async buffer => {
                const data = new Uint8Array(buffer);
                await this.cache(sha256sum, data);
                resolve(data);
            }
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


/**
 * @implements {FileStorageInterface}
 */
class ServerPackStorageWrapper {
    constructor(file_storage, baseurl) {
        dbg_assert(baseurl, "ServerMemoryFileStorage: baseurl should not be empty");

        this.storage = file_storage;
        this.baseurl = baseurl;
        // store promise avoid parallel calls
        this.fileInfoMap = {};
        this.packMap = {};
    }

    /**
     * @param {string} sha256sum
     * @return {!Promise<Uint8Array>}
     */
    async load_from_server(sha256sum) {
        console.log('try load file ', sha256sum);
        // check file map
        const prefix = sha256sum.substring(0, 1);
        if (!this.fileInfoMap[prefix]) {

            this.fileInfoMap[prefix] = new Promise((resolveMap) => {
                v86util.load_file(this.baseurl + `${prefix}.map.json`, {
                    as_json: true,
                    /**
                     * @param {Array<number>} resp 
                     */
                    done: async resp => {
                        const infoMap = {};
                        let i = 0;
                        let end = resp.length;
                        let start = 0;
                        while (i < end) {
                            const fileEnd = start + resp[i + 1];
                            infoMap[resp[i]] = {
                                start: start,
                                end: fileEnd,
                            }
                            start = fileEnd;

                            i += 2;
                        }
                        resolveMap(infoMap);
                    }
                });
            });

            this.packMap[prefix] = new Promise((resolvePack) => {
                v86util.load_file(this.baseurl + `${prefix}.pack`, {
                    /**
                     * @param {ArrayBuffer} buffer 
                     */
                    done: async buffer => {
                        resolvePack(buffer);
                    }
                });
            });
        }

        const infoMap = await this.fileInfoMap[prefix];
        /**
         * @type {ArrayBuffer}
         */
        const pack = await this.packMap[prefix];

        const hash = sha256sum.split('.')[0];

        return new Uint8Array(pack, infoMap[hash].start, infoMap[hash].end - infoMap[hash].start);
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
    };

    /**
     * @param {string} sha256sum
     */
    uncache(sha256sum) {
        this.storage.uncache(sha256sum);
    };
}




// Closure Compiler's way of exporting
if (typeof module !== "undefined" && typeof module.exports !== "undefined") {
    module.exports["MemoryFileStorage"] = MemoryFileStorage;
    module.exports["ServerFileStorageWrapper"] = ServerFileStorageWrapper;
    module.exports["ServerPackStorageWrapper"] = ServerPackStorageWrapper;
}
else if (typeof window !== "undefined") {
    window["MemoryFileStorage"] = MemoryFileStorage;
    window["ServerFileStorageWrapper"] = ServerFileStorageWrapper;
    window["ServerPackStorageWrapper"] = ServerPackStorageWrapper;
}
else if (typeof importScripts === "function") {
    // web worker
    self["MemoryFileStorage"] = MemoryFileStorage;
    self["ServerFileStorageWrapper"] = ServerFileStorageWrapper;
    self["ServerPackStorageWrapper"] = ServerPackStorageWrapper;
}
