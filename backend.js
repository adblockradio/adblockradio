var Db = require("./predictor-db/db.js");
var MlPredictor = require("./predictor-ml/ml.js");
var Dl = require("./dl/dl.js");
var { getMeta } = require("webradio-metadata");
var log = require("loglevel");
log.setLevel("debug");

var country = "France";
var name = "RTL";

const ENABLE_PREDICTOR_FINGERPRINT = true;
const ENABLE_MRS = true;
const ENABLE_PREDICTOR_ML = false;
const SAVE_AUDIO = true;
const FETCH_METADATA = false;

var dl = new Dl({ country: country, name: name, segDuration: 10 });
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
//dl.pipe(decoder.stdin); //.write(data);

if (ENABLE_PREDICTOR_FINGERPRINT) {
	var Codegen = require("stream-audio-fingerprint");
	var fingerprinter = new Codegen();
	decoder.stdout.pipe(fingerprinter);
}
if (ENABLE_PREDICTOR_ML) {
	var mlPredictor = new MlPredictor({ country: country, name: name});
	decoder.stdout.pipe(mlPredictor);
}

var db;

dl.on("metadata", function(metadata) {
	log.info(country + "_" + name + " metadata=" + JSON.stringify(metadata));
	db = new Db({ country: country, name: name, ext: metadata.ext, path: __dirname });
	var dbs = null;

	/*if (ENABLE_PREDICTOR_FINGERPRINT) {
		var fingerprintFinder = db.getFingerprintFinder();
		fingerprinter.pipe(fingerprintFinder);
		fingerprintFinder.on("data", function(results) {
			log.debug("fingerprintFinder: " + results);
		});
	}*/

	dl.on("data", function(dataObj) { //newsegment", function(tBuffer, isready) {
		var tBuffer = dataObj.tBuffer;
		if (!dataObj.newSegment) {
			decoder.stdin.write(dataObj.data);
			if (SAVE_AUDIO) dbs.audio.write(dataObj.data); //dl.pipe(dbs.audio);
		} else {
			dl.pause();
			if (dbs) {
				//if (SAVE_AUDIO) dl.unpipe(dbs.audio);
				dbs.audio.end();

				if (ENABLE_PREDICTOR_FINGERPRINT) {
					fingerprinter.unpipe(dbs.fingerWriter);
					fingerprinter.unpipe(dbs.fingerFinder);
				}
				dbs.fingerWriter.end();
				dbs.fingerFinder.end();
				var refdbs = dbs;
				dbs.fingerFinder.once("end", function() {
					if (ENABLE_PREDICTOR_FINGERPRINT) refdbs.fingerFinder.unpipe(refdbs.metadata);
					if (ENABLE_PREDICTOR_ML) mlPredictor.unpipe(refdbs.metadata);
					refdbs.metadata.end();
				});
			}
			db.newAudioSegment(function(newdbs) {
				dbs = newdbs;
				if (ENABLE_PREDICTOR_FINGERPRINT) {
					fingerprinter.pipe(dbs.fingerWriter);
					fingerprinter.pipe(dbs.fingerFinder);
					dbs.fingerFinder.pipe(dbs.metadata);
					dbs.fingerFinder.on("data", function(obj) {
						if (ENABLE_MRS && obj.type === "match" && obj.data.mrs) {
							//var file1 = dbs.prefix + "." + metadata.ext;
							//var file2 = dbs.dir + obj.data.file["todo"] + "." + metadata.ext;
							log.debug("Backend: should launch MRS now between " + obj.data.mrs.new + " and " + obj.data.mrs.old);
						}
						dbs.metadata.write(obj);
					});
					//dbs.fingerFinder.on("data", function(results) {
						//log.debug("fingerprintFinder: ");
						//log.debug(results);
					//});
				}
				if (ENABLE_PREDICTOR_ML) mlPredictor.pipe(dbs.metadata);
				if (FETCH_METADATA) {
					getMeta(country, name, function(err, parsedMeta, corsEnabled) {
						if (err) {
							log.warn("getMeta: error fetching title meta. err=" + err);
						} else {
							log.info(country + "_" + name + " meta=" + JSON.stringify(parsedMeta));
							if (!dbs.metadata.ended) {
								dbs.metadata.write({ type: "title", data: parsedMeta });
							} else {
								log.warn("getMeta: could not write metadata, stream already ended");
							}
						}
					});
				}
				decoder.stdin.write(dataObj.data);
				if (SAVE_AUDIO) dbs.audio.write(dataObj.data);

				dl.resume();
			});
		}
	});
});
