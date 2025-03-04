
const { ipcRenderer } = require('electron');
const fs = require('node:fs');
const p = require('node:path');
const { writeFile, mkdir, readdir, stat } = require('node:fs/promises');
const wavefileReader = require('wavefile-reader');
const SunCalc = require('suncalc');
const ffmpeg = require('fluent-ffmpeg');
const png = require('fast-png');
const {utimesSync} = require('utimes');
const {writeToPath} = require('@fast-csv/format');
const merge = require('lodash.merge');
import { State } from './state.js';
import { sqlite3 } from './database.js';
import {trackEvent} from './tracking.js';
import {extractWaveMetadata} from './metadata.js';

const DEBUG = true;

// Function to join Buffers and not use Buffer.concat() which leads to detached ArrayBuffers
function joinBuffers(buffer1, buffer2) {
    // Create a new buffer with the combined length
    const combinedBuffer = Buffer.allocUnsafe(buffer1.length + buffer2.length);
    buffer1.copy(combinedBuffer, 0);
    buffer2.copy(combinedBuffer, buffer1.length);
    return combinedBuffer;
}

// Save console.warn and console.error functions
const originalWarn = console.warn;
const originalError = console.error;

const generateAlert =({message, type, autohide}) => {
    UI.postMessage({event: 'generate-alert', type: type || 'info',  message: message, autohide: autohide});
}
function customURLEncode(str) {
    return encodeURIComponent(str)
      .replace(/[!'()*]/g, (c) => {
        // Replacing additional characters not handled by encodeURIComponent 
        return '%' + c.charCodeAt(0).toString(16).toUpperCase();
      })
      .replace(/%20/g, '+'); // Replace space with '+' instead of '%20'
  }

// Override console.warn to intercept and track warnings
console.warn = function() {
    // Call the original console.warn to maintain default behavior
    originalWarn.apply(console, arguments);
    
    // Track the warning message using your tracking function
    trackEvent(STATE.UUID, 'Worker Warning', arguments[0], customURLEncode(arguments[1]));
};

// Override console.error to intercept and track errors
console.error = function() {
    // Call the original console.error to maintain default behavior
    originalError.apply(console, arguments);
    
    // Track the error message using your tracking function
    trackEvent(STATE.UUID, 'Worker Handled Errors', arguments[0], customURLEncode(arguments[1]));
};
// Implement error handling in the worker
self.onerror = function(message, file, lineno, colno, error) {
    trackEvent(STATE.UUID, 'Unhandled Worker Error', message, customURLEncode(error?.stack));
    if (message.includes('dynamic link library')) generateAlert({type: 'error',  message: 'There has been an error loading the model. This may be due to missing AVX support. Chirpity AI models require the AVX2 instructions set to run. If you have AVX2 enabled and still see this notice, please refer to <a href="https://github.com/Mattk70/Chirpity-Electron/issues/84" target="_blank">this issue</a> on Github.'})
    // Return false not to inhibit the default error handling
    return false;
    };

self.addEventListener('unhandledrejection', function(event) {
    // Extract the error message and stack trace from the event
    const errorMessage = event.reason?.message;
    const stackTrace = event.reason?.stack;
    
    // Track the unhandled promise rejection
    trackEvent(STATE.UUID, 'Unhandled Worker Promise Rejections', errorMessage, customURLEncode(stackTrace));
});

self.addEventListener('rejectionhandled', function(event) {
    // Extract the error message and stack trace from the event
    const errorMessage = event.reason?.message;
    const stackTrace = event.reason?.stack;
    
    // Track the unhandled promise rejection
    trackEvent(STATE.UUID, 'Handled Worker Promise Rejections', errorMessage, customURLEncode(stackTrace));
});

//Object will hold files in the diskDB, and the active timestamp from the most recent selection analysis.
const STATE = new State();


let WINDOW_SIZE = 3;
const SUPPORTED_FILES = ['.wav', '.flac', '.opus', '.m4a', '.mp3', '.mpga', '.ogg', '.aac', '.mpeg', '.mp4', '.mov'];

let NUM_WORKERS, AUDIO_BACKLOG;
let workerInstance = 0;
let appPath, tempPath, BATCH_SIZE, LABELS, batchChunksToSend = {};
let LIST_WORKER;

const DATASET = false;
const adding_chirpity_additions = true;
const dataset_database = DATASET;
const DATASET_SAVE_LOCATION = "E:/DATASETS/BirdNET_wavs";

// Adapted from https://stackoverflow.com/questions/6117814/get-week-of-year-in-javascript-like-in-php
Date.prototype.getWeekNumber = function(){
    var d = new Date(Date.UTC(this.getFullYear(), this.getMonth(), this.getDate()));
    var dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
    return Math.ceil((((d - yearStart) / 86400000) + 1)/7 * (48/52))
};


const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path.replace('app.asar', 'app.asar.unpacked');
//ffmpeg.setFfmpegPath(staticFfmpeg.path.replace('app.asar', 'app.asar.unpacked'));
ffmpeg.setFfmpegPath(ffmpegPath);
let predictionsRequested = {}, predictionsReceived = {}, filesBeingProcessed = [];
let diskDB, memoryDB;

let t0; // Application profiler

const setupFfmpegCommand = ({ 
    file, 
    start = 0, 
    end = undefined, 
    sampleRate = 24000, 
    channels = 1, 
    format = 's16le', //<= outputs audio without header
    additionalFilters = [],
    metadata = {},
    audioCodec = null,
    audioBitrate = null,
    outputOptions = []
}) => {
    const command = ffmpeg('file:' + file)
        .format(format)
        .audioChannels(channels)
        .audioFrequency(sampleRate);

    // Add filters if provided
    additionalFilters.forEach(filter => {
        command.audioFilters(filter);
    });
    if (Object.keys(metadata).length) { 
        metadata = Object.entries(metadata).flatMap(([k, v]) => {
            if (typeof v === 'string') {
                // Escape special characters, including quotes and apostrophes
                v=v.replaceAll(' ', '_');
            };
            return ['-metadata', `${k}=${v}`]
        });
        command.addOutputOptions(metadata)
    } 

    // Set codec if provided
    if (audioCodec) command.audioCodec(audioCodec);

    // Set bitRate if provided
    if (audioBitrate) command.audioBitrate(audioBitrate);

    // Add any additional output options
    if (outputOptions.length) command.addOutputOptions(...outputOptions);

    command.seekInput(start).duration(end - start)
    if (DEBUG){
        command.on('start', function (commandLine) {
            console.log('FFmpeg command: ' + commandLine);
        })
    }
    return command;
};

const getSelectionRange = (file, start, end) => {
    return { start: (start * 1000) + METADATA[file].fileStart, end: (end * 1000) + METADATA[file].fileStart }
}
const createDB = async (file) => {
    const archiveMode = !!file;
    if (file) {
        fs.openSync(file, "w");
        diskDB = new sqlite3.Database(file);
        DEBUG && console.log("Created disk database", diskDB.filename);
    } else {
        memoryDB = new sqlite3.Database(':memory:');
        DEBUG && console.log("Created new in-memory database");
    }
    const db = archiveMode ? diskDB : memoryDB;
    await db.runAsync('BEGIN');
    await db.runAsync('CREATE TABLE species(id INTEGER PRIMARY KEY, sname TEXT NOT NULL, cname TEXT NOT NULL)');
    await db.runAsync(`CREATE TABLE locations( id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon  REAL NOT NULL, place TEXT NOT NULL, UNIQUE (lat, lon))`);
    await db.runAsync(`CREATE TABLE files(id INTEGER PRIMARY KEY, name TEXT NOT NULL, duration REAL, filestart INTEGER, locationID INTEGER, archiveName TEXT, metadata TEXT, UNIQUE (name),
        CONSTRAINT fk_locations FOREIGN KEY (locationID) REFERENCES locations(id) ON DELETE SET NULL)`);
    // Ensure place names are unique too
    await db.runAsync('CREATE UNIQUE INDEX idx_unique_place ON locations(lat, lon)');
    await db.runAsync(`CREATE TABLE records( dateTime INTEGER, position INTEGER, fileID INTEGER, speciesID INTEGER, confidence INTEGER, label  TEXT,  comment  TEXT, end INTEGER, callCount INTEGER, isDaylight INTEGER, 
        UNIQUE (dateTime, fileID, speciesID), CONSTRAINT fk_files FOREIGN KEY (fileID) REFERENCES files(id) ON DELETE CASCADE,  FOREIGN KEY (speciesID) REFERENCES species(id))`);
    await db.runAsync(`CREATE TABLE duration( day INTEGER, duration INTEGER, fileID INTEGER, UNIQUE (day, fileID), CONSTRAINT fk_files FOREIGN KEY (fileID) REFERENCES files(id) ON DELETE CASCADE)`);

    if (archiveMode) {
        for (let i = 0; i < LABELS.length; i++) {
            const [sname, cname] = LABELS[i].replaceAll("'", "''").split('_');
            await db.runAsync('INSERT INTO species VALUES (?,?,?)', i, sname, cname);
        }
    } else {
        const filename = diskDB.filename;
        let { code } = await db.runAsync('ATTACH ? as disk', filename);
        // If the db is not ready
        while (code === "SQLITE_BUSY") {
            console.log("Disk DB busy")
            setTimeout(() => {}, 10);
            let response = await db.runAsync('ATTACH ? as disk', filename);
            code = response.code;
        }
        let response = await db.runAsync('INSERT INTO files SELECT * FROM disk.files');
        DEBUG && console.log(response.changes + ' files added to memory database')
        response = await db.runAsync('INSERT INTO locations SELECT * FROM disk.locations');
        DEBUG && console.log(response.changes + ' locations added to memory database')
        response = await db.runAsync('INSERT INTO species SELECT * FROM disk.species');
        DEBUG && console.log(response.changes + ' species added to memory database')
    }
    await db.runAsync('END');
    return db
}


async function loadDB(path) {
    // We need to get the default labels from the config file
    DEBUG && console.log("Loading db " + path)
    let modelLabels;
    if (STATE.model === 'birdnet'){
        const labelFile = `labels/V2.4/BirdNET_GLOBAL_6K_V2.4_Labels_en.txt`; 
        await fetch(labelFile).then(response => {
            if (! response.ok) throw new Error('Network response was not ok');
            return response.text();
        }).then(filecontents => {
            modelLabels = filecontents.trim().split(/\r?\n/);
        }).catch( (error) =>{
            console.error('There was a problem fetching the label file:', error);
        })
    } else {
        const {labels} =  JSON.parse(fs.readFileSync(p.join(__dirname, `${STATE.model}_model_config.json`), "utf8"));
        modelLabels = labels;
    }
    
    // Add Unknown Sp.
    modelLabels.push("Unknown Sp._Unknown Sp.");
    const num_labels = modelLabels.length;
    LABELS = modelLabels; // these are the default english labels
    const file = dataset_database ? p.join(path, `archive_dataset${num_labels}.sqlite`) : p.join(path, `archive${num_labels}.sqlite`)

    if (!fs.existsSync(file)) {
        await createDB(file);
    } else if (diskDB?.filename !== file) {
        diskDB = new sqlite3.Database(file);
        STATE.update({ db: diskDB });
        await diskDB.runAsync('VACUUM');
        await diskDB.runAsync('PRAGMA foreign_keys = ON');
        const { count } = await diskDB.getAsync('SELECT COUNT(*) as count FROM records')
        if (count) {
            UI.postMessage({ event: 'diskDB-has-records' })
        }
        // Get the labels from the DB. These will be in preferred locale
        DEBUG && console.log("Getting labels from disk db " + path)
        const res = await diskDB.allAsync("SELECT sname || '_' || cname AS labels FROM species ORDER BY id")
        LABELS = res.map(obj => obj.labels); // these are the labels in the preferred locale
        DEBUG && console.log("Opened and cleaned disk db " + file)
    }
    UI.postMessage({event: 'labels', labels: LABELS})
    return true;
}

// Define the list of updates (always add new updates at the end. ORDER IS IMPORTANT!)
const DB_updates = [
    {
        name: 'add_columns_archiveName_and_metadata_and_foreign_key_to_files',
        query: async (db) => {
            try {
                // Disable foreign key checks (or dropping files will drop records too!!!)
                await db.runAsync('PRAGMA foreign_keys = OFF');
                // Update: Adding foreign key to files
                await db.runAsync('BEGIN TRANSACTION;');
                await db.runAsync(`
                    CREATE TABLE files_new (
                        id INTEGER PRIMARY KEY, 
                        name TEXT NOT NULL, 
                        duration REAL,
                        filestart INTEGER, 
                        locationID INTEGER, 
                        archiveName TEXT, 
                        metadata TEXT, 
                        UNIQUE (name),
                        CONSTRAINT fk_locations FOREIGN KEY (locationID) REFERENCES locations(id) ON DELETE SET NULL
                    );
                `);
                await db.runAsync(`
                    INSERT INTO files_new (id, name, duration, filestart, locationID)
                    SELECT id, name, duration, filestart, locationID
                    FROM files;
                `);
                await db.runAsync(`DROP TABLE files;`);
                await db.runAsync(`ALTER TABLE files_new RENAME TO files;`);


                // If we get to here, it's all good: Commit the transaction
                await db.runAsync('COMMIT;');

            } catch (error) {
                // If any error occurs, rollback the transaction
                await db.runAsync('ROLLBACK;');
                throw new Error(`Migration failed: ${error.message}`);
            } finally {
                // Disable foreign key checks
                await db.runAsync('PRAGMA foreign_keys = ON');
            }
        }
    },
];



// Function to check and apply Updates
async function checkAndApplyUpdates(db) {
    // Ensure the system_info table exists
    await db.runAsync(`
        CREATE TABLE IF NOT EXISTS db_upgrade (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `);

    // Get the last Update applied
    let lastUpdate = await db.getAsync(
        `SELECT value FROM db_upgrade WHERE key = 'last_update'`
    );

    if (!lastUpdate) {
        // Insert default if not present for older databases
        lastUpdate = { value: '__' };
        await db.runAsync(`
            INSERT INTO db_upgrade (key, value) VALUES ('last_update', '__')
        `);
    }

    // Apply updates that come after the last update applied
    let updateIndex = DB_updates.findIndex(m => m.name === lastUpdate.value);
    
    // Start from the next Update
    updateIndex = updateIndex >= 0 ? updateIndex + 1 : 0;

    for (let i = updateIndex; i < DB_updates.length; i++) {
        const update = DB_updates[i];
        try {
            console.log(`Applying Update: ${update.name}`);
            await update.query(db);

            // Update the last Update applied
            await db.runAsync(`UPDATE db_upgrade SET value = ? WHERE key = 'last_update'`, update.name);

            console.log(`Update '${update.name}' applied successfully.`);
        } catch (err) {
            console.error(`Error applying Database update '${update.name}':`, err);
            throw err; // Stop the process if an Update fails
        }
    }
}


let METADATA = {};
let index = 0, AUDACITY = {}, predictionStart;
let sampleRate; // Should really make this a property of the model
let predictWorkers = [], aborted = false;
let audioCtx;
// Set up the audio context:
function setAudioContext() {
    audioCtx = new AudioContext({ latencyHint: 'interactive', sampleRate: sampleRate });
}


let UI;
let FILE_QUEUE = [];


const dirInfo = async ({ folder = undefined, recursive = false }) => {
    const files = await readdir(folder, { withFileTypes: true });
    const ctimes = [];
    const paths = files.map(async file => {
        const path = p.join(folder, file.name);
        if (file.isDirectory()) {
            if (recursive) {
                return await dirInfo({ folder: path, recursive: true })
            } else {
                return 0
            }
        }
        if (file.isFile() || file.isSymbolicLink()) {
            const { size, ctimeMs } = await stat(path);
            ctimes.push([path, ctimeMs, size]);
            return size
            
        }
        return 0;
    });
    const pathResults = await Promise.all(paths);
    const flattenedPaths = pathResults.flat(Infinity);
    const size = flattenedPaths.reduce((i, size) => i + size, 0);
    // Newest to oldest file, so we can pop the list (faster)
    ctimes.sort((a, b) => {
        return a[1] - b[1]
    })
    //console.table(ctimes);
    return [size, ctimes];
}

let INITIALISED = null;

async function handleMessage(e) {
    const args = e.data;
    const action = args.action;
    DEBUG && console.log('message received', action)
    if (action !== "_init_" && INITIALISED) {
        // Wait until _init_ or onLaunch completes before processing other messages
        await INITIALISED;
    }
    switch (action) {
        case "_init_": {
            let {model, batchSize, threads, backend, list} = args;
            const t0 = Date.now();
            STATE.detect.backend = backend;
            setGetSummaryQueryInterval(threads)
            INITIALISED = (async () => {
                LIST_WORKER = await spawnListWorker(); // this can change the backend if tfjs-node isn't available
                DEBUG && console.log('List worker took', Date.now() - t0, 'ms to load');
                await onLaunch({model: model, batchSize: batchSize, threads: threads, backend: STATE.detect.backend, list: list});
            })();
            break;
        }
        case "abort": {
            onAbort(args);
            break;
        }
        case "analyse": {
            if (!predictWorkers.length) {
                generateAlert({type: 'warning',  
                    message: `A previous analysis resulted in an out-of-memory error, it is recommended you reduce the batch size from ${BATCH_SIZE}`
                })
                UI.postMessage({event: 'analysis-complete', quiet: true});
                break;
            }
            predictionsReceived = {};
            predictionsRequested = {};
            await onAnalyse(args);
            break;
        }
        case 'change-batch-size': {
            BATCH_SIZE = args.batchSize;
            predictWorkers.forEach(worker => {
                worker.postMessage({message:'change-batch-size', batchSize: BATCH_SIZE})
            })
            break;
        }
        case 'change-threads': {
            const threads = e.data.threads;
            setGetSummaryQueryInterval(threads)
            const delta = threads - predictWorkers.length;
            NUM_WORKERS+=delta;
            if (delta > 0) {
                spawnPredictWorkers(STATE.model, STATE.list, BATCH_SIZE, delta)
            } else {
                for (let i = delta; i < 0; i++) {
                    const worker = predictWorkers.pop();
                    worker.terminate();
                }
            }
            break;
        }
        case "change-mode": {
            await onChangeMode(args.mode);
            break;
        }
        case "chart": {
            await onChartRequest(args);
            break;
        }
        case 'check-all-files-saved': {
            savedFileCheck(args.files);
            break;
        }
        case "convert-dataset": {convertSpecsFromExistingSpecs();
            break;
        }
        case "create-dataset": {
            args.included = await getIncludedIDs()
            saveResults2DataSet(args);
            break;
        }
        case "delete": {await onDelete(args);
            break;
        }
        case "delete-species": {await onDeleteSpecies(args);
            break;
        }
        case "export-results": {await getResults(args);
            break;
        }
        case "file-load-request": {
            index = 0;
            filesBeingProcessed.length && onAbort(args);
            DEBUG && console.log("Worker received audio " + args.file);
            await loadAudioFile(args);
            const mode = METADATA[args.file]?.isSaved ? 'archive' : 'analyse';
            await onChangeMode(mode);
            break;
        }
        case "filter": {
            if (STATE.db) {
                await getResults(args);
                args.updateSummary && await getSummary(args);
                args.included = await getIncludedIDs(args.file);
                const [total, offset, species] = await getTotal(args);
                UI.postMessage({event: 'total-records', total: total, offset: offset, species: species})
            }
            break;
        }
        case "get-detected-species-list": {getDetectedSpecies();
            break;
        }
        case "get-valid-species": {getValidSpecies(args.file);
            break;
        }
        case "get-locations": { getLocations({ db: STATE.db, file: args.file });
        break;
        }
        case "get-valid-files-list": { await getFiles(args.files);
            break;
        }
        case "insert-manual-record": { await onInsertManualRecord(args);
            break;
        }
        case "load-model": {
            if (filesBeingProcessed.length) {
                onAbort(args);
            }
            else {
                predictWorkers.length && terminateWorkers()
            };
            INITIALISED =  onLaunch(args);
            break;
        }
        case "post": {await uploadOpus(args);
            break;
        }
        case "purge-file": {onFileDelete(args.fileName);
            break;
        }
        case "compress-and-organise": { 
            convertAndOrganiseFiles();
            break;
        }
        case "relocated-file": {onFileUpdated(args.originalFile, args.updatedFile);
            break;
        }
        case "save": {DEBUG && console.log("file save requested");
            await saveAudio(args.file, args.start, args.end, args.filename, args.metadata);
            break;
        }
        case "save2db": {await onSave2DiskDB(args);
            break;
        }
        case "set-custom-file-location": {
            onSetCustomLocation(args);
            break;
        }
        case "update-buffer": {await loadAudioFile(args);
            break;
        }
        case "update-file-start": {await onUpdateFileStart(args);
            break;
        }
        case "update-list": {
            STATE.list = args.list;
            STATE.customList = args.list === 'custom' ? args.customList : STATE.customList;
            const {lat, lon, week} = STATE;
            // Clear the LIST_CACHE & STATE.included keys to force list regeneration
            LIST_CACHE = {}; //[`${lat}-${lon}-${week}-${STATE.model}-${STATE.list}`];
            delete STATE.included?.[STATE.model]?.[STATE.list];
            LIST_WORKER && await setIncludedIDs(lat, lon, week )
            args.refreshResults && await Promise.all([getResults(), getSummary()]);
            break;
        }
        case 'update-locale': {
            await onUpdateLocale(args.locale, args.labels, args.refreshResults)
            break;
        }
        case "update-state": {
            appPath = args.path || appPath; tempPath = args.temp || tempPath;
            // If we change the speciesThreshold, we need to invalidate any location caches
            if (args.speciesThreshold) {
                if (STATE.included?.['birdnet']?.['location'])  STATE.included.birdnet.location = {};
                if (STATE.included?.['chirpity']?.['location'])  STATE.included.chirpity.location = {};
            }
            // likewise, if we change the "use local birds" setting we need to flush the migrants cache"
            if (args.local !== undefined){
                if (STATE.included?.['birdnet']?.['nocturnal'])  delete STATE.included.birdnet.nocturnal;
            }
            STATE.update(args);
            break;
        }
        default: {UI.postMessage("Worker communication lines open");
        }
    }
}

ipcRenderer.on('new-client', async (event) => {
    [UI] = event.ports;
    UI.onmessage = handleMessage
})

function savedFileCheck(fileList) {
    if (diskDB){
        // Construct a parameterized query to count the matching files in the database
        const query = `SELECT COUNT(*) AS count FROM files WHERE name IN (${prepParams(fileList)})`;

        // Execute the query with the file list as parameters
        diskDB.get(query, fileList, (err, row) => {
            if (err) {
                console.error('Error querying database during savedFileCheck:', err);
            } else {
                const count = row.count;
                const result = count === fileList.length;
                UI.postMessage({event: 'all-files-saved-check-result', result: result});
            }
        });
    } else {
        generateAlert({type: 'error',  message: 'The database has not finished loading. The saved file check was skipped'})
        return undefined
    }
}

function setGetSummaryQueryInterval(threads){
    STATE.incrementor = STATE.detect.backend !== 'tensorflow' ? threads * 10 : threads;
}

async function onChangeMode(mode) {
    memoryDB || await createDB();
    UI.postMessage({ event: 'mode-changed', mode: mode })
    STATE.changeMode({
        mode: mode,
        disk: diskDB,
        memory: memoryDB
    });
}

const filtersApplied = (list) => list?.length && list.length < LABELS.length -1;

/**
* onLaunch called when Application is first opened or when model changed
*/

async function onLaunch({model = 'chirpity', batchSize = 32, threads = 1, backend = 'tensorflow', list = 'everything'}){
    SEEN_MODEL_READY = false;
    LIST_CACHE = {}
    sampleRate = model === "birdnet" ? 48_000 : 24_000;
    setAudioContext(sampleRate);
    UI.postMessage({event:'ready-for-tour'});
    STATE.detect.backend = backend;
    BATCH_SIZE = batchSize;
    STATE.update({ model: model });
    await loadDB(appPath); // load the diskdb
    await checkAndApplyUpdates(diskDB);
    await createDB(); // now make the memoryDB
    STATE.update({ db: memoryDB })
    NUM_WORKERS = threads;
    spawnPredictWorkers(model, list, batchSize, NUM_WORKERS);
}


async function spawnListWorker() {
    const worker_1 = await new Promise((resolve, reject) => {
        const worker = new Worker('./js/listWorker.js', { type: 'module' });
        worker.onmessage = function (event) {
            // Resolve the promise once the worker sends a message indicating it's ready
            const message = event.data.message;
            
            if (message === 'list-model-ready') {
                return resolve(worker);
            } else if (message === "tfjs-node") {
                event.data.available || (STATE.detect.backend = 'webgpu');
                UI.postMessage({event: 'tfjs-node', hasNode: event.data.available})
            }
        };

        worker.onerror = function (error) {
            reject(error);
        };

        // Start the worker
        worker.postMessage('start');
    })
    return function listWorker(message_1) {
        return new Promise((resolve_1, reject_1) => {
            worker_1.onmessage = function (event_1) {
                const { result, messages } = event_1.data;
                resolve_1({ result, messages });
            };

            worker_1.onerror = function (error_1) {
                reject_1(error_1);
            };

            DEBUG && console.log('getting a list from the list worker');
            worker_1.postMessage(message_1);
        });
    };
}


/**
* Generates a list of supported audio files, recursively searching directories.
* Sends this list to the UI
* @param {*} files must be a list of file paths
*/
const getFiles = async (files, image) => {
    let file_list = [], folderDropped = false;
    for (let i = 0; i < files.length; i++) {
        const path = files[i];
        const stats = fs.lstatSync(path)
        if (stats.isDirectory()) {
            folderDropped = true
            const dirFiles = await getFilesInDirectory(path)
            file_list = [...file_list,...dirFiles]
        } else {
            const filename = p.basename(path)
            filename.startsWith('.') || file_list.push(path) // Exclude hidden files (in subfolders)
        }
    }
    // filter out unsupported files
    const supported_files = image ? ['.png'] : SUPPORTED_FILES;
    
    file_list = file_list.filter((file) => {
        return supported_files.some(ext => file.toLowerCase().endsWith(ext))
    }
    )
    const fileOrFolder = folderDropped ? 'Open Folder(s)' : 'Open Files(s)'
    trackEvent(STATE.UUID, 'UI', 'Drop', fileOrFolder, file_list.length);
    UI.postMessage({ event: 'files', filePaths: file_list });
    return file_list;
}


const getFilesInDirectory = async (dir) => {
    const files = [];
    const stack = [dir];
    
    while (stack.length) {
        const currentDir = stack.pop();
        const dirents = await readdir(currentDir, { withFileTypes: true });
        for (const dirent of dirents) {
            const path = p.join(currentDir, dirent.name);
            if (dirent.isDirectory()) {
                stack.push(path);
            } else {
                const filename = p.basename(path)
                filename.startsWith('._') || files.push(path)
            }
        }
    }
    
    return files;
};

const prepParams = (list) => list.map(_ => '?').join(',');
function getFileSQLAndParams(range){
    const fileParams = prepParams(STATE.filesToAnalyse)
    const params = [];
    let SQL = '';
    if (range?.start) { // Prioritise range queries
        SQL += ' AND dateTime BETWEEN ? AND ? ';
        params.push(range.start, range.end);
    } else if (['analyse'].includes(STATE.mode)) {
        SQL += ` AND name IN  (${fileParams}) `;
        params.push(...STATE.filesToAnalyse);
    } else if (['archive'].includes(STATE.mode)) {
        SQL += ` AND ( name IN  (${fileParams}) `;
        params.push(...STATE.filesToAnalyse);
        SQL += ` OR archiveName IN  (${fileParams}) ) `;
        const archivePath = STATE.archive.location + p.sep;
        const archive_names = STATE.filesToAnalyse.map(item => item.replace(archivePath, ''))
        params.push(...archive_names);
    }
    return [SQL, params]
}

const prepSummaryStatement = (included) => {
    const range = STATE.mode === 'explore' ? STATE.explore.range : undefined;
    const params = [STATE.detect.confidence];
    let summaryStatement = `
    WITH ranked_records AS (
        SELECT records.dateTime, records.confidence, files.name, files.archiveName, cname, sname, COALESCE(callCount, 1) as callCount, speciesID, isDaylight,
        RANK() OVER (PARTITION BY fileID, dateTime ORDER BY records.confidence DESC) AS rank
        FROM records
        JOIN files ON files.id = records.fileID
        JOIN species ON species.id = records.speciesID
        WHERE confidence >=  ? `;

    const [SQLtext, fileParams] = getFileSQLAndParams(range);
    summaryStatement += SQLtext, params.push(...fileParams);

    if (filtersApplied(included)) {
        const includedParams = prepParams(included);
        summaryStatement += ` AND speciesID IN (${includedParams}) `;
        params.push(...included);
    }
    if (STATE.detect.nocmig){
        summaryStatement += ' AND COALESCE(isDaylight, 0) != 1 ';
    }
    
    if (STATE.locationID) {
        summaryStatement += ' AND locationID = ? ';
        params.push(STATE.locationID);
    }
    summaryStatement += `
    )
    SELECT speciesID, cname, sname, COUNT(cname) as count, SUM(callcount) as calls, ROUND(MAX(ranked_records.confidence) / 10.0, 0) as max
    FROM ranked_records
    WHERE ranked_records.rank <= ${STATE.topRankin}`;
    
    summaryStatement +=  ` GROUP BY speciesID  ORDER BY cname`;

    return [summaryStatement, params]
}
    

const getTotal = async ({species = undefined, offset = undefined, included = [], file = undefined}= {}) => {
    let params = [];
    const range = STATE.mode === 'explore' ? STATE.explore.range : undefined;
    offset = offset ?? (species !== undefined ? STATE.filteredOffset[species] : STATE.globalOffset);
    let SQL = ` WITH MaxConfidencePerDateTime AS (
        SELECT confidence,
        speciesID,
        RANK() OVER (PARTITION BY fileID, dateTime ORDER BY records.confidence DESC) AS rank
        FROM records 
        JOIN files ON records.fileID = files.id 
        WHERE confidence >= ${STATE.detect.confidence} `;
    if (file) {
        params.push(file)
        SQL += ' AND files.name = ? '
    }
    else if (filtersApplied(included)) SQL += ` AND speciesID IN (${included}) `;
    if (STATE.detect.nocmig) SQL += ' AND COALESCE(isDaylight, 0) != 1 ';
    if (STATE.locationID) SQL += ` AND locationID =  ${STATE.locationID}`;
    const [SQLtext, fileParams] = getFileSQLAndParams(range);
    SQL += SQLtext, params.push(...fileParams);
    SQL += ' ) '
    SQL += `SELECT COUNT(confidence) AS total FROM MaxConfidencePerDateTime WHERE rank <= ${STATE.topRankin}`;
    
    if (species) {
        params.push(species);
        SQL += ' AND speciesID = (SELECT id from species WHERE cname = ?) '; 
    }
    const {total} = await STATE.db.getAsync(SQL, ...params)
    return [total, offset, species]
}

const prepResultsStatement = (species, noLimit, included, offset, topRankin) => {
    const params = [STATE.detect.confidence];
    let resultStatement = `
    WITH ranked_records AS (
        SELECT 
        records.dateTime, 
        files.duration, 
        files.filestart, 
        fileID,
        files.name,
        files.archiveName,
        files.locationID,
        records.position, 
        records.speciesID,
        species.sname, 
        species.cname, 
        records.confidence as score, 
        records.label, 
        records.comment, 
        records.end,
        records.callCount,
        records.isDaylight,
        RANK() OVER (PARTITION BY fileID, dateTime ORDER BY records.confidence DESC) AS rank
        FROM records 
        JOIN species ON records.speciesID = species.id 
        JOIN files ON records.fileID = files.id 
        WHERE confidence >= ? 
        `;
    // // Prioritise selection ranges
    const range = STATE.selection?.start ? STATE.selection :
        STATE.mode === 'explore' ? STATE.explore.range : false;
    
    // If you're using the memory db, you're either analysing one,  or all of the files
    const [SQLtext, fileParams] = getFileSQLAndParams(range);
    resultStatement += SQLtext, params.push(...fileParams);

    if (filtersApplied(included)) {
        resultStatement += ` AND speciesID IN (${prepParams(included)}) `;
        params.push(...included);
    }
    if (STATE.selection) {
        resultStatement += ` AND name = ? `;
        params.push(FILE_QUEUE[0])
    }
    if (STATE.locationID) {
        resultStatement += ` AND locationID = ? `;
        params.push(STATE.locationID)
    }
    if (STATE.detect.nocmig){
        resultStatement += ' AND COALESCE(isDaylight, 0) != 1 '; // Backward compatibility for < v0.9.
    }
    
    resultStatement += ` )
    SELECT 
    dateTime as timestamp, 
    score,
    duration, 
    filestart, 
    name as file, 
    archiveName,
    fileID,
    position, 
    speciesID,
    sname, 
    cname, 
    score, 
    label, 
    comment,
    end,
    callCount,
    isDaylight,
    rank
    FROM 
    ranked_records 
    WHERE rank <= ? `;
    params.push(topRankin);
    if (species){
        resultStatement+=  ` AND  cname = ? `;
        params.push(species);
    }
    const limitClause = noLimit ? '' : 'LIMIT ?  OFFSET ?';
    noLimit || params.push(STATE.limit, offset);

    resultStatement += ` ORDER BY ${STATE.sortOrder}, callCount DESC ${limitClause} `;
    
    return [resultStatement, params];
}


// Not an arrow function. Async function has access to arguments - so we can pass them to processnextfile
async function onAnalyse({
    filesInScope = [],
    start = 0,
    end = undefined,
    reanalyse = false,
    circleClicked = false
}) {
    // Now we've asked for a new analysis, clear the aborted flag
    aborted = false; //STATE.incrementor = 1;
    predictionStart = new Date();
    // Set the appropriate selection range if this is a selection analysis
    STATE.update({ selection: end ? getSelectionRange(filesInScope[0], start, end) : undefined });
    
    DEBUG && console.log(`Worker received message: ${filesInScope}, ${STATE.detect.confidence}, start: ${start}, end: ${end}`);
    //Reset GLOBAL variables
    index = 0;
    AUDACITY = {};
    batchChunksToSend = {};
    FILE_QUEUE = filesInScope;
    AUDIO_BACKLOG = 0;
    STATE.processingPaused = false;
    
    
    if (!STATE.selection) {
        // Clear records from the memory db
        await memoryDB.runAsync('DELETE FROM records; VACUUM');
        //create a copy of files in scope for state, as filesInScope is spliced
        STATE.setFiles([...filesInScope]);
    }
    
    let count = 0;
    if (DATASET  && !STATE.selection && !reanalyse) {
        for (let i = FILE_QUEUE.length - 1; i >= 0; i--) {
            let file = FILE_QUEUE[i];
            //STATE.db = diskDB;
            const result = await diskDB.getAsync('SELECT name FROM files WHERE name = ?', file);
            if (result && result.name !== FILE_QUEUE[0]) {
                DEBUG && console.log(`Skipping ${file}, already analysed`)
                FILE_QUEUE.splice(i, 1)
                count++
                continue;
            }
            DEBUG && console.log(`Adding ${file} to the queue.`)
        }
    }
    else {
        // check if results for the files are cached 
        // we only consider it cached if all files have been saved to the disk DB)
        // BECAUSE we want to change state.db to disk if they are
        let allCached = true;
        for (let i = 0; i < FILE_QUEUE.length; i++) {
            const file = FILE_QUEUE[i];
            const row = await getSavedFileInfo(file)
            if (row) {
                await setMetadata({file: file})
            } else {
                allCached = false;
                break;
            } 
        }
        const retrieveFromDatabase = ((allCached && !reanalyse && !STATE.selection) || circleClicked);
        if (retrieveFromDatabase) {
            filesBeingProcessed = [];
            if (circleClicked) {
                // handle circle here
                await getResults({ topRankin: 5 });
            } else {
                await onChangeMode('archive');
                FILE_QUEUE.forEach(file => UI.postMessage({ event: 'update-audio-duration', value: METADATA[file].duration }));
                // Weirdness with promise all - list worker called 2x and no results returned
                //await Promise.all([getResults(), getSummary()] );
                await getResults();
                await getSummary();
            }
            return;
        }
        
    }
    DEBUG && console.log("FILE_QUEUE has", FILE_QUEUE.length, 'files', count, 'files ignored')
    STATE.selection || onChangeMode('analyse');
    
    filesBeingProcessed = [...FILE_QUEUE];
    for (let i=0;i<NUM_WORKERS;i++){
        processNextFile({ start: start, end: end, worker: i });
    }
}

function onAbort({
    model = STATE.model,
    list = STATE.list,
}) {
    aborted = true;
    FILE_QUEUE = [];
    predictQueue = [];
    filesBeingProcessed = [];
    predictionsReceived = {};
    predictionsRequested = {};
    index = 0;
    DEBUG && console.log("abort received")
    //restart the workers
    terminateWorkers();
    setTimeout(() => spawnPredictWorkers(model, list, BATCH_SIZE, NUM_WORKERS), 20);

}

const getDuration = async (src) => {
    let audio;
    return new Promise(function (resolve, reject) {
        audio = new Audio();
        audio.src = src.replaceAll('#', '%23').replaceAll('?', '%3F'); // allow hash and ? in the path (https://github.com/Mattk70/Chirpity-Electron/issues/98)
        audio.addEventListener("loadedmetadata", function () {
            const duration = audio.duration;
            audio = undefined;
            // Tidy up - cloning removes event listeners
            const old_element = document.getElementById("audio");
            const new_element = old_element.cloneNode(true);
            old_element.parentNode.replaceChild(new_element, old_element);
            
            resolve(duration);
        });
        audio.addEventListener('error', (error) => {
            generateAlert({type: 'error',  message: 'Unable to extract essential metadata from ' + src})
            reject(error, src)
        })
    });
}


/**
* getWorkingFile's purpose is to locate a file and set its metadata. 
* @param file: full path to source file
* @returns {Promise<boolean|*>}
*/
async function getWorkingFile(file) {
    // find the file
    const source_file = fs.existsSync(file) ? file : await locateFile(file);
    if (!source_file) return false;
    const metadata = await setMetadata({ file: file, source_file: source_file });
    if (!metadata) return false
    METADATA[source_file] = METADATA[file];
    return source_file;
}

/**
 * Function to locate a file either in the archive, or with the same basename but different extension from SUPPORTED_FILES
 * @param {string} file - Full path to a file that doesn't exist
 * @returns {string | null} - Full path to the located file or null if not found
 */
async function locateFile(file) {

    // Check if the file has been archived
    const row = await diskDB.getAsync('SELECT archiveName from files WHERE name = ?', file);
    if (row?.archiveName){
        const fullPathToFile = p.join(STATE.archive.location, row.archiveName)
        if (fs.existsSync(fullPathToFile)) {
            return fullPathToFile;
        }
    }
    // Not there, search the directory
    const dir = p.dirname(file); // Get directory of the provided file
    const baseName = p.basename(file, p.extname(file)); // Get the base name without extension

    // Read all files in the directory
    try {
        const files = fs.readdirSync(dir);

        // Search for a file with the same base name
        for (const currentFile of files) {
            const currentBaseName = p.basename(currentFile, p.extname(currentFile));
            
            // Check if the base name matches before comparing the extension
            if (currentBaseName === baseName) {
                const currentExt = p.extname(currentFile);

                if (SUPPORTED_FILES.includes(currentExt)) {
                    return p.join(dir, currentFile); // Return the full path of the found file
                }
            }
        }
    } catch (error) {
        if (error.message.includes('scandir')){
            const match = error.message.match(/'([^']+)'/);
            UI.postMessage({
                event: 'generate-alert', type: 'warning', 
                message: `Unable to locate folder "${match}". Perhaps the disk was removed?`
            })
        }
        console.warn(error.message + ' - Disk removed?'); // Expected that this happens when the directory doesn't exist
    } 
    return null;
}

async function notifyMissingFile(file) {
    let missingFile;
    // Look for the file in te Archive
    const row = await diskDB.getAsync('SELECT * FROM FILES WHERE name = ?', file);
    if (row?.id) missingFile = file
    UI.postMessage({
        event: 'generate-alert', type: 'warning', 
        message: `Unable to locate source file with any supported file extension: ${file}`,
        file: missingFile
    })
}

async function loadAudioFile({
    file = '',
    start = 0,
    end = 20,
    position = 0,
    region = false,
    preserveResults = false,
    play = false,
    queued = false,
    goToRegion = true
}) {

    if (file) {
        await fetchAudioBuffer({ file, start, end })
        .then((buffer) => {
            let audioArray = buffer.getChannelData(0);
            UI.postMessage({
                event: 'worker-loaded-audio',
                location: METADATA[file].locationID,
                start: METADATA[file].fileStart,
                sourceDuration: METADATA[file].duration,
                bufferBegin: start,
                file: file,
                position: position,
                contents: audioArray,
                fileRegion: region,
                preserveResults: preserveResults,
                play: play,
                queued: queued,
                goToRegion,
                metadata: METADATA[file].metadata
            }, [audioArray.buffer]);
        })
        .catch( (error) => {
            console.log(error);
            // notify and return null if no matching file was found
            generateAlert({type: 'error',  message: error.message});
            error.code === 'ENOENT' && notifyMissingFile(file)
        })
        let week;
        if (STATE.list === 'location'){
            week = STATE.useWeek ? new Date(METADATA[file].fileStart).getWeekNumber() : -1
            // Send the week number of the surrent file
            UI.postMessage({event: 'current-file-week', week: week})
        } else { UI.postMessage({event: 'current-file-week', week: undefined}) }
    }
}


function addDays(date, days) {
    let result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}



/**
* Called by getWorkingFile, setCustomLocation
* Assigns file metadata to a metadata cache object. file is the key, and is the source file
* @param file: the file name passed to the worker
* @param source_file: the file that exists ( will be different after compression)
* @returns {Promise<unknown>}
*/
const setMetadata = async ({ file, source_file = file }) => {
    METADATA[file] ??= {};
    if (METADATA[file].isComplete) return METADATA[file];

    // CHeck the database first, so we honour any manual updates.
    const savedMeta = await getSavedFileInfo(file).catch(error => console.warn('getSavedFileInfo error', error));
    if (savedMeta) {
        METADATA[file] = savedMeta;
        METADATA[file].isSaved = true; // Queried by UI to establish saved state of file.
    }

    let guanoTimestamp;    
    // savedMeta may just have a locationID if it was set by onSetCUstomLocation
    if (! savedMeta?.duration) {
        try {
            METADATA[file].duration = await getDuration(file)
        } catch (e) {
            throw new Error('Unable to determine file duration ', e);
        }
        if (file.toLowerCase().endsWith('wav')){
            const t0 = Date.now();
            const wavMetadata = await extractWaveMetadata(file)//.catch(error => console.warn("Error extracting GUANO", error));
            if (Object.keys(wavMetadata).includes('guano')){
                const guano = wavMetadata.guano;
                const location = guano['Loc Position'];
                if (location){
                    const [lat, lon] = location.split(' ');
                    const roundedFloat = (string) => Math.round(parseFloat(string) * 10000) / 10000;
                    await onSetCustomLocation({ lat: roundedFloat(lat), lon: roundedFloat(lon), place: location, files: [file] }) 
                }
                guanoTimestamp = Date.parse(guano.Timestamp);
                METADATA[file].fileStart = guanoTimestamp;
            }
            if (Object.keys(wavMetadata).length > 0){
                METADATA[file].metadata = JSON.stringify(wavMetadata);
            }
            DEBUG && console.log(`GUANO search took: ${(Date.now() - t0)/1000} seconds`);
        }
    }
    let fileStart, fileEnd;
    // Prepare to set dateDurations
    if (savedMeta?.fileStart) { 
        // Saved timestamps have the highest priority allowing for an override of Guano timestamp/file mtime
        fileStart = new Date(savedMeta.fileStart);
        fileEnd = new Date(fileStart.getTime() + (METADATA[file].duration * 1000));
    } else if (guanoTimestamp) { // Guano has second priority
        fileStart = new Date(guanoTimestamp);
        fileEnd = new Date(guanoTimestamp + (METADATA[file].duration * 1000));
    } else { // Least preferred
        const stat = fs.statSync(source_file);
        fileEnd = new Date(stat.mtime);
        fileStart = new Date(stat.mtime - (METADATA[file].duration * 1000));
    }
    
    // split  the duration of this file across any dates it spans
    METADATA[file].dateDuration = {};
    const key = new Date(fileStart);
    key.setHours(0, 0, 0, 0);
    const keyCopy = addDays(key, 0).getTime();
    if (fileStart.getDate() === fileEnd.getDate()) {
        METADATA[file].dateDuration[keyCopy] = METADATA[file].duration;
    } else {
        const key2 = addDays(key, 1);
        const key2Copy = addDays(key2, 0).getTime();
        METADATA[file].dateDuration[keyCopy] = (key2Copy - fileStart) / 1000;
        METADATA[file].dateDuration[key2Copy] = METADATA[file].duration - METADATA[file].dateDuration[keyCopy];
    }
    // If we haven't set METADATA.file.fileStart by now we need to create it from a Date
    METADATA[file].fileStart ??= fileStart.getTime();
    // Set complete flag
    METADATA[file].isComplete = true;
    return METADATA[file];
}

function setupCtx(audio, rate, destination, file) {
    rate ??= sampleRate;
    // Deal with detached arraybuffer issue
    const useFilters = (STATE.filters.sendToModel && STATE.filters.active) || destination === 'UI';
    return audioCtx.decodeAudioData(audio.buffer)
    .then( audioBuffer => {
        const audioCtxSource = audioCtx.createBufferSource();
        audioCtxSource.buffer = audioBuffer;
        audioBuffer = null; //  release memory
        const duration = audioCtxSource.buffer.duration;
        const buffer = audioCtxSource.buffer;

        const offlineCtx = new OfflineAudioContext(1, rate * duration, rate);
        const offlineSource = offlineCtx.createBufferSource();
        offlineSource.buffer = buffer;
        let previousFilter = undefined;
        if (useFilters){
            if (STATE.filters.active) {
                if (STATE.filters.highPassFrequency) {
                    // Create a highpass filter to cut low-frequency noise
                    const highpassFilter = offlineCtx.createBiquadFilter();
                    highpassFilter.type = "highpass"; // Standard second-order resonant highpass filter with 12dB/octave rolloff. Frequencies below the cutoff are attenuated; frequencies above it pass through.
                    highpassFilter.frequency.value = STATE.filters.highPassFrequency; //frequency || 0; // This sets the cutoff frequency. 0 is off. 
                    highpassFilter.Q.value = 0; // Indicates how peaked the frequency is around the cutoff. The greater the value, the greater the peak.
                    offlineSource.connect(highpassFilter);
                    previousFilter = highpassFilter;
                }
                if (STATE.filters.lowShelfFrequency && STATE.filters.lowShelfAttenuation) {
                    // Create a lowshelf filter to attenuate low-frequency noise
                    const lowshelfFilter = offlineCtx.createBiquadFilter();
                    lowshelfFilter.type = 'lowshelf';
                    lowshelfFilter.frequency.value = STATE.filters.lowShelfFrequency; // This sets the cutoff frequency of the lowshelf filter to 1000 Hz
                    lowshelfFilter.gain.value = STATE.filters.lowShelfAttenuation; // This sets the boost or attenuation in decibels (dB)
                    previousFilter ? previousFilter.connect(lowshelfFilter) : offlineSource.connect(lowshelfFilter);
                    previousFilter = lowshelfFilter;
                }
            }      
        }
        if (STATE.audio.gain){
            var gainNode = offlineCtx.createGain();
            gainNode.gain.value = Math.pow(10, STATE.audio.gain / 20);
            previousFilter ? previousFilter.connect(gainNode) : offlineSource.connect(gainNode);
            gainNode.connect(offlineCtx.destination);
        } else {
            previousFilter ? previousFilter.connect(offlineCtx.destination) : offlineSource.connect(offlineCtx.destination);
        }
        offlineSource.start();
        return offlineCtx;
    })
    .catch(error => aborted || console.warn(error, file));    
};

function checkBacklog(ffmpegCommand = null) {
    return new Promise((resolve) => {
        let firstRun = true, hysteresis_factor = 2;
        DEBUG && console.time('checking backlog');

        if (!aborted && AUDIO_BACKLOG < NUM_WORKERS * hysteresis_factor && !STATE.processingPaused) {
            DEBUG && console.timeEnd('checking backlog');
            resolve(true);
            return;
        }

        const interval = setInterval(() => {
            const backlog = AUDIO_BACKLOG;

            if (aborted) {
                clearInterval(interval);
                resolve(false);
                return;
            }

            if (firstRun) {
                DEBUG && console.log('backlog (initial):', backlog);
                firstRun = false; // Ensure this logs only on the first call
            }

            if (backlog >= NUM_WORKERS * hysteresis_factor) {
                if (ffmpegCommand) {
                    STATE.processingPaused || (ffmpegCommand && ffmpegCommand.kill('SIGSTOP'));
                }
                firstRun && console.log('stop signal sent, backlog: ', backlog);
                STATE.processingPaused = true;

            } else if (backlog <= NUM_WORKERS) {
                DEBUG && console.log('backlog (final):', backlog);
                if (STATE.processingPaused) {
                    if (ffmpegCommand) {
                        ffmpegCommand.kill('SIGCONT');
                    }
                    console.log('resume signal sent, backlog: ', backlog);
                    STATE.processingPaused = false;
                }

                clearInterval(interval); // Backlog is within limits, stop checking
                DEBUG && console.timeEnd('checking backlog');
                resolve(true); // Resolve the promise
            }
        }, 20);
    });
}



/**
*
* @param file
* @param start
* @param end
* @returns {Promise<void>}
*/

let predictQueue = [];

const getWavePredictBuffers = async ({
    file = '', start = 0, end = undefined
}) => {
    if (! fs.existsSync(file)) {
        const found = await getWorkingFile(file);
        if (!found) return
        return await getPredictBuffers({file, start, end})
    }
    // Ensure max and min are within range
    start = Math.max(0, start);
    end = Math.min(METADATA[file].duration, end);
    if (start > METADATA[file].duration) {
        return
    }
    let meta = {};
    batchChunksToSend[file] = Math.ceil((end - start) / (BATCH_SIZE * WINDOW_SIZE));
    predictionsReceived[file] = 0;
    predictionsRequested[file] = 0;
    let readStream;
    // extract the header. With bext and iXML metadata, this can be up to 128k, hence 131072
    const headerStream = fs.createReadStream(file, {start: 0, end: 524288, highWaterMark: 524288});
    headerStream.on('readable',  () => {
        let chunk = headerStream.read();
        let wav = new wavefileReader.WaveFileReader();
        try {
            wav.fromBuffer(chunk);
        } catch (e) {
            generateAlert({type: 'error',  message: `Cannot parse ${file}, it has an invalid wav header.`});
            console.warn('GetWavePredictBuffers failed: ', e)
            headerStream.close();
            updateFilesBeingProcessed(file);
            return;
        }
        let headerEnd;
        wav.signature.subChunks.forEach(el => {
            if (el['chunkId'] === 'data') {
                headerEnd = el.chunkData.start;
            }
        });
        meta.header = chunk.subarray(0, headerEnd);
        const byteRate = wav.fmt.byteRate;
        const sample_rate = wav.fmt.sampleRate;
        meta.byteStart = Math.round((start * byteRate) / sample_rate) * sample_rate + headerEnd;
        meta.byteEnd = Math.round((end * byteRate) / sample_rate) * sample_rate + headerEnd;
        meta.highWaterMark = byteRate * BATCH_SIZE * WINDOW_SIZE;
        headerStream.destroy();
        DEBUG && console.log('Header extracted for ', file);


        readStream = fs.createReadStream(file, {
            start: meta.byteStart, end: meta.byteEnd, highWaterMark: meta.highWaterMark
        });

    
        let chunkStart = start * sampleRate;
        // Changed on.('data') handler because of:  https://stackoverflow.com/questions/32978094/nodejs-streams-and-premature-end
        readStream.on('readable', async () => {
            if (aborted) {
                readStream.destroy();
                return
            }
            const notAborted = await checkBacklog();
            if (notAborted){
                const chunk = readStream.read();
                if (chunk === null || chunk.byteLength <= 1 ) {
                    // EOF
                    chunk?.byteLength && predictionsReceived[file]++;
                    readStream.destroy();
                } else {
                    const audio = joinBuffers(meta.header, chunk);
                    predictQueue.push([audio, file, end, chunkStart]);
                    chunkStart += WINDOW_SIZE * BATCH_SIZE * sampleRate;
                    processPredictQueue();
                }
            } else {
                readStream.destroy();
            }
        })
        readStream.on('error', err => {
            console.log(`readstream error: ${err}, start: ${start}, , end: ${end}, duration: ${METADATA[file].duration}`);
            err.code === 'ENOENT' && notifyMissingFile(file);
        })
    })    
}

function processPredictQueue(audio, file, end, chunkStart){

    if (! audio) [audio, file, end, chunkStart]  = predictQueue.shift(); // Dequeue chunk
    if (audio.length === 0) {
        console.error('Shifted zero length audio from predict queue');
        return
    } 
    predictionsRequested[file]++; // do this before any async stuff
    setupCtx(audio, undefined, 'model', file).then(offlineCtx => {
        let worker;
        if (offlineCtx) {
            offlineCtx.startRendering().then((resampled) => {
                const myArray = resampled.getChannelData(0);
                feedChunksToModel(myArray, chunkStart, file, end, worker);
                AUDIO_BACKLOG++;
                return
            }).catch((error) => {
                predictionsRequested[file]--; // Didn't request a prediction after all
                aborted || console.error(`PredictBuffer rendering failed: ${error}, file ${file}`);
                updateFilesBeingProcessed(file);
                return
            });
        } else {
            if (audio.length === 0){
                if (!aborted){
                    // If the audio length is 0 now, we must have run out of memory
                    terminateWorkers();
                    // Hard quit
                    UI.postMessage({event: 'analysis-complete', quiet: true})
                    console.error(`Out of memory. Batch size was (${BATCH_SIZE}) threads: ${predictWorkers.length}`);
                        aborted = true;
                        const message = `
                            <p class="text-danger h6">System memory exhausted, the operation has been terminated. </p>
                            <p>
                            <b>Tip:</b> Close any unnecessary open applications. If that is not effective, reduce the number of Threads ${BATCH_SIZE > 4 ? 'or lower the batch size' : ''} in the system settings'}.<p>`;
                    generateAlert({type: 'error',  message: message, autohide: false})
                return
            }
        }
        console.log('Short chunk', audio.length, 'padding');
        let chunkLength = STATE.model === 'birdnet' ? 144_000 : 72_000;
        const myArray = new Float32Array(Array.from({ length: chunkLength }).fill(0));
        feedChunksToModel(myArray, chunkStart, file, end);
        AUDIO_BACKLOG++;
    }}).catch(error => { 
        aborted || console.warn(file, error) ;
        predictionsRequested[file]--; // Didn't request a prediction after all
    })
}

const getPredictBuffers = async ({
    file = '', start = 0, end = undefined
}) => {
    if (! fs.existsSync(file)) { 
        const found = await getWorkingFile(file);
        if (!found) return
    }
    // Ensure max and min are within range
    start = Math.max(0, start);
    end = Math.min(METADATA[file].duration, end);
    if (start > METADATA[file].duration) {
        return
    }

    const MINIMUM_AUDIO_LENGTH = 0.05; // below this value doesn't generate another chunk
    batchChunksToSend[file] = Math.ceil((end - start - MINIMUM_AUDIO_LENGTH) / (BATCH_SIZE * WINDOW_SIZE));
    predictionsReceived[file] = 0;
    predictionsRequested[file] = 0;
    
    const samplesInBatch = sampleRate * BATCH_SIZE * WINDOW_SIZE
    const highWaterMark =  samplesInBatch * 2;
    
    let chunkStart = start * sampleRate;


    await processAudio(file, start, end, chunkStart, highWaterMark, samplesInBatch)

}

function lookForHeader(buffer){
    //if (buffer.length < 4096) return undefined
    try {
        const wav = new wavefileReader.WaveFileReader();
        wav.fromBuffer(buffer);
        let headerEnd;
        wav.signature.subChunks.forEach(el => {
            if (el['chunkId'] === 'data') {
                headerEnd = el.chunkData.start;
            }
        });
        return buffer.subarray(0, headerEnd);
    } catch (e) {
        DEBUG && console.log(e)
        return undefined
    }
}

function processAudio (file, start, end, chunkStart, highWaterMark, samplesInBatch){
    let header, shortFile = true;
    return new Promise((resolve, reject) => {
        let concatenatedBuffer = Buffer.alloc(0);
        const command = setupFfmpegCommand({file, start, end, sampleRate})
        command.on('error', (error) => {
            if (error.message === 'Output stream closed'){
                console.warn(`processAudio: ${file} ${error}`);
            } else {
                if (error.message.includes('SIGKILL')) console.log('FFMPEG process shut down at user request')
                reject(error)
            }
        });
        command.on('progress', (progress) => {
            DEBUG && console.log('progress: ', progress.timemark)
            checkBacklog(command)
        })
        command.on('codecData', function(data) {
            if (data.duration !== 'N/A') {
                // Update Metadata with accurate duration
                const [hours, minutes, seconds] = data.duration.split(':').map(parseFloat);
                const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;
                METADATA[file].duration = totalSeconds
            }
          })
        const STREAM = command.pipe();
        STREAM.on('data', (chunk) => {
            if (aborted) {
                STREAM.destroy();
                return
            }
            concatenatedBuffer = concatenatedBuffer.length ? joinBuffers(concatenatedBuffer, chunk) : chunk;
            // if we have a full buffer
            if (concatenatedBuffer.length > highWaterMark) {
                const audio_chunk = concatenatedBuffer.subarray(0, highWaterMark);
                const remainder = concatenatedBuffer.subarray(highWaterMark);
                prepareWavForModel(audio_chunk, file, end, chunkStart);
                feedChunksToModel(...predictQueue.shift());
                chunkStart += samplesInBatch;
                concatenatedBuffer = remainder;
            }
            
        });
        STREAM.on('end', () => {
            // wait for the ffpmegstream to close: https://github.com/fluent-ffmpeg/node-fluent-ffmpeg/issues/1171#issuecomment-1361524138
            setTimeout( () => {
                //EOF: deal with part-full buffers
                if (concatenatedBuffer.byteLength){
                    prepareWavForModel(concatenatedBuffer, file, end, chunkStart);
                    feedChunksToModel(...predictQueue.shift());
                }
                DEBUG && console.log('All chunks sent for ', file);
                return resolve()
            }, 40)
        })

        STREAM.on('error', err => {
            console.log('stream error: ', err);
            err.code === 'ENOENT' && notifyMissingFile(file);
        })

    }).catch(error => console.log(error));
}

function prepareWavForModel(audio, file, end, chunkStart) {
    predictionsRequested[file]++;
    
    // Calculate the number of samples and directly create a Float32Array
    const sampleCount = (audio.length) / 2; // 2 bytes per sample for 16-bit PCM
    const channelData = new Float32Array(sampleCount);
    
    // Populate the Float32Array with normalised values
    for (let i = 0, j = 0; j < audio.length; i++, j += 2) {
        const sample = audio.readInt16LE(j);
        channelData[i] = sample / 32768; // Normalise to [-1, 1] range
    }
    
    // Send the channel data to the model
    predictQueue.push([channelData, chunkStart, file, end]);
    AUDIO_BACKLOG++;
}

/**
*  Called when file first loaded, when result clicked and when saving or sending file snippets
* @param args
* @returns {Promise<unknown>}
*/
const fetchAudioBuffer = async ({
    file = '', start = 0, end = undefined
}) => {
    if (! fs.existsSync(file)) {
        file = await getWorkingFile(file);
        if (!file) throw new Error('Cannot locate ' + file);
    }
    METADATA[file]?.duration || await setMetadata({file:file});
    end ??= METADATA[file].duration; 
    let concatenatedBuffer = Buffer.alloc(0);

    // Ensure start is a minimum 0.1 seconds from the end of the file, and >= 0
    start = METADATA[file].duration < 0.1 ? 0 : Math.min(METADATA[file].duration - 0.1, start)
    end = Math.min(end, METADATA[file].duration);
    // Use ffmpeg to extract the specified audio segment
    if (isNaN(start)) throw(new Error('fetchAudioBuffer: start is NaN'));
    return new Promise((resolve, reject) => {
        const command = setupFfmpegCommand({
            file,
            start,
            end,
            sampleRate: 24000,
            format: 'wav',
            channels: 1,
            additionalFilters: [
                STATE.filters.lowShelfAttenuation && {
                    filter: 'lowshelf',
                    options: `gain=${STATE.filters.lowShelfAttenuation}:f=${STATE.filters.lowShelfFrequency}`
                },
                STATE.filters.highPassFrequency && {
                    filter: 'highpass',
                    options: `f=${STATE.filters.highPassFrequency}:poles=1`
                },
                STATE.audio.normalise && {
                    filter: 'loudnorm',
                    options: "I=-16:LRA=11:TP=-1.5"
                }
            ].filter(Boolean),
        });
        const stream = command.pipe();
        
        command.on('error', error => {
            generateAlert({type: 'error',  message: error})
            reject(new Error('fetchAudioBuffer: Error extracting audio segment:', error));
        });

        stream.on('readable', () => {
            const chunk = stream.read();
            if (chunk === null){
                // Last chunk
                const audio = concatenatedBuffer;
                setupCtx(audio, sampleRate, 'UI', file).then(offlineCtx => {
                    offlineCtx.startRendering().then(resampled => {
                        resolve(resampled);
                    }).catch((error) => {
                        console.error(`FetchAudio rendering failed: ${error}`);
                    });
                }).catch( (error) => {
                    reject(error.message)
                });  
                stream.destroy();
            } else {
                concatenatedBuffer = concatenatedBuffer.length ?  joinBuffers(concatenatedBuffer, chunk) : chunk;
            }
        })
    });
}

// Helper function to check if a given time is within daylight hours
function isDuringDaylight(datetime, lat, lon) {
    const date = new Date(datetime);
    const { dawn, dusk } = SunCalc.getTimes(date, lat, lon);
    return datetime >= dawn && datetime <= dusk;
}

async function feedChunksToModel(channelData, chunkStart, file, end, worker) {

    if (worker === undefined) {
        // pick a worker - this method is faster than looking for available workers
        if (++workerInstance === NUM_WORKERS) {
            workerInstance = 0;
        }
        worker = workerInstance
    }
    const objData = {
        message: 'predict',
        worker: worker,
        fileStart: METADATA[file].fileStart,
        file: file,
        start: chunkStart,
        duration: end,
        resetResults: !STATE.selection,
        snr: STATE.filters.SNR,
        context: STATE.detect.contextAware,
        confidence: STATE.detect.confidence,
        chunks: channelData
    };
    predictWorkers[worker].isAvailable = false;
    predictWorkers[worker].postMessage(objData, [channelData.buffer]);
}
async function doPrediction({
    file = '',
    start = 0,
    end = METADATA[file].duration,
}) {
    if (file.toLowerCase().endsWith('.wav')){
        await getWavePredictBuffers({ file: file, start: start, end: end }).catch( (error) => console.warn(error));
    } else {
        await getPredictBuffers({ file: file, start: start, end: end }).catch( (error) => console.warn(error));
    }
    
    UI.postMessage({ event: 'update-audio-duration', value: METADATA[file].duration });
}

const speciesMatch = (path, sname) => {
    const pathElements = path.split(p.sep);
    const species = pathElements[pathElements.length - 2];
    sname = sname.replace(/ /g, '_');
    return species.includes(sname)
}

const convertSpecsFromExistingSpecs = async (path) => {
    path ??= '/mnt/608E21D98E21A88C/Users/simpo/PycharmProjects/Data/New_Dataset';
    const file_list = await getFiles([path], true);
    for (let i = 0; i < file_list.length; i++) {
        const parts = p.parse(file_list[i]);
        let species = parts.dir.split(p.sep);
        species = species[species.length - 1];
        const [filename, time] = parts.name.split('_');
        const [start, end] = time.split('-');
        const path_to_save = path.replace('New_Dataset', 'New_Dataset_Converted') + p.sep + species;
        const file_to_save = p.join(path_to_save, parts.base);
        if (fs.existsSync(file_to_save)) {
            DEBUG && console.log("skipping file as it is already saved")
        } else {
            const file_to_analyse = parts.dir.replace('New_Dataset', 'XC_ALL_mp3') + p.sep + filename + '.mp3';
            const AudioBuffer = await fetchAudioBuffer({
                start: parseFloat(start), end: parseFloat(end), file: file_to_analyse
            })
            if (AudioBuffer) {  // condition to prevent barfing when audio snippet is v short i.e. fetchAudioBUffer false when < 0.1s
                if (++workerInstance === NUM_WORKERS) {
                    workerInstance = 0;
                }
                const buffer = AudioBuffer.getChannelData(0);
                predictWorkers[workerInstance].postMessage({
                    message: 'get-spectrogram',
                    filepath: path_to_save,
                    file: parts.base,
                    buffer: buffer,
                    height: 256,
                    width: 384,
                    worker: workerInstance
                }, [buffer.buffer]);
            }
        }
    }
}
            
const saveResults2DataSet = ({species, included}) => {
    const exportType = 'audio';
    const rootDirectory = DATASET_SAVE_LOCATION;
    sampleRate = STATE.model === 'birdnet' ? 48_000 : 24_000;
    const height = 256, width = 384;
    let t0 = Date.now()
    let promise = Promise.resolve();
    let promises = [];
    let count = 0;
    let db2ResultSQL = `SELECT dateTime AS timestamp, 
    files.duration, 
    files.filestart,
    files.name AS file, 
    position,
    species.sname, 
    species.cname, 
    confidence AS score, 
    label, 
    comment
    FROM records
    JOIN species
    ON species.id = records.speciesID
    JOIN files ON records.fileID = files.id
    WHERE confidence >= ${STATE.detect.confidence}`;
    db2ResultSQL += filtersApplied(included) ? ` AND speciesID IN (${prepParams(included)})` : '';
    
    let params = filtersApplied(included) ? included : [];
    if (species) {
        db2ResultSQL += ` AND species.cname = ?`;
        params.push(species)
    }
    STATE.db.each(db2ResultSQL, ...params, async (err, result) => {
        // Check for level of ambient noise activation
        let ambient, threshold, value = STATE.detect.confidence;
        // adding_chirpity_additions is a flag for curated files, if true we assume every detection is correct
        if (!adding_chirpity_additions) {
                ambient = (result.sname2 === 'Ambient Noise' ? result.score2 : result.sname3 === 'Ambient Noise' ? result.score3 : false)
                console.log('Ambient', ambient)
                // If we have a high level of ambient noise activation, insist on a high threshold for species detection
                if (ambient && ambient > 0.2) {
                    value = 0.7
                }
            // Check whether top predicted species matches folder (i.e. the searched for species)
            // species not matching the top prediction sets threshold to 2000, effectively limiting treatment to manual records
            threshold = speciesMatch(result.file, result.sname) ? value : 2000;
        } else {
            //threshold = result.sname === "Ambient_Noise" ? 0 : 2000;
            threshold = result.sname === "Ambient_Noise" ? 0 : 0;
        }
        promise = promise.then(async function () {
            let score = result.score;
            if (score >= threshold) {
                //const folders = p.dirname(result.file).split(p.sep);
                species = result.cname.replaceAll(' ', '_');
                const sname = result.sname.replaceAll(' ', '_');
                // score 2000 when manual id. if manual ID when doing  additions put it in the species folder
                const folder = adding_chirpity_additions && score !== 2000 ? 'No_call' : `${sname}~${species}`;
                // get start and end from timestamp
                const start = result.position;
                let end = start + 3;
                
                // filename format: <source file>_<confidence>_<start>.png
                const file = `${p.basename(result.file).replace(p.extname(result.file), '')}_${start}-${end}.png`;
                const filepath = p.join(rootDirectory, folder)
                const file_to_save = p.join(filepath, file)
                if (fs.existsSync(file_to_save)) {
                    DEBUG && console.log("skipping file as it is already saved")
                } else {
                    end = Math.min(end, result.duration);
                    if (exportType === 'audio') saveAudio(result.file, start, end, file.replace('.png', '.wav'), {Artist: 'Chirpity'}, filepath)
                    else {
                        const AudioBuffer = await fetchAudioBuffer({
                            start: start, end: end, file: result.file
                        })
                        if (AudioBuffer) {  // condition to prevent barfing when audio snippet is v short i.e. fetchAudioBUffer false when < 0.1s
                            if (++workerInstance === NUM_WORKERS) {
                                workerInstance = 0;
                            }
                            
                            const buffer = AudioBuffer.getChannelData(0);
                            predictWorkers[workerInstance].postMessage({
                                message: 'get-spectrogram',
                                filepath: filepath,
                                file: file,
                                buffer: buffer,
                                height: height,
                                width: width,
                                worker: workerInstance
                            }, [buffer.buffer]);
                        }
                    }
                    count++;
                }
            }
            return new Promise(function (resolve) {
                setTimeout(resolve, 0.1);
            });
        })
        promises.push(promise)
    }, (err) => {
        if (err) return console.log(err);
        Promise.all(promises).then(() => console.log(`Dataset created. ${count} files saved in ${(Date.now() - t0) / 1000} seconds`))
    })
    
}
            
const onSpectrogram = async (filepath, file, width, height, data, channels) => {
    await mkdir(filepath, { recursive: true });
    let image = await png.encode({ width: 384, height: 256, data: data, channels: channels })
    const file_to_save = p.join(filepath, file);
    await writeFile(file_to_save, image);
    DEBUG && console.log('saved:', file_to_save);
};
            
async function uploadOpus({ file, start, end, defaultName, metadata, mode }) {
    const blob = await bufferToAudio({ file: file, start: start, end: end, format: 'opus', meta: metadata });
    // Populate a form with the file (blob) and filename
    const formData = new FormData();
    //const timestamp = Date.now()
    formData.append("thefile", blob, defaultName);
    // Was the prediction a correct one?
    formData.append("Chirpity_assessment", mode);
    // post form data
    const xhr = new XMLHttpRequest();
    xhr.responseType = 'text';
    // log response
    xhr.onload = () => {
        DEBUG && console.log(xhr.response);
    };
    // create and send the reqeust
    xhr.open('POST', 'https://birds.mattkirkland.co.uk/upload');
    xhr.send(formData);
}
            
const bufferToAudio = async ({
    file = '', start = 0, end = 3, meta = {}, format = undefined, folder = undefined, filename = undefined
}) => {
    if (! fs.existsSync(file)) {
        const found = await getWorkingFile(file);
        if (!found) return
    }
    let padding = STATE.audio.padding;
    let fade = STATE.audio.fade;
    let bitrate = STATE.audio.bitrate;
    let quality = parseInt(STATE.audio.quality);
    let downmix = STATE.audio.downmix;
    format ??= STATE.audio.format;
    const formatMap = {
        mp3: { audioCodec: 'libmp3lame', soundFormat: 'mp3' },
        wav: { audioCodec: 'pcm_s16le', soundFormat: 'wav' },
        flac: { audioCodec: 'flac', soundFormat: 'flac' },
        opus: { audioCodec: 'libopus', soundFormat: 'opus' }
    };
    const { audioCodec, soundFormat } = formatMap[format] || {};
    
    METADATA[file] || await getWorkingFile(file);
    if (padding) {
        start -= padding;
        end += padding;
        start = Math.max(0, start);
        end = Math.min(end, METADATA[file].duration);
    }
    
    return new Promise(function (resolve, reject) {
        let command = ffmpeg('file:' + file)
        .toFormat(soundFormat)
        .audioChannels(downmix ? 1 : -1)
        // I can't get this to work with Opus
        // .audioFrequency(METADATA[file].sampleRate)
        .audioCodec(audioCodec).seekInput(start).duration(end - start)
        if (['mp3', 'm4a', 'opus'].includes(format)) {
            //if (format === 'opus') bitrate *= 1000;
            command = command.audioBitrate(bitrate)
        } else if (['flac'].includes(format)) {
            command = command.audioQuality(quality)
        }
        if (STATE.filters.active) {
            const filters = [];
            if (STATE.filters.lowShelfFrequency > 0) {
                filters.push({
                    filter: 'lowshelf',
                    options: `gain=${STATE.filters.lowShelfAttenuation}:f=${STATE.filters.lowShelfFrequency}`
                });
            }
            if (STATE.filters.highPassFrequency > 0) {
                filters.push({
                    filter: 'highpass',
                    options: `f=${STATE.filters.highPassFrequency}:poles=1`
                });
            }            
            if (STATE.audio.normalise) {
                filters.push({
                    filter: 'loudnorm',
                    options: "I=-16:LRA=11:TP=-1.5"
                });
            }            
            if (filters.length > 0) {
                command = command.audioFilters(filters);
            }            
        }
        if (fade && padding) {
            const duration = end - start;
            if (start >= 1 && end <= METADATA[file].duration - 1) {
                command = command.audioFilters(
                    {
                        filter: 'afade',
                        options: `t=in:ss=${start}:d=1`
                    },
                    {
                        filter: 'afade',
                        options: `t=out:st=${duration - 1}:d=1`
                    }
                )}
        }
        if (Object.entries(meta).length){
            meta = Object.entries(meta).flatMap(([k, v]) => {
                if (typeof v === 'string') {
                    // Escape special characters, including quotes and apostrophes
                    v=v.replaceAll(' ', '_');
                };
                return ['-metadata', `${k}=${v}`]
            });
            command.addOutputOptions(meta)
        }
        //const destination = p.join((folder || tempPath), 'file.mp3');
        const destination = p.join((folder || tempPath), filename);
        command.save(destination);

        command.on('start', function (commandLine) {
            DEBUG && console.log('FFmpeg command: ' + commandLine);
        })
        command.on('error', (err) => {
            console.log('An error occurred: ' + err.message);
        })
        command.on('end', function () {
            DEBUG && console.log(format + " file rendered")
            resolve(destination)
        })
    })
};
                
async function saveAudio(file, start, end, filename, metadata, folder) {
    filename = filename.replaceAll(':', '-');
    const convertedFilePath = await bufferToAudio({
        file: file, start: start, end: end, meta: metadata, folder: folder, filename: filename
    });
    if (folder) { DEBUG && console.log('Audio file saved: ', convertedFilePath) }
    else {
        UI.postMessage({event:'audio-file-to-save', file: convertedFilePath, filename: filename, extension: STATE.audio.format})
    }
}

// Create a flag to indicate if parseMessage is currently being executed
let isParsing = false;

// Create a queue to hold messages while parseMessage is executing
const messageQueue = [];

// Function to process the message queue
const processQueue = async () => {
    if (!isParsing && messageQueue.length > 0) {
        // Set isParsing to true to prevent concurrent executions
        isParsing = true;
        
        // Get the first message from the queue
        const message = messageQueue.shift();

        // Parse the message
        await parseMessage(message).catch( (error) => {
            console.warn("Parse message error", error, 'message was', message);
        });
       
        // Set isParsing to false to allow the next message to be processed
        isParsing = false;
        
        // Process the next message in the queue
        processQueue();
    }
};

               
/// Workers  From the MDN example5
function spawnPredictWorkers(model, list, batchSize, threads) {
    // And be ready to receive the list:
    for (let i = 0; i < threads; i++) {
        const workerSrc = model === 'v3' ? 'BirdNet' : model === 'birdnet' ? 'BirdNet2.4' : 'model';
        const worker = new Worker(`./js/${workerSrc}.js`, { type: 'module' });
        worker.isAvailable = true;
        worker.isReady = false;
        predictWorkers.push(worker)
        DEBUG && console.log('loading a worker')
        worker.postMessage({
            message: 'load',
            model: model,
            list: list,
            batchSize: batchSize,
            backend: STATE.detect.backend,
            lat: STATE.lat,
            lon: STATE.lon,
            week: STATE.week,
            threshold: STATE.speciesThreshold,
            worker: i
        })

        // Web worker message event handler
        worker.onmessage = (e) => {
            // Push the message to the queue
            messageQueue.push(e);
            // Process the queue
            processQueue();
        };
        worker.onerror = (e) => {
            console.warn(`Worker ${i} is suffering, shutting it down. THe error was:`, e.message)
            predictWorkers.splice(i, 1);
            worker.terminate();
        }
    }
}

const terminateWorkers = () => {
        predictWorkers.forEach(worker => {
        worker.terminate()
    })
        predictWorkers = [];
}

async function batchInsertRecords(cname, label, files, originalCname) {
    const db = STATE.db;
    let params = [originalCname, STATE.detect.confidence];
    t0 = Date.now();
    let query = `SELECT * FROM records WHERE speciesID = (SELECT id FROM species WHERE cname = ?) AND confidence >= ? `;
    if (STATE.mode !== 'explore') {
        query += ` AND fileID in (SELECT id FROM files WHERE name IN (${prepParams(files)}))`
        params.push(...files);
    } else if (STATE.explore.range.start) {
        query += ` AND dateTime BETWEEN ${STATE.explore.range.start} AND ${STATE.explore.range.end}`;
    }
    const records = await STATE.db.allAsync(query, ...params);
    const updatedID = db.getAsync('SELECT id FROM species WHERE cname = ?', cname);
    let count = 0;
    await db.runAsync('BEGIN');
    for (let i = 0; i< records.length; i++) {
        const item = records[i];
        const { dateTime, speciesID, fileID, position, end, comment, callCount } = item;
        const { name } = await STATE.db.getAsync('SELECT name FROM files WHERE id = ?', fileID)
        // Delete existing record
        const changes = await db.runAsync('DELETE FROM records WHERE datetime = ? AND speciesID = ? AND fileID = ?', dateTime, speciesID, fileID)
        count += await onInsertManualRecord({
            cname: cname,
            start: position,
            end: end,
            comment: comment,
            count: callCount,
            file: name,
            label: label,
            batch: false,
            originalCname: undefined,
            updateResults: i === records.length -1 // trigger a UI update after the last item
        })
    }
    await db.runAsync('END');
    DEBUG && console.log(`Batch record update took ${(Date.now() - t0) / 1000} seconds`)
}
                        
const onInsertManualRecord = async ({ cname, start, end, comment, count, file, label, batch, originalCname, confidence, position, speciesFiltered, updateResults = true }) => {
    if (batch) return batchInsertRecords(cname, label, file, originalCname)
    start = parseFloat(start), end = parseFloat(end);
    const startMilliseconds = Math.round(start * 1000);
    let changes = 0, fileID, fileStart;
    const db = STATE.db;
    const { speciesID } = await db.getAsync(`SELECT id as speciesID FROM species WHERE cname = ?`, cname);
    let res = await db.getAsync(`SELECT id,filestart FROM files WHERE name = ?`, file);

    if (!res) { 
        // Manual records can be added off the bat, so there may be no record of the file in either db
        fileStart = METADATA[file].fileStart;
        res = await db.runAsync('INSERT OR IGNORE INTO files VALUES ( ?,?,?,?,?,?,? )',
        fileID, file, METADATA[file].duration, fileStart, undefined, undefined, METADATA[file].metadata);
        fileID = res.lastID;
        changes = 1;
        let durationSQL = Object.entries(METADATA[file].dateDuration)
        .map(entry => `(${entry.toString()},${fileID})`).join(',');
        await db.runAsync(`INSERT OR REPLACE INTO duration VALUES ${durationSQL}`);
    } else {
        fileID = res.id;
        fileStart = res.filestart;
    }
    
    const dateTime = fileStart + startMilliseconds;
    const isDaylight = isDuringDaylight(dateTime, STATE.lat, STATE.lon);
    confidence = confidence || 2000;
    // Delete an existing record if it exists
    const result = await db.getAsync(`SELECT id as originalSpeciesID FROM species WHERE cname = ?`, originalCname);
    result?.originalSpeciesID && await db.runAsync('DELETE FROM records WHERE datetime = ? AND speciesID = ? AND fileID = ?', dateTime, result.originalSpeciesID, fileID)
    const response = await db.runAsync('INSERT OR REPLACE INTO records VALUES ( ?,?,?,?,?,?,?,?,?,?)',
    dateTime, start, fileID, speciesID, confidence, label, comment, end, parseInt(count), isDaylight);
    
    if (response.changes){
        STATE.db === diskDB ? UI.postMessage({ event: 'diskDB-has-records' }) : UI.postMessage({event: 'unsaved-records'});
    }
    if (updateResults){
        if (position)  position.start = start;
        await getResults({species:speciesFiltered, position: position});
        await getSummary({species: speciesFiltered});
    }
    return changes;
}

const insertDurations = async (file, id) => {
    const durationSQL = Object.entries(METADATA[file].dateDuration)
    .map(entry => `(${entry.toString()},${id})`).join(',');
    // No "OR IGNORE" in this statement because it should only run when the file is new
    const result = await STATE.db.runAsync(`INSERT INTO duration VALUES ${durationSQL}`);
}

const generateInsertQuery = async (latestResult, file) => {
    const db = STATE.db;
    try {
        await db.runAsync('BEGIN');
        let insertQuery = 'INSERT OR IGNORE INTO records VALUES ';
        let fileID;
        let res = await db.getAsync('SELECT id FROM files WHERE name = ?', file);
        if (!res) {
            let id = null;
            if (METADATA[file].metadata){
                const metadata = JSON.parse(METADATA[file].metadata);
                const guano = metadata.guano;
                if (guano && guano['Loc Position']){
                    const [lat, lon] = guano['Loc Position'].split(' ');
                    const place = guano['Site Name'] || guano['Loc Position'];
                    const row = await db.getAsync('SELECT id FROM locations WHERE lat = ? AND lon = ?', parseFloat(lat), parseFloat(lon))
                    if (!row) {
                        const result = await db.runAsync('INSERT OR IGNORE INTO locations VALUES ( ?, ?,?,? )',
                        undefined, parseFloat(lat), parseFloat(lon), place);
                        id = result.lastID;
                    }
                }
            }
            res = await db.runAsync('INSERT OR IGNORE INTO files VALUES ( ?,?,?,?,?,?,? )',
            undefined, file, METADATA[file].duration, METADATA[file].fileStart, id, null, METADATA[file].metadata);
            fileID = res.lastID;
            await insertDurations(file, fileID);
        } else {
            fileID = res.id;
        }

        let [keysArray, speciesIDBatch, confidenceBatch] = latestResult;
        const minConfidence = Math.min(STATE.detect.confidence, 150); // store results with 15% confidence and up unless confidence set lower
        for (let i = 0; i < keysArray.length; i++) {
            const key = parseFloat(keysArray[i]);
            const timestamp = METADATA[file].fileStart + key * 1000;
            const isDaylight = isDuringDaylight(timestamp, STATE.lat, STATE.lon);
            const confidenceArray = confidenceBatch[i];
            const speciesIDArray = speciesIDBatch[i];
            for (let j = 0; j < confidenceArray.length; j++) {
                const confidence = Math.round(confidenceArray[j] * 1000);
                if (confidence < minConfidence) break;
                const speciesID = speciesIDArray[j];
                insertQuery += `(${timestamp}, ${key}, ${fileID}, ${speciesID}, ${confidence}, null, null, ${key + 3}, null, ${isDaylight}), `;
            }
        }
        // Remove the trailing comma and space
        insertQuery = insertQuery.slice(0, -2);
        //DEBUG && console.log(insertQuery);
        // Make sure we have some values to INSERT
        insertQuery.endsWith(')') && await db.runAsync(insertQuery)
            .catch( (error) => console.log("Database error:", error))
        await db.runAsync('END');
        return fileID
    } catch {
        await db.runAsync('ROLLBACK');
    }
}

const parsePredictions = async (response) => {
    let file = response.file;
    AUDIO_BACKLOG--;
    const latestResult = response.result;
    if (!latestResult.length){
        predictionsReceived[file]++;
        return response.worker
    }
    DEBUG && console.log('worker being used:', response.worker);
    if (! STATE.selection) await generateInsertQuery(latestResult, file).catch(error => console.warn('Error generating insert query', error));
    let [keysArray, speciesIDBatch, confidenceBatch] = latestResult;
    if (index < 499){
        const included = await getIncludedIDs(file).catch( (error) => console.log('Error getting included IDs', error));
        for (let i = 0; i < keysArray.length; i++) {
            let updateUI = false;
            let key = parseFloat(keysArray[i]);
            const timestamp = METADATA[file].fileStart + key * 1000;
            const confidenceArray = confidenceBatch[i];
            const speciesIDArray = speciesIDBatch[i];
            for (let j = 0; j < confidenceArray.length; j++) {
                let confidence = confidenceArray[j];
                if (confidence < 0.05) break;
                confidence*=1000;
                let speciesID = speciesIDArray[j];
                updateUI = (confidence > STATE.detect.confidence && (! included.length || included.includes(speciesID)));
                if (STATE.selection || updateUI) {
                    let end, confidenceRequired;
                    if (STATE.selection) {
                        const duration = (STATE.selection.end - STATE.selection.start) / 1000;
                        end = key + duration;
                        confidenceRequired = STATE.userSettingsInSelection ?
                        STATE.detect.confidence : 50;
                    } else {
                        end = key + 3;
                        confidenceRequired = STATE.detect.confidence;
                    }
                    if (confidence >= confidenceRequired) {
                        const { cname, sname } = await memoryDB.getAsync(`SELECT cname, sname FROM species WHERE id = ${speciesID}`).catch(error => console.warn('Error getting species name', error));
                        const result = {
                            timestamp: timestamp,
                            position: key,
                            end: end,
                            file: file,
                            cname: cname,
                            sname: sname,
                            score: confidence
                        }
                        sendResult(++index, result, false);
                        // Only show the highest confidence detection, unless it's a selection analysis
                        if (! STATE.selection) break;
                    };
                }
            }
        } 
    }
    predictionsReceived[file]++;
    const received = sumObjectValues(predictionsReceived);
    const total = sumObjectValues(batchChunksToSend);
    const progress = received / total;
    const fileProgress = predictionsReceived[file] / batchChunksToSend[file];
    UI.postMessage({ event: 'progress', progress: progress, file: file });
    if (fileProgress === 1) {
        if (index === 0 ) {
            const result = `No detections found in ${file}. Searched for records using the ${STATE.list} list and having a minimum confidence of ${STATE.detect.confidence/10}%`
                        UI.postMessage({
                event: 'new-result',
                file: file,
                result: result,
                index: index,
                selection: STATE.selection
            });  
        } 
        updateFilesBeingProcessed(response.file)
        DEBUG && console.log(`File ${file} processed after ${(new Date() - predictionStart) / 1000} seconds: ${filesBeingProcessed.length} files to go`);
    }

    !STATE.selection && (STATE.increment() === 0) && await getSummary({ interim: true });

    return response.worker
}
                        
let SEEN_MODEL_READY = false;
async function parseMessage(e) {
    const response = e.data;
    switch (response['message']) {
        case "model-ready": {
            predictWorkers[response.worker].isReady = true;
            predictWorkers[response.worker].isAvailable = true;
            if ( !SEEN_MODEL_READY) {
                SEEN_MODEL_READY = true;
                sampleRate = response["sampleRate"];
                const backend = response["backend"];
                console.log(backend);
                UI.postMessage({
                    event: "model-ready",
                    message: "ready",
                    backend: backend,
                    sampleRate: sampleRate
                });
        }
        break;
        }
        case "prediction": {
            if ( !aborted) {
                predictWorkers[response.worker].isAvailable = true;
                let worker = await parsePredictions(response).catch( (error) =>  console.log('Error parsing predictions', error));
                DEBUG && console.log('predictions left for', response.file, batchChunksToSend[response.file] - predictionsReceived[response.file])
                const remaining = predictionsReceived[response.file] - batchChunksToSend[response.file]
                if (remaining === 0) {
                    if (filesBeingProcessed.length) {
                        processNextFile({ worker: worker });
                    } 
                }
            }
        break;
        }
        case "spectrogram": {onSpectrogram(response["filepath"], response["file"], response["width"], response["height"], response["image"], response["channels"]);
        break;
    }}
}
        
/**
* Called when a files processing is finished
* @param {*} file 
*/
function updateFilesBeingProcessed(file) {
    // This method to determine batch complete
    const fileIndex = filesBeingProcessed.indexOf(file);
    if (fileIndex !== -1) {
        filesBeingProcessed.splice(fileIndex, 1)
        DEBUG && console.log('filesbeingprocessed updated length now :', filesBeingProcessed.length)
    }
    if (!filesBeingProcessed.length) {
        if (!STATE.selection) getSummary();
        // Need this here in case last file is not sent for analysis (e.g. nocmig mode)
        UI.postMessage({event: 'analysis-complete'})

    }
}
        
        
// Optional Arguments
async function processNextFile({
    start = undefined, end = undefined, worker = undefined
} = {}) { 
    if (FILE_QUEUE.length) {
        let file = FILE_QUEUE.shift()
        const found = await getWorkingFile(file).catch(error => {
            console.warn('Error in getWorkingFile', error);
            generateAlert({type: 'warning',  message: error.message})
        });
        if (found) {
            if (end) {}
            let boundaries = [];
            if (!start) boundaries = await setStartEnd(file).catch( (error) => console.warn('Error in setStartEnd', error));
            else boundaries.push({ start: start, end: end });
            for (let i = 0; i < boundaries.length; i++) {
                const { start, end } = boundaries[i];
                if (start === end) {
                    // Nothing to do for this file
                    
                    updateFilesBeingProcessed(file);
                    const result = `No detections. ${file} has no period within it where predictions would be given. <b>Tip:</b> To see detections in this file, disable nocmig mode and run the analysis again.`;
                    
                    UI.postMessage({
                        event: 'new-result', file: file, result: result, index: index
                    });
                    
                    DEBUG && console.log('Recursion: start = end')
                    await processNextFile(arguments[0]).catch(error => console.warn('Error in processNextFile call', error));
                    
                } else {
                    if (!sumObjectValues(predictionsReceived)) {
                        UI.postMessage({
                            event: 'progress',
                            text: "<span class='loading text-nowrap'>Awaiting detections</span>",
                            file: file
                        });
                    }
                    await doPrediction({
                        start: start, end: end, file: file, worker: worker
                    }).catch( (error) => console.warn('Error in doPrediction', error, 'file', file, 'start', start, 'end', end));
                }
            }
        } else {
            DEBUG && console.log('Recursion: file not found')
            updateFilesBeingProcessed(file) // remove file from processing list
            await processNextFile(arguments[0]).catch(error => console.warn('Error in recursive processNextFile call', error));
        }
    }
}

function sumObjectValues(obj) {
    let total = 0;
    for (const key in obj) {  total += obj[key] }
    return total;
}

function onSameDay(timestamp1, timestamp2) {
    const date1Str = new Date(timestamp1).toLocaleDateString();
    const date2Str = new Date(timestamp2).toLocaleDateString();
    return date1Str === date2Str;
}


// Function to calculate the active intervals for an audio file in nocmig mode

function calculateNighttimeBoundaries(fileStart, fileEnd, latitude, longitude) {
    const activeIntervals = [];
    const maxFileOffset = (fileEnd - fileStart) / 1000;
    const dayNightBoundaries = [];
    //testing
    const startTime = new Date(fileStart);
    //needed
    const endTime = new Date(fileEnd);
    endTime.setHours(23, 59, 59, 999);
    for (let currentDay = new Date(fileStart);
    currentDay <= endTime;
    currentDay.setDate(currentDay.getDate() + 1)) {
        const { dawn, dusk } = SunCalc.getTimes(currentDay, latitude, longitude)
        dayNightBoundaries.push(dawn.getTime(), dusk.getTime())
    }
    
    for (let i = 0; i < dayNightBoundaries.length; i++) {
        const offset = (dayNightBoundaries[i] - fileStart) / 1000;
        // negative offsets are boundaries before the file starts.
        // If the file starts during daylight, we move on
        if (offset < 0) {
            if (!isDuringDaylight(fileStart, latitude, longitude) && i > 0) {
                activeIntervals.push({ start: 0 })
            }
            continue;
        }
        // Now handle 'all daylight' files
        if (offset >= maxFileOffset) {
            if (isDuringDaylight(fileEnd, latitude, longitude)) {
                if (!activeIntervals.length) {
                    activeIntervals.push({ start: 0, end: 0 })
                    return activeIntervals
                }
            }
        }
        // The list pattern is [dawn, dusk, dawn, dusk,...]
        // So every second item is a start trigger
        if (i % 2 !== 0) {
            if (offset > maxFileOffset) break;
            activeIntervals.push({ start: Math.max(offset, 0) });
            // and the others are a stop trigger
        } else {
            activeIntervals.length || activeIntervals.push({ start: 0 })
            activeIntervals[activeIntervals.length - 1].end = Math.min(offset, maxFileOffset);
        }
    }
    activeIntervals[activeIntervals.length - 1].end ??= maxFileOffset;
    return activeIntervals;
}

async function setStartEnd(file) {
    const meta = METADATA[file];
    let boundaries;
    //let start, end;
    if (STATE.detect.nocmig) {
        const fileEnd = meta.fileStart + (meta.duration * 1000);
        const result = await STATE.db.getAsync('SELECT * FROM locations WHERE id = ?', meta.locationID);
        const { lat, lon } = result ? { lat: result.lat, lon: result.lon } : { lat: STATE.lat, lon: STATE.lon };
        boundaries = calculateNighttimeBoundaries(meta.fileStart, fileEnd, lat, lon);
    } else {
        boundaries = [{ start: 0, end: meta.duration }];
    }
    return boundaries;
}


const getSummary = async ({
    species = undefined,
    active = undefined,
    interim = false,
    action = undefined,
} = {}) => {
    const included = STATE.selection ? [] : await getIncludedIDs();
    const [sql, params] = prepSummaryStatement(included);
    const offset = species ? STATE.filteredOffset[species] : STATE.globalOffset;


    const summary = await STATE.db.allAsync(sql, ...params);
    const event = interim ? 'update-summary' : 'summary-complete';
    UI.postMessage({
        event: event,
        summary: summary,
        offset: offset,
        audacityLabels: AUDACITY,
        filterSpecies: species,
        active: active,
        action: action
    })
};


/**
*
* @param files: files to query for detections
* @param species: filter for SQL query
* @param limit: the pagination limit per page
* @param offset: is the SQL query offset to use
* @param topRankin: return results >= to this rank for each datetime
* @param directory: if set, will export audio of the returned results to this folder
* @param format: whether to export audio or text
*
* @returns {Promise<integer> } A count of the records retrieved
*/
const getResults = async ({
    species = undefined,
    limit = STATE.limit,
    offset = undefined,
    topRankin = STATE.topRankin,
    directory = undefined,
    format = undefined,
    active = undefined,
    position = undefined
} = {}) => {
    let confidence = STATE.detect.confidence;
    const included = STATE.selection ? [] : await getIncludedIDs();
    if (position) {
        //const position = await getPosition({species: species, dateTime: select.dateTime, included: included});
        offset = (position.page - 1) * limit;
        active = position.row;
        // update the pagination
        const [total, , ] = await getTotal({species: species, offset: offset, included: included})
        UI.postMessage({event: 'total-records', total: total, offset: offset, species: species})
    }
    offset = offset ?? (species ? (STATE.filteredOffset[species] ?? 0) : STATE.globalOffset);
    if (species) STATE.filteredOffset[species] = offset;
    else STATE.update({ globalOffset: offset });
    
    
    let index = offset;
    AUDACITY = {};

    const [sql, params] = prepResultsStatement(species, limit === Infinity, included, offset, topRankin);
    
    const result = await STATE.db.allAsync(sql, ...params);
    let formattedValues;
    let previousFile = null, cumulativeOffset = 0; 

    const formatFunctions = {
        text: formatCSVValues,
        eBird: formateBirdValues,
        Raven: formatRavenValues
    };
    
    if (format in formatFunctions) {
        // CSV export. Format the values
        formattedValues = await Promise.all(result.map(async (item, index) => {
            if (format === 'Raven') {
                item = { ...item, selection: index + 1 } // Add a selection number for Raven
                 if (item.file !== previousFile){ // Positions need to be cumulative across files in Raven
                    if (previousFile !== null){
                        cumulativeOffset += result.find(r => r.file === previousFile).duration;
                    }
                    previousFile = item.file;
                }
                item.offset = cumulativeOffset;
            }
            return await formatFunctions[format](item);
        }));
    
        if (format === 'eBird'){
            // Group the data by "Start Time", "Common name", and "Species" and calculate total species count for each group
            const summary = formattedValues.reduce((acc, curr) => {
                const key = `${curr["Start Time"]}_${curr["Common name"]}_${curr["Species"]}`;
                if (!acc[key]) {
                    acc[key] = {
                        "Common name": curr["Common name"],
                        // Include other fields from the original data
                        "Genus": curr["Genus"],
                        "Species": curr["Species"],
                        "Species Count": 0,
                        "Species Comments": curr["Species Comments"],
                        "Location Name": curr["Location Name"],
                        "Latitude": curr["Latitude"],
                        "Longitude": curr["Longitude"],
                        "Date": curr["Date"],
                        "Start Time": curr["Start Time"],
                        "State/Province": curr["State/Province"],
                        "Country": curr["Country"],
                        "Protocol": curr["Protocol"],
                        "Number of observers": curr["Number of observers"],
                        "Duration": curr["Duration"],
                        "All observations reported?": curr["All observations reported?"],
                        "Distance covered": curr["Distance covered"],
                        "Area covered": curr["Area covered"],
                        "Submission Comments": curr["Submission Comments"]
                    };
                }
                // Increment total species count for the group
                acc[key]["Species Count"] += curr["Species Count"];
                return acc;
            }, {});
            // Convert summary object into an array of objects
            formattedValues = Object.values(summary);

        }
        // Create a write stream for the CSV file
        let filename = species || 'All';
        filename += format == 'Raven' ? `_selections.txt` : '_detections.csv';
        const filePath = p.join(directory, filename);
        writeToPath(filePath, formattedValues, {headers: true, delimiter: format === 'Raven' ? '\t' : ','})
        .on('error', err => generateAlert({type: 'warning',  message: `Cannot save file ${filePath}\nbecause it is open in another application`}))
        .on('finish', () => {
            generateAlert({message: filePath + ' has been written successfully.'});
        });
    }
    else {
        for (let i = 0; i < result.length; i++) {
            const r = result[i];
            if (format === 'audio') {
                if (limit){
                    // Audio export. Format date to YYYY-MM-DD-HH-MM-ss
                    const dateArray = new Date(r.timestamp).toString().split(' ');
                    const dateString = dateArray.slice(0, 5).join(' ').replaceAll(':', '_');
                    //const dateString = new Date(r.timestamp).toISOString().replace(/[TZ]/g, ' ').replace(/\.\d{3}/, '').replace(/[-:]/g, '-').trim();
                    const filename = `${r.cname}_${dateString}.${STATE.audio.format}`
                    DEBUG && console.log(`Exporting from ${r.file}, position ${r.position}, into folder ${directory}`)
                    saveAudio(r.file, r.position, r.end, filename, {Artist: 'Chirpity'}, directory)
                    i === result.length - 1 && UI.postMessage({ event: 'generate-alert', message: `${result.length} files saved` })
                } 
            }
            else if (species && STATE.mode !== 'explore') {
                // get a number for the circle
                const { count } = await STATE.db.getAsync(`SELECT COUNT(*) as count FROM records WHERE dateTime = ?
                AND confidence >= ? and fileID = ?`, r.timestamp, confidence, r.fileID);
                r.count = count;
                sendResult(++index, r, true);
            } else {
                sendResult(++index, r, true)
            }
           if (i === result.length -1) UI.postMessage({event: 'processing-complete'})
        }
        if (!result.length) {
            if (STATE.selection) {
                // No more detections in the selection
                sendResult(++index, 'No detections found in the selection', true)
            } else {
                species = species || '';
                const nocmig = STATE.detect.nocmig ? '<b>nocturnal</b>' : ''
                sendResult(++index, `No ${nocmig} ${species} detections found ${STATE.mode === 'explore' ? 'in the Archive' : ''} using the ${STATE.list} list.`, true)
            }
        }
    }
    (STATE.selection && topRankin === STATE.topRankin)  || UI.postMessage({event: 'database-results-complete', active: active, select: position?.start});
};

// Function to format the CSV export
async function formatCSVValues(obj) {
    // Create a copy of the original object to avoid modifying it directly
    const modifiedObj = { ...obj };
    // Get lat and lon
    const result = await STATE.db.getAsync(`
        SELECT lat, lon, place 
        FROM files JOIN locations on locations.id = files.locationID 
        WHERE files.name = ? `, modifiedObj.file);
    const latitude =  result?.lat || STATE.lat;
    const longitude =  result?.lon || STATE.lon;
    const place =  result?.place || STATE.place;
    modifiedObj.score /= 1000;
    modifiedObj.score = modifiedObj.score.toString().replace(/^2$/, 'confirmed');
    // Step 2: Multiply 'end' by 1000 and add 'timestamp'
    modifiedObj.end = (modifiedObj.end - modifiedObj.position) * 1000  + modifiedObj.timestamp;
    
    // Step 3: Convert 'timestamp' and 'end' to a formatted string
    modifiedObj.timestamp = formatDate(modifiedObj.timestamp)
    modifiedObj.end = formatDate(modifiedObj.end);
    // Create a new object with the right headers
    const newObj = {};
    newObj['File'] = modifiedObj.file
    newObj['Detection start'] = modifiedObj.timestamp
    newObj['Detection end'] = modifiedObj.end
    newObj['Common name'] = modifiedObj.cname
    newObj['Latin name'] = modifiedObj.sname
    newObj['Confidence'] = modifiedObj.score
    newObj['Label'] = modifiedObj.label
    newObj['Comment'] = modifiedObj.comment
    newObj['Call count'] = modifiedObj.callCount
    newObj['File offset'] = secondsToHHMMSS(modifiedObj.position)
    newObj['Latitude'] = latitude;
    newObj['Longitude'] = longitude;
    newObj['Place'] = place;
    return newObj;
}

// Function to format the eBird export
async function formateBirdValues(obj) {
    // Create a copy of the original object to avoid modifying it directly
    const modifiedObj = { ...obj };
    // Get lat and lon
    const result = await STATE.db.getAsync(`
        SELECT lat, lon, place 
        FROM files JOIN locations on locations.id = files.locationID 
        WHERE files.name = ? `, modifiedObj.file);
    const latitude =  result?.lat || STATE.lat;
    const longitude =  result?.lon || STATE.lon;
    const place =  result?.place || STATE.place;
    modifiedObj.timestamp = formatDate(modifiedObj.filestart);
    let [date, time] = modifiedObj.timestamp.split(' ');
    const [year, month, day] = date.split('-');
    date = `${month}/${day}/${year}`;
    const [hours, minutes] = time.split(':')
    time = `${hours}:${minutes}`;
    if (STATE.model === 'chirpity'){
        // Regular expression to match the words inside parentheses
        const regex = /\(([^)]+)\)/;
        const matches = modifiedObj.cname.match(regex);
        // Splitting the input string based on the regular expression match
        const [name, calltype] = modifiedObj.cname.split(regex);
        modifiedObj.cname = name.trim(); // Output: "words words"
        modifiedObj.comment ??= calltype;
    }
    const [genus, species] = modifiedObj.sname.split(' ');
    // Create a new object with the right keys
    const newObj = {};
    newObj['Common name'] = modifiedObj.cname;
    newObj['Genus'] = genus;
    newObj['Species'] = species;
    newObj['Species Count'] = modifiedObj.callCount || 1;
    newObj['Species Comments'] = modifiedObj.comment?.replace(/\r?\n/g, ' ');
    newObj['Location Name'] = place;
    newObj['Latitude'] = latitude;
    newObj['Longitude'] = longitude;
    newObj['Date'] = date;
    newObj['Start Time'] = time;
    newObj['State/Province'] = '';
    newObj['Country'] = '';
    newObj['Protocol'] = 'Stationary';
    newObj['Number of observers'] = '1';
    newObj['Duration'] = Math.ceil(modifiedObj.duration / 60);
    newObj['All observations reported?'] = 'N';
    newObj['Distance covered'] = '';
    newObj['Area covered'] = '';
    newObj['Submission Comments'] = 'Submission initially generated from Chirpity';
    return newObj;
}

function formatRavenValues(obj) {
    // Create a copy of the original object to avoid modifying it directly
    const modifiedObj = { ...obj };

    if (STATE.model === 'chirpity'){
        // Regular expression to match the words inside parentheses
        const regex = /\(([^)]+)\)/;
        const matches = modifiedObj.cname.match(regex);
        // Splitting the input string based on the regular expression match
        const [name, calltype] = modifiedObj.cname.split(regex);
        modifiedObj.cname = name.trim(); // Output: "words words"
    }
    // Create a new object with the right keys
    const newObj = {};
    newObj['Selection'] = modifiedObj.selection;
    newObj['View'] = 'Spectrogram 1';
    newObj['Channel'] = 1;
    newObj['Begin Time (s)'] = modifiedObj.position + modifiedObj.offset;
    newObj['End Time (s)'] = modifiedObj.end  + modifiedObj.offset;
    newObj['Low Freq (Hz)'] = 0;
    newObj['High Freq (Hz)'] = 15000;
    newObj['Common Name'] = modifiedObj.cname;
    newObj['Confidence'] = modifiedObj.score / 1000;
    newObj['Begin Path'] = modifiedObj.file ;
    newObj['File Offset (s)'] = modifiedObj.position;
    return newObj;
}

function secondsToHHMMSS(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    
    const HH = String(hours).padStart(2, '0');
    const MM = String(minutes).padStart(2, '0');
    const SS = String(remainingSeconds).padStart(2, '0');
    
    return `${HH}:${MM}:${SS}`;
}

const formatDate = (timestamp) =>{
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

const sendResult = (index, result, fromDBQuery) => {
    const file = result.file;
    if (typeof result === 'object') {
        // Convert confidence back to % value
        result.score = (result.score / 10).toFixed(0)
        // Recreate Audacity labels (will create filtered view of labels if filtered)
        const audacity = {
            timestamp: `${result.position}\t${result.position + WINDOW_SIZE}`,
            cname: result.cname,
            score: Number(result.score) / 100
        };
        AUDACITY[file] ??= [];
        AUDACITY[file].push(audacity);
    }
    UI.postMessage({
        event: 'new-result',
        file: file,
        result: result,
        index: index,
        isFromDB: fromDBQuery,
        selection: STATE.selection
    });
};


const getSavedFileInfo = async (file) => {
    if (diskDB){
        const prefix = STATE.archive.location + p.sep;
        // Get rid of archive (library) location prefix
        const archiveFile = file.replace(prefix , '');
        let row = await diskDB.getAsync(`
            SELECT duration, filestart AS fileStart, metadata AS guano, locationID
            FROM files LEFT JOIN locations ON files.locationID = locations.id 
            WHERE name = ? OR archiveName = ?`,file, archiveFile);
        if (!row) {
            const baseName = file.replace(/^(.*)\..*$/g, '$1%');
            row = await diskDB.getAsync('SELECT * FROM files LEFT JOIN locations ON files.locationID = locations.id WHERE name LIKE  (?)',baseName);
        } 
        return row
    } else {
        generateAlert({type: 'error',  message: 'The database has not finished loading. The check for the presence of the file in the archive has been skipped'})
        return undefined
    }
};


/**
*  Transfers data in memoryDB to diskDB
* @returns {Promise<unknown>}
*/
const onSave2DiskDB = async ({file}) => {
    t0 = Date.now();
    if (STATE.db === diskDB) {
        UI.postMessage({
            event: 'generate-alert',
            message: `Records already saved, nothing to do`
        })
        return // nothing to do. Also will crash if trying to update disk from disk.
    }
    const included = await getIncludedIDs(file);
    let filterClause = filtersApplied(included) ? `AND speciesID IN (${included} )` : '';
    if (STATE.detect.nocmig) filterClause += ' AND isDaylight = FALSE ';
    await memoryDB.runAsync('BEGIN');
    await memoryDB.runAsync(`INSERT OR IGNORE INTO disk.files SELECT * FROM files`);
    await memoryDB.runAsync(`INSERT OR IGNORE INTO disk.locations SELECT * FROM locations`);
    // Set the saved flag on files' METADATA
    for (let file in METADATA) {
        METADATA[file].isSaved = true
    }
    // Update the duration table
    let response = await memoryDB.runAsync('INSERT OR IGNORE INTO disk.duration SELECT * FROM duration');
    DEBUG && console.log(response.changes + ' date durations added to disk database');
    // now update records
    response = await memoryDB.runAsync(`
    INSERT OR IGNORE INTO disk.records 
    SELECT * FROM records
    WHERE confidence >= ${STATE.detect.confidence} ${filterClause} `);
    DEBUG && console.log(response?.changes + ' records added to disk database');
    await memoryDB.runAsync('END');
    DEBUG && console.log("transaction ended");
    if (response?.changes) {
        UI.postMessage({ event: 'diskDB-has-records' });
        if (!DATASET) {
            
            // Now we have saved the records, set state to DiskDB
            await onChangeMode('archive');
            getLocations({ db: STATE.db, file: file });
            UI.postMessage({
                event: 'generate-alert',
                message: `Database update complete, ${response.changes} records added to the archive in ${((Date.now() - t0) / 1000)} seconds`,
                updateFilenamePanel: true,
                database: true
            })
        }
    }
};

const filterLocation = () => STATE.locationID ? ` AND files.locationID = ${STATE.locationID}` : '';

const getSeasonRecords = async (species, season) => {
    // Add Location filter
    const locationFilter = filterLocation();
    // Because we're using stmt.prepare, we need to unescape quotes
    const seasonMonth = { spring: "< '07'", autumn: " > '06'" }
    return new Promise(function (resolve, reject) {
        const stmt = diskDB.prepare(`
        SELECT MAX(SUBSTR(DATE(records.dateTime/1000, 'unixepoch', 'localtime'), 6)) AS maxDate,
        MIN(SUBSTR(DATE(records.dateTime/1000, 'unixepoch', 'localtime'), 6)) AS minDate
        FROM records
        JOIN species ON species.id = records.speciesID
        JOIN files ON files.id = records.fileID
        WHERE species.cname = (?) ${locationFilter}
        AND STRFTIME('%m',
        DATETIME(records.dateTime / 1000, 'unixepoch', 'localtime'))
        ${seasonMonth[season]}`);
        stmt.get(species, (err, row) => {
            if (err) {
                reject(err)
            } else {
                resolve(row)
            }
        })
    })
};

const getMostCalls = (species) => {
    return new Promise(function (resolve, reject) {
        // Add Location filter
        const locationFilter = filterLocation();
        diskDB.get(`
        SELECT COUNT(*) as count, 
        DATE(dateTime/1000, 'unixepoch', 'localtime') as date
        FROM records 
        JOIN species on species.id = records.speciesID
        JOIN files ON files.id = records.fileID
        WHERE species.cname = ? ${locationFilter}
        GROUP BY STRFTIME('%Y', DATETIME(dateTime/1000, 'unixepoch', 'localtime')),
        STRFTIME('%W', DATETIME(dateTime/1000, 'unixepoch', 'localtime')),
        STRFTIME('%d', DATETIME(dateTime/1000, 'unixepoch', 'localtime'))
        ORDER BY count DESC LIMIT 1`, species, (err, row) => {
            if (err) {
                reject(err)
            } else {
                resolve(row)
            }
        })
    })
}

const getChartTotals = ({
    species = undefined, range = {}, aggregation = 'Week'
}) => {
    // Add Location filter
    const locationFilter = filterLocation();
    const dateRange = range;
    
    // Work out sensible aggregations from hours difference in date range
    const hours_diff = dateRange.start ? Math.round((dateRange.end - dateRange.start) / (1000 * 60 * 60)) : 745;
    DEBUG && console.log(hours_diff, "difference in hours")
    
    const dateFilter = dateRange.start ? ` AND dateTime BETWEEN ${dateRange.start} AND ${dateRange.end} ` : '';
    
    // Default values for grouping
    let groupBy = "Year, Week";
    let orderBy = 'Year';
    let dataPoints = Math.max(52, Math.round(hours_diff / 24 / 7));
    let startDay = 0;
    
    // Update grouping based on aggregation parameter
    if (aggregation === 'Day') {
        groupBy += ", Day";
        orderBy = 'Year, Week';
        dataPoints = Math.round(hours_diff / 24);
        const date = dateRange.start !== undefined ? new Date(dateRange.start) : new Date(Date.UTC(2020, 0, 0, 0, 0, 0));
        startDay = Math.floor((date - new Date(date.getFullYear(), 0, 0, 0, 0, 0)) / 1000 / 60 / 60 / 24);
    } else if (aggregation === 'Hour') {
        groupBy = "Hour";
        orderBy = 'CASE WHEN Hour >= 12 THEN Hour - 12 ELSE Hour + 12 END';
        dataPoints = 24;
        const date = dateRange.start !== undefined ? new Date(dateRange.start) : new Date(Date.UTC(2020, 0, 0, 0, 0, 0));
        startDay = Math.floor((date - new Date(date.getFullYear(), 0, 0, 0, 0, 0)) / 1000 / 60 / 60 / 24);
    }
    
    return new Promise(function (resolve, reject) {
        diskDB.all(`SELECT CAST(STRFTIME('%Y', DATETIME(dateTime / 1000, 'unixepoch', 'localtime')) AS INTEGER) AS Year, 
        CAST(STRFTIME('%W', DATETIME(dateTime/1000, 'unixepoch', 'localtime')) AS INTEGER) AS Week,
        CAST(STRFTIME('%j', DATETIME(dateTime/1000, 'unixepoch', 'localtime')) AS INTEGER) AS Day, 
        CAST(STRFTIME('%H', DATETIME(dateTime/1000, 'unixepoch', 'localtime')) AS INTEGER) AS Hour,    
        COUNT(*) as count
        FROM records
        JOIN species ON species.id = speciesID
        JOIN files ON files.id = fileID
        WHERE species.cname = ? ${dateFilter} ${locationFilter}
        GROUP BY ${groupBy}
        ORDER BY ${orderBy}`, species, (err, rows) => {
            if (err) {
                reject(err)
            } else {
                resolve([rows, dataPoints, aggregation, startDay])
            }
        })
    })
}
        
const getRate = (species) => {
    return new Promise(function (resolve, reject) {
        const calls = Array.from({length: 52}).fill(0);
        const total = Array.from({length: 52}).fill(0);
        // Add Location filter
        const locationFilter = filterLocation();
        
        diskDB.all(`select STRFTIME('%W', DATE(dateTime / 1000, 'unixepoch', 'localtime')) as week, COUNT(*) as calls
        from records
        JOIN species ON species.id = records.speciesID
        JOIN files ON files.id = records.fileID
        WHERE species.cname = ? ${locationFilter}
        group by week;`, species, (err, rows) => {
            for (let i = 0; i < rows.length; i++) {
                calls[parseInt(rows[i].week) - 1] = rows[i].calls;
            }
            diskDB.all("select STRFTIME('%W', DATE(duration.day / 1000, 'unixepoch', 'localtime')) as week, cast(sum(duration) as real)/3600  as total from duration group by week;", (err, rows) => {
                for (let i = 0; i < rows.length; i++) {
                    // Round the total to 2 dp
                    total[parseInt(rows[i].week) - 1] = Math.round(rows[i].total * 100) / 100;
                }
                let rate = [];
                for (let i = 0; i < calls.length; i++) {
                    total[i] > 0 ? rate[i] = Math.round((calls[i] / total[i]) * 100) / 100 : rate[i] = 0;
                }
                if (err) {
                    reject(err)
                } else {
                    resolve([total, rate])
                }
            })
        })
    })
}

/**
 * getDetectedSpecies generates a list of species to use in dropdowns for chart and explore mode filters
 * It doesn't really make sense to use location specific filtering here, as there is a location filter in the 
 * page. For now, I'm just going skip the included IDs filter if location mode is selected
 */
const getDetectedSpecies = () => {
    const range = STATE.explore.range;
    const confidence = STATE.detect.confidence;
    let sql = `SELECT cname, locationID
    FROM records
    JOIN species ON species.id = records.speciesID 
    JOIN files on records.fileID = files.id`;
    
    if (STATE.mode === 'explore') sql += ` WHERE confidence >= ${confidence}`;
    if (STATE.list !== 'location' && filtersApplied(STATE.included)) {
        sql += ` AND speciesID IN (${STATE.included.join(',')})`;
    }
    if (range?.start) sql += ` AND datetime BETWEEN ${range.start} AND ${range.end}`;
    sql += filterLocation();
    sql += ' GROUP BY cname ORDER BY cname';
    diskDB.all(sql, (err, rows) => {
        err ? console.log(err) : UI.postMessage({ event: 'seen-species-list', list: rows })
    })
};

/**
 *  getValidSpecies generates a list of species included/excluded based on settings
 *  For week specific lists, we need the file
 * @returns Promise <void>
 */
const getValidSpecies = async (file) => {
    const included = await getIncludedIDs(file);
    let excludedSpecies, includedSpecies;
    let sql = `SELECT cname, sname FROM species`;
    // We'll ignore Unknown Sp. here, hence length < (LABELS.length *-1*)

    if (filtersApplied(included)) {
        sql += ` WHERE id IN (${included.join(',')})`;
    }
    sql += ' GROUP BY cname ORDER BY cname';
    includedSpecies = await diskDB.allAsync(sql)
    
    if (filtersApplied(included)){
        sql = sql.replace('IN', 'NOT IN');
        excludedSpecies = await diskDB.allAsync(sql);
    }
    UI.postMessage({ event: 'valid-species-list', included: includedSpecies, excluded: excludedSpecies })
};

const onUpdateFileStart = async (args) => { 
    let file = args.file;
    const newfileMtime = new Date(Math.round(args.start + (METADATA[file].duration * 1000)));
    utimesSync(file, {atime: Date.now(), mtime: newfileMtime});

    METADATA[file].fileStart = args.start;
    delete METADATA[file].isComplete;
    let db = STATE.db;
    let row = await db.getAsync('SELECT id, locationID FROM files  WHERE name = ?', file);
    
    if (!row) {
        DEBUG && console.log('File not found in database, adding.');
        const result = await db.runAsync('INSERT INTO files (id, name, duration, filestart) values (?, ?, ?, ?)', undefined, file, METADATA[file].duration, args.start);
        // update file metadata
        await setMetadata({file});
        await insertDurations(file, result.lastID);
        // If no file, no records, so we're done.
    }
    else {
        const {id, locationID} = row;
        let { changes } = await db.runAsync('UPDATE files SET filestart = ? where id = ?', args.start, id);
        DEBUG && console.log(changes ? `Changed ${file}` : `No changes made`);
        // update file metadata
        await setMetadata({file});
        // Update dateDuration
        let result;
        result = await db.runAsync('DELETE FROM duration WHERE fileID = ?', id);
        console.log(result.changes, ' entries deleted from duration');
        await insertDurations(file, id);
        try {
            // Begin transaction
            await db.runAsync('BEGIN TRANSACTION');

            // Create a temporary table with the same structure as the records table
            await db.runAsync(`
                CREATE TABLE temp_records AS
                SELECT * FROM records;
            `);

            // Update the temp_records table with the new filestart values
            await db.runAsync('UPDATE temp_records SET dateTime = (position * 1000) + ? WHERE fileID = ?', args.start, id);

            // Check if temp_records exists and drop the original records table
            const tempExists = await db.getAsync(`SELECT name FROM sqlite_master WHERE type='table' AND name='temp_records';`);

            if (tempExists) {
                // Drop the original records table
                await db.runAsync('DROP TABLE records;');
            }

            // Rename the temp_records table to replace the original records table
            await db.runAsync('ALTER TABLE temp_records RENAME TO records;');

            // Recreate the UNIQUE constraint on the new records table
            await db.runAsync(`
                CREATE UNIQUE INDEX idx_unique_record ON records (dateTime, fileID, speciesID);
            `);

            // Update the daylight flag if necessary
            let lat, lon;
            if (locationID) {
                const location = await db.getAsync('SELECT lat, lon FROM locations WHERE id = ?', locationID);
                lat = location.lat;
                lon = location.lon;
            } else {
                lat = STATE.lat;
                lon = STATE.lon;
            }

            // Collect updates to be performed on each record
            const updatePromises = [];

            db.each(`
                SELECT rowid, dateTime, fileID, speciesID, confidence, isDaylight FROM records WHERE fileID = ${id}
            `, async (err, row) => {
                if (err) {
                    throw err; // This will trigger rollback
                }
                const isDaylight = isDuringDaylight(row.dateTime, lat, lon) ? 1 : 0;
                // Update the isDaylight column for this record
                updatePromises.push(db.runAsync('UPDATE records SET isDaylight = ? WHERE isDaylight != ? AND rowid = ?', isDaylight, isDaylight, row.rowid));
            }, async (err, count) => {
                if (err) {
                    throw err; // This will trigger rollback
                }
                // Wait for all updates to finish
                await Promise.all(updatePromises);
                // Commit transaction once all rows are processed
                await db.runAsync('COMMIT');
                DEBUG && console.log(`File ${file} updated successfully.`);
                count && await Promise.all([getResults(), getSummary()]);
            });
        } catch (error) {
            // Rollback in case of error
            await db.runAsync('ROLLBACK');
            console.error(`Transaction failed: ${error.message}`);
        }
    }
};

async function onDelete({
    file,
    start,
    end,
    species,
    active,
    // need speciesfiltered because species triggers getSummary to highlight it
    speciesFiltered
}) {
    const db = STATE.db;
    const { id, filestart } = await db.getAsync('SELECT id, filestart from files WHERE name = ?', file);
    const datetime = filestart + (parseFloat(start) * 1000);
    end = parseFloat(end);
    const params = [id, datetime, end];
    let sql = 'DELETE FROM records WHERE fileID = ? AND datetime = ? AND end = ?';
    if (species) {
        sql += ' AND speciesID = (SELECT id FROM species WHERE cname = ?)'
        params.push(species);
    }
    // let test = await db.allAsync('SELECT * from records WHERE speciesID = (SELECT id FROM species WHERE cname = ?)', species)
    // console.log('After insert: ',JSON.stringify(test));
    let { changes } = await db.runAsync(sql, ...params);
    if (changes) {
        if (STATE.mode !== 'selection') {
            // Update the summary table
            if (speciesFiltered === false) {
                delete arguments[0].species
            }
            await getSummary(arguments[0]);
        }
        // Update the seen species list
        if (db === diskDB) {
            getDetectedSpecies();
        } else {
            UI.postMessage({event: 'unsaved-records'});
        }
    }
}

async function onDeleteSpecies({
    species,
    // need speciesfiltered because species triggers getSummary to highlight it
    speciesFiltered
}) {
    const db = STATE.db;
    const params = [species];
    let SQL = `DELETE FROM records 
    WHERE speciesID = (SELECT id FROM species WHERE cname = ?)`;
    if (STATE.mode === 'analyse') {
        const rows = await db.allAsync(`SELECT id FROM files WHERE NAME IN (${prepParams(STATE.filesToAnalyse)})`, ...STATE.filesToAnalyse);
        const ids = rows.map(row => row.id).join(',');
        SQL += ` AND fileID in (${ids})`;
    }
    else if (STATE.mode === 'explore') {
        const { start, end } = STATE.explore.range;
        if (start) SQL += ` AND dateTime BETWEEN ${start} AND ${end}`
    }
    let { changes } = await db.runAsync(SQL, ...params);
    if (changes) {
        if (db === diskDB) {
            // Update the seen species list
            getDetectedSpecies();
        } else {
            UI.postMessage({event: 'unsaved-records'});
        }
    }
}


async function onChartRequest(args) {
    DEBUG && console.log(`Getting chart for ${args.species} starting ${args.range.start}`);
    const dateRange = args.range, results = {}, dataRecords = {};
    // Escape apostrophes
    if (args.species) {
        t0 = Date.now();
        await getSeasonRecords(args.species, 'spring')
        .then((result) => {
            dataRecords.earliestSpring = result['minDate'];
            dataRecords.latestSpring = result['maxDate'];
        }).catch((error) => {
            console.log(error)
        })
        
        await getSeasonRecords(args.species, 'autumn')
        .then((result) => {
            dataRecords.earliestAutumn = result['minDate'];
            dataRecords.latestAutumn = result['maxDate'];
        }).catch((error) => {
            console.log(error)
        })
        
        DEBUG && console.log(`Season chart generation took ${(Date.now() - t0) / 1000} seconds`)
        t0 = Date.now();
        await getMostCalls(args.species)
        .then((row) => {
            row ? dataRecords.mostDetections = [row.count, row.date] : dataRecords.mostDetections = ['N/A', 'Not detected'];
        }).catch((error) => {
            console.log(error)
        })
        
        DEBUG && console.log(`Most calls  chart generation took ${(Date.now() - t0) / 1000} seconds`)
        t0 = Date.now();
    }
    const [dataPoints, aggregation] = await getChartTotals(args)
    .then(([rows, dataPoints, aggregation, startDay]) => {
        for (let i = 0; i < rows.length; i++) {
            const year = rows[i].Year;
            const week = rows[i].Week;
            const day = rows[i].Day;
            const hour = rows[i].Hour;
            const count = rows[i].count;
            // stack years
            if (!(year in results)) {
                results[year] = Array.from({length: dataPoints}).fill(0);
            }
            if (aggregation === 'Week') {
                results[year][parseInt(week) - 1] = count;
            } else if (aggregation === 'Day') {
                results[year][parseInt(day) - startDay] = count;
            } else {
                // const d = new Date(dateRange.start);
                // const hoursOffset = d.getHours();
                // const index = ((parseInt(day) - startDay) * 24) + (parseInt(hour) - hoursOffset);
                results[year][hour] = count;
            }
        }
        return [dataPoints, aggregation]
    }).catch((error) => {
        console.log(error)
    })
    
    DEBUG && console.log(`Chart series generation took ${(Date.now() - t0) / 1000} seconds`)
    t0 = Date.now();
    // If we have a years worth of data add total recording duration and rate
    let total, rate;
    if (dataPoints === 52) [total, rate] = await getRate(args.species)
    DEBUG && console.log(`Chart rate generation took ${(Date.now() - t0) / 1000} seconds`)
    const pointStart = dateRange.start ??= Date.UTC(2020, 0, 0, 0, 0, 0);
    UI.postMessage({
        event: 'chart-data', // Restore species name
        species: args.species ? args.species.replace("''", "'") : undefined,
        results: results,
        rate: rate,
        total: total,
        records: dataRecords,
        dataPoints: dataPoints,
        pointStart: pointStart,
        aggregation: aggregation
    })
}
async function onFileUpdated(oldName, newName){
    const newDuration = Math.round(await getDuration(newName));
    try {
        const result = await STATE.db.runAsync(`UPDATE files SET name = ? WHERE name = ? AND duration BETWEEN ? - 1 and ? + 1`, newName, oldName, newDuration, newDuration);
        if (result.changes){
            UI.postMessage({
                event: 'generate-alert', message: 'The file location was successfully updated in the database. Refresh the results to see the records.'
            });
        } else {
            UI.postMessage({
                event: 'generate-alert', type: 'error',  message: '<span class="text-danger">No changes made</span>. The selected file has a different duration to the original file.'
            });
        }
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT' && err.message.includes('UNIQUE')) {
            // Unique constraint violation, show specific error message
            UI.postMessage({
                event: 'generate-alert', type: 'warning',  
                message: '<span class="text-danger">No changes made</span>. The selected file already exists in the database.'
            });
        } else {
            // Other types of errors
            UI.postMessage({
                event: 'generate-alert', type: 'error',  
                message: `<span class="text-danger">An error occurred while updating the file: ${err.message}</span>`
            });
        }
    }
}

const onFileDelete = async (fileName) => {
    const result = await diskDB.runAsync('DELETE FROM files WHERE name = ?', fileName);
    if (result.changes) {
        //await onChangeMode('analyse');
        getDetectedSpecies();
        UI.postMessage({
            event: 'generate-alert',
            message: `${fileName} 
            and its associated records were deleted successfully`,
            updateFilenamePanel: true
        });
        await Promise.all([getResults(), getSummary()] );
    } else {
        UI.postMessage({
            event: 'generate-alert', message: `${fileName} 
            was not found in the Archive database.`
        });
    }
}
    
async function onUpdateLocale(locale, labels, refreshResults){
    let t0 = performance.now();
    await diskDB.runAsync('BEGIN');
    await memoryDB.runAsync('BEGIN');
    if (STATE.model === 'birdnet'){
        for (let i = 0; i < labels.length; i++){
            const [sname, cname] = labels[i].trim().split('_');
            await diskDB.runAsync('UPDATE species SET cname = ? WHERE sname = ?', cname, sname);
            await memoryDB.runAsync('UPDATE species SET cname = ? WHERE sname = ?', cname, sname);
        }
    } else {
        for (let i = 0; i < labels.length; i++) {
            const [sname, newCname] = labels[i].split('_');
            // For chirpity, we check if the existing cname ends with a <call type> in brackets
            const existingCnameResult = await memoryDB.allAsync('SELECT cname FROM species WHERE sname = ?', sname);
            if (existingCnameResult.length) {
                for (let i = 0; i < existingCnameResult.length; i++){
                    const {cname} = existingCnameResult[i];
                    const existingCname = cname;
                    const existingCnameMatch = existingCname.match(/\(([^)]+)\)$/); // Regex to match word(s) within brackets at the end of the string
                    const newCnameMatch = newCname.match(/\(([^)]+)\)$/);
                    // Do we have a specific call type to match?
                    if (newCnameMatch){
                        // then only update the database where existing and new call types match
                        if (newCnameMatch[0] === existingCnameMatch[0]){
                            const callTypeMatch = '%' + newCnameMatch[0] + '%' ;
                            await diskDB.runAsync("UPDATE species SET cname = ? WHERE sname = ? AND cname LIKE ?", newCname, sname, callTypeMatch);
                            await memoryDB.runAsync("UPDATE species SET cname = ? WHERE sname = ? AND cname LIKE ?", newCname, sname, callTypeMatch);
                        }
                    } else { // No (<call type>) in the new label - so we add the new name to all the species call types in the database
                        let appendedCname = newCname, bracketedWord;
                        if (existingCnameMatch) {
                            bracketedWord = existingCnameMatch[0];
                            appendedCname += ` ${bracketedWord}`; // Append the bracketed word to the new cname (for each of the existingCnameResults)
                            const callTypeMatch = '%' + bracketedWord + '%';
                            await diskDB.runAsync("UPDATE species SET cname = ? WHERE sname = ? AND cname LIKE ?", appendedCname, sname, callTypeMatch);
                            await memoryDB.runAsync("UPDATE species SET cname = ? WHERE sname = ? AND cname LIKE ?", appendedCname, sname, callTypeMatch);
                        } else {
                            await diskDB.runAsync("UPDATE species SET cname = ? WHERE sname = ?", appendedCname, sname);
                            await memoryDB.runAsync("UPDATE species SET cname = ? WHERE sname = ?", appendedCname, sname);
                        }
                    }
                }
            }
        }
    }
    await diskDB.runAsync('END');
    await memoryDB.runAsync('END');
    STATE.update({locale: locale});
    if (refreshResults) await Promise.all([getResults(), getSummary()])
}
    
async function onSetCustomLocation({ lat, lon, place, files, db = STATE.db }) {
    if (!place) {
        const { id } = await db.getAsync(`SELECT id FROM locations WHERE lat = ? AND lon = ?`, lat, lon);
        const result = await db.runAsync(`DELETE FROM locations WHERE lat = ? AND lon = ?`, lat, lon);
        if (result.changes) {
            await db.runAsync(`UPDATE files SET locationID = null WHERE locationID = ?`, id);
        }
    } else {
        const result = await db.runAsync(`
        INSERT INTO locations VALUES (?, ?, ?, ?)
        ON CONFLICT(lat,lon) DO UPDATE SET place = excluded.place`, undefined, lat, lon, place);
        const { id } = await db.getAsync(`SELECT ID FROM locations WHERE lat = ? AND lon = ?`, lat, lon);
        for (const file of files) {
            await db.runAsync('UPDATE files SET locationID = ? WHERE name = ?', id, file);
            // we may not have set the METADATA for the file
            if (METADATA[file]) {
                METADATA[file].locationID = id; 
            } else {
                METADATA[file] = {}
                METADATA[file].locationID = id;
            }
            // tell the UI the file has a location id
            UI.postMessage({ event: 'file-location-id', file: file, id: id });
        }
    }
    await getLocations({ db: db, file: files[0] });
}
    
async function getLocations({ db = STATE.db, file }) {
    const locations = await db.allAsync('SELECT * FROM locations ORDER BY place');
    locations ??= [];
    UI.postMessage({ event: 'location-list', locations: locations, currentLocation: METADATA[file]?.locationID })
}
    
/**
 * getIncludedIDs
 * Helper function to provide a list of valid species for the filter. 
 * Will look for a list in the STATE.included cache, and if not present, 
 * will call setIncludedIDs to generate a new list
 * @param {*} file 
 * @returns a list of IDs included in filtered results
 */
async function getIncludedIDs(file){
    t0 = Date.now();
    let lat, lon, week, hitOrMiss = 'hit';
    if (STATE.list === 'location' || (STATE.list === 'nocturnal' && STATE.local)){
        if (file){
            file = METADATA[file];
            week = STATE.useWeek ? new Date(file.fileStart).getWeekNumber() : "-1";
            lat = file.lat || STATE.lat;
            lon = file.lon || STATE.lon;
            STATE.week = week;
        } else {
            // summary context: use the week, lat & lon from the first file??
            lat = STATE.lat, lon = STATE.lon;
            week = STATE.useWeek ? STATE.week : "-1";
        }
        const location = lat.toString() + lon.toString();
        if (STATE.included?.[STATE.model]?.[STATE.list]?.[week]?.[location] === undefined ) {
            // Cache miss
            const list = await setIncludedIDs(lat,lon,week)
            hitOrMiss = 'miss';
        } 
        //DEBUG && console.log(`Cache ${hitOrMiss}: setting the ${STATE.list} list took ${Date.now() -t0}ms`)
        return STATE.included[STATE.model][STATE.list][week][location];
        
    } else {
        if (STATE.included?.[STATE.model]?.[STATE.list] === undefined) {
            // The object lacks the week / location
            LIST_WORKER && await setIncludedIDs();
            hitOrMiss = 'miss';
        }
        //DEBUG && console.log(`Cache ${hitOrMiss}: setting the ${STATE.list} list took ${Date.now() -t0}ms`)
        return STATE.included[STATE.model][STATE.list];
    }
}

/**
 * setIncludedIDs
 * Calls list_worker for a new list, checks to see if a pending promise already exists
 * @param {*} lat 
 * @param {*} lon 
 * @param {*} week 
 * @returns 
 */

let LIST_CACHE = {};

async function setIncludedIDs(lat, lon, week) {
    const key = `${lat}-${lon}-${week}-${STATE.model}-${STATE.list}`;
    if (LIST_CACHE[key]) {
        // If a promise is in the cache, return it
        return await LIST_CACHE[key];
    }
    console.log('calling for a new list')
    // Store the promise in the cache immediately
    LIST_CACHE[key] = (async () => {
        const { result, messages } = await LIST_WORKER({
            message: 'get-list',
            model: STATE.model,
            listType: STATE.list,
            customList: STATE.customList,
            lat: lat || STATE.lat,
            lon: lon || STATE.lon,
            week: week || STATE.week,
            useWeek: STATE.useWeek,
            localBirdsOnly: STATE.local,
            threshold: STATE.speciesThreshold
        });
        // Add the index of "Unknown Sp." to all lists
        STATE.list !== 'everything' && result.push(LABELS.length - 1)
        
        let includedObject = {};
        if (STATE.list === 'location' || (STATE.list === 'nocturnal' && STATE.local)){
            const location = lat.toString() + lon.toString();
            includedObject = {
                [STATE.model]: {
                    [STATE.list]: {
                        [week]: {
                            [location]: result
                        }
                    }
                }
            };
        } else {
            includedObject = {
                [STATE.model]: {
                    [STATE.list]: result
                }
            };
        }

        if (STATE.included === undefined) STATE.included = {}
        STATE.included = merge(STATE.included, includedObject);
        messages.forEach(message => generateAlert({type: 'warning',  message: message} ))
        return STATE.included;
    })();

    // Await the promise
    return await LIST_CACHE[key];
}

///////// Database compression and archive ////



const pLimit = require('p-limit');

async function convertAndOrganiseFiles(threadLimit) {
    // SANITY checks: archive location exists and is writeable?
    if (!fs.existsSync(STATE.archive.location)) {
        generateAlert({type: 'error',  message: `Cannot access archive location: ${STATE.archive.location}. <br> Operation aborted`});
        return false;
    }
    try {
        fs.accessSync(STATE.archive.location, fs.constants.W_OK);
    } catch {
        generateAlert({type: 'error',  message: `Cannot write to archive location: ${STATE.archive.location}. <br> Operation aborted`});
        return false;
    }
    threadLimit ??= 4; // Set a default
    const limit = pLimit(threadLimit);

    const db = diskDB;
    const fileProgressMap = {};
    const conversions = []; // Array to hold the conversion promises

    // Query the files table to get the necessary data
    const rows = await db.allAsync("SELECT f.id, f.name, f.duration, f.filestart, l.place FROM files f LEFT JOIN locations l ON f.locationID = l.id");

    for (const row of rows){
        row.place ??= STATE.place;
        const fileDate = new Date(row.filestart);
        const year = String(fileDate.getFullYear());
        const month = fileDate.toLocaleString('default', { month: 'long' });
        const place = row.place?.replace(/[\/\\?%*:|"<>]/g, '_').trim();

        const inputFilePath = row.name;
        const outputDir = p.join(place, year, month);
        const outputFileName = p.basename(inputFilePath, p.extname(inputFilePath)) + '.' + STATE.archive.format;
        const fullPath = p.join(STATE.archive.location, outputDir);
        const fullFilePath = p.join(fullPath, outputFileName);
        const dbArchiveName = p.join(outputDir, outputFileName);

        // Does the file we want to convert exist?
        if (!fs.existsSync(inputFilePath)) {
            UI.postMessage({
                event: 'generate-alert', type: 'warning', 
                message: `Cannot access: ${inputFilePath}<br>Skipping conversion.`
            });
            continue;
        }

        const {archiveName} = await db.getAsync('SELECT archiveName FROM files WHERE name = ?', inputFilePath);
        if (archiveName === dbArchiveName && fs.existsSync(fullFilePath)) {
            // TODO: just check for the file, if archvive name is null, add archive name to the db (if it is complete)
            DEBUG && console.log(`File ${inputFilePath} already converted. Skipping conversion.`);
            continue;
        }

        if (!fs.existsSync(fullPath)) {
            try {
                fs.mkdirSync(fullPath, { recursive: true });
            } catch (err) {
                UI.postMessage({
                    event: 'generate-alert', type: 'error', 
                    message: `Failed to create directory: ${fullPath}<br>Error: ${err.message}`
                });
                continue;
            }
        }

        // Add the file conversion to the pool
        fileProgressMap[inputFilePath] = 0;
        conversions.push(limit(() => convertFile(inputFilePath, fullFilePath, row, db, dbArchiveName, fileProgressMap)));

    }
    
    Promise.allSettled(conversions).then((results) => {
        // Oftentimes, the final percent.progress reported is < 100. So when finished, send 100 so the progress panel can be hidden
        UI.postMessage({
            event: 'conversion-progress',
            progress: { percent: 100 },
            text: ''
        });
        // Summarise the results
        let successfulConversions = 0;
        let failedConversions = 0;
        let failureReasons = [];

        results.forEach((result) => {
            if (result.status === 'fulfilled') {
                successfulConversions++;
            } else {
                failedConversions++;
                failureReasons.push(result.reason);  // Collect the reason for the failure
            }
        });
        const attempted  = successfulConversions + failedConversions;
        // Create a summary message
        let summaryMessage;
        let type = 'info';
        
        if (attempted) {
           summaryMessage = `Processing complete: ${successfulConversions} successful, ${failedConversions} failed.`;
           if (failedConversions > 0) {
                type = 'warning';
                summaryMessage += `<br>Failed conversion reasons:<br><ul>`;
                failureReasons.forEach(reason => {
                    summaryMessage += `<li>${reason}</li>`;
                });
                summaryMessage += `</ul>`;
            }
        } else { summaryMessage = 'Library is up to date. Nothing to do'}

        // Post the summary message
        UI.postMessage({
            event: `generate-alert`, type: type,
            message: summaryMessage
        });
    })
};

async function convertFile(inputFilePath, fullFilePath, row, db, dbArchiveName, fileProgressMap) {
    METADATA[inputFilePath] || await setMetadata({file: inputFilePath});
    const boundaries = await setStartEnd(inputFilePath);

    return new Promise((resolve, reject) => {
        let command = ffmpeg('file:' + inputFilePath)
    
        if (STATE.archive.format === 'ogg') {
            command.audioBitrate('128k')
                .audioChannels(1) // Set to mono
                .audioFrequency(26_000) // Set sample rate for BirdNET
        }
    
        let scaleFactor = 1;
        if (STATE.archive.trim) {
            if (boundaries.length > 1) { 
                generateAlert({type: 'warning',  message: `Multi-day operations are not yet supported: ${inputFilePath} will not be trimmed`});
            } else {
                const {start, end} = boundaries[0];
                if (start === end) {
                    generateAlert({type: 'warning', message: `${inputFilePath} will not be added to the archive as it is entirely during daylight.`});
                    return resolve();
                }
                command.seekInput(start).duration(end - start);
                scaleFactor = row.duration / (end-start);
                row.duration = end - start;
            }
        }
        command.output(fullFilePath)
            .on('start', function (commandLine) {
                DEBUG && console.log('FFmpeg command: ' + commandLine);
            })
            .on('end', () => {
                const newfileMtime = new Date(Math.round(row.filestart + (row.duration * 1000)));
                utimesSync(fullFilePath, {atime: Date.now(), mtime: newfileMtime});

                db.run("UPDATE files SET archiveName = ? WHERE id = ?", [dbArchiveName, row.id], (err) => {
                    if (err) {
                        console.error("Error updating the database:", err);
                    } else {
                        generateAlert({message: `Finished conversion for ${inputFilePath}`});
                    }
                    resolve();
                });
            })
            .on('error', (err) => {
                generateAlert({type: 'error',  message: `Error converting file ${inputFilePath}:`, err});
                reject(err);
            })
            .on('progress', (progress) => {
                if (!isNaN(progress.percent)) {
                    fileProgressMap[inputFilePath] = progress.percent * scaleFactor;
                    const values = Object.values(fileProgressMap);
                    const sum = values.reduce((accumulator, currentValue) => accumulator + currentValue, 0);
                    const average = sum / values.length;
                    UI.postMessage({
                        event: `conversion-progress`,
                        progress: { percent: average },
                        text: `Archive file conversion progress: ${average.toFixed(1)}%`
                    });
                }
            })
            .run();
    });
}
