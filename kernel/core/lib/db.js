// Database Configuration
const { Settings } = require('../../settings.js');

const STORE_NAME = "savestates";
const PICTURE_STORE_NAME = "pictures";
const MAX_SLOTS = 10;
const IDB_VERSION = 1;
const IDB_STORES = ['savestates', 'pictures', 'gamepad_config'];

function getCurrentDB(systemId) {
    return STORE_NAME + '-DB';
}

function resolveStoreName(storeName) {
    if (storeName) return storeName;
    if (typeof STORE_NAME !== 'undefined') return STORE_NAME;
    return IDB_STORES[0];
}

// Helper to get data from IndexedDB
async function idbGet(key, storeName) {
    const db = await openDB();
    const resolvedStore = resolveStoreName(storeName);
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(resolvedStore, "readonly");
        const store = transaction.objectStore(resolvedStore);
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Helper to save data to IndexedDB
async function idbSet(key, value, storeName) {
    const db = await openDB();
    const resolvedStore = resolveStoreName(storeName);
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(resolvedStore, "readwrite");
        const store = transaction.objectStore(resolvedStore);
        const request = store.put(value, key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// Promise wrapper for initializing/opening IndexedDB
function openDB(systemId) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(getCurrentDB(systemId), IDB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            for (const storeName of IDB_STORES) {
                if (!db.objectStoreNames.contains(storeName)) {
                    db.createObjectStore(storeName);
                }
            }
            // Allow pages that declare a custom STORE_NAME to self-register.
            if (typeof STORE_NAME !== 'undefined' && !IDB_STORES.includes(STORE_NAME)) {
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Helper to delete a key from IndexedDB
async function idbDelete(key, storeName) {
    const db = await openDB();
    const resolvedStore = resolveStoreName(storeName);
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(resolvedStore, "readwrite");
        const store = transaction.objectStore(resolvedStore);
        const request = store.delete(key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

async function gzipCompress(data) {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gzipDecompress(data) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function captureCanvasPicture() {
    const canvas = typeof getGameCanvas === 'function'
        ? getGameCanvas()
        : document.getElementById('gameCanvas');
    if (!canvas) return Promise.resolve(null);
    return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob), 'image/png');
    });
}

function isGameActive() {
    return Settings.app !== undefined && Settings.app.currentLevel && Settings.app.currentLevel.active;
}

async function saveState() {
    if (!isGameActive()) {
        alert('Start a game first');
        return;
    }

    try {
        const simulator = Settings.app.currentLevel;

        if (!simulator || typeof simulator.getSnapshot !== 'function') {
            alert('Snapshot support not yet added to Simulator. Please add getSnapshot() / setSnapshot().');
            return;
        }

        const snapshot = simulator.getSnapshot();
        const jsonString = JSON.stringify(snapshot);
        const memorySnapshot = new TextEncoder().encode(jsonString);

        const compressedData = await gzipCompress(memorySnapshot);
        const dataToSave = new Blob([compressedData], { type: 'application/gzip' });

        const metaKey = `meta_${STORE_NAME}`;
        let meta = await idbGet(metaKey) || { currentSlot: -1, hasSaves: false };

        meta.currentSlot = (meta.currentSlot + 1) % MAX_SLOTS;
        meta.hasSaves = true;

        const stateKey = `state_${STORE_NAME}_slot_${meta.currentSlot}`;
        await idbSet(stateKey, dataToSave);
        await idbSet(metaKey, meta);

        const pictureBlob = await captureCanvasPicture();
        if (pictureBlob) {
            console.log(pictureBlob);
            await idbSet(STORE_NAME, pictureBlob, PICTURE_STORE_NAME);
        }

        console.log(`[Save] Exact snapshot saved to slot ${meta.currentSlot}`);
        const loadBtn = document.getElementById('btnLoad');
        if (loadBtn) loadBtn.disabled = false;

    } catch (e) {
        console.error("Failed to save snapshot:", e);
        alert('Save failed: ' + e.message);
    }
}

async function loadState() {
    if (!isGameActive()) {
        alert('Start a game first');
        return false;
    }

    try {
        const meta = await idbGet(`meta_${STORE_NAME}`);
        if (!meta || !meta.hasSaves) {
            alert('No saved states found.');
            return false;
        }

        const slotToLoad = meta.currentSlot;
        const stateKey = `state_${STORE_NAME}_slot_${slotToLoad}`;
        const savedStateBlob = await idbGet(stateKey);

        if (!(savedStateBlob instanceof Blob)) {
            console.error(`Slot ${slotToLoad} missing or corrupted!`);
            return false;
        }

        const savedStateBuffer = await gzipDecompress(await savedStateBlob.arrayBuffer());
        const jsonString = new TextDecoder().decode(savedStateBuffer);
        const snapshot = JSON.parse(jsonString);

        const simulator = Settings.app.currentLevel;

        if (!simulator || typeof simulator.setSnapshot !== 'function') {
            alert('Cannot load — snapshot support missing in Simulator.');
            return false;
        }

        const success = simulator.setSnapshot(snapshot);

        if (success) {
            console.log(`[Load] Exact snapshot restored from slot ${slotToLoad}`);
            if (typeof simulator.updateScrubberUI === 'function') {
                simulator.updateScrubberUI();
            }
        }
        return !!success;

    } catch (e) {
        console.error("Failed to load snapshot:", e);
        alert('Load failed: ' + e.message);
        return false;
    }
}

module.exports = { loadState, saveState };