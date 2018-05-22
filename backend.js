const Db = require("./predictor-db/db.js");
const Hotlist = require("./predictor-db/hotlist.js");
const MlPredictor = require("./predictor-ml/ml.js");
const { StreamDl } = require("stream-tireless-baler");
const { getMeta } = require("webradio-metadata");
const { log } = require("abr-log")("pred-master");

var country = "France";
var name = "RTL";

const ENABLE_PREDICTOR_FINGERPRINT = true;
const ENABLE_PREDICTOR_ML = true;
const SAVE_AUDIO = true;
const FETCH_METADATA = false;

/* overview of operations

dl: fetches http data, sends "newSegment" events.
|	|
|	V
|	if SAVE_AUDIO: dbs.audio.write() save to disk
|
V
decoder: converts http data to PCM audio samples.
|	|
|	V
|	if ENABLE_PREDICTOR_ML: mlPredictor
|	|
|	V
|	dbs.metadata
|
V
if ENABLE_PREDICTOR_FINGERPRINT: hotlist
|
V
dbs.metadata


if FETCH_METADATA: getMeta
|
V
dbs.metadata

*/

class Predictor {
	constructor(options) {
		// stream identification
		const country = options.country; 	// mandatory argument
		const name = options.name;			// mandatory argument

		// send stream status to listener every N seconds
		const predInterval = options.predInterval !== undefined ? optiond.predInterval : 1;

		// save audio file and metadata every N **predInterval times**.
		const saveDuration = options.saveDuration !== undefined ? options.saveDuration : 10;

		// module options
		const ENABLE_PREDICTOR_FINGERPRINT = (options.predictor && options.predictor.fingerprint !== undefined) ? !!options.predictor.fingerprint : true;
		const ENABLE_PREDICTOR_ML = (options.predictor && options.predictor.hotlist !== undefined) ? options.predictor.hotlist : true;
		const SAVE_AUDIO = options.saveAudio !== undefined ? options.saveAudio : true;
		const SAVE_METADATA = options.saveMetadata !== undefined ? options.saveMetadata : true;
		const FETCH_METADATA = options.fetchMetadata !== undefined ? options.fetchMetadata : false;

		// output of predictions
		const listener = options.listener;	// mandatory argument, instance of a Writable Stream.

		var self = this;
		var dl = new StreamDl({ country: country, name: name, segDuration: predInterval });
		dl.on("error", function(err) {
			console.log("dl err=" + err);
		});

		var decoder = require('child_process').spawn('ffmpeg', [
			'-i', 'pipe:0',
			'-acodec', 'pcm_s16le',
			'-ar', 11025,
			'-ac', 1,
			'-f', 'wav',
			'-v', 'fatal',
			'pipe:1'
		], { stdio: ['pipe', 'pipe', process.stderr] });

		if (ENABLE_PREDICTOR_FINGERPRINT) {
			var hotlist = new Hotlist({ country: country, name: name });
			decoder.stdout.pipe(hotlist);
			hotlist.pipe(listener);
		}
		if (ENABLE_PREDICTOR_ML) {
			var mlPredictor = new MlPredictor({ country: country, name: name });
			decoder.stdout.pipe(mlPredictor);
			mlPredictor.pipe(listener);
		}

		dl.on("metadata", function(metadata) { // this happens once at the beginning of stream download
			log.info(country + "_" + name + " metadata=" + JSON.stringify(metadata, null, "\t"));
			var db = new Db({
				country: country,
				name: name,
				ext: metadata.ext,
				saveAudio: SAVE_AUDIO,
				path: __dirname
			});
			var dbs = null;
			let predCounter = 0;

			dl.on("data", function(dataObj) { // this may happen quite often
				var tBuffer = dataObj.tBuffer;

				// dataObj.newSegment is true when the chunk of data we receive belongs to a new audio segment.
				// it happens once every [predInterval] seconds.
				if (!dataObj.newSegment) {
					if (SAVE_AUDIO) dbs.audio.write(dataObj.data);
					listener.write({ type: "audio", data: dataObj.data, tBuffer: dataObj.tBuffer });
					return decoder.stdin.write(dataObj.data);
				}

				// save audio and metadata less frequently than status updates. to do so, we count the audio segments.
				predCounter += 1;
				if (predCounter < saveDuration) return;
				predCounter = 0;

				dl.pause();
				if (dbs) {
					//if (SAVE_AUDIO) dl.unpipe(dbs.audio);
					if (SAVE_AUDIO) dbs.audio.end();
					if (SAVE_METADATA) {
						if (ENABLE_PREDICTOR_FINGERPRINT) hotlist.unpipe(dbs.metadata);
						if (ENABLE_PREDICTOR_ML) mlPredictor.unpipe(dbs.metadata);
						dbs.metadata.end();
					}
				}

				db.newAudioSegment(function(newdbs) {
					dbs = newdbs;

					// TODO: do the hotlist search only if mlPredictor is unsure.
					if (SAVE_METADATA) {
						if (ENABLE_PREDICTOR_FINGERPRINT) {
							// send Hotlist detections to metadata history DB
							hotlist.pipe(dbs.metadata);
						}
						if (ENABLE_PREDICTOR_ML) {
							// send ML predictions results to metadata history DB
							mlPredictor.pipe(dbs.metadata);
						}
					}
					if (FETCH_METADATA) {
						// send web-scraped metadata to history DB
						getMeta(country, name, function(err, parsedMeta, corsEnabled) {
							if (err) return log.warn("getMeta: error fetching title meta. err=" + err);
							log.info(country + "_" + name + " meta=" + JSON.stringify(parsedMeta));
							listener.write({ type: "title", data: parsedMeta });
							if (SAVE_METADATA) {
								if (dbs.metadata.ended) return log.warn("getMeta: could not write metadata, stream already ended");
								dbs.metadata.write({ type: "title", data: parsedMeta });
							}
						});
					}
					if (SAVE_AUDIO) dbs.audio.write(dataObj.data);
					decoder.stdin.write(dataObj.data);
					dl.resume();
				});
			});
		});
	}

	stop() {
		// TODO
	}

}

