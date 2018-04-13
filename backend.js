var Db = require("./predictor-db/db.js");
const Hotlist = require("./predictor-db/hotlist.js");
var MlPredictor = require("./predictor-ml/ml.js");
//const Codegen = require("stream-audio-fingerprint");
var { StreamDl } = require("../adblockradio-dl/dl.js");
var { getMeta } = require("webradio-metadata");
var { log } = require("abr-log")("pred-master");

var country = "France";
var name = "RTL";

const ENABLE_PREDICTOR_FINGERPRINT = true;
const ENABLE_MRS = false;
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


var dl = new StreamDl({ country: country, name: name, segDuration: 10 });
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
}
if (ENABLE_PREDICTOR_ML) {
	var mlPredictor = new MlPredictor({ country: country, name: name });
	decoder.stdout.pipe(mlPredictor);
}

var db;

dl.on("metadata", function(metadata) {
	log.info(country + "_" + name + " metadata=" + JSON.stringify(metadata));
	db = new Db({
		country: country,
		name: name,
		ext: metadata.ext,
		saveAudio: SAVE_AUDIO,
		path: __dirname
	});
	var dbs = null;

	dl.on("data", function(dataObj) {
		var tBuffer = dataObj.tBuffer;
		if (!dataObj.newSegment) {
			decoder.stdin.write(dataObj.data);
			if (SAVE_AUDIO) dbs.audio.write(dataObj.data);
		} else {
			dl.pause();
			if (dbs) {
				//if (SAVE_AUDIO) dl.unpipe(dbs.audio);
				if (SAVE_AUDIO) dbs.audio.end();
				if (ENABLE_PREDICTOR_FINGERPRINT) hotlist.unpipe(dbs.metadata);
				if (ENABLE_PREDICTOR_ML) mlPredictor.unpipe(dbs.metadata);
				dbs.metadata.end();
			}
			db.newAudioSegment(function(newdbs) {
				dbs = newdbs;
				if (ENABLE_PREDICTOR_FINGERPRINT) {
					// send Hotlist detections to metadata history DB
					hotlist.pipe(dbs.metadata);
				}
				if (ENABLE_PREDICTOR_ML) {
					// send ML predictions results to metadata history DB
					mlPredictor.pipe(dbs.metadata);
				}
				if (FETCH_METADATA) {
					// send web-scraped metadata to history DB
					getMeta(country, name, function(err, parsedMeta, corsEnabled) {
						if (err) return log.warn("getMeta: error fetching title meta. err=" + err);
						if (dbs.metadata.ended) return log.warn("getMeta: could not write metadata, stream already ended");
						log.info(country + "_" + name + " meta=" + JSON.stringify(parsedMeta));
						dbs.metadata.write({ type: "title", data: parsedMeta });
					});
				}
				decoder.stdin.write(dataObj.data);
				if (SAVE_AUDIO) dbs.audio.write(dataObj.data);
				dl.resume();
			});
		}
	});
});
