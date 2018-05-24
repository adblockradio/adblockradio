"use strict";

const Db = require("./predictor-db/db.js");
const Hotlist = require("./predictor-db/hotlist.js");
const MlPredictor = require("./predictor-ml/ml.js");
const { StreamDl } = require("stream-tireless-baler");
const { getMeta } = require("webradio-metadata");
const { log } = require("abr-log")("pred-master");
const async = require("async");

/* overview of operations
TODO obsolete, to update!

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

		// output of predictions
		this.listener = options.listener;	// mandatory argument, instance of a Writable Stream.

		// module options
		this.config = {
			// send stream status to listener every N seconds
			predInterval: options.predInterval !== undefined ? optiond.predInterval : 1,

			// save audio file and metadata every N seconds // **predInterval times**.
			saveDuration: options.saveDuration !== undefined ? options.saveDuration : 10,

			ENABLE_PREDICTOR_FINGERPRINT: (options.predictor && options.predictor.hotlist !== undefined) ? !!options.predictor.hotlist : true,
			ENABLE_PREDICTOR_ML: (options.predictor && options.predictor.ml !== undefined) ? options.predictor.ml : true,
			SAVE_AUDIO: options.saveAudio !== undefined ? options.saveAudio : true,
			SAVE_METADATA: options.saveMetadata !== undefined ? options.saveMetadata : true,
			FETCH_METADATA: options.fetchMetadata !== undefined ? options.fetchMetadata : false
		}

		this._onData = this._onData.bind(this);
		this._newAudioSegment = this._newAudioSegment.bind(this);

		log.info("run predictor with config=" + JSON.stringify(this.config, null, "\t"));

		if (!country || !name || !this.listener) {
			return log.error("Predictor need to be constructed with: country (string), name (string) and listener(Writable stream)");
		}

		var self = this;
		this.dl = new StreamDl({ country: country, name: name, segDuration: self.config.predInterval });
		this.dl.on("error", function(err) {
			console.log("dl err=" + err);
		});
		this.dl.pause();

		this.decoder = require('child_process').spawn('ffmpeg', [
			'-i', 'pipe:0',
			'-acodec', 'pcm_s16le',
			'-ar', 11025,
			'-ac', 1,
			'-f', 'wav',
			'-v', 'fatal',
			'pipe:1'
		], { stdio: ['pipe', 'pipe', process.stderr] });

		if (this.config.ENABLE_PREDICTOR_FINGERPRINT) {
			this.hotlist = new Hotlist({ country: country, name: name });
			this.hotlist.pipe(this.listener);
			this.decoder.stdout.pipe(this.hotlist);
		}
		if (this.config.ENABLE_PREDICTOR_ML) {
			this.mlPredictor = new MlPredictor({ country: country, name: name });
			this.mlPredictor.pipe(this.listener);
			// we pipe decoder to mlPredictor later, once mlPredictor is ready to process data.
		}

		this.dl.on("metadata", function(metadata) { // this happens once at the beginning of stream download
			log.info(country + "_" + name + " metadata=" + JSON.stringify(metadata, null, "\t"));

			self.db = new Db({
				country: country,
				name: name,
				ext: metadata.ext,
				saveAudio: self.config.SAVE_AUDIO,
				path: __dirname
			});

			self.dbs = null;
			self.predCounter = 0

			self._newAudioSegment(function() {
				log.debug("first segment created");
				self.dl.resume();
			});

			self.dl.on("data", self._onData);
		});
	}

	_onData(dataObj) {
		if (!this.dbs) return log.error("no dbs!!");

		const tBuffer = dataObj.tBuffer;
		//log.debug("received " + dataObj.data.length + " bytes. newSegment=" + dataObj.newSegment);
		// dataObj.newSegment is true when the chunk of data we receive belongs to a new audio segment.
		// it happens once every [predInterval] seconds.

		const self = this;
		const out = function() {
			if (self.config.SAVE_AUDIO) self.dbs.audio.write(dataObj.data);
			self.listener.write(Object.assign(dataObj, { type: "audio" }));
			self.decoder.stdin.write(dataObj.data);
		}

		if (!dataObj.newSegment) return out();

		// actions on new segment
		//log.debug("dl+decoder pause");

		this.dl.pause();
		self.decoder.stdout.pause();

		async.parallel([

			function(cb) {
				return self.config.ENABLE_PREDICTOR_ML && self.mlPredictor.ready ? self.mlPredictor.sendStopWord(cb) : setImmediate(cb);
			},
			function(cb) {
				return self.config.ENABLE_PREDICTOR_FINGERPRINT ? self.hotlist.onFingers(cb) : setImmediate(cb);
			}

		], function(err) {

			// save audio and metadata less frequently than status updates. to do so, we count the audio segments.
			self.predCounter += 1;
			log.debug("new segment. predcounter=" + self.predCounter + "/" + self.config.saveDuration);

			const finish = function() {
				//log.debug("dl+decoder resume");
				self.decoder.stdout.resume();
				self.dl.resume();
				out();
			}

			if (self.predCounter < self.config.saveDuration) {
				finish();
			} else {
				self.predCounter = 0;
				self._newAudioSegment(finish);
			}
		});
	}

	_newAudioSegment(callback) {

		if (this.dbs) {
			if (this.config.SAVE_AUDIO) this.dbs.audio.end();
			if (this.config.SAVE_METADATA) {
				if (this.config.ENABLE_PREDICTOR_FINGERPRINT) this.hotlist.unpipe(this.dbs.metadata);
				if (this.config.ENABLE_PREDICTOR_ML) this.mlPredictor.unpipe(this.dbs.metadata);
				this.dbs.metadata.end();
			}
		}

		if (this.config.ENABLE_PREDICTOR_ML && this.mlPredictor.ready && !this.mlPredictor.ready2) {
			//log.debug("mlPredictor data pipe activated");
			this.decoder.stdout.pipe(this.mlPredictor);
			this.mlPredictor.ready2 = true;
		}

		var self = this;
		this.db.newAudioSegment(function(dbs) {
			//log.debug("newAudioSegment");
			self.dbs = dbs;

			// TODO: do the hotlist search only if mlPredictor is unsure?
			if (self.config.SAVE_METADATA) {
				if (self.config.ENABLE_PREDICTOR_FINGERPRINT) {
					// send Hotlist detections to metadata history DB
					self.hotlist.pipe(self.dbs.metadata);
				}
				if (self.config.ENABLE_PREDICTOR_ML) {
					// send ML predictions results to metadata history DB
					if (!self.mlPredictor) log.error("empty mlpredictor");
					if (!self.dbs.metadata) log.error("empty dbs.metadata");
					self.mlPredictor.pipe(self.dbs.metadata);
				}
			}

			// TODO put fetch metadata out of this process, it may delay it.
			if (self.config.FETCH_METADATA) {
				// send web-scraped metadata to history DB
				getMeta(country, name, function(err, parsedMeta, corsEnabled) {
					if (err) return log.warn("getMeta: error fetching title meta. err=" + err);
					log.info(country + "_" + name + " meta=" + JSON.stringify(parsedMeta));
					self.listener.write({ type: "title", data: parsedMeta });
					if (self.config.SAVE_METADATA) {
						if (self.dbs.metadata.ended) return log.warn("getMeta: could not write metadata, stream already ended");
						self.dbs.metadata.write({ type: "title", data: parsedMeta });
					}
				});
			}
			callback();
		});
	}

	stop() {
		// TODO
	}

}


module.exports = Predictor;