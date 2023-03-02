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


// copy from https://www.npmjs.com/package/@kvs/indexeddb
function invariant(condition, message) {
    if (condition) {
        return;
    }
    throw new Error(message);
}
const openDB = ({ name, version, tableName, onUpgrade }) => {
    return new Promise((resolve, reject) => {
        const openRequest = indexedDB.open(name, version);
        openRequest.onupgradeneeded = function (event) {
            var _a;
            // IndexedDB has oldVersion and newVersion is native properties
            const oldVersion = event.oldVersion;
            const newVersion = (_a = event.newVersion) !== null && _a !== void 0 ? _a : version;
            const database = openRequest.result;
            try {
                // create table at first time
                if (!newVersion || newVersion <= 1) {
                    database.createObjectStore(tableName);
                }
            }
            catch (e) {
                reject(e);
            }
            // for drop instance
            // https://github.com/w3c/IndexedDB/issues/78
            // https://www.w3.org/TR/IndexedDB/#introduction
            database.onversionchange = () => {
                database.close();
            };
            // @ts-expect-error: target should be existed
            event.target.transaction.oncomplete = async () => {
                try {
                    await onUpgrade({
                        oldVersion,
                        newVersion,
                        database
                    });
                    return resolve(database);
                }
                catch (error) {
                    return reject(error);
                }
            };
        };
        openRequest.onblocked = () => {
            reject(openRequest.error);
        };
        openRequest.onerror = function () {
            reject(openRequest.error);
        };
        openRequest.onsuccess = function () {
            const db = openRequest.result;
            resolve(db);
        };
    });
};
const dropInstance = (database, databaseName) => {
    return new Promise((resolve, reject) => {
        database.close();
        const request = indexedDB.deleteDatabase(databaseName);
        request.onupgradeneeded = (event) => {
            event.preventDefault();
            resolve();
        };
        request.onblocked = () => {
            reject(request.error);
        };
        request.onerror = function () {
            reject(request.error);
        };
        request.onsuccess = function () {
            resolve();
        };
    });
};
const getItem = (database, tableName, key) => {
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(tableName, "readonly");
        const objectStore = transaction.objectStore(tableName);
        const request = objectStore.get(String(key));
        request.onsuccess = () => {
            resolve(request.result);
        };
        request.onerror = () => {
            reject(request.error);
        };
    });
};
const hasItem = async (database, tableName, key) => {
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(tableName, "readonly");
        const objectStore = transaction.objectStore(tableName);
        const request = objectStore.count(String(key));
        request.onsuccess = () => {
            resolve(request.result !== 0);
        };
        request.onerror = () => {
            reject(request.error);
        };
    });
};
const setItem = async (database, tableName, key, value) => {
    // If the value is undefined, delete the key
    // This behavior aim to align localStorage implementation
    if (value === undefined) {
        await deleteItem(database, tableName, key);
        return;
    }
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(tableName, "readwrite");
        const objectStore = transaction.objectStore(tableName);
        const request = objectStore.put(value, String(key));
        transaction.oncomplete = () => {
            resolve();
        };
        transaction.onabort = () => {
            reject(request.error ? request.error : transaction.error);
        };
        transaction.onerror = () => {
            reject(request.error ? request.error : transaction.error);
        };
    });
};
const deleteItem = async (database, tableName, key) => {
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(tableName, "readwrite");
        const objectStore = transaction.objectStore(tableName);
        const request = objectStore.delete(String(key));
        transaction.oncomplete = () => {
            resolve();
        };
        transaction.onabort = () => {
            reject(request.error ? request.error : transaction.error);
        };
        transaction.onerror = () => {
            reject(request.error ? request.error : transaction.error);
        };
    });
};
const clearItems = async (database, tableName) => {
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(tableName, "readwrite");
        const objectStore = transaction.objectStore(tableName);
        const request = objectStore.clear();
        transaction.oncomplete = () => {
            resolve();
        };
        transaction.onabort = () => {
            reject(request.error ? request.error : transaction.error);
        };
        transaction.onerror = () => {
            reject(request.error ? request.error : transaction.error);
        };
    });
};
const iterator = (database, tableName) => {
    const handleCursor = (request) => {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    return resolve({
                        done: true
                    });
                }
                return resolve({
                    done: false,
                    value: cursor
                });
            };
            request.onerror = () => {
                reject(request.error);
            };
        });
    };
    const transaction = database.transaction(tableName, "readonly");
    const objectStore = transaction.objectStore(tableName);
    const request = objectStore.openCursor();
    return {
        async next() {
            const { done, value } = await handleCursor(request);
            if (!done) {
                const storageKey = value === null || value === void 0 ? void 0 : value.key;
                const storageValue = value === null || value === void 0 ? void 0 : value.value;
                value === null || value === void 0 ? void 0 : value.continue();
                return { done: false, value: [storageKey, storageValue] };
            }
            return { done: true, value: undefined };
        }
    };
};
const createStore = ({ database, databaseName, tableName }) => {
    const store = {
        delete(key) {
            return deleteItem(database, tableName, key).then(() => true);
        },
        get(key) {
            return getItem(database, tableName, key);
        },
        has(key) {
            return hasItem(database, tableName, key);
        },
        set(key, value) {
            return setItem(database, tableName, key, value).then(() => store);
        },
        clear() {
            return clearItems(database, tableName);
        },
        dropInstance() {
            return dropInstance(database, databaseName);
        },
        close() {
            return Promise.resolve().then(() => {
                database.close();
            });
        },
        [Symbol.asyncIterator]() {
            return iterator(database, tableName);
        },
        __debug__database__: database
    };
    return store;
};

const kvsIndexedDB = async (options) => {
    var _a;
    const { name, version, upgrade, ...indexDBOptions } = options;
    invariant(typeof name === "string", "name should be string");
    invariant(typeof version === "number", "version should be number");
    const tableName = (_a = indexDBOptions.tableName) !== null && _a !== void 0 ? _a : "kvs";
    const database = await openDB({
        name,
        version,
        tableName,
        onUpgrade: ({ oldVersion, newVersion, database }) => {
            if (!upgrade) {
                return;
            }
            return upgrade({
                kvs: createStore({ database: database, tableName: tableName, databaseName: name }),
                oldVersion,
                newVersion
            });
        }
    });
    return createStore({ database: database, tableName: tableName, databaseName: name });
};


/**
 * @implements {FileStorageInterface}
 */
class ServerPackStorageWrapper {
    constructor(file_storage, baseurl, use_pack) {
        dbg_assert(baseurl, "ServerMemoryFileStorage: baseurl should not be empty");

        this.storage = file_storage;
        this.baseurl = baseurl;
        // store promise avoid parallel calls
        this.fileInfoMap = {};
        this.packMap = {};
        this.kv = null;
        if (typeof use_pack === 'object') {
            this.prefix_length = use_pack.prefix_length || 1;

            if (use_pack.idb_key) {
                kvsIndexedDB({
                    name: use_pack.idb_key,
                    version: 1,
                }).then(ins => {
                    this.kv = ins;
                });
            }
        } else {
            this.prefix_length = 1;
        }
    }

    /**
     * @param {string} sha256sum
     * @return {!Promise<Uint8Array>}
     */
    async load_from_server(sha256sum) {
        console.log('try load file ', sha256sum);
        // check file map
        const prefix = sha256sum.substring(0, this.prefix_length);
        if (!this.fileInfoMap[prefix]) {

            this.fileInfoMap[prefix] = new Promise((resolveMap) => {
                const resourceUrl = this.baseurl + `${prefix}.map.json`;

                if (this.kv && this.kv.has(resourceUrl)) {
                    return resolveMap(this.kv.get(resourceUrl));
                }
                v86util.load_file(resourceUrl, {
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
                        this.kv && this.kv.set(resourceUrl, infoMap);
                        resolveMap(infoMap);
                    }
                });
            });

            this.packMap[prefix] = new Promise((resolvePack) => {
                const resourceUrl = this.baseurl + `${prefix}.pack`;
                if (this.kv && this.kv.has(resourceUrl)) {
                    return resolvePack(this.kv.get(resourceUrl));
                }
                v86util.load_file(resourceUrl, {
                    /**
                     * @param {ArrayBuffer} buffer 
                     */
                    done: async buffer => {
                        this.kv && this.kv.set(resourceUrl, buffer);
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
