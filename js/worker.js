const {ipcRenderer} = require('electron');
const fs = require('fs');
const wavefileReader = require('wavefile-reader');
const p = require('path');
let BATCH_SIZE;
const adding_chirpity_additions = true;
let labels;
const sqlite3 = require('sqlite3').verbose();

sqlite3.Database.prototype.runAsync = function (sql, ...params) {
    return new Promise((resolve, reject) => {
        this.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
};

sqlite3.Database.prototype.allAsync = function (sql, ...params) {
    return new Promise((resolve, reject) => {
        this.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
};

sqlite3.Database.prototype.getAsync = function (sql, ...params) {
    return new Promise((resolve, reject) => {
        this.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
};

const SunCalc = require('suncalc2');
const ffmpeg = require('fluent-ffmpeg');
const png = require('fast-png');
const {writeFile, mkdir, readdir} = require('node:fs/promises');
const {utimes} = require('utimes');
const stream = require("stream");
const file_cache = 'chirpity';
let TEMP, appPath, CACHE_LOCATION;

const staticFfmpeg = require('ffmpeg-static-electron');
const {stat} = require("fs/promises");
const {mem} = require("systeminformation");
console.log(staticFfmpeg.path);
ffmpeg.setFfmpegPath(staticFfmpeg.path);

let predictionsRequested = 0, predictionsReceived = 0;
let COMPLETED = [], OPENFILES = [];
let diskDB, memoryDB, NOCMIG, latitude, longitude;

let t0; // Application profiler

//Object will hold files in the diskDB, and the active timestamp from the most recent selection analysis.
let STATE;
const setState = () => {
    STATE = {
        db: undefined,
        saved: new Set(), // list of files requested that are in the disk database
        activeTimestamp: undefined, // Active Timestamp from most recent selection ID / active row
        globalOffset: 0, // Current start number for unfiltered results
        filteredOffset: {} // Current species start number for filtered results

    }
}
setState();

const createDB = async (file) => {
    const archiveMode = !!file;
    if (file) {
        fs.openSync(file, "w");
        diskDB = new sqlite3.Database(file);
        console.log("Created disk database", diskDB.filename);
    } else {
        memoryDB = new sqlite3.Database(':memory:');
        console.log("Created new in-memory database");
    }
    const db = archiveMode ? diskDB : memoryDB;
    await db.runAsync('BEGIN');
    await db.runAsync('CREATE TABLE species(id INTEGER PRIMARY KEY, sname TEXT, cname TEXT)');
    await db.runAsync('CREATE TABLE files(name TEXT,duration  REAL,filestart INTEGER, UNIQUE (name))');
    await db.runAsync('CREATE TABLE duration(day INTEGER, duration INTEGER, fileID INTEGER,UNIQUE (day, fileID))');
    await db.runAsync(`CREATE TABLE records
                       (
                           dateTime INTEGER,
                           birdID1  INTEGER,
                           birdID2  INTEGER,
                           birdID3  INTEGER,
                           conf1    REAL,
                           conf2    REAL,
                           conf3    REAL,
                           fileID   INTEGER,
                           position INTEGER,
                           label    TEXT,
                           comment  TEXT,
                           UNIQUE (dateTime, fileID)
                       )`);
    if (archiveMode) {
        for (let i = 0; i < labels.length; i++) {
            const [sname, cname] = labels[i].replaceAll("'", "''").split('_');
            await db.runAsync(`INSERT INTO species
                               VALUES (${i}, '${sname}', '${cname}')`);
        }
    } else {
        const filename = diskDB.filename;
        let {code} = await db.runAsync(`ATTACH '${filename}' as disk`);
        // If the db is not ready
        while (code === "SQLITE_BUSY") {
            console.log("Disk DB busy")
            setTimeout(() => {
            }, 10);
            let response = await db.runAsync(`ATTACH '${filename}' as disk`);
            code = response.code;
        }
        let response = await db.runAsync('INSERT INTO files SELECT * FROM disk.files');
        console.log(response.changes + ' files added to memory database')
        response = await db.runAsync('INSERT INTO species SELECT * FROM disk.species');
        console.log(response.changes + ' species added to memory database')
    }
    await db.runAsync('END');
}

async function loadDB(path) {
    // Ensure we're using the db for the number of labels we have in the model
    if (path) {
        const file = p.join(path, `archive${labels.length}.sqlite`)
        if (!fs.existsSync(file)) {
            await createDB(file);
        } else {
            diskDB = new sqlite3.Database(file);
            console.log("Opened disk db " + file)
        }
    } else {
        await createDB();
    }
    return true
}

let metadata = {};
let minConfidence, index = 0, AUDACITY = {}, predictionStart;
let sampleRate = 24000;  // Value obtained from model.js CONFIG, however, need default here to permit file loading before model.js response
let predictWorker, predicting = false, predictionDone = false, aborted = false;

// Set up the audio context:
const audioCtx = new AudioContext({latencyHint: 'interactive', sampleRate: sampleRate});

let UI;
let FILE_QUEUE = [];


const dirInfo = async ({folder = undefined, recursive = false}) => {
    const files = await readdir(folder, {withFileTypes: true});
    const ctimes = [];
    const paths = files.map(async file => {
        const path = p.join(folder, file.name);
        if (file.isDirectory()) {
            if (recursive) {
                return await dirInfo({folder: path, recursive: true})
            } else {
                return 0
            }
        }
        if (file.isFile() || file.isSymbolicLink()) {
            const {size, ctimeMs} = await stat(path);
            ctimes.push([path, ctimeMs, size]);
            return size

        }
        return 0;
    });
    const size = (await Promise.all(paths)).flat(Infinity).reduce((i, size) => i + size, 0);
    // Newest to oldest file, so we can pop the list (faster)
    ctimes.sort((a, b) => {
        return a[1] - b[1]
    })
    //console.table(ctimes);
    return [size, ctimes];
}

const clearCache = async (fileCache, sizeLimitInGB, message) => {
    // Cache size
    let [size, ctimes] = await dirInfo({folder: fileCache});
    const requiredSpace = sizeLimitInGB * 1024 ** 3;
    // If Full, clear at least 25% of cache, so we're not doing this too frequently
    let newSize;
    if (size > requiredSpace) {
        // while (size > requiredSpace && COMPLETED.length) {
        while (COMPLETED.length > 1) {
            const file = COMPLETED.shift();
            const proxy = metadata[file].proxy;
            // Make sure we don't delete original files!
            if (proxy !== file) {
                const stat = fs.lstatSync(proxy);
                // Remove tmp file from metadata
                fs.rmSync(proxy, {force: true});
                // Delete the metadata
                delete metadata[file];
                console.log(`removed ${file} from cache`);
                size -= stat.size;
            }
        }
        if (!COMPLETED.length) {
            console.log('All completed files removed from cache')
            // Cache still full?
            if (size > requiredSpace) {
                console.log('Cache still full')
            }
        }
        return true
    }
    return false
}

ipcRenderer.on('new-client', (event) => {
    [UI] = event.ports;
    UI.onmessage = async (e) => {
        const args = e.data;
        const action = args.action;
        console.log('message received ', action)
        switch (action) {
            case 'set-variables':
                // This pattern to only update variables that have values
                latitude = args.lat || latitude;
                longitude = args.lon || longitude;
                // Boolean value an issue with this pattern so...
                if (Object.keys(args).includes('nocmig')) NOCMIG = args.nocmig;
                minConfidence = args.confidence || minConfidence;
                TEMP = args.temp || TEMP;
                appPath = args.path || appPath;
                break;
            case 'clear-cache':
                CACHE_LOCATION = p.join(TEMP, 'chirpity');
                if (!fs.existsSync(CACHE_LOCATION)) fs.mkdirSync(CACHE_LOCATION);
                await clearCache(CACHE_LOCATION, 0);  // belt and braces - in dev mode, ctrl-c in console will prevent cache clear on exit
                break;
            case 'open-files':
                await getFiles(args.files)
                break;
            case 'update-record':
                await onUpdateRecord(args)
                break;
            case 'delete':
                await onDelete(args)
                break;
            case 'update-file-start':
                await onUpdateFileStart(args)
                break;
            case 'get-detected-species-list':
                getSpecies(diskDB, args.range);
                break;
            case 'create-dataset':
                saveResults2DataSet();
                break;
            case 'load-model':
                UI.postMessage({event: 'spawning'});
                BATCH_SIZE = parseInt(args.batchSize);
                if (predictWorker) predictWorker.terminate();
                spawnWorker(args.model, args.list, BATCH_SIZE, args.warmup);
                break;
            case 'update-model':
                predictWorker.postMessage({message: 'list', list: args.list})
                break;
            case 'file-load-request':
                index = 0;
                if (predicting) onAbort(args);

                STATE['db'] = memoryDB;
                console.log('Worker received audio ' + args.file);
                predictionsRequested = 0;
                predictionsReceived = 0;
                await loadAudioFile(args);
                break;
            case 'update-buffer':
                await loadAudioFile(args);
                break;
            case 'filter':
                await getResults(args);
                await getSummary(args);
                break;
            case 'explore':
                STATE['db'] = diskDB;
                args.context = 'explore';
                args.explore = true;
                await getResults(args);
                await getSummary(args);
                break;
            case 'analyse':
                // Create a new memory db unless we're looking at a selection
                if (!args.end) await createDB();
                predictionsReceived = 0;
                predictionsRequested = 0;
                await onAnalyse(args);
                break;
            case 'save':
                console.log("file save requested")
                await saveMP3(args.file, args.start, args.end, args.filename, args.metadata);
                break;
            case 'post':
                await uploadOpus(args);
                break;
            case 'save2db':
                await onSave2DiskDB();
                break;
            case 'abort':
                onAbort(args);
                break;
            case 'chart':
                await onChartRequest(args);
                break;
            default:
                UI.postMessage('Worker communication lines open')
        }
    }
})


const getFiles = async (files) => {
    let file_list = [];
    for (let i = 0; i < files.length; i++) {
        const stats = fs.lstatSync(files[i])
        if (stats.isDirectory()) {
            const dirFiles = await getFilesInDirectory(files[i])
            file_list = file_list.concat(dirFiles)
        } else {
            file_list.push(files[i])
        }
    }
    UI.postMessage({event: 'files', filePaths: file_list});
}

// Get a list of files in a folder and subfolders
const getFilesInDirectory = async dir => {
    const files = await readdir(dir, {withFileTypes: true});
    let file_map = files.map(async file => {
        const path = p.join(dir, file.name);
        if (file.isDirectory()) return await getFilesInDirectory(path);
        if (file.isFile() || file.isSymbolicLink()) {
            return path
        }
        return 0;
    });
    file_map = (await Promise.all(file_map)).flat(Infinity)
    return file_map
}


// No need to pass through arguments object, so arrow function used.

// Not an arrow function. Async function has access to arguments - so we can pass them to processnextfile
async function onAnalyse({
                             filesInScope = [],
                             currentFile = undefined,
                             start = 0,
                             end = undefined,
                             resetResults = false,
                             reanalyse = false,
                             confidence = minConfidence,
                             list = 'everything'
                         }) {

    const selection = !!end; // if end was passed, this is a selection
    console.log(`Worker received message: ${filesInScope}, ${confidence}, start: ${start}, end: ${end}, list ${list}`);
    minConfidence = confidence;
    predictWorker.postMessage({message: 'list', list: list})
    //Set global filesInScope for summary to use
    OPENFILES = filesInScope;
    index = 0;
    AUDACITY = {};

    COMPLETED = [];
    UI.postMessage('reset-results');
    const toAnalyse = currentFile ? [currentFile] : filesInScope;

    if (!selection && !reanalyse) {
        // check if results for the files are cached (we only consider it cached if all files have been saved to the disk DB)
        let allCached = true;
        for (let i = 0; i < toAnalyse.length; i++) {
            if (!await isDuplicate(toAnalyse[i])) {
                allCached = false;
                break;
            }
        }
        if (allCached) {
            STATE.db = diskDB;
            await getResults({db: diskDB, files: toAnalyse});
            await getSummary({files: toAnalyse})
            return
        }
    }
    STATE.db = memoryDB;
    for (let i = 0; i < toAnalyse.length; i++) {
        let file = toAnalyse[i];
        // Set global var, for parsePredictions
        FILE_QUEUE.push(file);
        console.log(`Adding ${file} to the queue.`)
        if (!predicting) {
            // Clear state unless analysing a selection
            if (!selection) setState();
            predicting = true;
            await processNextFile(arguments[0]);
        }
    }
}

function onAbort({
                     model = 'efficientnet', list = 'migrants', warmup = true
                 }) {
    aborted = true;
    FILE_QUEUE = [];
    index = 0;
    console.log("abort received")
    if (predicting) {
        //restart the worker
        UI.postMessage({event: 'spawning'});
        predictWorker.terminate()
        spawnWorker(model, list, BATCH_SIZE, warmup)
    }
    predicting = false;
    predictionDone = true;
    predictionsReceived = 0;
    predictionsRequested = 0;
    UI.postMessage({event: 'prediction-done', batchInProgress: true});
}

const getDuration = async (src) => {
    let audio;
    return new Promise(function (resolve) {
        audio = new Audio();
        audio.src = src;
        audio.addEventListener("loadedmetadata", function () {
            const duration = audio.duration
            audio = null;
            // Tidy up - cloning removes event listeners
            const old_element = document.getElementById("audio");
            const new_element = old_element.cloneNode(true);
            old_element.parentNode.replaceChild(new_element, old_element);

            resolve(duration);
        });
    });
}

const convertFileFormat = (file, destination, size, error) => {
    return new Promise(function (resolve) {
        const sampleRate = 24000, channels = 1, bitDepth = 2;
        let totalTime, finalSizeInGB;
        ffmpeg(file)
            .audioChannels(channels)
            .audioFrequency(sampleRate)
            .on('error', (err) => {
                console.log('An error occurred: ' + err.message);
                if (err) {
                    error(err.message);
                }
            })
            // Handle progress % being undefined
            .on('codecData', async data => {
                // HERE YOU GET THE TOTAL TIME
                totalTime = parseInt(data.duration.replace(/:/g, ''))
            })
            .on('progress', (progress) => {
                // HERE IS THE CURRENT TIME
                const time = parseInt(progress.timemark.replace(/:/g, ''))

                // AND HERE IS THE CALCULATION
                const percent = (time / totalTime) * 100
                console.log('Processing: ' + percent + ' % converted');
                UI.postMessage({
                    event: 'progress', text: 'Decompressing file', progress: percent / 100
                })
            })
            .on('end', () => {
                UI.postMessage({event: 'progress', text: 'File decompressed', progress: 1.0})
                resolve(destination)
            })
            .save(destination)
    });
}

/**
 * getWorkingFile called by loadAudioFile, getPredictBuffers, fetchAudioBuffer and processNextFile
 * purpose is to create a wav file from the source file and set its metadata. If the file *is* a wav file, it returns
 * that file, else it checks for a temp wav file, if not found it calls convertFileFormat to extract
 * and create a wav file in the users temp folder and returns that file's path. The flag for this file is set in the
 * metadata object as metadata[file].proxy
 *
 * @param file: full path to source file
 * @returns {Promise<boolean|*>}
 */
async function getWorkingFile(file) {
    if (metadata[file] && metadata[file].isComplete && metadata[file].proxy) return metadata[file].proxy;
    // find the file
    const source_file = fs.existsSync(file) ? file : await locateFile(file);
    if (!source_file) return false;
    let proxy = source_file;

    if (!source_file.endsWith('.wav')) {
        const pc = p.parse(source_file);
        const filename = pc.base.replace(pc.ext, '.wav');
        const destination = p.join(TEMP, file_cache, filename);
        if (fs.existsSync(destination)) {
            proxy = destination;
        } else {
            // get some metadata from the source file
            const statsObj = fs.statSync(source_file);
            const sourceMtime = statsObj.mtime;

            //console.log(Date.UTC(sourceMtime));

            proxy = await convertFileFormat(source_file, destination, statsObj.size, function (errorMessage) {
                console.log(errorMessage);
                return true;
            });
            // assign the source file's save time to the proxy file
            await utimes(proxy, sourceMtime.getTime());
        }
    }
    if (!metadata[file] || !metadata[file].isComplete) {
        await getMetadata({file: file, proxy: proxy, source_file: source_file});
    }
    return proxy;
}

/**
 * Function to return path to file searching for new extensions if original file has been compressed.
 * @param file
 * @returns {Promise<*>}
 */
async function locateFile(file) {
    // Ordered from the highest likely quality to lowest
    const supported_files = ['.wav', '.flac', '.opus', '.m4a', '.mp3', '.mpga', '.ogg', '.aac', '.mpeg', '.mp4'];
    const dir = p.parse(file).dir, name = p.parse(file).name;
    // Check folder exists before trying to traverse it. If not, return empty list
    let [, folderInfo] = fs.existsSync(dir) ?
        await dirInfo({folder: dir, recursive: false}) : ['', []];
    let filesInFolder = [];
    folderInfo.forEach(item => {
        filesInFolder.push(item[0])
    })
    let supportedVariants = []
    supported_files.forEach(ext => {
        supportedVariants.push(p.join(dir, name + ext))
    })
    const matchingFileExt = supportedVariants.find(variant => {
        const matching = (file) => variant.toLowerCase() === file.toLowerCase();
        return filesInFolder.some(matching)
    })
    if (!matchingFileExt) {
        UI.postMessage({
            event: 'generate-alert', message: `Unable to load source file with any supported file extension: ${file}`
        })
        return false;
    }
    return matchingFileExt;
}

async function loadAudioFile({
                                 file = '', start = 0, end = 20, position = 0, region = false, doubleBuffer = false
                             }) {
    const found = await getWorkingFile(file);
    if (found) {
        await fetchAudioBuffer({file, start, end})
            .then((buffer) => {
                const length = buffer.length;
                const myArray = buffer.getChannelData(0);
                UI.postMessage({
                    event: 'worker-loaded-audio',
                    fileStart: metadata[file].fileStart,
                    sourceDuration: metadata[file].duration,
                    bufferBegin: start,
                    file: file,
                    position: position,
                    length: length,
                    contents: myArray,
                    region: region,
                    doubleBuffer: doubleBuffer
                });
            })
            .catch(e => {
                console.log('e');
            })
    }
}


function addDays(date, days) {
    let result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

/**
 * Called by getWorkingFile, setStartEnd??,
 * Assigns file metadata to a metadata cache object. file is the key, and is the source file
 * proxy is required if the source file is not a wav to populate the headers
 * @param file: the file name passed to the worker
 * @param proxy: the wav file to use for predictions
 * @param source_file: the file that exists ( will be different after compression)
 * @returns {Promise<unknown>}
 */
const getMetadata = async ({file, proxy = file, source_file = file}) => {
    metadata[file] = {proxy: proxy};
    // CHeck the database first, so we honour any manual update.
    const savedMeta = await getFileInfo(file);
    metadata[file].duration = savedMeta && savedMeta.duration ? savedMeta.duration : await getDuration(proxy);

    return new Promise((resolve) => {
        if (metadata[file] && metadata[file].isComplete) {
            resolve(metadata[file])
        } else {
            let fileStart, fileEnd;
            if (savedMeta && savedMeta.filestart) {
                fileStart = new Date(savedMeta.filestart);
                fileEnd = new Date(fileStart.getTime() + (metadata[file].duration * 1000));
            } else {
                metadata[file].stat = fs.statSync(source_file);
                fileEnd = new Date(metadata[file].stat.mtime);
                fileStart = new Date(metadata[file].stat.mtime - (metadata[file].duration * 1000));
            }

            // split  the duration of this file across any dates it spans
            metadata[file].dateDuration = {};
            const key = new Date(fileStart);
            key.setHours(0, 0, 0, 0);
            const keyCopy = addDays(key, 0).getTime();
            if (fileStart.getDate() === fileEnd.getDate()) {
                metadata[file].dateDuration[keyCopy] = metadata[file].duration;
            } else {
                const key2 = addDays(key, 1);

                const key2Copy = addDays(key2, 0).getTime();
                metadata[file].dateDuration[keyCopy] = (key2Copy - fileStart) / 1000;
                metadata[file].dateDuration[key2Copy] = metadata[file].duration - metadata[file].dateDuration[keyCopy];
            }
            // Now we have completed the date comparison above, we convert fileStart to millis
            fileStart = fileStart.getTime();
            // Add dawn and dusk for the file to the metadata
            let astro = SunCalc.getTimes(fileStart, latitude, longitude);
            metadata[file].dusk = astro.dusk.getTime();
            // If file starts after dark, dawn is next day
            if (fileStart > astro.dusk.getTime()) {
                astro = SunCalc.getTimes(fileStart + 8.47e+7, latitude, longitude);
                metadata[file].dawn = astro.dawn.getTime();
            } else {
                metadata[file].dawn = astro.dawn.getTime();
            }
            // We use proxy here as the file *must* be a wav file
            const readStream = fs.createReadStream(proxy);
            readStream.on('data', async chunk => {
                let wav = new wavefileReader.WaveFileReader();
                wav.fromBuffer(chunk);
                // Extract Header
                let headerEnd;
                wav.signature.subChunks.forEach(el => {
                    if (el['chunkId'] === 'data') {
                        headerEnd = el.chunkData.start;
                    }
                });
                // Update relevant file properties
                metadata[file].head = headerEnd;
                metadata[file].header = chunk.slice(0, headerEnd)
                metadata[file].bytesPerSec = wav.fmt.byteRate;
                metadata[file].numChannels = wav.fmt.numChannels;
                metadata[file].sampleRate = wav.fmt.sampleRate;
                metadata[file].bitsPerSample = wav.fmt.bitsPerSample
                metadata[file].fileStart = fileStart;
                // Set complete flag
                metadata[file].isComplete = true;
                readStream.close()
                return resolve(metadata[file]);
            });
            readStream.on('error', err => {
                console.log('readstream error:' + err)
            })
        }
    })
}

const convertTimeToBytes = (time, metadata) => {
    const bytesPerSample = metadata.bitsPerSample / 8;
    // get the nearest sample start - they can be 2,3 or 4 bytes representations. Then add the header offest
    return (Math.round((time * metadata.bytesPerSec) / bytesPerSample) * bytesPerSample) + metadata.head;
}

async function setupCtx(chunk, header) {
    // Deal with detached arraybuffer issue
    let audioBufferChunk;
    try {
        chunk = Buffer.concat([header, chunk]);
        audioBufferChunk = await audioCtx.decodeAudioData(chunk.buffer);
    } catch {
        return false
    }

    const source = audioCtx.createBufferSource();
    source.buffer = audioBufferChunk;
    const duration = source.buffer.duration;
    const buffer = source.buffer;
    const offlineCtx = new OfflineAudioContext(1, sampleRate * duration, sampleRate);
    const offlineSource = offlineCtx.createBufferSource();
    offlineSource.buffer = buffer;
    offlineSource.connect(offlineCtx.destination);
    offlineSource.start();
    return offlineCtx;
}

/**
 *
 * @param file
 * @param start
 * @param end
 * @param resetResults
 * @returns {Promise<void>}
 */
const getPredictBuffers = async ({
                                     file = '', start = 0, end = undefined, resetResults = false
                                 }) => {
    //let start = args.start, end = args.end, resetResults = args.resetResults, file = args.file;
    let chunkLength = 72000;
    // Ensure max and min are within range
    start = Math.max(0, start);
    end = Math.min(metadata[file].duration, end);

    if (start > metadata[file].duration) {
        return
    }
    const byteStart = convertTimeToBytes(start, metadata[file]);
    const byteEnd = convertTimeToBytes(end, metadata[file]);
    // Match highWaterMark to batch size... so we efficiently read bytes to feed to model - 3 for 3 second chunks
    const highWaterMark = metadata[file].bytesPerSec * BATCH_SIZE * 3;
    const proxy = metadata[file].proxy;
    const readStream = fs.createReadStream(proxy, {
        start: byteStart, end: byteEnd, highWaterMark: highWaterMark
    });
    let chunkStart = start * sampleRate;
    //const fileDuration = end - start;

    readStream.on('data', async chunk => {
        // Ensure data is processed in order
        readStream.pause();
        const offlineCtx = await setupCtx(chunk, metadata[file].header);
        if (offlineCtx) {
            offlineCtx.startRendering().then((resampled) => {
                const myArray = resampled.getChannelData(0);
                const samples = parseInt(((end - start) * sampleRate).toFixed(0));
                const increment = samples < chunkLength ? samples : chunkLength;
                feedChunksToModel(myArray, increment, chunkStart, file, end, resetResults);
                chunkStart += 3 * BATCH_SIZE * sampleRate;
                // Now the async stuff is done ==>
                readStream.resume();
            }).catch((err) => {
                console.error(`PredictBuffer rendering failed: ${err}`);
                // Note: The promise should reject when startRendering is called a second time on an OfflineAudioContext
            });
        } else {
            console.log('Short chunk', chunk.length, 'skipping')
            // Create array with 0's (short segment of silence that will trigger the finalChunk flag
            const myArray = new Float32Array(new Array(1000).fill(0));
            feedChunksToModel(myArray, chunkLength, chunkStart, file, end, resetResults);
            readStream.resume();
        }
    })
    readStream.on('end', function () {
        readStream.close()
    })
    readStream.on('error', err => {
        console.log(`readstream error: ${err}, start: ${start}, , end: ${end}, duration: ${metadata[file].duration}`)
    })
}

/**
 *  Called when file first loaded, when result clicked and when saving or sending file snippets
 * @param args
 * @returns {Promise<unknown>}
 */
const fetchAudioBuffer = async ({
                                    file = '', start = 0, end = metadata[file].duration
                                }) => {
    if (end - start < 0.1) return  // prevents dataset creation barfing with  v. short buffers
    const proxy = await getWorkingFile(file);
    if (!proxy) return false
    return new Promise(async (resolve, reject) => {
        const byteStart = convertTimeToBytes(start, metadata[file]);
        const byteEnd = convertTimeToBytes(end, metadata[file]);

        if (byteEnd < byteStart) {
            console.log(`!!!!!!!!!!!!! End < start encountered for ${file}, end was ${end} start is ${start}`)
        }
        // Match highWaterMark to batch size... so we efficiently read bytes to feed to model - 3 for 3 second chunks
        const highWaterMark = byteEnd - byteStart + 1;

        const readStream = fs.createReadStream(proxy, {
            start: byteStart, end: byteEnd, highWaterMark: highWaterMark
        });
        readStream.on('data', async chunk => {
            // Ensure data is processed in order
            readStream.pause();
            const offlineCtx = await setupCtx(chunk, metadata[file].header);

            offlineCtx.startRendering().then(resampled => {
                // `resampled` contains an AudioBuffer resampled at 24000Hz.
                // use resampled.getChannelData(x) to get an Float32Array for channel x.
                readStream.resume();
                resolve(resampled);
            }).catch((err) => {
                console.error(`FetchAudio rendering failed: ${err}`);
                // Note: The promise should reject when startRendering is called a second time on an OfflineAudioContext
            });
        })

        readStream.on('end', function () {
            readStream.close()
        })
        readStream.on('error', err => {
            console.log(`readstream error: ${err}, start: ${start}, , end: ${end}, duration: ${metadata[file].duration}`)
        })
    });
}

function sendMessageToWorker(chunkStart, chunks, file, duration, resetResults, predictionsRequested) {
    const finalChunk = (chunkStart / sampleRate) + (chunks.length * 3) >= duration;
    const objData = {
        message: 'predict',
        fileStart: metadata[file].fileStart,
        file: file,
        duration: duration,
        resetResults: resetResults,
        finalChunk: finalChunk,
        predictionsRequested: predictionsRequested
    }
    let chunkBuffers = {};
    // Key chunks by their position
    let position = chunkStart;
    chunks.forEach(chunk => {
        chunkBuffers[position] = chunk;
        position += sampleRate * 3;
    })
    objData['chunks'] = chunkBuffers;
    predictWorker.postMessage(objData, chunkBuffers);
}

async function doPrediction({
                                file = '', start = 0, end = metadata[file].duration, resetResults = false
                            }) {
    predictionDone = false;
    predictionStart = new Date();
    predicting = true;
    await getPredictBuffers({file: file, start: start, end: end, resetResults: resetResults});
    UI.postMessage({event: 'update-audio-duration', value: metadata[file].duration});
}

function feedChunksToModel(channelData, increment, chunkStart, file, duration, resetResults) {
    let chunks = [];
    for (let i = 0; i < channelData.length; i += increment) {
        let chunk = channelData.slice(i, i + increment);
        // Batch predictions
        predictionsRequested++;
        chunks.push(chunk);
        if (chunks.length === BATCH_SIZE) {
            sendMessageToWorker(chunkStart, chunks, file, duration, resetResults, predictionsRequested);
            chunks = [];
        }
    }
    //clear up remainder less than BATCH_SIZE
    if (chunks.length) sendMessageToWorker(chunkStart, chunks, file, duration, resetResults, predictionsRequested);
}

const speciesMatch = (path, sname) => {
    const pathElements = path.split(p.sep);
    const species = pathElements[pathElements.length - 2];
    sname = sname.replaceAll(' ', '_');
    return species.includes(sname)
}

const saveResults2DataSet = (rootDirectory) => {
    if (!rootDirectory) rootDirectory = '/home/matt/PycharmProjects/Data/Amendment_temp_folder';
    let promise = Promise.resolve();
    let promises = [];
    let count = 0;
    const t0 = Date.now();
    memoryDB.each(db2ResultSQL, (err, result) => {
        // Check for level of ambient noise activation
        let ambient, threshold, value = 0.25;
        // adding_chirpity_additions is a flag for curated files, if true we assume every detection is correct
        if (!adding_chirpity_additions) {
            ambient = (result.sname2 === 'Ambient Noise' ? result.score2 : result.sname3 === 'Ambient Noise' ? result.score3 : false)
            console.log('Ambient', ambient)
            // If we have a high level of ambient noise activation, insist on a high threshold for species detection
            if (ambient && ambient > 0.2) {
                value = 0.7
            }
            // Check whether top predicted species matches folder (i.e. the searched for species)
            // species not matching the top prediction sets threshold to 2, effectively doing nothing with results
            // that don't match the searched for species
            threshold = speciesMatch(result.file, result.sname) ? value : 2.0;
        } else {
            threshold = 0;
        }
        promise = promise.then(async function (resolve) {
            if (result.score >= threshold) {
                let end = Math.min(result.end, result.duration);
                const AudioBuffer = await fetchAudioBuffer({
                    start: result.start, end: end, file: result.file
                })
                if (AudioBuffer) {  // condition to prevent barfing when audio snippet is v short i.e. fetchAudioBUffer false when < 0.1s
                    const buffer = AudioBuffer.getChannelData(0);
                    const [_, folder] = p.dirname(result.file).match(/^.*\/(.*)$/)
                    // filename format: <source file>_<confidence>_<start>.png
                    const file = `${p.basename(result.file).replace(p.extname(result.file), '')}_${result['score'].toFixed(2)}_${result.start}-${result.end}.png`;
                    const filepath = p.join(rootDirectory, folder)
                    predictWorker.postMessage({
                        message: 'get-spectrogram', filepath: filepath, file: file, buffer: buffer
                    })
                    count++;
                }
            }
            return new Promise(function (resolve) {
                setTimeout(resolve, 5);
            });
        })
        promises.push(promise)
    }, (err, files) => {
        if (err) return console.log(err);
        Promise.all(promises).then(() => console.log(`Dataset created. ${count} files saved in ${(Date.now() - t0) / 1000} seconds`))
    })
}

const onSpectrogram = async (filepath, file, width, height, data, channels) => {
    await mkdir(filepath, {recursive: true});
    let image = await png.encode({width: width, height: height, data: data, channels: channels})
    const file_to_save = p.join(filepath, file);
    await writeFile(file_to_save, image);
    console.log('saved:', file_to_save);
};

async function uploadOpus({file, start, end, defaultName, metadata, mode}) {
    const Blob = await bufferToAudio({file: file, start: start, end: end, format: 'opus', meta: metadata});
// Populate a form with the file (blob) and filename
    const formData = new FormData();
    //const timestamp = Date.now()
    formData.append("thefile", Blob, defaultName);
    // Was the prediction a correct one?
    formData.append("Chirpity_assessment", mode);
// post form data
    const xhr = new XMLHttpRequest();
    xhr.responseType = 'text';
// log response
    xhr.onload = () => {
        console.log(xhr.response);
    };
// create and send the reqeust
    xhr.open('POST', 'https://birds.mattkirkland.co.uk/upload');
    xhr.send(formData);
}

const bufferToAudio = ({
                           file = '', start = 0, end = 3, format = 'opus', meta = {}
                       }) => {
    let audioCodec, soundFormat, mimeType;
    if (format === 'opus') {
        audioCodec = 'libopus';
        soundFormat = 'opus'
        mimeType = 'audio/ogg'
    } else if (format === 'mp3') {
        audioCodec = 'libmp3lame';
        soundFormat = 'mp3';
        mimeType = 'audio/mpeg'
    }
    let optionList = [];
    for (let [k, v] of Object.entries(meta)) {
        if (typeof v === 'string') {
            v = v.replaceAll(' ', '_');
        }
        optionList.push('-metadata');
        optionList.push(`${k}=${v}`);
    }
    return new Promise(function (resolve) {
        const bufferStream = new stream.PassThrough();
        const command = ffmpeg(metadata[file].proxy)
            .seekInput(start)
            .duration(end - start)
            .audioBitrate(160)
            .audioChannels(1)
            .audioFrequency(24000)
            .audioCodec(audioCodec)
            .format(soundFormat)
            .outputOptions(optionList)
            .on('error', (err) => {
                console.log('An error occurred: ' + err.message);
            })
            .on('end', function () {
                console.log(format + " file rendered")
            })
            .writeToStream(bufferStream);

        const buffers = [];
        bufferStream.on('data', (buf) => {
            buffers.push(buf);
        })
        bufferStream.on('end', function () {
            const outputBuffer = Buffer.concat(buffers);
            let audio = [];
            audio.push(new Int8Array(outputBuffer))
            const blob = new Blob(audio, {type: mimeType});
            resolve(blob);
        });
    })
}

async function saveMP3(file, start, end, filename, metadata) {
    const MP3Blob = await bufferToAudio({
        file: file, start: start, end: end, format: 'mp3', meta: metadata
    });
    const anchor = document.createElement('a');
    document.body.appendChild(anchor);
    anchor.style = 'display: none';
    const url = window.URL.createObjectURL(MP3Blob);
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.URL.revokeObjectURL(url);
}


/// Workers  From the MDN example
function spawnWorker(model, list, batchSize, warmup) {
    predictWorker = new Worker('./js/model.js');
    //const modelPath = model === 'efficientnet' ? '../24000_B3/' : '../24000_v9/';
    //const modelPath = model === 'efficientnet' ? '../test_24000_v10/' : '../24000_v9/';
    //const modelPath = model === 'efficientnet' ? '../test_2022128_EfficientNetB3_wd=10xlr_sigmoid_focal_crossentropy_256x384_AdamW_447/' : '../24000_v9/';
     const modelPath = model === 'efficientnet' ? '../test_20221222_EfficientNetB3_wd=10xlr_sigmoid_focal_crossentropy_256x384_AdamW_447/' : '../24000_v9/';
    console.log(modelPath);
    // Now we've loaded a new model, clear the aborted flag
    aborted = false;
    predictWorker.postMessage(['load', modelPath, list, batchSize, warmup])
    predictWorker.onmessage = async (e) => {
        await parseMessage(e)
    }
}

const parsePredictions = async (response) => {
    let file, batchInProgress = false;
    predictionsReceived = response['predictionsReceived'];
    const result = response['result'];
    file = response.file;
    let fileSQL = prepSQL(file);
    // If we are working on a saved file, use the disk db
    STATE.db = STATE.saved.has(file) ? diskDB : memoryDB;
    const db = STATE.db;
    for (let i = 0; i < result.length; i++) {
        const prediction = result[i];
        const position = parseFloat(prediction[0]);
        UI.postMessage({event: 'progress', progress: (position / metadata[file].duration), file: file});
        //console.log('Prediction received from worker', result);
        if (!prediction[1].suppressed && prediction[1].score > minConfidence) {
            const result = prediction[1];
            const audacity = prediction[2];
            index++;
            if (!response['resetResults']) {
                // This is a selection, create a result flag to allow the UI to scroll to its position
                STATE['activeTimestamp'] = result.timestamp;
            } else {
                STATE['activeTimestamp'] = undefined
            }
            if (db === memoryDB) {
                UI.postMessage({
                    event: 'prediction-ongoing',
                    file: file,
                    result: result,
                    index: index,
                    resetResults: response['resetResults'],
                });
            }
            AUDACITY[file] ? AUDACITY[file].push(audacity) : AUDACITY[file] = [audacity];
            //save result to memory db (N.B. tried using transactions, but was no faster.
            // Also, transactions had to start end in other functions, which is bad style!
            await db.runAsync(`INSERT
            OR IGNORE INTO files VALUES ( '${fileSQL}',
            ${metadata[file].duration},
            ${response['fileStart']}
            )`);
            const {rowid} = await db.getAsync(`SELECT rowid
                                               FROM files
                                               WHERE name = '${fileSQL}'`);
            let durationSQL = Object.entries(metadata[file].dateDuration)
                .map(entry => `(${entry.toString()},${rowid})`).join(',');
            await db.runAsync(`INSERT
            OR IGNORE INTO duration VALUES
            ${durationSQL}`);
            await db.runAsync(`INSERT
            OR REPLACE INTO records 
                VALUES (
            ${result.timestamp},
            ${result.id_1},
            ${result.id_2},
            ${result.id_3},
            ${result.score},
            ${result.score2},
            ${result.score3},
            ${rowid},
            ${result.position},
            null,
            null
            )`);

        }
    }
    if (response.finished) {
        COMPLETED.push(file);
        const row = await db.getAsync(`SELECT rowid
                                       FROM files
                                       WHERE name = '${fileSQL}'`);
        if (!row) {
            const result = `No predictions found in ${file}`;
            UI.postMessage({
                event: 'prediction-ongoing',
                file: file,
                result: result,
                index: 1,
                resetResults: response['resetResults']
            });
        }
        console.log(`Prediction done ${FILE_QUEUE.length} files to go`);
        console.log('Analysis took ' + (new Date() - predictionStart) / 1000 + ' seconds.');
        UI.postMessage({event: 'progress', progress: 1.0, text: '...'});
        batchInProgress = FILE_QUEUE.length ? true : predictionsRequested - predictionsReceived;
        predictionDone = true;
    }
    return [file, batchInProgress]
}

async function parseMessage(e) {
    const response = e.data;
    if (response['message'] === 'model-ready') {
        const chunkLength = response['chunkLength'];
        sampleRate = response['sampleRate'];
        const backend = response['backend'];
        console.log(backend);
        UI.postMessage({event: 'model-ready', message: 'ready', backend: backend, labels: labels})
    } else if (response['message'] === 'labels') {
        t0 = Date.now();
        labels = response['labels'];
        // Now we have what we need to populate a database...
        // Load the archive db
        await loadDB(appPath);
        // Create in-memory database
        await loadDB();
        await dbSpeciesCheck();
    } else if (response['message'] === 'prediction' && !aborted) {
        // add filename to result for db purposes
        let [file, batchInProgress] = await parsePredictions(response);
        if (response['finished']) {
            process.stdout.write(`FILE QUEUE: ${FILE_QUEUE.length}, Prediction requests ${predictionsRequested}, predictions received ${predictionsReceived}    \r`)
            if (predictionsReceived === predictionsRequested) {
                const limit = 10;
                await clearCache(CACHE_LOCATION, limit);
                // This is the one time results *do not* come from the database
                if (!batchInProgress) {
                    if (STATE.db === diskDB) await getResults({files: OPENFILES})
                    await getSummary({files: OPENFILES});
                } else {
                    UI.postMessage({
                        event: 'prediction-done', batchInProgress: true,
                    })
                }
            }
            await processNextFile();
        }
    } else if (response['message'] === 'spectrogram') {
        await onSpectrogram(response['filepath'], response['file'], response['width'], response['height'], response['image'], response['channels'])
    }
}

// Optional Arguments
async function processNextFile({
                                   start = undefined, end = undefined, resetResults = false,
                               } = {}) {
    if (FILE_QUEUE.length) {
        let file = FILE_QUEUE.shift()
        const found = await getWorkingFile(file);
        if (found) {
            if (end) {
                // If we have an end value already, we're analysing a selection
            }
            if (start === undefined) [start, end] = await setStartEnd(file);
            if (start === 0 && end === 0) {
                // Nothing to do for this file
                const result = `No predictions.for ${file}. It has no period within it where predictions would be given`;
                if (!FILE_QUEUE.length) {
                    UI.postMessage({
                        event: 'prediction-ongoing', file: file, result: result, index: -1, resetResults: false,
                    });
                }
                UI.postMessage({
                    event: 'prediction-done', file: file, audacityLabels: AUDACITY, batchInProgress: FILE_QUEUE.length
                });
                await processNextFile(arguments[0]);
            } else {
                await doPrediction({
                    start: start, end: end, file: file, resetResults: resetResults,
                });
            }
        } else {
            await processNextFile(arguments[0]);
        }
    } else {
        predicting = false;
        return true
    }
}

async function setStartEnd(file) {
    const meta = metadata[file];
    let start, end;
    if (NOCMIG) {
        const fileEnd = meta.fileStart + (meta.duration * 1000);
        // If it's dark at the file start, start at 0 ...otherwise start at dusk
        if (meta.fileStart < meta.dawn || meta.fileStart > meta.dusk) {
            start = 0;
        } else {
            // not dark at start, is it still light at the end?
            if (fileEnd <= meta.dusk) {
                // No? skip this file
                return [0, 0];
            } else {
                // So, it *is* dark by the end of the file
                start = (meta.dusk - meta.fileStart) / 1000;
            }
        }
        // Now set the end
        meta.fileStart < meta.dawn && fileEnd >= meta.dawn ? end = (meta.dawn - meta.fileStart) / 1000 : end = meta.duration;
    } else {
        start = 0;
        end = meta.duration;
    }
    return [start, end];
}


const setWhereWhen = ({dateRange, species, files, context}) => {
    let where = '';
    if (files.length) {
        where = 'WHERE files.name IN  (';
        // Format the file list
        files.forEach(file => {
            file = prepSQL(file);
            where += `'${file}',`
        })
        // remove last comma
        where = where.slice(0, -1);
        where += ')';
    }
    const cname = context !== 'summary' ? 's1.cname' : 'cname';
    if (species) where += `${files.length ? ' AND ' : ' WHERE '} ${cname} =  '${prepSQL(species)}'`;
    const when = dateRange && dateRange.start ? `AND datetime BETWEEN ${dateRange.start} AND ${dateRange.end}` : '';
    return [where, when]
}


const getSummary = async ({
                              db = STATE.db,
                              range = undefined,
                              files = [],
                              species = undefined,
                              explore = false,
                              active = undefined,
                          } = {}) => {
    const offset = species ? STATE.filteredOffset[species] : STATE.globalOffset;
    let [where, when] = setWhereWhen({
        dateRange: range, species: explore ? species : undefined, files: files, context: 'summary'
    });
    const summary = await db.allAsync(`
        SELECT MAX(conf1) as max, cname, sname, COUNT(cname) as count
        FROM records
            INNER JOIN species
        ON species.id = birdid1
            INNER JOIN files ON fileID = files.rowid
            ${where} ${when}
        GROUP BY cname
        ORDER BY max (conf1) DESC;`);
    // need another setWhereWhen call for total
    [where, when] = setWhereWhen({
        dateRange: range, species: species, files: files, context: 'summary'
    });
    const {total} = await db.getAsync(`SELECT COUNT(*) AS total
                                       FROM records
                                                INNER JOIN species
                                                           ON species.id = birdid1
                                                INNER JOIN files ON fileID = files.rowid
                                           ${where} ${when}`);
    // need to send offset here?
    UI.postMessage({
        event: 'prediction-done',
        summary: summary,
        total: total,
        offset: offset,
        audacityLabels: AUDACITY,
        filterSpecies: species,
        active: active,
        batchInProgress: false,
    })
}


const dbSpeciesCheck = async () => {
    const {speciesCount} = await diskDB.getAsync('SELECT COUNT(*) as speciesCount FROM species');
    if (speciesCount !== labels.length) {
        UI.postMessage({
            event: 'generate-alert',
            message: `Warning:\nThe ${speciesCount} species in the archive database does not match the ${labels.length} species being used by the model.`
        })
    }
}

const getResults = async ({
                              db = STATE.db,
                              range = undefined,
                              order = 'timestamp',
                              files = [],
                              species = undefined,
                              context = 'results',
                              limit = 500,
                              offset = undefined
                          }) => {
    if (offset === undefined) { // Get offset state
        if (species) {
            if (!STATE.filteredOffset[species]) STATE.filteredOffset[species] = 0;
            offset = STATE.filteredOffset[species];
        } else {
            offset = STATE.globalOffset;
        }
    } else { // Set offset state
        if (species) STATE.filteredOffset[species] = offset;
        else STATE.globalOffset = offset;
    }

    const [where, when] = setWhereWhen({
        dateRange: range, species: species, files: files, context: context
    });

    // TODO: mixed files: among open files, only some are saved. Merge results??
    let index = offset;
    return new Promise(function (resolve, reject) {
        // db.each doesn't call the callback if there are no results, so:
        db.each(`${db2ResultSQL} ${where} ${when} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, (err, result) => {
            if (err) {
                reject(err)
            } else { // on each result
                index++;
                UI.postMessage({
                    event: 'prediction-ongoing',
                    file: result.file,
                    result: result,
                    index: index,
                    resetResults: false,
                    fromDB: true
                });
                // Recreate Audacity labels
                const file = result.file
                const audacity = {
                    timestamp: `${result.start}\t${result.start + 3}`,
                    cname: result.cname,
                    score: result.score
                };
                AUDACITY[file] ? AUDACITY[file].push(audacity) : AUDACITY[file] = [audacity];
            }
        }, async (err, count) => {   //on finish
            if (err) console.log(err);
            if (!count && species) await getResults({
                files: files,
                range: range,
                context: context,
                limit: limit,
                offset: offset
            })
            return resolve(offset)
        })
    })
}

const isDuplicate = async (file) => {
    const baseName = file.replace(/^(.*)\..*$/g, '$1').replace("'", "''");
    const row = await diskDB.getAsync(`SELECT *
                                       FROM files
                                       WHERE name LIKE '${baseName}%'`);
    if (row) {
        metadata[row.name] = {fileStart: row.filestart, duration: row.duration}
        return row.name
    }
    return false
}

const getFileInfo = async (file) => {
    // look for file in the disk DB, ignore extension
    const baseName = file.replace(/^(.*)\..*$/g, '$1').replace("'", "''");
    return new Promise(function (resolve, reject) {
        diskDB.get(`SELECT *
                    FROM files
                    WHERE name LIKE '${baseName}%'`, (err, row) => {
            if (err) {
                console.log('There was an error ', err)
            } else {
                resolve(row)
            }
        })
    })
}


/**
 *  Transfers data in memoryDB to diskDB
 * @returns {Promise<unknown>}
 */
const onSave2DiskDB = async () => {
    t0 = Date.now();
    memoryDB.runAsync('BEGIN');
    const files = await memoryDB.allAsync('SELECT * FROM files');
    const filesSQL = files.map(file => `('${prepSQL(file.name)}', ${file.duration}, ${file.filestart})`).toString();
    let response = await memoryDB.runAsync(`INSERT
    OR IGNORE INTO disk.files VALUES
    ${filesSQL}`);
    console.log(response.changes + ' files added to disk database')
    // Update the duration table
    response = await memoryDB.runAsync('INSERT OR IGNORE INTO disk.duration SELECT * FROM duration');
    console.log(response.changes + ' date durations added to disk database')
    response = await memoryDB.runAsync('INSERT OR IGNORE INTO disk.records SELECT * FROM records');
    console.log(response.changes + ' records added to disk database')
    memoryDB.runAsync('END');
    // Clear and relaunch the memory DB
    //memoryDB.close(); // is this necessary??
    await createDB();
    files.forEach(file => STATE.saved.add(file));
    // Now we have saved the records, set state to DiskDB
    STATE.db = diskDB;
    UI.postMessage({
        event: 'generate-alert',
        message: `Database update complete, ${response.changes} records added to the archive in ${((Date.now() - t0) / 1000)} seconds`
    })
}

const getSeasonRecords = async (species, season) => {
    const seasonMonth = {spring: "< '07'", autumn: " > '06'"}
    return new Promise(function (resolve, reject) {
        const stmt = diskDB.prepare(`
            SELECT MAX(SUBSTR(DATE(records.dateTime/1000, 'unixepoch', 'localtime'), 6)) AS maxDate,
                   MIN(SUBSTR(DATE(records.dateTime/1000, 'unixepoch', 'localtime'), 6)) AS minDate
            FROM records
                     INNER JOIN species ON species.id = records.birdID1
            WHERE species.cname = (?)
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
}

const getMostCalls = (species) => {
    return new Promise(function (resolve, reject) {
        diskDB.get(`
            SELECT count(*) as count, 
            DATE(dateTime/1000, 'unixepoch', 'localtime') as date
            FROM records INNER JOIN species
            on species.id = records.birdID1
            WHERE species.cname = '${species}'
            GROUP BY STRFTIME('%Y', DATETIME(dateTime/1000, 'unixepoch', 'localtime')),
                STRFTIME('%W', DATETIME(dateTime/1000, 'unixepoch', 'localtime')),
                STRFTIME('%d', DATETIME(dateTime/1000, 'unixepoch', 'localtime'))
            ORDER BY count DESC LIMIT 1`, (err, row) => {
            if (err) {
                reject(err)
            } else {
                resolve(row)
            }
        })
    })
}

const getChartTotals = ({
                            species = undefined, range = {}
                        }) => {
    const dateRange = range;
    // Work out sensible aggregations from hours difference in daterange
    const hours_diff = dateRange.start ? Math.round((dateRange.end - dateRange.start) / (1000 * 60 * 60)) : 745;
    console.log(hours_diff, "difference in hours")
    const dateFilter = dateRange.start ? ` AND dateTime BETWEEN ${dateRange.start} AND ${dateRange.end} ` : '';
    // default to group by Week
    let dataPoints = Math.max(52, Math.round(hours_diff / 24 / 7));
    let groupBy = "Year, Week";
    let orderBy = 'Year'
    let aggregation = 'Week';
    let startDay = 0;
    if (hours_diff <= 744) {
        //31 days or less: group by Day
        groupBy += ", Day";
        orderBy = 'Year, Week';
        dataPoints = Math.round(hours_diff / 24);
        aggregation = 'Day';
        const date = dateRange.start ? new Date(dateRange.start) : Date.UTC(2020, 0, 0, 0, 0, 0);
        startDay = Math.floor((date - new Date(date.getFullYear(), 0, 0, 0, 0, 0)) / 1000 / 60 / 60 / 24);
    }
    if (hours_diff <= 72) {
        // 3 days or less, group by Hour of Day
        groupBy += ", Hour";
        orderBy = 'Day, Hour';
        dataPoints = hours_diff;
        aggregation = 'Hour';
    }

    return new Promise(function (resolve, reject) {
        diskDB.all(`SELECT STRFTIME('%Y', DATETIME(dateTime / 1000, 'unixepoch', 'localtime')) AS Year, 
            STRFTIME('%W', DATETIME(dateTime/1000, 'unixepoch', 'localtime')) AS Week,
            STRFTIME('%j', DATETIME(dateTime/1000, 'unixepoch', 'localtime')) AS Day, 
            STRFTIME('%H', DATETIME(dateTime/1000, 'unixepoch', 'localtime')) AS Hour,    
            COUNT(*) as count
                    FROM records
                        INNER JOIN species
                    on species.id = birdid1
                    WHERE species.cname = '${species}' ${dateFilter}
                    GROUP BY ${groupBy}
                    ORDER BY ${orderBy};`, (err, rows) => {
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
        const calls = new Array(52).fill(0);
        const total = new Array(52).fill(0);


        diskDB.all(`select STRFTIME('%W', DATE(dateTime / 1000, 'unixepoch', 'localtime')) as week, count(*) as calls
                    from records
                             INNER JOIN species ON species.id = records.birdid1
                    WHERE species.cname = '${species}'
                    group by week;`, (err, rows) => {
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

const getSpecies = (db, range) => {
    const where = range && range.start ? `WHERE dateTime BETWEEN ${range.start} AND ${range.end}` : '';
    db.all(`SELECT DISTINCT cname, sname, COUNT(cname) as count
            FROM records
                INNER JOIN species
            ON birdid1 = id ${where}
            GROUP BY cname
            ORDER BY cname`, (err, rows) => {
        if (err) console.log(err); else {
            UI.postMessage({event: 'seen-species-list', list: rows})
        }
    })
}


const onUpdateFileStart = async (args) => {
    let file = args.file;
    const newfileMtime = args.start + (metadata[file].duration * 1000);
    await utimes(file, Math.round(newfileMtime));
    // update the metadata
    metadata[file].isComplete = false;
    //allow for this file to be compressed...
    await getWorkingFile(file);
    file = file.replace("'", "''");
    let db = diskDB;

    let {rowid} = await db.getAsync(`SELECT rowid
                                     from files
                                     where name = '${file}'`);
    const {changes} = await db.runAsync(`UPDATE files
                                         SET filestart = ${args.start}
                                         where rowid = '${rowid}'`);
    changes ? console.log(`Changed ${file}`) : console.log(`No changes made`);
    let result = await db.runAsync(`UPDATE records
                                    set dateTime = position + ${args.start}
                                    where fileid = ${rowid}`);
    console.log(`Changed ${result.changes} records associated with  ${file}`);
}

const prepSQL = (string) => string.replaceAll("''", "'").replaceAll("'", "''");

async function onDelete({file, start, active, species, files, context = 'results', order, explore, range}) {
    const db = STATE.db;
    file = prepSQL(file);
    const {filestart} = await db.getAsync(`SELECT filestart
                                           from files
                                           WHERE name = '${file}'`);
    const datetime = filestart + (parseFloat(start) * 1000);
    await db.runAsync('DELETE FROM records WHERE datetime = ' + datetime);
    await getResults(arguments[0]);
    await getSummary(arguments[0]);
    await getSpecies(db, range);
}

async function onUpdateRecord({
                                  openFiles = [],
                                  currentFile = '',
                                  start = 0,
                                  value = '',
                                  db = STATE.db,
                                  isBatch = false,
                                  from = '',
                                  what = 'birdID1',
                                  order = 'timestamp',
                                  isFiltered = false,
                                  isExplore = false,
                                  range = {},
                                  active = undefined
                              }) {
    // Construct the SQL
    let whatSQL = '', whereSQL = '';
    value = prepSQL(value);
    let fromSQL = prepSQL(from);
    currentFile = prepSQL(currentFile);
    if (what === 'ID' || what === 'birdID1') {
        // Map the field name to the one in the database
        what = 'birdID1';
        whatSQL = `conf1 = 2, birdID1 = (SELECT id FROM species WHERE cname = '${value}')`;
    } else if (what === 'label') {
        whatSQL = `label = '${value}'`;
    } else {
        whatSQL = `comment = '${value}'`;
    }
    const filesSQL = openFiles.map(file => `'${prepSQL(file)}'`).toString();
    if (isBatch) {
        //Batch update
        whereSQL = `WHERE birdID1 = (SELECT id FROM species WHERE cname = '${fromSQL}') `;
        if (openFiles.length) {
            whereSQL += `AND fileID IN (SELECT rowid from files WHERE name in (${filesSQL}))`;
        }
    } else {
        // Sanitize input: start is passed to the function in float seconds,
        // but we need a millisecond integer
        const startMilliseconds = (start * 1000).toFixed(0);
        // Single record
        whereSQL = `WHERE datetime = (SELECT filestart FROM files WHERE name = '${currentFile}') + ${startMilliseconds}`
    }
    const t0 = Date.now();
    const {changes} = await db.runAsync(`UPDATE records
                                         SET ${whatSQL} ${whereSQL}`);
    if (changes) {
        console.log(`Updated ${changes} records for ${what} in ${db.filename.replace(/.*\//, '')} database, setting it to ${value}`);
        console.log(`Update without transaction took ${Date.now() - t0} milliseconds`);
        const species = isFiltered || isExplore ? from : '';
        if (isExplore) openFiles = [];
        await getResults({
            db: db,
            files: openFiles,
            species: species,
            explore: isExplore,
            order: order
        });
        await getSummary({db: db, files: openFiles, species: species, explore: isExplore, active: active});
        // Update the species list
        await getSpecies(db, range);
        if (db === memoryDB) {
            UI.postMessage({
                event: 'generate-alert', message: 'Remember to save your records to store this change'
            })
        }
    } else {
        console.log(`No records updated in ${db.filename.replace(/.*\//, '')}`)
    }
}

async function onChartRequest(args) {
    console.log(`Getting chart for ${args.species} starting ${args.range[0]}`);
    // Escape apostrophes
    if (args.species) args.species = prepSQL(args.species);
    const dateRange = args.range;
    const dataRecords = {}, results = {};
    t0 = Date.now();
    await getSeasonRecords(args.species, 'spring')
        .then((result) => {
            dataRecords.earliestSpring = result['minDate'];
            dataRecords.latestSpring = result['maxDate'];
        }).catch((message) => {
            console.log(message)
        })

    await getSeasonRecords(args.species, 'autumn')
        .then((result) => {
            dataRecords.earliestAutumn = result['minDate'];
            dataRecords.latestAutumn = result['maxDate'];
        }).catch((message) => {
            console.log(message)
        })

    console.log(`Season chart generation took ${(Date.now() - t0) / 1000} seconds`)
    t0 = Date.now();
    await getMostCalls(args.species)
        .then((row) => {
            row ? dataRecords.mostDetections = [row.count, row.date] : dataRecords.mostDetections = ['N/A', 'Not detected'];
        }).catch((message) => {
            console.log(message)
        })

    console.log(`Most calls  chart generation took ${(Date.now() - t0) / 1000} seconds`)
    t0 = Date.now();
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
                    results[year] = new Array(dataPoints).fill(0);
                }
                if (aggregation === 'Week') {
                    results[year][parseInt(week) - 1] = count;
                } else if (aggregation === 'Day') {
                    results[year][parseInt(day) - startDay] = count;
                } else {
                    const d = new Date(dateRange.start);
                    const hoursOffset = d.getHours();
                    const index = ((parseInt(day) - startDay) * 24) + (parseInt(hour) - hoursOffset);
                    results[year][index] = count;
                }
            }
            return [dataPoints, aggregation]
        }).catch((message) => {
            console.log(message)
        })

    console.log(`Chart series generation took ${(Date.now() - t0) / 1000} seconds`)
    t0 = Date.now();
    // If we have a years worth of data add total recording duration and rate
    let total, rate;
    if (dataPoints === 52) [total, rate] = await getRate(args.species)
    console.log(`Chart rate generation took ${(Date.now() - t0) / 1000} seconds`)
    const pointStart = dateRange.start ? dateRange.start : Date.UTC(2020, 0, 0, 0, 0, 0);
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

const db2ResultSQL = 'SELECT dateTime AS timestamp, position AS position, s1.cname as cname, s2.cname as cname2, s3.cname as cname3, birdid1 as id_1, birdid2 as id_2, birdid3 as id_3, position as start, position + 3 as end, conf1 as score, conf2 as score2, conf3 as score3,s1.sname as sname, s2.sname as sname2, s3.sname as sname3,files.duration, files.name as file, comment, label FROM records LEFT JOIN species s1 on s1.id = birdid1 LEFT JOIN species s2 on s2.id = birdid2 LEFT JOIN species s3 on s3.id = birdid3 INNER JOIN files on files.rowid = records.fileid';

/*
Todo: bugs
    ***Crash on abort - no crash now, but predictions resume
    ***when analysing second batch of results, the first results linger.
    Confidence filter not honoured on refresh results
    ***Table does not  expand to fit when operation aborted
    ***when current model list differs from the one used when saving records, getResults gives wrong species
        -solved as in there are separate databases now, so results cached in the db for another model wont register.
    when nocmig mode on, getResults for daytime files prints no results, but summary printed. No warning given.
    ***manual records entry doesn't preserve species in explore mode
    ***save records to db doesn't work with updaterecord!
    ***AUDACITY results for multiple files doesn't work well, as it puts labels in by position only. Need to make audacity an object,
        and return the result for the current file only #######
    In explore, editID doesn't change the label of the region to the new species
    Analyse selection returns just the file in which the selection is requested


Todo: Database
     Database delete: records, files (and all associated records). Use when reanalysing
     Database file path update, batch update - so we can move files around after analysis
     ***Compatibility with updates, esp. when num classes change
        -Create a new database for each model with appropriate num classes?

Todo: Location.
     Associate lat lon with files, expose lat lon settings in UI. Allow for editing once saved

Todo cache:
    ***Clear cache on application exit, as well as start
    ***Set max cache size
    ***Cache fills before analyse complete. So it fills up ahead of predictions, and files get deleted
        before they're done with
    ***Now cache is limited, need to re-open file when browsing and file not present

Todo: manual entry
    ***check creation of manual entries
    ***indicate manual entry/confirmed entry
    save entire selected range as one entry. By default or as an option?
    ***get entry to appear in position among existing detections and centre on it

Todo: UI
    ***Drag folder to load audio files within (recursively)
    ***Stop flickering when updating results
    Expose SNR feature
    ***Pagination? Limit table records to say, 1000
    Better tooltips, for all options
    Sort summary by headers
    Have a panel for all analyse settings, not just nocmig mode
    ***Delay hiding submenu on mouseout (added box-shadow)
    Align the label on the spec to the right to minimize overlap with axis labels


Todo: Charts
    Allow better control of aggregation (e.g) hourly over a week
    Permit inclusion of hours recorded in other date ranges
    Allow choice of chart type
    Rip out highcharts, use chart.js.
    Allow multiple species comparison, e.g. compare Song Thrush and Redwing peak migration periods

Todo: Explore
    ***Make summary range aware
    ***Make seen species list range aware

Todo: Performance
    Investigate background throttling when worker hidden
        If an issue, Explore spawning predictworker from UI, Shared worker??
            => hopefully prevents  background throttling (imapact TBD)
    Can we avoid the datasync in snr routine?
    Smaller model faster - but retaining accuracy? Read up on Knowledge distillation

Todo: model.
     Improve accuracy, accuracy accuracy!
        - refine training
        - look at snr for false positives impact
     Establish classes protocol. What's in, what name to give it
     Speed - knowledge distillation??

Todo: Releases
     Limit features for free users
     Premium features are??
     Upsell premium features
     Automatic updates
     Implement version protocol
     ***Better way to link js model to checkpoint model: USE same folder names

Todo: IDs
    Search by label,
    Search for comment

Todo: Tests & code quality
    Order / group functions semantically
    Investigate unit tests
    Investigate coverage
    Integrate with commit?
    Document code, jsdoc?
    Use de-referencing on all args parameters
    Shorten functions
    Review all global vars: set global var policy. Capitalise all globals
    Make use of const functions / arrow vs. normal ones consistent.
    **Review use of async functions
    **Make Locatefile() case insensitive
 */